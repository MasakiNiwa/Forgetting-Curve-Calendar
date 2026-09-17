/** 画面をまたいで使う部品 */
import { h, button, iconButton } from './dom.js';
import { icon } from './icons.js';
import { toast } from './overlays.js';
import { formatMedium, formatRelative, formatSmart, todayKey } from '../core/date.js';
import { bodyPreview, displayTitle } from '../core/models.js';
import { RATINGS, retentionSeries, sanitizeIntervals } from '../core/curve.js';
import { reviewState } from '../core/store.js';

const STATUS_LABEL = {
  overdue: '期限切れ',
  due: '今日',
  upcoming: '予定',
  done: '完了',
  skipped: 'スキップ',
};

export function tagChips(tags) {
  if (!tags?.length) return null;
  return h('span', { class: 'note-card__tags' },
    ...tags.map((t) => h('span', { class: 'chip chip--static' }, `#${t}`)));
}

export function emptyState({ iconName = 'sparkle', title, text, action }) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty__icon', html: icon(iconName, { size: 40 }), style: { display: 'flex', justifyContent: 'center' } }),
    h('div', { class: 'empty__title' }, title),
    text ? h('div', { class: 'empty__text' }, text) : null,
    action ? h('div', { style: { marginTop: '16px' } }, action) : null);
}

/**
 * 復習タスクのカード。想起結果の入力ボタン付き。
 * @param {object} ctx {store, note, review, onOpen, showActions}
 */
export function reviewCard({ store, note, review, onOpen, showActions = true }) {
  const state = reviewState(review);
  const total = note.reviews.length;
  const position = note.reviews.filter((r) => r.status !== 'pending').length;

  const card = h('article', {
    class: [
      'note-card',
      state === 'overdue' ? 'note-card--overdue' : '',
      review.status !== 'pending' ? 'note-card--done' : '',
      note.parentId ? 'note-card--child' : '',
    ].filter(Boolean).join(' '),
  });

  const head = h('div', { class: 'note-card__head' },
    h('span', { class: 'note-card__title' }, displayTitle(note)),
    iconButton(icon('more', { size: 20 }), {
      label: 'メモの操作',
      className: 'icon-btn',
      onClick: (e) => { e.stopPropagation(); onOpen?.(note, 'menu'); },
    }));
  card.appendChild(head);

  const preview = bodyPreview(note);
  if (preview) {
    card.appendChild(h('p', { class: 'note-card__body' }, preview));
  }

  const meta = h('div', { class: 'note-card__meta' },
    h('span', { class: 'note-card__step' },
      `${review.extra ? '追加復習' : `${review.step + 1}回目`} / 全${total}回`),
    h('span', {}, `${STATUS_LABEL[state]}・${formatRelative(review.due)}`),
    position > 0 ? h('span', {}, `完了 ${position}`) : null);
  if (note.tags.length) meta.appendChild(tagChips(note.tags));
  card.appendChild(meta);

  if (showActions && review.status === 'pending') {
    const actions = h('div', { class: 'note-card__actions' });
    Object.values(RATINGS).forEach((r) => {
      actions.appendChild(button(r.label, {
        className: `btn btn--sm rating-btn rating-btn--${r.id}`,
        onClick: (e) => {
          e.stopPropagation();
          store.rateReview(note.id, review.id, r.id);
          const next = store.getNote(note.id)?.reviews.find((x) => x.status === 'pending');
          toast(next ? `${r.label}：次の復習は ${formatRelative(next.due)}` : `${r.label}：このメモは定着しました`, {
            actionLabel: '取り消す',
            onAction: () => store.undoReview(note.id, review.id),
          });
        },
      }));
    });
    card.appendChild(actions);
  } else if (showActions) {
    const label = review.status === 'done'
      ? `${RATINGS[review.rating]?.label ?? '完了'}として記録済み`
      : 'スキップしました';
    card.appendChild(h('div', { class: 'note-card__actions' },
      h('span', { style: { fontSize: '.76rem', color: 'var(--fcc-on-surface-variant)', alignSelf: 'center' } }, label),
      button('取り消す', {
        className: 'btn btn--sm btn--text',
        onClick: (e) => { e.stopPropagation(); store.undoReview(note.id, review.id); },
      })));
  }

  card.addEventListener('click', () => onOpen?.(note, 'detail'));
  return card;
}

/** メモ一覧・日別パネルで使うシンプルなメモカード */
export function noteCard({ store, note, onOpen, subtitle }) {
  const next = note.reviews.find((r) => r.status === 'pending');
  const done = note.reviews.filter((r) => r.status !== 'pending').length;
  const childCount = store.childrenOf(note.id).length;

  const card = h('article', {
    class: `note-card ${note.parentId ? 'note-card--child' : ''}`,
    onClick: () => onOpen?.(note, 'detail'),
  },
  h('div', { class: 'note-card__head' },
    note.status === 'graduated' ? h('span', { html: icon('graduate', { size: 18 }), style: { color: 'var(--fcc-success)', display: 'flex' } }) : null,
    h('span', { class: 'note-card__title' }, displayTitle(note)),
    iconButton(icon('more', { size: 20 }), {
      label: 'メモの操作',
      onClick: (e) => { e.stopPropagation(); onOpen?.(note, 'menu'); },
    })),
  bodyPreview(note) ? h('p', { class: 'note-card__body' }, bodyPreview(note)) : null,
  h('div', { class: 'note-card__meta' },
    h('span', {}, subtitle || `作成 ${formatMedium(note.anchorDate)}`),
    h('span', { class: 'note-card__step' }, `${done}/${note.reviews.length}`),
    !next ? h('span', {}, '定着') : (subtitle ? null : h('span', {}, `次 ${formatRelative(next.due)}`)),
    childCount ? h('span', {}, `追加メモ ${childCount}`) : null,
    note.tags.length ? tagChips(note.tags) : null));

  return card;
}

/** 復習履歴のタイムライン */
export function reviewTimeline(store, note) {
  const wrap = h('div', { class: 'timeline' });
  const today = todayKey();
  note.reviews.forEach((review) => {
    const state = reviewState(review, today);
    const dotClass = review.status === 'pending' ? 'timeline__dot--pending'
      : review.status === 'skipped' ? 'timeline__dot--skipped' : '';
    wrap.appendChild(h('div', { class: 'timeline__item' },
      h('div', { class: 'timeline__rail' },
        h('span', { class: `timeline__dot ${dotClass}` }),
        h('span', { class: 'timeline__line' })),
      h('div', { class: 'timeline__content' },
        h('div', { class: 'timeline__date' },
          `${formatSmart(review.due)}　`,
          h('span', { style: { fontWeight: '400', color: 'var(--fcc-on-surface-variant)', fontSize: '.78rem' } },
            `${review.extra ? '追加復習' : `${review.step + 1}回目`}・${STATUS_LABEL[state]}`)),
        review.rating
          ? h('div', { class: 'timeline__note' }, `想起: ${RATINGS[review.rating]?.label ?? review.rating}`)
          : null)));
  });
  return wrap;
}

/**
 * 忘却曲線のプレビュー（SVG）。設定画面とエディタで共用。
 */
export function curvePreview(intervals, ease = 2.5) {
  const list = sanitizeIntervals(intervals);
  const series = retentionSeries(list, ease);
  const W = 320;
  const H = 130;
  const PAD = { l: 8, r: 8, t: 10, b: 20 };
  const maxT = series[series.length - 1]?.t || 1;
  const x = (t) => PAD.l + (t / maxT) * (W - PAD.l - PAD.r);
  const y = (r) => PAD.t + (1 - r) * (H - PAD.t - PAD.b);

  const line = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.r).toFixed(1)}`).join('');
  const area = `${line}L${x(maxT).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;

  const marks = list.map((d) => `<circle class="curve-mark" cx="${x(d).toFixed(1)}" cy="${y(1).toFixed(1)}" r="3"/>`).join('');
  // ラベルが重ならないよう、一定間隔以上離れたものだけを描く
  let lastLabelX = -Infinity;
  const labels = list.map((d, i) => {
    const px = x(d);
    const isLast = i === list.length - 1;
    if (!isLast && px - lastLabelX < 34) return '';
    if (isLast && px - lastLabelX < 34) return '';
    lastLabelX = px;
    return `<text class="curve-label" x="${px.toFixed(1)}" y="${H - 6}" text-anchor="middle">${d}日</text>`;
  }).join('');

  return svgFromMarkup(`
    <svg class="curve-preview" viewBox="0 0 ${W} ${H}"
         role="img" aria-label="忘却曲線のイメージ">
      <path class="curve-area" d="${area}"/>
      <path class="curve-line" d="${line}"/>
      <line class="curve-axis" x1="${PAD.l}" y1="${y(0)}" x2="${W - PAD.r}" y2="${y(0)}"/>
      ${marks}${labels}
    </svg>`);
}

/** 文字列マークアップから SVG 要素を生成する（名前空間対応） */
export function svgFromMarkup(markup) {
  const wrap = document.createElement('div');
  wrap.innerHTML = markup.trim();
  return wrap.firstElementChild;
}
