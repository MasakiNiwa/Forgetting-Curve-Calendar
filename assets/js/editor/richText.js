/**
 * リッチテキストのエディタ（本文ぜんぶで 1 枚の編集面）。
 *
 * 方針:
 * - 画面はふつうのメモ帳と同じで、どこを押してもそこにカーソルが入り、
 *   Enter で次の段落へ進み、空行も空行のまま残る。
 * - 入力そのものはブラウザの編集機能（contenteditable）に任せる。
 *   打っている最中にこちらが作り直さないので、日本語の変換も
 *   「元に戻す」も、カーソルの位置も、いつもどおりに動く。
 * - 書式は打った形からその場で整える（「- 」で箇条書き、「# 」で見出し…）。
 * - 保存する形はこれまでどおり素の Markdown。開くときに DOM へ、
 *   直したら Markdown へ戻す（どちらの向きも、この 1 ファイルで完結させる）。
 *
 * 構造の変更（表の行や列、チェックの入れ替え）は execCommand を通して行う。
 * ブラウザの「元に戻す」に同じ流れで載せるため。
 */
import { h, append } from '../ui/dom.js';
import { parseMarkdown, safeUrl } from '../core/markdown.js';

/* ------------------------------------------------------------------ */
/* Markdown → 編集できる DOM                                          */
/* ------------------------------------------------------------------ */

const BOX_CHECKED = '☑';
const BOX_EMPTY = '☐';

function checkBox(checked) {
  return h('span', {
    class: `rt__box ${checked ? 'rt__box--on' : ''}`.trim(),
    contenteditable: 'false',
    role: 'checkbox',
    'aria-checked': checked ? 'true' : 'false',
    'aria-label': checked ? 'チェックを外す' : 'チェックを入れる',
  }, checked ? BOX_CHECKED : BOX_EMPTY);
}

function inlineToDom(nodes, parent) {
  nodes.forEach((node) => {
    if (node.type === 'text') { parent.appendChild(document.createTextNode(node.text)); return; }
    if (node.type === 'code') { parent.appendChild(h('code', {}, node.text)); return; }
    if (node.type === 'link') {
      const a = h('a', { href: node.href, rel: 'noopener noreferrer' });
      inlineToDom(node.children, a);
      parent.appendChild(a);
      return;
    }
    const tag = { strong: 'strong', em: 'em', del: 's' }[node.type];
    if (!tag) return;
    const el = h(tag, {});
    inlineToDom(node.children || [], el);
    parent.appendChild(el);
  });
}

function listToDom(block) {
  const list = h(block.ordered ? 'ol' : 'ul', {});
  block.items.forEach((item) => {
    const li = h('li', {});
    if (item.checked === true || item.checked === false) {
      li.dataset.check = item.checked ? '1' : '0';
      li.appendChild(checkBox(item.checked));
    }
    inlineToDom(item.inline || [], li);
    (item.children || []).forEach((child) => li.appendChild(listToDom(child)));
    list.appendChild(li);
  });
  return list;
}

function blockToDom(block) {
  switch (block.type) {
    case 'heading': {
      const el = h(`h${Math.min(6, block.level)}`, {});
      inlineToDom(block.inline, el);
      return el;
    }
    case 'paragraph': {
      const p = h('p', {});
      block.lines.forEach((line, i) => {
        if (i) p.appendChild(h('br', {}));
        inlineToDom(line, p);
      });
      return p;
    }
    case 'list':
      return listToDom(block);
    case 'quote': {
      const el = h('blockquote', {});
      append(el, block.blocks.map(blockToDom));
      return el;
    }
    case 'code': {
      const code = h('code', {}, block.text);
      const pre = h('pre', {});
      if (block.lang) pre.dataset.lang = block.lang;
      pre.appendChild(code);
      return pre;
    }
    case 'rule':
      return h('hr', {});
    case 'table': {
      const table = h('table', {});
      const thead = h('thead', {});
      const hr = h('tr', {});
      block.head.forEach((cell, i) => {
        const th = h('th', block.align[i] ? { 'data-align': block.align[i] } : {});
        inlineToDom(cell, th);
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      const tbody = h('tbody', {});
      block.rows.forEach((row) => {
        const tr = h('tr', {});
        row.forEach((cell, i) => {
          const td = h('td', block.align[i] ? { 'data-align': block.align[i] } : {});
          inlineToDom(cell, td);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.append(thead, tbody);
      return h('div', { class: 'rt__table' }, table);
    }
    default:
      return null;
  }
}

const emptyParagraph = () => h('p', {}, h('br', {}));

/**
 * Markdown から、編集できる中身を作る。
 *
 * かたまりの間に空行が 2 つ以上あったら、その数だけ空の段落を置く。
 * 「行を空けて書く」書き方を、開き直しても保てるようにするため。
 */
export function markdownToDom(markdown) {
  const frag = document.createDocumentFragment();
  const blocks = parseMarkdown(markdown);
  let prevEnd = null;
  blocks.forEach((block) => {
    if (prevEnd !== null) {
      const blank = Math.max(0, block.start - prevEnd);
      for (let i = 1; i < blank; i += 1) frag.appendChild(emptyParagraph());
    }
    const el = blockToDom(block);
    if (el) frag.appendChild(el);
    prevEnd = block.end;
  });
  if (!frag.childNodes.length) frag.appendChild(emptyParagraph());
  return frag;
}

/* ------------------------------------------------------------------ */
/* DOM → Markdown                                                     */
/* ------------------------------------------------------------------ */

/** そのまま書くと別の意味になってしまう文字を守る */
function escapeText(text) {
  return String(text).replace(/([\\*`~])/g, '\\$1');
}

/** 文字や強調など、行の中身を 1 つぶん */
function inlineNode(child, { inTable = false } = {}) {
  if (child.nodeType === 3) {
    const text = escapeText(child.nodeValue);
    return inTable ? text.replace(/\|/g, '\\|') : text;
  }
  if (child.nodeType !== 1) return '';
  const tag = child.tagName;
  if (tag === 'BR') return '\n';
  if (child.classList?.contains('rt__box')) return '';   // チェックの印は行の頭で付ける
  if (tag === 'UL' || tag === 'OL') return '';           // 入れ子の並びは呼び出し側で
  if (tag === 'CODE') return `\`${child.textContent}\``;
  if (tag === 'A') {
    const href = safeUrl(child.getAttribute('href'));
    const label = inlineOf(child, { inTable });
    return href ? `[${label}](${href})` : label;
  }
  if (tag === 'STRONG' || tag === 'B') return `**${inlineOf(child, { inTable })}**`;
  if (tag === 'EM' || tag === 'I') return `*${inlineOf(child, { inTable })}*`;
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') return `~~${inlineOf(child, { inTable })}~~`;
  return inlineOf(child, { inTable });
}

function inlineOf(node, options = {}) {
  let out = '';
  node.childNodes.forEach((child) => { out += inlineNode(child, options); });
  return out;
}

const BLOCK_TAGS = /^(P|DIV|H[1-6]|UL|OL|BLOCKQUOTE|PRE|HR|TABLE)$/;

/**
 * 中に段落があったり、むき出しの文字があったりする入れ物を読む。
 * ブラウザは <blockquote>文字</blockquote> のような形も作るので、
 * どちらの形でも同じ結果になるようにする。
 */
function innerBlocks(el) {
  const parts = [];
  let buffer = '';
  el.childNodes.forEach((node) => {
    if (node.nodeType === 1 && BLOCK_TAGS.test(node.tagName)) {
      if (buffer.trim()) { parts.push(buffer); buffer = ''; }
      const md = blockOf(node);
      if (md !== null && md !== '') parts.push(md);
      return;
    }
    buffer += inlineNode(node);
  });
  if (buffer.trim()) parts.push(buffer);
  return parts.join('\n\n');
}

function listOf(list, depth = 0) {
  const ordered = list.tagName === 'OL';
  const pad = '  '.repeat(depth);
  let n = 1;
  const lines = [];
  [...list.children].forEach((li) => {
    if (li.tagName !== 'LI') return;
    const marker = ordered ? `${n} . `.replace(' . ', '. ') : '- ';
    if (ordered) n += 1;
    const check = li.dataset.check;
    const box = check === undefined ? '' : (check === '1' ? '[x] ' : '[ ] ');
    lines.push(`${pad}${marker}${box}${inlineOf(li).replace(/\n/g, ' ')}`);
    [...li.children].forEach((child) => {
      if (child.tagName === 'UL' || child.tagName === 'OL') lines.push(listOf(child, depth + 1));
    });
  });
  return lines.join('\n');
}

function tableOfDom(table) {
  const rowOf = (tr) => [...tr.children].map((cell) => inlineOf(cell, { inTable: true }).replace(/\n/g, ' ').trim());
  const headRow = table.querySelector('thead tr');
  const head = headRow ? rowOf(headRow) : [];
  const align = headRow ? [...headRow.children].map((c) => c.dataset.align || null) : [];
  const bar = (a) => (a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---');
  const body = [...table.querySelectorAll('tbody tr')].map((tr) => rowOf(tr));
  const width = Math.max(head.length, ...body.map((r) => r.length), 1);
  const pad = (arr) => Array.from({ length: width }, (_, i) => arr[i] ?? '');
  const line = (cells) => `| ${pad(cells).join(' | ')} |`;
  return [line(head), `| ${pad(align).map(bar).join(' | ')} |`, ...body.map(line)].join('\n');
}

function blockOf(el) {
  const tag = el.tagName;
  // 表は入れ物（div）に入れてあるので、ふつうの段落より先に見る
  if (el.classList?.contains('rt__table')) {
    const table = el.querySelector('table');
    return table ? tableOfDom(table) : '';
  }
  if (/^H[1-6]$/.test(tag)) {
    const level = Number(tag[1]);
    return `${'#'.repeat(level)} ${inlineOf(el).replace(/\n/g, ' ')}`;
  }
  if (tag === 'P' || tag === 'DIV') {
    const text = inlineOf(el);
    return text.replace(/ /g, ' ');
  }
  if (tag === 'UL' || tag === 'OL') return listOf(el);
  if (tag === 'BLOCKQUOTE') {
    const inner = innerBlocks(el);
    return inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
  }
  if (tag === 'PRE') {
    const lang = el.dataset.lang || '';
    return `\`\`\`${lang}\n${el.textContent.replace(/\n$/, '')}\n\`\`\``;
  }
  if (tag === 'HR') return '---';
  if (tag === 'TABLE') return tableOfDom(el);
  return inlineOf(el);
}

/** 編集している中身を、素の Markdown に戻す */
export function domToMarkdown(root) {
  const parts = [];
  root.childNodes.forEach((node) => {
    if (node.nodeType === 3) {
      const text = node.nodeValue.trim();
      if (text) parts.push(escapeText(node.nodeValue));
      return;
    }
    if (node.nodeType !== 1) return;
    const md = blockOf(node);
    parts.push(md === null ? '' : md);
  });
  return parts.join('\n\n')
    // 空の段落は「空行」として残す（書いた形をそのままに）
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/[ \t]+$/gm, '');
}

/* ------------------------------------------------------------------ */
/* 編集面                                                              */
/* ------------------------------------------------------------------ */

const exec = (name, value = null) => {
  try { return document.execCommand(name, false, value); } catch { return false; }
};

/** いまカーソルがいる、いちばん外側のかたまり */
function currentBlock(root) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let node = sel.getRangeAt(0).startContainer;
  if (node === root) return root.childNodes[Math.min(sel.getRangeAt(0).startOffset, root.childNodes.length - 1)] || null;
  while (node && node.parentNode !== root) node = node.parentNode;
  return node;
}

/** カーソルのある行（li / p / 見出しなど、いちばん近いもの） */
function currentLine(root) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let node = sel.getRangeAt(0).startContainer;
  if (node.nodeType === 3) node = node.parentNode;
  while (node && node !== root && !/^(P|LI|H[1-6]|PRE|TD|TH|BLOCKQUOTE|DIV)$/.test(node.tagName)) node = node.parentNode;
  return node === root ? null : node;
}

function caretAtStart(el) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(el);
  range.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  return range.toString().replace(/​/g, '').length === 0;
}

function placeCaret(node, offset = 0) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  try {
    range.setStart(node, offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch { /* 置けないときは、そのまま */ }
}

/** その行の先頭にカーソルを置く */
function caretToStart(el) {
  const first = el.firstChild;
  if (first && first.nodeType === 3) placeCaret(first, 0);
  else placeCaret(el, 0);
}

/** 打った形から書式へ（「- 」で箇条書き、「# 」で見出し…） */
const INPUT_RULES = [
  { re: /^(#{1,3})\s$/, run: (m) => exec('formatBlock', `h${m[1].length}`) },
  { re: /^[-*+]\s$/, run: () => exec('insertUnorderedList') },
  { re: /^\d{1,3}[.)]\s$/, run: () => exec('insertOrderedList') },
  { re: /^>\s$/, run: () => exec('formatBlock', 'blockquote') },
];

export function createRichEditor({ onChange, onSelectionChange } = {}) {
  const element = h('div', {
    class: 'rt',
    contenteditable: 'true',
    spellcheck: 'false',
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-label': '本文',
  });

  let composing = false;
  let silent = false;   // load 中など、変更を知らせたくないとき

  const emit = () => {
    if (silent || composing) return;
    normalize();
    onChange?.(domToMarkdown(element));
  };

  /**
   * ブラウザの編集が残す、ちぐはぐな形を整える。
   *
   * 空の段落の中で箇条書きにすると <p><ul>…</ul></p> のような形になり、
   * そのままでは中身が読み取れない。移すだけなので、カーソルは外れない。
   */
  function normalize() {
    const nestedLists = [...element.querySelectorAll('p > ul, p > ol')];
    const strayBoxes = [...element.querySelectorAll('.rt__box')].filter((b) => !b.closest('li'));
    const bareText = [...element.childNodes].filter((n) => n.nodeType === 3 && n.nodeValue.trim());
    if (!nestedLists.length && !strayBoxes.length && !bareText.length && element.childNodes.length) return;

    // 形を直すあいだ、カーソルの居場所を覚えておく（文字を動かすだけなので戻せる）
    const sel = window.getSelection();
    const saved = sel && sel.rangeCount && element.contains(sel.getRangeAt(0).startContainer)
      ? { node: sel.getRangeAt(0).startContainer, offset: sel.getRangeAt(0).startOffset }
      : null;

    nestedLists.forEach((list) => {
      const p = list.parentElement;
      const hasOther = [...p.childNodes].some((n) => n !== list
        && !(n.nodeType === 1 && n.tagName === 'BR')
        && (n.nodeType !== 3 || n.nodeValue.trim()));
      if (hasOther) p.after(list);
      else p.replaceWith(list);
    });
    // 行から外れたチェックの印は、ただの文字になってしまうので片づける
    strayBoxes.forEach((box) => box.remove());
    // むき出しの文字は段落に入れる
    bareText.forEach((node) => {
      const p = h('p', {});
      node.replaceWith(p);
      p.appendChild(node);
    });
    if (!element.childNodes.length) element.appendChild(emptyParagraph());

    if (saved && saved.node.isConnected) placeCaret(saved.node, saved.offset);
  }

  /* ------------------------------------------------------ 打ち込み */

  element.addEventListener('compositionstart', () => { composing = true; });
  element.addEventListener('compositionend', () => { composing = false; emit(); });

  element.addEventListener('input', () => {
    if (composing) return;
    applyInputRules();
    emit();
  });

  element.addEventListener('keydown', (e) => {
    // 変換中は、こちらの決まりごとを差し込まない
    if (e.isComposing || composing) return;
    const line = currentLine(element);

    // コードの中の Enter は、ただの改行
    if (e.key === 'Enter' && line?.closest?.('pre')) {
      e.preventDefault();
      exec('insertText', '\n');
      emit();
      return;
    }
    // 表の中の Enter は、次のマスへ
    if (e.key === 'Enter' && (line?.tagName === 'TD' || line?.tagName === 'TH')) {
      e.preventDefault();
      moveCell(line, e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === 'Tab' && (line?.tagName === 'TD' || line?.tagName === 'TH')) {
      e.preventDefault();
      moveCell(line, e.shiftKey ? -1 : 1);
      return;
    }
    // 引用の中の空行で Enter → 引用から抜ける
    if (e.key === 'Enter' && line?.closest?.('blockquote') && !line.textContent.trim()) {
      e.preventDefault();
      exec('outdent');
      if (currentLine(element)?.closest?.('blockquote')) exec('formatBlock', 'p');
      emit();
      return;
    }
    // 空のリスト項目で Enter → ふつうの段落に戻す
    if (e.key === 'Enter' && line?.tagName === 'LI' && !line.textContent.trim()) {
      e.preventDefault();
      exec('outdent');
      if (currentLine(element)?.tagName === 'LI') exec('formatBlock', 'p');
      emit();
      return;
    }
    // チェック項目の頭で Backspace → チェックだけ外す
    if (e.key === 'Backspace' && line?.tagName === 'LI' && line.dataset.check !== undefined && caretAtStart(line)) {
      e.preventDefault();
      setCheck(line, null);
      emit();
    }
  });

  // 貼り付けは、書式を持ち込まずに文字だけ
  element.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain');
    if (text === undefined || text === null) return;
    e.preventDefault();
    exec('insertText', text);
    emit();
  });

  // チェックは押すだけで入る／外れる
  element.addEventListener('click', (e) => {
    const box = e.target.closest?.('.rt__box');
    if (!box) return;
    e.preventDefault();
    const li = box.closest('li');
    if (!li) return;
    setCheck(li, li.dataset.check !== '1');
    emit();
  });

  document.addEventListener('selectionchange', () => {
    if (!element.contains(window.getSelection()?.anchorNode || null)) return;
    onSelectionChange?.(state());
  });

  /* -------------------------------------------------------- 決まりごと */

  /**
   * 行の頭に打った記号を消す。
   * textContent を空にすると打っている場所が分からなくなるので、
   * 「行の頭からカーソルまで」を選んで消す（元に戻すにも載る）。
   */
  function dropPrefix(line) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const caret = sel.getRangeAt(0);
    const range = document.createRange();
    range.selectNodeContents(line);
    try {
      range.setEnd(caret.startContainer, caret.startOffset);
    } catch {
      return false;
    }
    sel.removeAllRanges();
    sel.addRange(range);
    exec('delete');
    return true;
  }

  function applyInputRules() {
    const line = currentLine(element);
    if (!line || line.closest('pre') || line.tagName === 'TD' || line.tagName === 'TH') return;
    const text = line.textContent || '';

    // チェック（「[] 」「[ ] 」「[x] 」）
    if (line.tagName === 'LI' && line.dataset.check === undefined) {
      const m = /^\[( |x|X)?\]\s$/.exec(text);
      if (m && dropPrefix(line)) {
        setCheck(line, (m[1] || '').toLowerCase() === 'x', { moveCaret: true });
        return;
      }
    }
    if (line.tagName !== 'P' && line.tagName !== 'LI' && !/^H[1-6]$/.test(line.tagName)) return;
    for (const rule of INPUT_RULES) {
      const m = rule.re.exec(text);
      if (!m) continue;
      // 打った記号は消してから、書式にする
      if (!dropPrefix(line)) return;
      rule.run(m);
      return;
    }
    // 「```」でコードのかたまり
    if (line.tagName === 'P' && /^```$/.test(text.trim())) {
      if (dropPrefix(line)) exec('formatBlock', 'pre');
    }
  }

  function setCheck(li, checked, { moveCaret = false } = {}) {
    const box = li.querySelector(':scope > .rt__box');
    if (checked === null) {
      delete li.dataset.check;
      box?.remove();
      return;
    }
    li.dataset.check = checked ? '1' : '0';
    const fresh = checkBox(checked);
    // 印の差し替えは、そのまま置き換える。
    // （execCommand を通すと印が「ただの文字」に化けることがあるため。
    //   押し直せば元に戻るので、履歴に載らなくても困らない）
    if (box) box.replaceWith(fresh);
    else li.insertBefore(fresh, li.firstChild);
    // 印のうしろから書き始められるようにする
    if (moveCaret) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStartAfter(fresh);
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }

  function moveCell(cell, dir) {
    const row = cell.parentElement;
    const cells = [...row.children];
    const at = cells.indexOf(cell);
    const nextInRow = cells[at + dir];
    if (nextInRow) { caretToStart(nextInRow); return; }
    const table = cell.closest('table');
    const rows = [...table.querySelectorAll('tr')];
    const rowAt = rows.indexOf(row);
    const nextRow = rows[rowAt + dir];
    if (nextRow) {
      const target = dir > 0 ? nextRow.children[0] : nextRow.children[nextRow.children.length - 1];
      caretToStart(target);
      return;
    }
    // いちばん最後のマスで進んだら、行を足す
    if (dir > 0) { addTableRow(table); }
  }

  /* -------------------------------------------------------- 差し込み */

  /**
   * かたまり（表・コード・区切り線）を、いまいる段落の次に置く。
   *
   * リストや表の中で insertHTML すると形が崩れるので、
   * いちばん外側のかたまりの隣に入れて、そこへカーソルを移す。
   */
  function insertBlocks(nodes, { caretIn } = {}) {
    const block = currentBlock(element);
    const frag = document.createDocumentFragment();
    nodes.forEach((n) => frag.appendChild(n));
    const first = nodes[0];
    if (block && block.parentElement === element) block.after(frag);
    else element.appendChild(frag);
    // もともと空の段落にいたなら、それは要らない
    if (block && block.tagName === 'P' && !block.textContent.trim()) block.remove();
    const target = caretIn ? first.querySelector(caretIn) : null;
    caretToStart(target || nodes[nodes.length - 1]);
    emit();
  }

  function addTableRow(table) {
    const body = table.querySelector('tbody');
    const width = table.querySelector('tr')?.children.length || 2;
    const tr = h('tr', {});
    for (let i = 0; i < width; i += 1) tr.appendChild(h('td', {}, h('br', {})));
    body.appendChild(tr);
    caretToStart(tr.children[0]);
    emit();
  }

  /* ------------------------------------------------------------ 状態 */

  function state() {
    const line = currentLine(element);
    return {
      bold: document.queryCommandState?.('bold') || false,
      italic: document.queryCommandState?.('italic') || false,
      block: line ? line.tagName.toLowerCase() : 'p',
      inList: Boolean(line?.closest?.('ul, ol')),
      inTable: Boolean(line?.closest?.('table')),
      inCode: Boolean(line?.closest?.('pre')),
    };
  }

  /* -------------------------------------------------------- 外向きの技 */

  /** 書式のボタンを押したとき、カーソルが編集面にあることを確かめる */
  function ensureFocus() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && element.contains(sel.anchorNode)) return;
    element.focus({ preventScroll: true });
    const last = element.lastElementChild;
    if (last) {
      const range = document.createRange();
      range.selectNodeContents(last);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }

  const rawCommands = {
    bold: () => { exec('bold'); emit(); },
    italic: () => { exec('italic'); emit(); },
    strike: () => { exec('strikeThrough'); emit(); },
    code: () => { wrapInline('code'); },
    heading: (level = 2) => {
      const line = currentLine(element);
      const now = line?.tagName?.toLowerCase();
      exec('formatBlock', now === `h${level}` ? 'p' : `h${level}`);
      emit();
    },
    bullet: () => { exec('insertUnorderedList'); emit(); },
    ordered: () => { exec('insertOrderedList'); emit(); },
    check: () => {
      let li = currentLine(element)?.closest?.('li');
      if (!li) {
        exec('insertUnorderedList');
        normalize();
        // 作り直しでカーソルの持ち主が変わることがあるので、いまいる場所から探し直す
        const block = currentBlock(element);
        li = block?.tagName === 'LI' ? block : (block?.querySelector?.('li') || null);
      }
      if (li) {
        const on = li.dataset.check === undefined;
        setCheck(li, on ? false : null, { moveCaret: on });
      }
      emit();
    },
    quote: () => {
      const line = currentLine(element);
      exec('formatBlock', line?.closest?.('blockquote') ? 'p' : 'blockquote');
      emit();
    },
    codeBlock: () => insertBlocks([h('pre', {}, h('code', {}, '')), emptyParagraph()], { caretIn: 'code' }),
    rule: () => insertBlocks([h('hr', {}), emptyParagraph()]),
    table: () => {
      const row = (tag, cells) => h('tr', {}, ...cells.map((c) => h(tag, {}, c ? document.createTextNode(c) : h('br', {}))));
      const table = h('table', {},
        h('thead', {}, row('th', ['見出し', '見出し'])),
        h('tbody', {}, row('td', ['', '']), row('td', ['', ''])));
      insertBlocks([h('div', { class: 'rt__table' }, table), emptyParagraph()], { caretIn: 'th' });
    },
    link: (href, label) => {
      const url = safeUrl(href);
      if (!url) return;
      const sel = window.getSelection();
      const text = sel && !sel.isCollapsed ? sel.toString() : (label || url);
      exec('insertHTML', `<a href="${url}" rel="noopener noreferrer">${text.replace(/[<>&]/g, '')}</a>`);
      emit();
    },
    addRow: () => { const t = currentLine(element)?.closest?.('table'); if (t) addTableRow(t); },
    addColumn: () => {
      const cell = currentLine(element);
      const table = cell?.closest?.('table');
      if (!table) return;
      const at = [...cell.parentElement.children].indexOf(cell) + 1;
      table.querySelectorAll('tr').forEach((tr) => {
        const isHead = tr.parentElement.tagName === 'THEAD';
        const fresh = h(isHead ? 'th' : 'td', {}, h('br', {}));
        const ref = tr.children[at];
        if (ref) tr.insertBefore(fresh, ref); else tr.appendChild(fresh);
      });
      emit();
    },
    removeRow: () => {
      const cell = currentLine(element);
      const tr = cell?.closest?.('tr');
      if (!tr || tr.parentElement.tagName === 'THEAD') return;
      const table = tr.closest('table');
      tr.remove();
      caretToStart(table.querySelector('tbody tr td') || table.querySelector('th'));
      emit();
    },
    removeColumn: () => {
      const cell = currentLine(element);
      const table = cell?.closest?.('table');
      if (!table) return;
      const at = [...cell.parentElement.children].indexOf(cell);
      if ((table.querySelector('tr')?.children.length || 0) <= 1) return;
      table.querySelectorAll('tr').forEach((tr) => tr.children[at]?.remove());
      emit();
    },
    undo: () => { exec('undo'); emit(); },
    redo: () => { exec('redo'); emit(); },
  };

  // どの技も、まずカーソルを編集面に戻してから動かす
  const commands = Object.fromEntries(Object.entries(rawCommands).map(([name, fn]) => [
    name,
    (...args) => { ensureFocus(); return fn(...args); },
  ]));

  function wrapInline(tag) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString();
    const inside = sel.anchorNode?.parentElement?.closest?.(tag);
    if (inside) {
      // すでにその書式なら外す
      inside.replaceWith(document.createTextNode(inside.textContent));
    } else {
      exec('insertHTML', `<${tag}>${text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</${tag}>`);
    }
    emit();
  }

  return {
    element,
    commands,
    state,
    /** 別のメモを開くときなど、中身を丸ごと入れ替える */
    load(markdown) {
      silent = true;
      element.innerHTML = '';
      element.appendChild(markdownToDom(markdown));
      silent = false;
    },
    /** いまの中身を Markdown で受け取る */
    value: () => domToMarkdown(element),
    focus({ toEnd = false } = {}) {
      element.focus({ preventScroll: true });
      const target = toEnd ? element.lastElementChild : element.firstElementChild;
      if (target) caretToStart(target);
    },
    isComposing: () => composing,
  };
}
