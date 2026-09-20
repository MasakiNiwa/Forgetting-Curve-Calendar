/**
 * 書く道具が読み込めなかったときの受け皿。
 *
 * 見た目の編集はできないが、「書けない・保存できない」だけは避けたい。
 * ふつうの入力欄として文字を書き、保存するときに文書データへ直す。
 * 呼び出し側から見た形は editor/docEditor.js と同じにしてある。
 */
import { docToText, normalizeDoc, textToDoc } from '../core/doc.js';

export function createPlainSurface(mount, {
  doc = null,
  text = '',
  editable = true,
  placeholder = '',
  onChange = () => {},
  onSelectionChange = () => {},
} = {}) {
  const normalized = normalizeDoc(doc);
  const area = document.createElement('textarea');
  area.className = 'ed__plain';
  area.setAttribute('aria-label', '本文');
  area.placeholder = placeholder;
  area.value = normalized ? docToText(normalized) : String(text || '');
  area.readOnly = editable === false;
  area.addEventListener('input', () => { grow(); onChange(); });
  area.addEventListener('keyup', () => onSelectionChange());
  area.addEventListener('click', () => onSelectionChange());
  mount.appendChild(area);

  function grow() {
    area.style.height = 'auto';
    area.style.height = `${Math.max(area.scrollHeight, 240)}px`;
  }
  grow();

  const noop = () => false;
  const insert = (value) => {
    const { selectionStart: s, selectionEnd: e } = area;
    area.value = `${area.value.slice(0, s)}${value}${area.value.slice(e)}`;
    area.setSelectionRange(s + value.length, s + value.length);
    grow();
    onChange();
    return true;
  };

  return {
    element: mount,
    plain: true,
    getDoc() { return textToDoc(area.value); },
    getText() { return area.value; },
    setDoc(next) {
      const d = normalizeDoc(next);
      area.value = d ? docToText(d) : '';
      grow();
    },
    isEmpty() { return !area.value.trim(); },
    focus({ end = false } = {}) {
      area.focus({ preventScroll: true });
      if (end) area.setSelectionRange(area.value.length, area.value.length);
    },
    setEditable(value) { area.readOnly = value === false; },
    destroy() { area.remove(); },
    state() {
      return {
        bold: false, italic: false, strike: false, underline: false, code: false, link: false,
        ink: '', marker: '',
        heading: 0, bullet: false, ordered: false, task: false, quote: false,
        codeBlock: false, inTable: false, taskStrike: true,
        canIndent: false, canOutdent: false, canUndo: true, canRedo: true,
      };
    },
    stats() {
      const value = area.value;
      return {
        chars: value.length,
        lines: value ? value.split('\n').length : 0,
        selected: area.selectionEnd - area.selectionStart,
      };
    },
    selection() { return { from: area.selectionStart, to: area.selectionEnd }; },
    select(from, to = from) {
      const max = area.value.length;
      area.focus({ preventScroll: true });
      area.setSelectionRange(Math.min(from, max), Math.min(to, max));
    },
    commands: {
      undo: () => document.execCommand?.('undo'),
      redo: () => document.execCommand?.('redo'),
      bold: noop, italic: noop, strike: noop, underline: noop, code: noop,
      ink: noop, marker: noop,
      heading: noop, bullet: noop, ordered: noop, task: noop, quote: noop,
      codeBlock: noop, rule: noop, table: noop, plain: noop,
      indent: noop, outdent: noop, taskStrike: noop,
      lineBreak: () => insert('\n'),
      addRow: noop, addColumn: noop, removeRow: noop, removeColumn: noop, removeTable: noop,
      unlink: noop,
      link: (href) => insert(String(href || '')),
      timestamp: (value) => insert(String(value || '')),
    },
    headings() {
      const out = [];
      let at = 0;
      area.value.split('\n').forEach((line) => {
        const m = line.match(/^(#{1,6})\s+(.+)$/);
        if (m) out.push({ level: m[1].length, text: m[2].trim(), pos: at });
        at += line.length + 1;
      });
      return out;
    },
    goTo(pos) { this.select(pos, pos); },
    scrollCaret() { /* 入力欄はブラウザが面倒を見てくれる */ },
    findMatches(query, { exact = false } = {}) {
      const needle = String(query ?? '');
      if (!needle) return [];
      const value = exact ? area.value : area.value.toLowerCase();
      const q = exact ? needle : needle.toLowerCase();
      const out = [];
      let at = value.indexOf(q);
      while (at !== -1) {
        out.push({ from: at, to: at + q.length });
        at = value.indexOf(q, at + q.length);
      }
      return out;
    },
    matchIndexAfterCaret(ranges) {
      const found = ranges.findIndex((r) => r.from >= area.selectionEnd);
      return found === -1 ? 0 : found;
    },
    highlight() { /* 入力欄には色を置けない */ },
    clearHighlight() { /* noop */ },
    revealRange(range) { if (range) this.select(range.from, range.to); },
    placeCaret(range) { if (range) this.select(range.from, range.to); },
    replaceRange(range, replacement) {
      if (!range) return false;
      area.setRangeText(replacement || '', range.from, range.to, 'end');
      grow();
      onChange();
      return true;
    },
    replaceRanges(ranges, replacement) {
      if (!ranges?.length) return 0;
      let value = area.value;
      [...ranges].reverse().forEach(({ from, to }) => {
        value = value.slice(0, from) + (replacement || '') + value.slice(to);
      });
      area.value = value;
      grow();
      onChange();
      return ranges.length;
    },
  };
}
