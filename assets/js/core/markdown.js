/**
 * ごく小さな Markdown の読み取り。
 *
 * ここでは「文字列 → 構造」までを担当し、画面に出す形（DOM）にするのは
 * ui/markdownView.js の仕事。分けてあるので、ここは DOM 無しで試せる。
 *
 * 対応するのはメモでよく使うものだけ:
 *   見出し / 箇条書き（入れ子・チェックボックス）/ 番号つき / 引用 /
 *   コード（``` と `…`）/ 区切り線 / 表 / 太字・斜体・打ち消し / リンク
 *
 * 書いた人を驚かせないための方針:
 * - 1 行の改行はそのまま改行として扱う（メモ帳の感覚に合わせる）
 * - 分からない書き方は、記号もろとも「ただの文字」として出す
 * - リンクは http / https / mailto だけ。それ以外はただの文字にする
 */

const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE = /^\s{0,3}(```|~~~)(.*)$/;
const TABLE_SPLIT = /^\s{0,3}\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
const CHECK = /^\[( |x|X)\]\s+(.*)$/;

/** 安全に開けるリンクだけを通す */
export function safeUrl(href) {
  const url = String(href || '').trim();
  if (/^(https?:|mailto:)/i.test(url)) return url;
  // 「//example.com」や「javascript:」などは開かない
  return null;
}

/* ------------------------------------------------------------------ */
/* 行の中身（太字・リンクなど）                                        */
/* ------------------------------------------------------------------ */

const INLINE_RULES = [
  { type: 'code', re: /`([^`\n]+)`/ },
  { type: 'strong', re: /\*\*([^\n]+?)\*\*/ },
  { type: 'strong', re: /__([^\n]+?)__/ },
  { type: 'del', re: /~~([^\n]+?)~~/ },
  { type: 'em', re: /\*([^*\n]+?)\*/ },
  { type: 'em', re: /(?<![A-Za-z0-9])_([^_\n]+?)_(?![A-Za-z0-9])/ },
  { type: 'link', re: /\[([^\]\n]*)\]\(([^)\s]+)\)/ },
  { type: 'autolink', re: /https?:\/\/[^\s<>"'）】」]+/ },
];

/** 続いた文字は 1 つにまとめる（分かれていても意味は同じなので、読みやすくする） */
function mergeText(nodes) {
  const out = [];
  nodes.forEach((node) => {
    const last = out[out.length - 1];
    if (node.type === 'text' && last?.type === 'text') last.text += node.text;
    else out.push(node);
  });
  return out;
}

/** 1 行ぶんの中身を、文字・強調・リンクに分ける */
export function parseInline(text) {
  return mergeText(scanInline(text));
}

function scanInline(text) {
  const src = String(text ?? '');
  if (!src) return [];
  let best = null;
  INLINE_RULES.forEach((rule) => {
    const m = rule.re.exec(src);
    if (!m) return;
    if (!best || m.index < best.match.index) best = { rule, match: m };
  });
  if (!best) return [{ type: 'text', text: src }];

  const { rule, match } = best;
  const before = src.slice(0, match.index);
  const after = src.slice(match.index + match[0].length);
  const head = before ? scanInline(before) : [];
  const tail = after ? scanInline(after) : [];

  if (rule.type === 'code') {
    return [...head, { type: 'code', text: match[1] }, ...tail];
  }
  if (rule.type === 'link' || rule.type === 'autolink') {
    const href = safeUrl(rule.type === 'link' ? match[2] : match[0]);
    // 開けないリンクは、書いたとおりの文字として残す
    if (!href) return [...head, { type: 'text', text: match[0] }, ...tail];
    const label = rule.type === 'link' ? (match[1] || href) : match[0];
    return [...head, { type: 'link', href, children: [{ type: 'text', text: label }] }, ...tail];
  }
  return [...head, { type: rule.type, children: parseInline(match[1]) }, ...tail];
}

/* ------------------------------------------------------------------ */
/* 段落・箇条書きなど                                                  */
/* ------------------------------------------------------------------ */

function listItemsFrom(lines, start) {
  const items = [];
  let i = start;
  const first = LIST.exec(lines[i]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);

  while (i < lines.length) {
    const m = LIST.exec(lines[i]);
    if (!m) break;
    const indent = m[1].length;
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      // 入れ子。ぶら下げる先が無ければ、自分の並びとして扱う
      const nested = listItemsFrom(lines, i);
      const parent = items[items.length - 1];
      if (parent) parent.children = [...(parent.children || []), nested.list];
      else items.push({ inline: [], children: [nested.list] });
      i = nested.next;
      continue;
    }
    if (/\d/.test(m[2]) !== ordered) break;   // 記号が変わったら別の並び
    let content = m[3];
    let checked = null;
    const check = CHECK.exec(content);
    if (check) {
      checked = check[1].toLowerCase() === 'x';
      content = check[2];
    }
    items.push({ inline: parseInline(content), checked, children: [] });
    i += 1;
  }
  return { list: { type: 'list', ordered, items }, next: i };
}

/** Markdown を、画面に出せる構造にする */
export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  let paragraph = null;

  const flush = () => {
    if (paragraph && paragraph.length) blocks.push({ type: 'paragraph', lines: paragraph });
    paragraph = null;
  };

  while (i < lines.length) {
    const line = lines[i];

    // 空行は段落の区切り
    if (!line.trim()) { flush(); i += 1; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const mark = fence[1];
      const lang = fence[2].trim();
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith(mark)) { body.push(lines[i]); i += 1; }
      i += 1;   // 閉じるしるしを読み飛ばす
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }

    if (RULE.test(line)) { flush(); blocks.push({ type: 'rule' }); i += 1; continue; }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: 'heading', level: heading[1].length, inline: parseInline(heading[2]) });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      flush();
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) { inner.push(QUOTE.exec(lines[i])[1]); i += 1; }
      blocks.push({ type: 'quote', blocks: parseMarkdown(inner.join('\n')) });
      continue;
    }

    if (LIST.test(line)) {
      flush();
      const { list, next } = listItemsFrom(lines, i);
      blocks.push(list);
      i = next;
      continue;
    }

    // 表（2 行目が区切りのときだけ）
    if (line.includes('|') && i + 1 < lines.length && TABLE_SPLIT.test(lines[i + 1]) && lines[i + 1].includes('|')) {
      flush();
      const cells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const head = cells(line).map(parseInline);
      const align = cells(lines[i + 1]).map((c) => {
        if (/^:.*:$/.test(c)) return 'center';
        if (/:$/.test(c)) return 'right';
        return null;
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(cells(lines[i]).map(parseInline));
        i += 1;
      }
      blocks.push({ type: 'table', head, align, rows });
      continue;
    }

    // ふつうの行。続くぶんは 1 つの段落にまとめる（改行はそのまま残す）
    if (!paragraph) paragraph = [];
    paragraph.push(parseInline(line));
    i += 1;
  }
  flush();
  return blocks;
}

/* ------------------------------------------------------------------ */
/* 一覧のプレビュー用                                                  */
/* ------------------------------------------------------------------ */

/** 記号を外して、ただの文にする（カードの抜粋などで使う） */
export function markdownToPlain(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^(\s*)([-*+]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?/gm, '$1')
    .replace(/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/gm, '')
    .replace(/!?\[([^\]\n]*)\]\(([^)\s]+)\)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^\n]+?)\*\*/g, '$1')
    .replace(/__([^\n]+?)__/g, '$1')
    .replace(/~~([^\n]+?)~~/g, '$1')
    .replace(/\*([^*\n]+?)\*/g, '$1');
}

/** Markdown らしい書き方が含まれているか（表示の切り替えの目安） */
export function looksLikeMarkdown(text) {
  const src = String(text ?? '');
  return /^\s{0,3}#{1,6}\s+/m.test(src)
    || /^(\s*)([-*+]|\d{1,9}[.)])\s+/m.test(src)
    || /^\s{0,3}>\s?/m.test(src)
    || /```/.test(src)
    || /\*\*[^\n*]+\*\*/.test(src)
    || /\[[^\]\n]*\]\([^)\s]+\)/.test(src);
}
