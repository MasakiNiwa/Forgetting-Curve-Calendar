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
        bold: false, italic: false, strike: false, code: false, link: false,
        heading: 0, bullet: false, ordered: false, task: false, quote: false,
        codeBlock: false, inTable: false, canUndo: true, canRedo: true,
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
      bold: noop, italic: noop, strike: noop, code: noop,
      heading: noop, bullet: noop, ordered: noop, task: noop, quote: noop,
      codeBlock: noop, rule: noop, table: noop,
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
    findNext(query) {
      if (!query) return null;
      const value = area.value;
      let at = value.indexOf(query, area.selectionEnd);
      if (at === -1) at = value.indexOf(query, 0);
      if (at === -1) return null;
      this.select(at, at + query.length);
      return { from: at, to: at + query.length };
    },
    replaceCurrent(query, replacement) {
      const { selectionStart: s, selectionEnd: e } = area;
      if (s === e || area.value.slice(s, e) !== query) return false;
      area.setRangeText(replacement || '', s, e, 'end');
      grow();
      onChange();
      return true;
    },
    replaceAll(query, replacement) {
      if (!query || !area.value.includes(query)) return 0;
      const count = area.value.split(query).length - 1;
      area.value = area.value.split(query).join(replacement || '');
      grow();
      onChange();
      return count;
    },
  };
}
