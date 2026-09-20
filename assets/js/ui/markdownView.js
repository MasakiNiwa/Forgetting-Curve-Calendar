/**
 * Markdown の構造を画面に出す。
 *
 * v0.14 で、保存されている本文はすべて文書データ（core/doc.js）になった。
 * ここが使われるのは、文書データを持たないものが来たときの受け皿と、
 * 古いメモを読み直して文書データへ移すとき（migrations）だけ。
 *
 * 文字はすべてテキストノードとして置く（innerHTML は使わない）ので、
 * メモに HTML を書いても、そのまま文字として出るだけで実行されない。
 */
import { h, append } from './dom.js';
import { parseMarkdown } from '../core/markdown.js';

function renderInline(nodes, parent) {
  nodes.forEach((node) => {
    if (node.type === 'text') { parent.appendChild(document.createTextNode(node.text)); return; }
    if (node.type === 'code') { parent.appendChild(h('code', { class: 'md__code' }, node.text)); return; }
    if (node.type === 'link') {
      const a = h('a', {
        class: 'md__link',
        href: node.href,
        target: '_blank',
        rel: 'noopener noreferrer',
      });
      renderInline(node.children, a);
      parent.appendChild(a);
      return;
    }
    const tag = { strong: 'strong', em: 'em', del: 's' }[node.type] || 'span';
    const el = h(tag, {});
    renderInline(node.children || [], el);
    parent.appendChild(el);
  });
}

function renderList(block) {
  const list = h(block.ordered ? 'ol' : 'ul', { class: 'md__list' });
  block.items.forEach((item) => {
    const li = h('li', { class: 'md__item' });
    if (item.checked === true || item.checked === false) {
      li.classList.add('md__item--check');
      if (item.checked) li.classList.add('md__item--done');
      // 読むための印なので、押せるようには見せない
      li.appendChild(h('span', { class: 'md__box', 'aria-hidden': 'true' }, item.checked ? '☑' : '☐'));
    }
    const text = h('span', { class: 'md__item-text' });
    renderInline(item.inline || [], text);
    li.appendChild(text);
    (item.children || []).forEach((child) => li.appendChild(renderList(child)));
    list.appendChild(li);
  });
  return list;
}

function renderBlock(block) {
  switch (block.type) {
    case 'heading': {
      const el = h(`h${Math.min(6, block.level + 2)}`, { class: `md__h md__h--${block.level}` });
      renderInline(block.inline, el);
      return el;
    }
    case 'paragraph': {
      const p = h('p', { class: 'md__p' });
      block.lines.forEach((line, i) => {
        if (i) p.appendChild(h('br', {}));
        renderInline(line, p);
      });
      return p;
    }
    case 'list':
      return renderList(block);
    case 'quote': {
      const el = h('blockquote', { class: 'md__quote' });
      append(el, block.blocks.map(renderBlock));
      return el;
    }
    case 'code':
      return h('pre', { class: 'md__pre' }, h('code', { class: 'md__pre-code' }, block.text));
    case 'rule':
      return h('hr', { class: 'md__rule' });
    case 'table': {
      const table = h('table', { class: 'md__table' });
      const thead = h('thead', {});
      const hr = h('tr', {});
      block.head.forEach((cell, i) => {
        const th = h('th', block.align[i] ? { style: { textAlign: block.align[i] } } : {});
        renderInline(cell, th);
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = h('tbody', {});
      block.rows.forEach((row) => {
        const tr = h('tr', {});
        row.forEach((cell, i) => {
          const td = h('td', block.align[i] ? { style: { textAlign: block.align[i] } } : {});
          renderInline(cell, td);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      // 幅のある表でも、はみ出さずに横へスクロールできるようにする
      return h('div', { class: 'md__table-wrap' }, table);
    }
    default:
      return null;
  }
}

/**
 * Markdown を読んで、その見た目の要素を返す。
 * @param {string} text
 * @param {{className?:string}} options
 */
export function markdownView(text, { className = '' } = {}) {
  const root = h('div', { class: `md ${className}`.trim() });
  append(root, parseMarkdown(text).map(renderBlock));
  return root;
}
