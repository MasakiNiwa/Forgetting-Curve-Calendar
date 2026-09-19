/**
 * メモを探すための道具。
 *
 * 日本語のメモでは「ソウキャク」と「そうきゃく」、「ＡＢＣ」と「abc」を
 * 同じものとして扱えないと、探しているのに見つからない。
 * そこで、比べるときだけ次をそろえる:
 *   全角と半角（NFKC）／ 大文字と小文字 ／ カタカナとひらがな
 *
 * 書き方:
 *   ことば ことば   … どちらも含むもの（AND）
 *   "ひとつづき"     … 空白を含めてそのまま
 *   -ことば          … それを含まないもの
 *   #タグ            … そのタグが付いたもの（-#タグ で除く）
 *
 * 当たった場所（範囲）も返すので、一覧では当たった行を抜き出して示せる。
 */

/** カタカナをひらがなに寄せる（長音「ー」はそのまま） */
const kataToHira = (text) => text.replace(/[ァ-ヶ]/g, (m) => String.fromCharCode(m.charCodeAt(0) - 0x60));

/** 比べるときの形にそろえた 1 文字（長さが変わることがある） */
function foldChar(ch) {
  return kataToHira(ch.normalize('NFKC').toLowerCase());
}

/**
 * 比べるための形にそろえる。
 * 元の文字のどこから来たかも返すので、当たった範囲を元の文字に戻せる。
 */
export function fold(text) {
  const src = String(text ?? '');
  let out = '';
  const map = [];
  for (let i = 0; i < src.length; i += 1) {
    const piece = foldChar(src[i]);
    for (let k = 0; k < piece.length; k += 1) map.push(i);
    out += piece;
  }
  map.push(src.length);
  return { text: out, map };
}

/**
 * 探すときの形にそろえた文字列だけが欲しいとき。
 * こちらは文字列まるごとを一度に変換する（1 文字ずつより、ずっと速い）。
 */
export const foldText = (text) => kataToHira(String(text ?? '').normalize('NFKC').toLowerCase());

/**
 * メモ 1 件ぶんの「探すための文字列」を覚えておく。
 * 打つたびに全メモをそろえ直すと、メモが増えたときに重くなる。
 * 中身が変わった時刻（contentUpdatedAt）が変われば作り直す。
 */
const foldedCache = new WeakMap();

function foldedOf(note, title) {
  const stamp = `${note.contentUpdatedAt || note.updatedAt}|${title}`;
  const hit = foldedCache.get(note);
  if (hit && hit.stamp === stamp) return hit.value;
  const value = {
    body: foldText(note.body || ''),
    others: foldText(`${title}\n${note.title || ''}\n${note.cue || ''}\n${note.tags.join(' ')}`),
    tags: note.tags.map(foldText),
  };
  foldedCache.set(note, { stamp, value });
  return value;
}

/** 入力された 1 行を、条件の集まりに分ける */
export function parseQuery(input) {
  const raw = String(input ?? '').trim();
  const terms = [];
  const tags = [];
  const notTags = [];
  // 「"…"」はひとつづき、それ以外は空白区切り
  const tokens = raw.match(/-?#?"[^"]*"|\S+/g) || [];

  tokens.forEach((token) => {
    let value = token;
    let negate = false;
    if (value.startsWith('-') && value.length > 1) { negate = true; value = value.slice(1); }
    let isTag = false;
    if (value.startsWith('#') && value.length > 1) { isTag = true; value = value.slice(1); }
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    if (!value) return;
    if (isTag) {
      (negate ? notTags : tags).push(foldText(value));
      return;
    }
    terms.push({ value: foldText(value), negate });
  });

  return { raw, terms, tags, notTags, empty: !terms.length && !tags.length && !notTags.length };
}

/** そろえた文字列の中から、当たった場所をすべて拾う */
function findAll(haystack, needle) {
  const hits = [];
  if (!needle) return hits;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    hits.push([at, at + needle.length]);
    at = haystack.indexOf(needle, at + needle.length);
  }
  return hits;
}

/**
 * メモが条件に合うか。
 * @param {object} note
 * @param {object} query parseQuery の結果
 * @param {{title?:string}} options 表示用タイトル（本文 1 行目から作る場合があるため外から渡す）
 * @returns {{hit:boolean, ranges:Array<[number,number]>}} ranges は本文の中の当たった場所
 */
export function matchNote(note, query, { title = '', withRanges = true } = {}) {
  if (!query || query.empty) return { hit: true, ranges: [] };

  const folded = foldedOf(note, title);
  if (query.tags.some((t) => !folded.tags.includes(t))) return { hit: false, ranges: [] };
  if (query.notTags.some((t) => folded.tags.includes(t))) return { hit: false, ranges: [] };

  for (const term of query.terms) {
    const found = folded.body.includes(term.value) || folded.others.includes(term.value);
    if (term.negate === found) return { hit: false, ranges: [] };
  }
  // 当たった場所は、見せるメモのぶんだけ調べる（全件ぶん作ると重い）
  return { hit: true, ranges: withRanges ? rangesIn(note, query) : [] };
}

/**
 * 本文のどこに当たったか（元の文字の位置）。
 * ここだけは 1 文字ずつ照らし合わせるので、絞り込んだあとに使う。
 */
export function rangesIn(note, query) {
  if (!query || !query.terms.length) return [];
  const body = fold(note.body || '');
  const ranges = [];
  query.terms.forEach((term) => {
    if (term.negate) return;
    findAll(body.text, term.value).forEach(([s, e]) => ranges.push([body.map[s], body.map[e]]));
  });
  ranges.sort((a, b) => a[0] - b[0]);
  return ranges;
}

/**
 * 当たったところを含む抜粋を作る。
 * @returns {{text:string, ranges:Array<[number,number]>, head:boolean}}
 *   ranges は抜粋の中での位置。head が false なら前を省いている。
 */
export function snippet(text, ranges, { length = 120, before = 24 } = {}) {
  const src = String(text ?? '');
  if (!ranges.length) {
    return { text: src.slice(0, length), ranges: [], head: true, tail: src.length <= length };
  }
  const first = ranges[0][0];
  // 当たった行の頭から見せる（行の途中で切ると読みにくいので）
  const lineStart = src.lastIndexOf('\n', Math.max(0, first - 1)) + 1;
  const start = Math.max(lineStart, first - before > lineStart ? first - before : lineStart);
  const end = Math.min(src.length, start + length);
  const cut = src.slice(start, end);
  const shifted = ranges
    .filter(([s, e]) => e > start && s < end)
    .map(([s, e]) => [Math.max(0, s - start), Math.min(cut.length, e - start)]);
  return { text: cut, ranges: shifted, head: start === 0, tail: end >= src.length };
}

/**
 * メモの並びを絞り込む。
 * 当たった場所は返さない（画面に出すぶんだけ rangesIn で調べる）。
 * @returns {Array<object>} 条件に合ったメモ
 */
export function searchNotes(notes, query, { titleOf = () => '' } = {}) {
  if (!query || query.empty) return [...notes];
  return notes.filter((note) => matchNote(note, query, {
    title: titleOf(note),
    withRanges: false,
  }).hit);
}
