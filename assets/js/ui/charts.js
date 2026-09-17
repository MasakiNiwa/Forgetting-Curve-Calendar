/**
 * 記録画面で使う小さなチャート群（依存ライブラリなしのインライン SVG）。
 *
 * 方針
 * - 色は「役割」で決める。想起結果は識別のためのカテゴリ色（検証済みの 3 色）、
 *   件数の濃淡は単一色相の連続スケール。
 * - 色だけに意味を持たせない。凡例と数値ラベルを必ず添える。
 * - マークは細く、角は軽く丸め、隣り合う面には 2px の隙間を空ける。
 * - ホバーで詳細が出る（SVG の <title>）。
 */
import { h } from './dom.js';
import { formatMedium, fromKey, toKey } from '../core/date.js';

export const RATING_COLORS = {
  known: 'var(--fcc-rating-known)',
  vague: 'var(--fcc-rating-vague)',
  forgot: 'var(--fcc-rating-forgot)',
};

const NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (v === null || v === undefined || v === false) return;
    el.setAttribute(k, String(v));
  });
  children.flat().filter(Boolean).forEach((c) => el.appendChild(c));
  return el;
}

function title(text) {
  const el = document.createElementNS(NS, 'title');
  el.textContent = text;
  return el;
}

/* ------------------------------------------------------------------ */
/* 想起の内訳（横 1 本の積み上げ）                                      */
/* ------------------------------------------------------------------ */

/**
 * @param {{known:number, vague:number, forgot:number}} counts
 * @param {Array<{id:string,label:string}>} order
 */
export function ratingBar(counts, order) {
  const total = order.reduce((sum, r) => sum + (counts[r.id] || 0), 0);
  if (!total) return null;

  const W = 320;
  const H = 18;
  const GAP = 2; // 面同士は必ず離す
  let x = 0;
  const segments = order.map((r) => {
    const value = counts[r.id] || 0;
    const width = Math.max(0, (value / total) * W - GAP);
    const rect = value
      ? svg('rect', {
        x: x.toFixed(1), y: 0, width: width.toFixed(1), height: H, rx: 4,
        fill: RATING_COLORS[r.id],
      }, title(`${r.label} ${value} 回（${Math.round((value / total) * 100)}%）`))
      : null;
    x += (value / total) * W;
    return rect;
  });

  const chart = svg('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'chart chart--bar',
    role: 'img',
    'aria-label': order.map((r) => `${r.label} ${counts[r.id] || 0} 回`).join('、'),
  }, segments);

  return h('div', {},
    chart,
    h('div', { class: 'chart__legend' },
      ...order.map((r) => {
        const value = counts[r.id] || 0;
        return h('span', { class: 'chart__legend-item' },
          h('span', { class: 'chart__swatch', style: { background: RATING_COLORS[r.id] } }),
          h('span', {}, r.label),
          h('b', {}, `${value}`),
          h('span', { class: 'chart__legend-pct' }, `${Math.round((value / total) * 100)}%`));
      })));
}

/* ------------------------------------------------------------------ */
/* 復習の記録（週 × 曜日のヒートマップ）                                */
/* ------------------------------------------------------------------ */

/**
 * @param {Map<string, {total:number}>} activity 日付 -> 実績
 * @param {{weeks?:number, endKey:string, weekStart?:number}} options
 */
export function activityHeatmap(activity, { weeks = 16, endKey, weekStart = 0 }) {
  const CELL = 12;
  const GAP = 3;
  const end = fromKey(endKey);
  // 週の最終列が今週になるよう、末尾を週の終わりまで進める
  const trailing = (6 - ((end.getDay() - weekStart + 7) % 7));
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate() + trailing);
  const first = new Date(last.getFullYear(), last.getMonth(), last.getDate() - (weeks * 7 - 1));

  const max = Math.max(1, ...[...activity.values()].map((v) => v.total));
  const cells = [];
  const monthLabels = [];
  let lastMonth = -1;
  let lastLabelWeek = -99;

  for (let w = 0; w < weeks; w += 1) {
    for (let d = 0; d < 7; d += 1) {
      const date = new Date(first.getFullYear(), first.getMonth(), first.getDate() + w * 7 + d);
      const key = toKey(date);
      const entry = activity.get(key);
      const level = entry ? Math.min(4, Math.ceil((entry.total / max) * 4)) : 0;
      const future = key > endKey;
      cells.push(svg('rect', {
        x: w * (CELL + GAP),
        y: d * (CELL + GAP),
        width: CELL,
        height: CELL,
        rx: 3,
        class: `heat heat--${level}`,
        opacity: future ? 0.3 : 1,
      }, title(`${formatMedium(key)}：${entry ? `${entry.total} 回` : '記録なし'}`)));

      // 月のラベルは、隣と重ならない間隔が空いたときだけ描く
      if (d === 0 && date.getMonth() !== lastMonth) {
        const enoughRoom = w - lastLabelWeek >= 3;
        lastMonth = date.getMonth();
        if (!enoughRoom) continue;
        lastLabelWeek = w;
        monthLabels.push(svg('text', {
          x: w * (CELL + GAP),
          y: -4,
          class: 'chart__axis-label',
        }, [document.createTextNode(`${date.getMonth() + 1}月`)]));
      }
    }
  }

  const width = weeks * (CELL + GAP);
  const height = 7 * (CELL + GAP);
  const chart = svg('svg', {
    viewBox: `0 -14 ${width} ${height + 14}`,
    class: 'chart chart--heatmap',
    role: 'img',
    'aria-label': `直近 ${weeks} 週間の復習の記録`,
  }, [...monthLabels, ...cells]);

  return h('div', {},
    chart,
    h('div', { class: 'chart__legend chart__legend--scale' },
      h('span', {}, '少'),
      ...[0, 1, 2, 3, 4].map((l) => h('span', { class: `chart__swatch heat-swatch heat--${l}` })),
      h('span', {}, '多')));
}

/* ------------------------------------------------------------------ */
/* これからの予定（月ごとの縦棒）                                        */
/* ------------------------------------------------------------------ */

export function monthlyBars(buckets, { onSelect } = {}) {
  const W = 320;
  const H = 96;
  const BASE = H - 16;
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const slot = W / buckets.length;
  const barW = Math.max(6, slot - 6);

  const bars = buckets.map((b, i) => {
    const barH = b.count ? Math.max(3, (b.count / max) * (BASE - 6)) : 0;
    const x = i * slot + (slot - barW) / 2;
    const label = `${b.year}年${b.month + 1}月：復習 ${b.count} 件`;
    const group = svg('g', { class: 'chart__bar-group', style: onSelect ? 'cursor:pointer' : null },
      svg('rect', { x, y: 0, width: barW, height: BASE, fill: 'transparent' }, title(label)),
      b.count
        ? svg('rect', {
          x, y: BASE - barH, width: barW, height: barH, rx: 4,
          class: 'chart__bar',
        }, title(label))
        : null,
      svg('text', {
        x: x + barW / 2, y: H - 4, 'text-anchor': 'middle', class: 'chart__axis-label',
      }, [document.createTextNode(String(b.month + 1))]));
    if (onSelect) group.addEventListener('click', () => onSelect(b));
    return group;
  });

  return svg('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'chart chart--bars',
    role: 'img',
    'aria-label': `これから ${buckets.length} ヶ月の復習予定件数`,
  }, [
    svg('line', { x1: 0, y1: BASE, x2: W, y2: BASE, class: 'chart__axis' }),
    ...bars,
  ]);
}
