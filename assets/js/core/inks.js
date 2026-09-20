/**
 * 文字の色とマーカーの色。
 *
 * 色は「#1b7f3a」のような値ではなく、**名前**（`green` など）で持つ。
 * 名前で持つ理由は 2 つ。
 *
 *   1. 明るい配色と暗い配色で、同じ名前のまま見やすい色に置き換えられる
 *      （値で持つと、暗い画面で黒い文字が読めなくなる）
 *   2. 保存される値が決まった一覧の中だけになる
 *      （外から貼り付けた本文に、好き勝手な CSS が入り込まない）
 *
 * 外のサイトから貼り付けた文字には値（`rgb(...)` など）が付いてくるので、
 * いちばん近い名前に寄せてから受け取る（nearestInk / nearestMarker）。
 *
 * ここは DOM にも編集ライブラリにも触れない純粋な部分。
 */

/** 文字の色（名前と、寄せるときの目印になる色相） */
export const INK_COLORS = [
  { id: 'red', label: '赤', hue: 4 },
  { id: 'orange', label: 'だいだい', hue: 32 },
  { id: 'green', label: '緑', hue: 142 },
  { id: 'blue', label: '青', hue: 214 },
  { id: 'purple', label: '紫', hue: 278 },
  { id: 'gray', label: '灰', hue: null },
];

/** マーカーの色 */
export const MARKER_COLORS = [
  { id: 'yellow', label: '黄', hue: 50 },
  { id: 'green', label: '緑', hue: 142 },
  { id: 'blue', label: '青', hue: 205 },
  { id: 'pink', label: '桃', hue: 334 },
  { id: 'purple', label: '紫', hue: 278 },
];

const INK_IDS = new Set(INK_COLORS.map((c) => c.id));
const MARKER_IDS = new Set(MARKER_COLORS.map((c) => c.id));

export const isInk = (id) => INK_IDS.has(String(id));
export const isMarker = (id) => MARKER_IDS.has(String(id));

export const inkLabel = (id) => INK_COLORS.find((c) => c.id === id)?.label || '';
export const markerLabel = (id) => MARKER_COLORS.find((c) => c.id === id)?.label || '';

/** 名前だけ書かれた色（外から貼り付けた本文で使われるもの） */
const NAMED = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  silver: [192, 192, 192],
  red: [255, 0, 0],
  crimson: [220, 20, 60],
  maroon: [128, 0, 0],
  brown: [165, 42, 42],
  orange: [255, 165, 0],
  gold: [255, 215, 0],
  yellow: [255, 255, 0],
  olive: [128, 128, 0],
  green: [0, 128, 0],
  lime: [0, 255, 0],
  teal: [0, 128, 128],
  cyan: [0, 255, 255],
  aqua: [0, 255, 255],
  blue: [0, 0, 255],
  navy: [0, 0, 128],
  indigo: [75, 0, 130],
  purple: [128, 0, 128],
  violet: [238, 130, 238],
  magenta: [255, 0, 255],
  fuchsia: [255, 0, 255],
  pink: [255, 192, 203],
};

/**
 * CSS の色を [r, g, b] にする。
 * 透明・読めない書き方・色ではない値（`initial` など）は null。
 */
export function parseColor(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'transparent' || raw === 'none' || raw === 'initial'
    || raw === 'inherit' || raw === 'unset' || raw === 'currentcolor') return null;

  if (NAMED[raw]) return NAMED[raw];

  const hex = raw.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    const s = hex[1];
    if (s.length === 3 || s.length === 4) {
      if (s.length === 4 && parseInt(s[3] + s[3], 16) < 24) return null;   // ほぼ透明
      return [0, 1, 2].map((i) => parseInt(s[i] + s[i], 16));
    }
    if (s.length === 6 || s.length === 8) {
      if (s.length === 8 && parseInt(s.slice(6, 8), 16) < 24) return null;
      return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
    }
    return null;
  }

  // rgb() / rgba() / 新しい書き方の rgb(0 0 0 / 50%)
  const fn = raw.match(/^rgba?\(([^)]+)\)$/);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const rgb = parts.slice(0, 3).map((p) => {
      const n = parseFloat(p);
      if (!Number.isFinite(n)) return NaN;
      return p.endsWith('%') ? Math.round((n / 100) * 255) : Math.round(n);
    });
    if (rgb.some((n) => !Number.isFinite(n))) return null;
    if (parts.length >= 4) {
      const a = parseFloat(parts[3]);
      const alpha = parts[3].endsWith('%') ? a / 100 : a;
      if (Number.isFinite(alpha) && alpha < 0.1) return null;   // ほぼ透明
    }
    return rgb.map((n) => Math.min(255, Math.max(0, n)));
  }

  return null;
}

/** 色合い（色相 0-360）・鮮やかさ・明るさ（0-1） */
export function toHsl([r, g, b]) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { hue: 0, sat: 0, light: l };
  const sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let hue;
  if (max === rn) hue = ((gn - bn) / d) % 6;
  else if (max === gn) hue = (bn - rn) / d + 2;
  else hue = (rn - gn) / d + 4;
  hue = (hue * 60 + 360) % 360;
  return { hue, sat, light: l };
}

/** 色相の近さ（0-180） */
function hueGap(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function nearestByHue(list, hue) {
  return list
    .filter((c) => c.hue !== null)
    .reduce((best, c) => (hueGap(hue, c.hue) < hueGap(hue, best.hue) ? c : best)).id;
}

/**
 * 貼り付けられた文字の色を、いちばん近い名前に寄せる。
 *
 * ふつうの本文の色（黒っぽい・白っぽい）は「色なし」にする。
 * そうしないと、外のサイトを貼り付けるたび全部に色が付いてしまう。
 */
export function nearestInk(value) {
  const rgb = parseColor(value);
  if (!rgb) return null;
  const { hue, sat, light } = toHsl(rgb);
  if (sat < 0.18) {
    // 色味がない: 濃い黒と薄い白は「ふつうの文字」として扱う
    if (light < 0.3 || light > 0.86) return null;
    return 'gray';
  }
  if (light < 0.12 || light > 0.94) return null;
  return nearestByHue(INK_COLORS, hue);
}

/**
 * 貼り付けられた背景色を、いちばん近いマーカーの名前に寄せる。
 * マーカーは薄い色が多いので、色味の判定はゆるめにする。
 */
export function nearestMarker(value) {
  const rgb = parseColor(value);
  if (!rgb) return null;
  const { hue, sat, light } = toHsl(rgb);
  // 白・黒・灰色の背景はマーカーではない（ただの地の色）
  if (sat < 0.08) return null;
  if (light > 0.97) return null;
  return nearestByHue(MARKER_COLORS, hue);
}
