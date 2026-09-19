/**
 * 「見たまま」で編集するための、かたまり（ブロック）単位の書き換え。
 *
 * 本文はあくまで素の Markdown の文字列のまま持つ。
 * ここでは「何行目から何行目を、この文字列に差し替える」という形だけを扱うので、
 * 見たままの編集でも、ソースを直接いじったのと同じ結果になる。
 *
 * DOM に触れないので、ここだけで試せる。
 */
import { parseMarkdown } from './markdown.js';

const splitLines = (text) => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');

/** 本文を、元の行つきのかたまりに分ける */
export function blocksOf(text) {
  const lines = splitLines(text);
  return parseMarkdown(text).map((block, index) => ({
    ...block,
    index,
    source: lines.slice(block.start, block.end).join('\n'),
  }));
}

/**
 * 行の範囲を差し替える。
 * 空文字でも「空の 1 行」が残る（書いている途中でかたまりが消えないように）。
 * まるごと消したいときは removeBlock を使う。
 */
export function replaceLines(text, start, end, source) {
  const lines = splitLines(text);
  return [...lines.slice(0, start), ...splitLines(source), ...lines.slice(end)].join('\n');
}

/** その文字列が何行ぶんか */
export const lineCount = (source) => splitLines(source).length;

/** かたまりを書き換える */
export function replaceBlock(text, block, source) {
  return replaceLines(text, block.start, block.end, source);
}

/**
 * かたまりを消す。
 * 前後が空行だらけにならないよう、後ろに続く空行も 1 行ぶん一緒に消す。
 */
export function removeBlock(text, block) {
  const lines = splitLines(text);
  let end = block.end;
  while (end < lines.length && !lines[end].trim()) end += 1;
  // 先頭以外なら、直前の空行は残す（かたまり同士の間が詰まらないように）
  const start = block.start;
  const next = [...lines.slice(0, start), ...lines.slice(end)];
  return next.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** かたまりの後ろ（または前）に、新しいかたまりを入れる */
export function insertBlock(text, block, source, { before = false } = {}) {
  const lines = splitLines(text);
  if (!block) {
    const body = lines.join('\n').replace(/\s+$/, '');
    return body ? `${body}\n\n${source}` : source;
  }
  const at = before ? block.start : block.end;
  const piece = splitLines(source);
  const head = lines.slice(0, at);
  const tail = lines.slice(at);
  // 前後に 1 行ずつ空きを作る（Markdown はかたまりの区切りが空行なので）
  const withGapBefore = head.length && head[head.length - 1].trim() ? [...head, ''] : head;
  const withGapAfter = tail.length && tail[0].trim() ? ['', ...tail] : tail;
  return [...withGapBefore, ...piece, ...withGapAfter].join('\n');
}

/** かたまりを 1 つ上／下へ動かす */
export function moveBlock(text, blocks, index, dir) {
  const other = index + dir;
  if (other < 0 || other >= blocks.length) return text;
  const a = blocks[Math.min(index, other)];
  const b = blocks[Math.max(index, other)];
  const lines = splitLines(text);
  const between = lines.slice(a.end, b.start);
  const next = [
    ...lines.slice(0, a.start),
    ...splitLines(b.source),
    ...between,
    ...splitLines(a.source),
    ...lines.slice(b.end),
  ];
  return next.join('\n');
}

/* ------------------------------------------------------------------ */
/* チェックボックス                                                    */
/* ------------------------------------------------------------------ */

const CHECK_LINE = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+\[)( |x|X)(\]\s*)/;

/** その行のチェックを入れ替える（押しやすさのため、行だけで完結させる） */
export function toggleCheck(text, lineIndex) {
  const lines = splitLines(text);
  const line = lines[lineIndex];
  if (line === undefined) return text;
  const m = CHECK_LINE.exec(line);
  if (!m) return text;
  const filled = m[2] !== ' ';
  lines[lineIndex] = line.replace(CHECK_LINE, `$1${filled ? ' ' : 'x'}$3`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 表                                                                  */
/* ------------------------------------------------------------------ */

const splitRow = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());

/** 表のかたまりを、編集しやすい形（生の文字）にする */
export function tableOf(block) {
  const lines = splitLines(block.source);
  const head = splitRow(lines[0] || '');
  const align = splitRow(lines[1] || '').map((c) => {
    if (/^:.*:$/.test(c)) return 'center';
    if (/:$/.test(c)) return 'right';
    if (/^:/.test(c)) return 'left';
    return null;
  });
  const rows = lines.slice(2).filter((l) => l.trim()).map((l) => splitRow(l));
  const width = Math.max(head.length, ...rows.map((r) => r.length), 1);
  const pad = (arr) => Array.from({ length: width }, (_, i) => arr[i] ?? '');
  return { head: pad(head), align: pad(align), rows: rows.map(pad) };
}

/** 表を Markdown に戻す */
export function tableToMarkdown(table) {
  const bar = (a) => (a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---');
  const line = (cells) => `| ${cells.map((c) => String(c ?? '').replace(/\|/g, '\\|').trim()).join(' | ')} |`;
  return [
    line(table.head),
    `| ${table.align.map(bar).join(' | ')} |`,
    ...table.rows.map(line),
  ].join('\n');
}

/** 行を足す／消す、列を足す／消す */
export function tableWithRow(table, at = table.rows.length) {
  const rows = [...table.rows];
  rows.splice(at, 0, table.head.map(() => ''));
  return { ...table, rows };
}

export function tableWithoutRow(table, at) {
  if (!table.rows.length) return table;
  const rows = table.rows.filter((_, i) => i !== at);
  return { ...table, rows };
}

export function tableWithColumn(table, at = table.head.length) {
  const insert = (arr, value) => { const next = [...arr]; next.splice(at, 0, value); return next; };
  return {
    head: insert(table.head, ''),
    align: insert(table.align, null),
    rows: table.rows.map((r) => insert(r, '')),
  };
}

export function tableWithoutColumn(table, at) {
  if (table.head.length <= 1) return table;
  const drop = (arr) => arr.filter((_, i) => i !== at);
  return { head: drop(table.head), align: drop(table.align), rows: table.rows.map(drop) };
}

/* ------------------------------------------------------------------ */
/* 新しいかたまりのひな形                                              */
/* ------------------------------------------------------------------ */

export const BLOCK_TEMPLATES = [
  { id: 'paragraph', label: '文章', icon: 'text', source: '' },
  { id: 'heading', label: '見出し', icon: 'heading', source: '## ' },
  { id: 'bullet', label: '箇条書き', icon: 'list', source: '- ' },
  { id: 'check', label: 'チェック', icon: 'checkbox', source: '- [ ] ' },
  { id: 'table', label: '表', icon: 'layers', source: '|  |  |\n| --- | --- |\n|  |  |' },
  { id: 'quote', label: '引用', icon: 'note', source: '> ' },
  { id: 'code', label: 'コード', icon: 'data', source: '```\n\n```' },
  { id: 'rule', label: '区切り線', icon: 'filter', source: '---' },
];
