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
   * @param {{onChange?:Function, onSelectionChange?:Function, onEscape?:Function,
   *          onTabEscape?:Function}} hooks
   * @param {{history?:EditHistory}} options 履歴を渡すと、同じメモの続きとして扱う
   */
  constructor(el, hooks = {}, { history } = {}) {
    this.el = el;
    this.hooks = hooks;
    this.history = history || new EditHistory();
    this.commands = new Map();
    this.composing = false;
    /** Esc のあとの Tab は、字下げではなくフォーカス移動に使う */
    this.tabMovesFocus = false;

    // 渡された履歴が今の本文と食い違うときだけ、作り直す
    if (!history || !history.current || history.current.text !== this.el.value) {
      this.history.reset(this.snapshot());
    }
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

  /**
   * 選択範囲にかかる行の範囲を返す。
   * 選択の終わりが次の行の先頭にあるときは、その行は含めない
   * （一般的なエディタと同じく、改行までの選択は 1 行の選択として扱う）。
   */
  lineRange(start = this.selection.start, end = this.selection.end) {
    const text = this.el.value;
    const from = text.lastIndexOf('\n', start - 1) + 1;
    const scanFrom = end > start && end > from && text[end - 1] === '\n' ? end - 1 : end;
    let to = text.indexOf('\n', scanFrom);
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

  /**
   * ステータスバー用の軽い集計。
   * 長いメモでも入力のたびに重くならないよう、文字列を作り直さずに数える。
   */
  quickStats() {
    const text = this.el.value;
    let lines = text ? 1 : 0;
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10) lines += 1;
    }
    const { start, end } = this.selection;
    return { chars: text.length, lines, selected: end - start };
  }

  /** 詳しい集計（文字数の内訳を出すときだけ使う） */
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

  /** コマンドを実行する。何もしなかったときは false（キー操作を横取りしない）。 */
  run(id, payload) {
    const command = this.commands.get(id);
    if (!command) return false;
    return command.run(this, payload) !== false;
  }

  /** キー操作をコマンドへ振り分ける。処理したら true。 */
  handleKey(event) {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    if (mod && key === 'z' && !event.shiftKey) { this.run('undo'); return true; }
    if ((mod && key === 'y') || (mod && event.shiftKey && key === 'z')) { this.run('redo'); return true; }

    // Esc → 次の Tab はフォーカス移動（キーボードだけで本文欄から出られるように）
    if (key === 'escape' && !mod) {
      if (this.hooks.onEscape?.() === true) return true;
      this.tabMovesFocus = true;
      this.hooks.onTabEscape?.();
      return true;
    }
    if (key === 'tab' && !mod) {
      if (this.tabMovesFocus) { this.tabMovesFocus = false; return false; }
      this.run(event.shiftKey ? 'outdent' : 'indent');
      return true;
    }
    if (key === 'enter' && !mod && !event.shiftKey && this.run('newline')) return true;
    if (key !== 'shift' && key !== 'control' && key !== 'meta' && key !== 'alt') {
      this.tabMovesFocus = false;
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

const HEADING = '# ';
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
  const { start, end } = editor.selection;
  const { from, to } = editor.lineRange();
  const block = editor.el.value.slice(from, to);
  const lines = block.split('\n');
  const targets = lines.filter((l) => l.trim());

  if (!targets.length) {
    // 空行で押したときは、行頭記号を置いてそのまま書き始められるようにする
    if (start !== end) return;
    const parsed = parseLine(lines[0] ?? '');
    const prefix = buildLine({ indent: parsed.indent, marker, text: '' });
    const caret = from + prefix.length;
    editor.replaceRange(from, to, prefix, { select: [caret, caret] });
    editor.focus({ start: caret, end: caret });
    return;
  }

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
    .registerCommand('heading', {
      label: '見出し',
      icon: 'heading',
      // 行頭の「# 」を付け外しする。長いメモの中で目印になる。
      run: (ed) => {
        const { from, to } = ed.lineRange();
        const block = ed.el.value.slice(from, to);
        const lines = block.split('\n');
        const targets = lines.filter((l) => l.trim());
        const allHeading = targets.length > 0 && targets.every((l) => /^#{1,6}\s/.test(l.trimStart()));
        const mapped = lines.map((line) => {
          if (!line.trim()) return line;
          const indent = line.match(/^[ \t]*/)[0];
          const rest = line.slice(indent.length);
          if (allHeading) return indent + rest.replace(/^#{1,6}\s+/, '');
          if (/^#{1,6}\s/.test(rest)) return line;
          return indent + HEADING + rest;
        }).join('\n');
        if (mapped === block) {
          // 空行なら「# 」を置いて、そのまま書き始められるようにする
          const caret = from + HEADING.length;
          ed.replaceRange(from, to, HEADING, { select: [caret, caret] });
          return;
        }
        ed.replaceRange(from, to, mapped, { select: [from, from + mapped.length] });
      },
    })
    .registerCommand('newline', {
      label: '改行',
      // 箇条書きの続きは自動で作る。空の項目で改行したら、そこで終わる。
      run: (ed) => {
        const { start, end } = ed.selection;
        if (start !== end) return false;
        const { from, to } = ed.lineRange(start, start);
        if (start !== to) return false;   // 行の途中では普通の改行
        const parsed = parseLine(ed.el.value.slice(from, to));
        if (!parsed.marker) return false;
        if (!parsed.text.trim()) {
          const caret = from + parsed.indent.length;
          ed.replaceRange(from, to, parsed.indent, { select: [caret, caret] });
          return true;
        }
        const marker = parsed.marker === 'done' ? 'todo' : parsed.marker;
        const prefix = buildLine({ indent: parsed.indent, marker, text: '' });
        ed.replaceRange(start, start, `\n${prefix}`);
        return true;
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
