/**
 * テキストエディタの中身（本文・選択範囲・履歴・コマンド）。
 *
 * 画面（ツールバーやボタン）とは分けてあるので、
 * ツールバー・メニュー・ショートカットのどれからでも同じコマンドを呼べる。
 * 機能を足すときは registerCommand() でコマンドを増やすだけでよい。
 */
import { EditHistory } from './history.js';

export class TextEditor {
  /**
   * @param {HTMLTextAreaElement} el
   * @param {{onChange?:Function, onSelectionChange?:Function}} hooks
   */
  constructor(el, hooks = {}) {
    this.el = el;
    this.hooks = hooks;
    this.history = new EditHistory();
    this.commands = new Map();
    this.composing = false;

    this.history.reset(this.snapshot());
    this.#bind();
    registerDefaultCommands(this);
  }

  /* ---------------------------------------------------------- 基本操作 */

  get text() { return this.el.value; }

  get selection() {
    return { start: this.el.selectionStart, end: this.el.selectionEnd };
  }

  snapshot() {
    return { text: this.el.value, start: this.el.selectionStart, end: this.el.selectionEnd };
  }

  /** 表示中の本文を丸ごと差し替える（別のメモを開くときなど） */
  load(text) {
    this.el.value = text;
    this.el.setSelectionRange(0, 0);
    this.history.reset(this.snapshot());
    this.hooks.onChange?.(this.text, { silent: true });
    this.hooks.onSelectionChange?.(this.selection);
  }

  focus({ start, end } = {}) {
    this.el.focus({ preventScroll: true });
    if (Number.isFinite(start)) {
      this.el.setSelectionRange(start, Number.isFinite(end) ? end : start);
    }
  }

  /**
   * 範囲を置き換える。1 手として履歴に残る。
   * @param {number} start
   * @param {number} end
   * @param {string} value
   * @param {{select?:[number,number], kind?:string}} options
   */
  replaceRange(start, end, value, { select, kind = 'command' } = {}) {
    const text = `${this.el.value.slice(0, start)}${value}${this.el.value.slice(end)}`;
    const caret = start + value.length;
    this.el.value = text;
    const [s, e] = select || [caret, caret];
    this.el.setSelectionRange(s, e);
    this.history.push(this.snapshot(), { kind, coalesce: false });
    this.#changed();
  }

  /** 本文全体を置き換える（検索置換など）。1 手として戻せる。 */
  setText(text, { select, kind = 'command' } = {}) {
    this.el.value = text;
    const [s, e] = select || [Math.min(this.el.value.length, this.selection.start), Math.min(this.el.value.length, this.selection.end)];
    this.el.setSelectionRange(s, e);
    this.history.push(this.snapshot(), { kind, coalesce: false });
    this.#changed();
  }

  /** カーソル位置に差し込む */
  insert(value, options) {
    const { start, end } = this.selection;
    this.replaceRange(start, end, value, options);
  }

  /* ---------------------------------------------------------- 行の操作 */

  /** 選択範囲にかかる行の範囲を返す */
  lineRange(start = this.selection.start, end = this.selection.end) {
    const text = this.el.value;
    const from = text.lastIndexOf('\n', start - 1) + 1;
    let to = text.indexOf('\n', end);
    if (to === -1) to = text.length;
    return { from, to };
  }

  /** 選択範囲の各行に関数を適用する */
  mapLines(fn, { kind = 'command' } = {}) {
    const { start, end } = this.selection;
    const { from, to } = this.lineRange(start, end);
    const block = this.el.value.slice(from, to);
    const mapped = block.split('\n').map(fn).join('\n');
    if (mapped === block) return;
    this.replaceRange(from, to, mapped, { select: [from, from + mapped.length], kind });
  }

  /** 現在の行・桁（1 始まり） */
  caretPosition() {
    const upto = this.el.value.slice(0, this.selection.start);
    const lines = upto.split('\n');
    return { line: lines.length, column: lines[lines.length - 1].length + 1 };
  }

  stats() {
    const text = this.el.value;
    return {
      chars: [...text].length,
      charsNoSpace: [...text.replace(/\s/g, '')].length,
      lines: text ? text.split('\n').length : 0,
      selected: [...text.slice(this.selection.start, this.selection.end)].length,
    };
  }

  /* ---------------------------------------------------------- コマンド */

  registerCommand(id, definition) {
    this.commands.set(id, definition);
    return this;
  }

  run(id, payload) {
    const command = this.commands.get(id);
    if (!command) return false;
    command.run(this, payload);
    return true;
  }

  /** キー操作をコマンドへ振り分ける。処理したら true。 */
  handleKey(event) {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    if (mod && key === 'z' && !event.shiftKey) { this.run('undo'); return true; }
    if ((mod && key === 'y') || (mod && event.shiftKey && key === 'z')) { this.run('redo'); return true; }
    if (key === 'tab' && !mod) {
      this.run(event.shiftKey ? 'outdent' : 'indent');
      return true;
    }
    for (const [id, command] of this.commands) {
      if (!command.key) continue;
      const need = command.key;
      if (need.mod && !mod) continue;
      if (Boolean(need.shift) !== event.shiftKey) continue;
      if (need.key.toLowerCase() !== key) continue;
      this.run(id);
      return true;
    }
    return false;
  }

  /* ---------------------------------------------------------- 内部 */

  #bind() {
    this.el.addEventListener('compositionstart', () => { this.composing = true; });
    this.el.addEventListener('compositionend', () => {
      this.composing = false;
      // 変換の確定を 1 手として記録する
      this.history.push(this.snapshot(), { kind: 'ime', coalesce: false });
      this.#changed();
    });
    this.el.addEventListener('input', () => {
      if (this.composing) { this.hooks.onChange?.(this.text, { composing: true }); return; }
      this.history.push(this.snapshot(), { kind: 'input' });
      this.#changed();
    });
    this.el.addEventListener('keydown', (event) => {
      if (this.composing || event.isComposing) return;
      if (this.handleKey(event)) event.preventDefault();
    });
    ['click', 'keyup', 'select', 'focus'].forEach((type) => {
      this.el.addEventListener(type, () => this.hooks.onSelectionChange?.(this.selection));
    });
  }

  #changed() {
    this.hooks.onChange?.(this.text, {});
    this.hooks.onSelectionChange?.(this.selection);
  }

  #restore(state) {
    if (!state) return;
    this.el.value = state.text;
    this.el.setSelectionRange(state.start, state.end);
    this.el.focus({ preventScroll: true });
    this.#changed();
  }

  applyHistory(state) { this.#restore(state); }
}

/* ------------------------------------------------------------------ */
/* 既定のコマンド                                                      */
/* ------------------------------------------------------------------ */

const BULLET = '- ';
const CHECKBOX = '- [ ] ';
const CHECKED = '- [x] ';
const INDENT = '  ';

/** 行を「字下げ・行頭記号・本文」に分解する */
function parseLine(line) {
  const indentMatch = line.match(/^[ \t]*/);
  const indent = indentMatch ? indentMatch[0] : '';
  const rest = line.slice(indent.length);
  if (rest.startsWith(CHECKBOX)) return { indent, marker: 'todo', text: rest.slice(CHECKBOX.length) };
  if (rest.startsWith(CHECKED)) return { indent, marker: 'done', text: rest.slice(CHECKED.length) };
  if (rest.startsWith(BULLET)) return { indent, marker: 'bullet', text: rest.slice(BULLET.length) };
  return { indent, marker: null, text: rest };
}

function buildLine({ indent, marker, text }) {
  const prefix = marker === 'todo' ? CHECKBOX : marker === 'done' ? CHECKED : marker === 'bullet' ? BULLET : '';
  return `${indent}${prefix}${text}`;
}

/**
 * 選択行の行頭記号を切り替える。
 * すでに全行がその記号なら外し、そうでなければ付け替える。
 */
function toggleMarker(editor, marker) {
  const { from, to } = editor.lineRange();
  const block = editor.el.value.slice(from, to);
  const lines = block.split('\n');
  const targets = lines.filter((l) => l.trim());
  if (!targets.length) return;

  const matches = (m) => (marker === 'todo' ? m === 'todo' || m === 'done' : m === marker);
  const allMarked = targets.every((l) => matches(parseLine(l).marker));

  const mapped = lines.map((line) => {
    if (!line.trim()) return line;
    const parsed = parseLine(line);
    return buildLine({ ...parsed, marker: allMarked ? null : marker });
  }).join('\n');

  if (mapped === block) return;
  editor.replaceRange(from, to, mapped, { select: [from, from + mapped.length] });
}

export function registerDefaultCommands(editor) {
  editor
    .registerCommand('undo', {
      label: '元に戻す',
      icon: 'undo',
      run: (ed) => ed.applyHistory(ed.history.undo()),
    })
    .registerCommand('redo', {
      label: 'やり直す',
      icon: 'redo',
      run: (ed) => ed.applyHistory(ed.history.redo()),
    })
    .registerCommand('bullet', {
      label: '箇条書き',
      icon: 'list',
      run: (ed) => toggleMarker(ed, 'bullet'),
    })
    .registerCommand('checkbox', {
      label: 'チェック',
      icon: 'checkbox',
      run: (ed) => toggleMarker(ed, 'todo'),
    })
    .registerCommand('toggleCheck', {
      label: '完了を切り替え',
      icon: 'check',
      run: (ed) => {
        const { from, to } = ed.lineRange();
        const block = ed.el.value.slice(from, to);
        const mapped = block.split('\n').map((line) => {
          if (!line.trim()) return line;
          const parsed = parseLine(line);
          if (parsed.marker === 'todo') return buildLine({ ...parsed, marker: 'done' });
          if (parsed.marker === 'done') return buildLine({ ...parsed, marker: 'todo' });
          return line;
        }).join('\n');
        if (mapped === block) return;
        ed.replaceRange(from, to, mapped, { select: [from, from + mapped.length] });
      },
    })
    .registerCommand('indent', {
      label: '字下げ',
      icon: 'indent',
      run: (ed) => {
        const { start, end } = ed.selection;
        if (start === end) {
          const { from } = ed.lineRange();
          ed.replaceRange(from, from, INDENT, { select: [start + INDENT.length, start + INDENT.length] });
          return;
        }
        ed.mapLines((line) => (line.trim() === '' ? line : INDENT + line));
      },
    })
    .registerCommand('outdent', {
      label: '字下げを戻す',
      icon: 'outdent',
      run: (ed) => ed.mapLines((line) => line.replace(/^ {1,2}|^\t/, '')),
    })
    .registerCommand('timestamp', {
      label: '日時を挿入',
      icon: 'clock',
      run: (ed) => {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const text = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
          + `${pad(now.getHours())}:${pad(now.getMinutes())}`;
        ed.insert(text);
      },
    })
    .registerCommand('duplicateLine', {
      label: '行を複製',
      icon: 'copy',
      run: (ed) => {
        const { from, to } = ed.lineRange();
        const line = ed.el.value.slice(from, to);
        ed.replaceRange(to, to, `\n${line}`, { select: [to + 1, to + 1 + line.length] });
      },
    })
    .registerCommand('deleteLine', {
      label: '行を削除',
      icon: 'trash',
      run: (ed) => {
        const { from, to } = ed.lineRange();
        const end = Math.min(ed.el.value.length, to + 1);
        ed.replaceRange(from, end, '', { select: [from, from] });
      },
    });
  return editor;
}
