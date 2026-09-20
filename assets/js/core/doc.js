/**
 * 本文の中身（文書データ）。
 *
 * v0.12 から、本文は「文書データ」（Tiptap / ProseMirror の JSON）で持つ。
 * 記号の書き方（Markdown）に縛られないので、
 * 「2 * 3」や「C:\temp」のような、ただの文字がそのまま残る。
 *
 * ここは DOM にも編集ライブラリにも触れない純粋な部分:
 *   - 受け取った文書データを、扱ってよい形だけに整える（normalizeDoc）
 *   - 探す・数える・見出しを拾うための「ただの文字」にする（docToText）
 *   - 持ち出し用に Markdown へ書き出す（docToMarkdown）
 *   - これまでの Markdown のメモを、文書データに直す（markdownToDoc）
 */
import { parseMarkdown } from './markdown.js';

/** 置いてよいかたまり（知らないものは段落として扱う） */
const BLOCK_TYPES = new Set([
  'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem',
  'taskList', 'taskItem', 'blockquote', 'codeBlock', 'horizontalRule',
  'table', 'tableRow', 'tableHeader', 'tableCell', 'hardBreak', 'text',
]);

/** 置いてよい飾り */
const MARK_TYPES = new Set(['bold', 'italic', 'strike', 'code', 'underline', 'link']);

/** 開いてよいリンクだけを通す */
function safeHref(href) {
  const url = String(href || '').trim();
  return /^(https?:|mailto:)/i.test(url) ? url : null;
}

function normalizeMarks(marks) {
  if (!Array.isArray(marks)) return undefined;
  const out = [];
  marks.forEach((mark) => {
    if (!mark || typeof mark !== 'object') return;
    const type = String(mark.type || '');
    if (!MARK_TYPES.has(type)) return;
    if (type === 'link') {
      const href = safeHref(mark.attrs?.href);
      if (!href) return;
      out.push({ type, attrs: { href, target: '_blank', rel: 'noopener noreferrer' } });
      return;
    }
    out.push({ type });
  });
  return out.length ? out : undefined;
}

const numberAttr = (value, fallback = null) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

function normalizeNode(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '');
  if (type === 'text') {
    const text = typeof raw.text === 'string' ? raw.text : '';
    if (!text) return null;
    const marks = normalizeMarks(raw.marks);
    return marks ? { type, text, marks } : { type, text };
  }
  if (!BLOCK_TYPES.has(type)) {
    // 知らないかたまりは、中身だけ拾って段落にする（書いたものを落とさない）
    const content = normalizeContent(raw.content);
    return content.length ? { type: 'paragraph', content } : null;
  }

  const node = { type };
  const attrs = raw.attrs && typeof raw.attrs === 'object' ? raw.attrs : {};
  if (type === 'heading') {
    node.attrs = { level: Math.min(6, Math.max(1, numberAttr(attrs.level, 1) || 1)) };
  } else if (type === 'orderedList') {
    node.attrs = { start: Math.max(1, numberAttr(attrs.start, 1) || 1) };
  } else if (type === 'taskList') {
    // 済みに取り消し線を引くかどうか（リストごとに選べる）
    node.attrs = { strike: attrs.strike !== false };
  } else if (type === 'taskItem') {
    node.attrs = { checked: attrs.checked === true };
  } else if (type === 'codeBlock') {
    node.attrs = { language: typeof attrs.language === 'string' ? attrs.language : null };
  } else if (type === 'tableHeader' || type === 'tableCell') {
    node.attrs = {
      colspan: Math.max(1, numberAttr(attrs.colspan, 1) || 1),
      rowspan: Math.max(1, numberAttr(attrs.rowspan, 1) || 1),
      colwidth: Array.isArray(attrs.colwidth) ? attrs.colwidth.map((n) => numberAttr(n, null)) : null,
    };
  }
  const content = normalizeContent(raw.content);
  if (content.length) node.content = content;
  return node;
}

function normalizeContent(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeNode).filter(Boolean);
}

/** 保存されていた文書データを、扱ってよい形に整える */
export function normalizeDoc(raw) {
  if (!raw || typeof raw !== 'object' || raw.type !== 'doc') return null;
  const content = normalizeContent(raw.content);
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

/** 何も書かれていないか */
export function isEmptyDoc(doc) {
  return !doc || !docToText(doc).trim();
}

/* ------------------------------------------------------------------ */
/* ただの文字にする                                                    */
/* ------------------------------------------------------------------ */

/**
 * 探す・数える・抜粋するための「ただの文字」。
 * かたまりごとに改行で区切る（行数や抜粋が自然になるように）。
 */
function nodeText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'horizontalRule') return '';
  const kids = (node.content || []).map(nodeText);
  switch (node.type) {
    case 'paragraph':
    case 'heading':
    case 'codeBlock':
      return kids.join('');
    case 'tableHeader':
    case 'tableCell':
      return kids.join(' ');
    case 'tableRow':
      return kids.join('\t');
    default:
      // 箇条書き・引用・表などは、中のかたまりごとに行を分ける
      return kids.join('\n');
  }
}

export function docToText(doc) {
  return (doc?.content || [])
    .map(nodeText)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ */
/* Markdown へ書き出す（持ち出し用）                                   */
/* ------------------------------------------------------------------ */

function inlineToMarkdown(nodes = []) {
  return nodes.map((node) => {
    if (node.type === 'hardBreak') return '\n';
    if (node.type !== 'text') return inlineToMarkdown(node.content);
    let text = node.text || '';
    const marks = node.marks || [];
    const has = (type) => marks.some((m) => m.type === type);
    if (has('code')) return `\`${text}\``;
    if (has('bold')) text = `**${text}**`;
    if (has('italic')) text = `*${text}*`;
    if (has('strike')) text = `~~${text}~~`;
    const link = marks.find((m) => m.type === 'link');
    if (link) text = `[${text}](${link.attrs.href})`;
    return text;
  }).join('');
}

function cellText(cell) {
  return (cell.content || []).map((n) => inlineToMarkdown(n.content)).join(' ').replace(/\|/g, '\\|').trim();
}

function listToMarkdown(node, depth) {
  const pad = '  '.repeat(depth);
  const ordered = node.type === 'orderedList';
  let n = Math.max(1, node.attrs?.start || 1);
  return (node.content || []).map((item) => {
    const isTask = item.type === 'taskItem';
    const marker = ordered ? `${n++}. ` : '- ';
    const box = isTask ? (item.attrs?.checked ? '[x] ' : '[ ] ') : '';
    const parts = [];
    let first = true;
    (item.content || []).forEach((child) => {
      if (child.type === 'bulletList' || child.type === 'orderedList' || child.type === 'taskList') {
        parts.push(listToMarkdown(child, depth + 1));
        return;
      }
      const text = blockToMarkdown(child, depth);
      if (first) { parts.unshift(`${pad}${marker}${box}${text}`); first = false; }
      else parts.push(`${pad}  ${text}`);
    });
    if (first) parts.unshift(`${pad}${marker}${box}`);
    return parts.join('\n');
  }).join('\n');
}

function blockToMarkdown(node, depth = 0) {
  switch (node.type) {
    case 'heading':
      return `${'#'.repeat(node.attrs?.level || 1)} ${inlineToMarkdown(node.content)}`;
    case 'paragraph':
      return inlineToMarkdown(node.content);
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return listToMarkdown(node, depth);
    case 'blockquote':
      return (node.content || []).map((c) => blockToMarkdown(c, depth)).join('\n\n')
        .split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
    case 'codeBlock':
      return `\`\`\`${node.attrs?.language || ''}\n${(node.content || []).map((c) => c.text || '').join('')}\n\`\`\``;
    case 'horizontalRule':
      return '---';
    case 'table': {
      const rows = (node.content || []).map((row) => (row.content || []).map(cellText));
      if (!rows.length) return '';
      const width = Math.max(...rows.map((r) => r.length), 1);
      const pad = (r) => Array.from({ length: width }, (_, i) => r[i] ?? '');
      const [head, ...body] = rows;
      return [
        `| ${pad(head).join(' | ')} |`,
        `| ${pad([]).map(() => '---').join(' | ')} |`,
        ...body.map((r) => `| ${pad(r).join(' | ')} |`),
      ].join('\n');
    }
    default:
      return inlineToMarkdown(node.content);
  }
}

/** 持ち出し用の Markdown（読み書きは文書データのまま） */
export function docToMarkdown(doc) {
  return (doc?.content || []).map((node) => blockToMarkdown(node)).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ------------------------------------------------------------------ */
/* これまでの Markdown を、文書データに直す                            */
/* ------------------------------------------------------------------ */

function inlineToDoc(nodes = []) {
  const out = [];
  const walk = (list, marks) => {
    list.forEach((node) => {
      if (node.type === 'text') {
        // 改行は、同じ段落の中の改行として扱う
        String(node.text).split('\n').forEach((piece, i) => {
          if (i) out.push({ type: 'hardBreak' });
          if (piece) out.push(marks.length ? { type: 'text', text: piece, marks: [...marks] } : { type: 'text', text: piece });
        });
        return;
      }
      if (node.type === 'code') {
        out.push({ type: 'text', text: node.text, marks: [...marks, { type: 'code' }] });
        return;
      }
      if (node.type === 'link') {
        const href = safeHref(node.href);
        walk(node.children || [], href
          ? [...marks, { type: 'link', attrs: { href, target: '_blank', rel: 'noopener noreferrer' } }]
          : marks);
        return;
      }
      const map = { strong: 'bold', em: 'italic', del: 'strike' };
      const mark = map[node.type];
      walk(node.children || [], mark ? [...marks, { type: mark }] : marks);
    });
  };
  walk(nodes, []);
  return out;
}

function listBlockToDoc(block) {
  const isTask = block.items.some((item) => item.checked === true || item.checked === false);
  const itemType = isTask ? 'taskItem' : 'listItem';
  const listType = isTask ? 'taskList' : (block.ordered ? 'orderedList' : 'bulletList');
  const content = block.items.map((item) => {
    const node = { type: itemType };
    if (isTask) node.attrs = { checked: item.checked === true };
    const inner = [{ type: 'paragraph', content: inlineToDoc(item.inline || []) }];
    (item.children || []).forEach((child) => inner.push(listBlockToDoc(child)));
    node.content = inner;
    return node;
  });
  const list = { type: listType, content };
  if (listType === 'orderedList') list.attrs = { start: 1 };
  return list;
}

function blockToDoc(block) {
  switch (block.type) {
    case 'heading':
      return { type: 'heading', attrs: { level: Math.min(6, block.level) }, content: inlineToDoc(block.inline) };
    case 'paragraph': {
      const content = [];
      block.lines.forEach((line, i) => {
        if (i) content.push({ type: 'hardBreak' });
        content.push(...inlineToDoc(line));
      });
      return { type: 'paragraph', content };
    }
    case 'list':
      return listBlockToDoc(block);
    case 'quote':
      return { type: 'blockquote', content: block.blocks.map(blockToDoc).filter(Boolean) };
    case 'code':
      return {
        type: 'codeBlock',
        attrs: { language: block.lang || null },
        content: block.text ? [{ type: 'text', text: block.text }] : [],
      };
    case 'rule':
      return { type: 'horizontalRule' };
    case 'table': {
      const rows = [];
      rows.push({
        type: 'tableRow',
        content: block.head.map((cell) => ({
          type: 'tableHeader',
          attrs: { colspan: 1, rowspan: 1, colwidth: null },
          content: [{ type: 'paragraph', content: inlineToDoc(cell) }],
        })),
      });
      block.rows.forEach((row) => {
        rows.push({
          type: 'tableRow',
          content: row.map((cell) => ({
            type: 'tableCell',
            attrs: { colspan: 1, rowspan: 1, colwidth: null },
            content: [{ type: 'paragraph', content: inlineToDoc(cell) }],
          })),
        });
      });
      return { type: 'table', content: rows };
    }
    default:
      return null;
  }
}

/**
 * これまでの Markdown の本文を、文書データに直す。
 *
 * 空行の扱いだけ、ひとこと。
 * 段落と段落のあいだの空行は「書いた空行」なので、空の段落として残す。
 * 見出しやリストのあいだの空行は、Markdown の書き方の決まり（区切り）なので
 * 残さない。残すと、開くたびに行が増えていくように見えてしまう。
 * どちらの場合も、2 つ以上続いた空行はそのぶんだけ残す。
 */
export function markdownToDoc(markdown) {
  const blocks = parseMarkdown(markdown);
  const content = [];
  let prev = null;
  blocks.forEach((block) => {
    if (prev) {
      const gap = Math.max(0, block.start - prev.end);
      const bothText = prev.type === 'paragraph' && block.type === 'paragraph';
      const blanks = bothText ? gap : gap - 1;
      for (let i = 0; i < blanks; i += 1) content.push({ type: 'paragraph' });
    }
    const node = blockToDoc(block);
    if (node) content.push(node);
    prev = block;
  });
  if (!content.length) content.push({ type: 'paragraph' });
  return { type: 'doc', content };
}

/**
 * ただの文字を、そのまま文書データにする。
 * 記号は読み取らない（「2 * 3」がそのまま残る）。
 * 書く道具が読み込めなかったときの受け皿としても使う。
 */
export function textToDoc(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const content = lines.map((line) => (
    line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }
  ));
  if (!content.length) content.push({ type: 'paragraph' });
  return { type: 'doc', content };
}

/** 文書データの見出し（メモ内の移動に使う） */
export function docHeadings(doc) {
  const out = [];
  (doc?.content || []).forEach((node, index) => {
    if (node.type !== 'heading') return;
    out.push({
      index,
      level: node.attrs?.level || 1,
      text: docToText({ type: 'doc', content: [node] }),
    });
  });
  return out;
}
