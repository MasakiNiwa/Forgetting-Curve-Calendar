/** 最小限の DOM ヘルパー（フレームワーク非依存） */

/**
 * 要素を作る。
 *
 * 注意: 値が false / null / undefined の属性は「付けない」。
 * `hidden: false` と書いても隠れないので、
 * 出し入れするものは作ったあとに `el.hidden = …` で決めること。
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  Object.entries(props || {}).forEach(([key, value]) => {
    if (value === null || value === undefined || value === false) return;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in el && key !== 'list' && typeof value !== 'object') {
      el[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : value);
    }
  });
  append(el, children);
  return el;
}

export function append(parent, children) {
  children.flat(Infinity).forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return parent;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** ボタン + インラインSVGアイコンのショートカット */
export function iconButton(svgMarkup, { label, className = 'icon-btn', onClick, ...rest } = {}) {
  return h('button', {
    type: 'button',
    class: className,
    'aria-label': label,
    title: label,
    html: svgMarkup,
    onClick,
    ...rest,
  });
}

export function button(label, { icon: svgMarkup, className = 'btn', onClick, ...rest } = {}) {
  const el = h('button', { type: 'button', class: className, onClick, ...rest });
  if (svgMarkup) {
    const span = document.createElement('span');
    span.innerHTML = svgMarkup;
    el.appendChild(span.firstElementChild);
  }
  el.appendChild(document.createTextNode(label));
  return el;
}
