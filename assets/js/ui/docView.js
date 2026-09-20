/**
 * 文書データ（本文）を画面に出す。
 *
 * 書くための道具（Tiptap）は重いので、読むだけの画面では読み込まない。
 * ここは保存された文書データを、そのまま素の DOM に組み直すだけの係。
 *
 * 文字はすべてテキストノードとして置く（innerHTML は使わない）ので、
 * メモに HTML を書いても、ただの文字として出るだけで実行されない。
 * 見た目の CSS は Markdown 表示（md__*）と共通にしてある。
 */
import { h } from './dom.js';
import { normalizeDoc } from '../core/doc.js';
import { markdownView } from './markdownView.js';

const MARK_TAG = { bold: 'strong', italic: 'em', strike: 's', underline: 'u' };

function renderText(node) {
  const marks = Array.isArray(node.marks) ? node.marks : [];
  // 文字を内側に置いて、飾りを外側へ重ねていく
  let el = document.createTextNode(node.text || '');
  marks.forEach((mark) => {
    if (mark.type === 'code') {
      const code = h('code', { class: 'md__code' });
      code.appendChild(el);
      el = code;
      return;
    }
    if (mark.type === 'link') {
      const a = h('a', {
        class: 'md__link',
        href: mark.attrs?.href || '',
        target: '_blank',
        rel: 'noopener noreferrer',
      });
      a.appendChild(el);
      el = a;
      return;
    }
    const tag = MARK_TAG[mark.type];
    if (!tag) return;
    const wrap = h(tag, {});
    wrap.appendChild(el);
    el = wrap;
  });
  return el;
}

function renderInto(parent, content) {
  (content || []).forEach((node) => {
    const el = renderNode(node);
    if (el) parent.appendChild(el);
  });
  return parent;
}

/** 表は、1 行目が見出しのマスなら thead として扱う */
function renderTable(node) {
  const rows = (node.content || []).filter((r) => r.type === 'tableRow');
  const table = h('table', { class: 'md__table' });
  const head = h('thead', {});
  const body = h('tbody', {});
  rows.forEach((row, i) => {
    const tr = h('tr', {});
    let isHead = false;
    (row.content || []).forEach((cell) => {
      const header = cell.type === 'tableHeader';
      if (header) isHead = true;
      const td = h(header ? 'th' : 'td', {
        colspan: (cell.attrs?.colspan ?? 1) > 1 ? cell.attrs.colspan : null,
        rowspan: (cell.attrs?.rowspan ?? 1) > 1 ? cell.attrs.rowspan : null,
      });
      renderInto(td, cell.content);
      tr.appendChild(td);
    });
    (isHead && i === 0 ? head : body).appendChild(tr);
  });
  if (head.childNodes.length) table.appendChild(head);
  if (body.childNodes.length) table.appendChild(body);
  // 幅のある表でも、はみ出さずに横へスクロールできるようにする
  return h('div', { class: 'md__table-wrap' }, table);
}

function renderNode(node) {
  if (!node || typeof node !== 'object') return null;
  switch (node.type) {
    case 'text':
      return renderText(node);
    case 'hardBreak':
      return h('br', {});
    case 'paragraph':
      return renderInto(h('p', { class: 'md__p' }), node.content);
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
      return renderInto(h(`h${Math.min(6, level + 2)}`, { class: `md__h md__h--${level}` }), node.content);
    }
    case 'bulletList':
      return renderInto(h('ul', { class: 'md__list' }), node.content);
    case 'orderedList': {
      const start = Number(node.attrs?.start) || 1;
      return renderInto(h('ol', { class: 'md__list', start: start > 1 ? start : null }), node.content);
    }
    case 'listItem':
      return renderInto(h('li', { class: 'md__item' }), node.content);
    case 'taskList':
      // 済みに取り消し線を引くかどうかは、書いた人が選んでいる
      return renderInto(h('ul', {
        class: 'md__list md__list--task',
        'data-strike': node.attrs?.strike === false ? 'false' : 'true',
      }), node.content);
    case 'taskItem': {
      const done = node.attrs?.checked === true;
      const li = h('li', { class: `md__item md__item--check${done ? ' md__item--done' : ''}` });
      // 読むための印なので、押せるようには見せない
      li.appendChild(h('span', { class: 'md__box', 'aria-hidden': 'true' }, done ? '☑' : '☐'));
      li.appendChild(renderInto(h('div', { class: 'md__item-text' }), node.content));
      return li;
    }
    case 'blockquote':
      return renderInto(h('blockquote', { class: 'md__quote' }), node.content);
    case 'codeBlock': {
      const text = (node.content || []).map((c) => c.text || '').join('');
      return h('pre', { class: 'md__pre' }, h('code', { class: 'md__pre-code' }, text));
    }
    case 'horizontalRule':
      return h('hr', { class: 'md__rule' });
    case 'table':
      return renderTable(node);
    default:
      // 知らないかたまりは、中身だけでも読めるように段落として出す
      return node.content ? renderInto(h('p', { class: 'md__p' }), node.content) : null;
  }
}

/**
 * 文書データの見た目を返す。
 * @param {object} raw 保存されていた文書データ
 * @param {{className?:string}} options
 */
export function docView(raw, { className = '' } = {}) {
  const doc = normalizeDoc(raw);
  const root = h('div', { class: `md ${className}`.trim() });
  if (doc) renderInto(root, doc.content);
  return root;
}

/**
 * メモの本文を出す。
 *
 * 本文（文書データ）は開いたときに読む（v0.15）。まだ手元に無いときは、
 * 素の文字をすぐ出しておき、読めたところで見た目を整えたものに差し替える。
 * 読む人を空白のまま待たせないため。
 *
 * v0.14 で、保存されている本文はすべて文書データに揃えた（migrations の v6→v7）。
 * それでも `doc` が無い（= null）ものが来たら、書いてあった文字をそのまま出す。
 *
 * @param {object} note
 * @param {{className?:string, text?:string, store?:object}} options
 */
export function noteBodyView(note, options = {}) {
  const { className = '', store } = options;
  if (note?.doc) return docView(note.doc, { className });
  const text = options.text !== undefined ? options.text : (note?.body || '');

  // まだ読んでいない本文は、読めてから差し替える
  if (note && note.doc === undefined && typeof store?.ensureDoc === 'function') {
    const slot = h('div', { class: 'md-slot' }, markdownView(text, { className }));
    store.ensureDoc(note).then((doc) => {
      if (!doc || !slot.isConnected) return;
      slot.replaceChildren(docView(doc, { className }));
    });
    return slot;
  }
  return markdownView(text, { className });
}

/** 文書データを持つメモか（表示の出しわけ用） */
export function hasDoc(note) {
  return Boolean(note?.doc);
}
