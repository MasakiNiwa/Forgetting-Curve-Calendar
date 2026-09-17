/** 画面をまたいで使う部品 */
import { h, button, iconButton } from './dom.js';
import { icon } from './icons.js';
import { toast } from './overlays.js';
import { formatDuration, formatMedium, formatRelative, formatSmart, todayKey } from '../core/date.js';
import { bodyPreview, displayTitle, hasHiddenContent, recallCue } from '../core/models.js';
import { RATINGS, retentionSeries, sanitizeIntervals } from '../core/curve.js';
import { reviewState } from '../core/store.js';

const STATUS_LABEL = {
  overdue: '思い出し待ち',
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

/** 想起結果のボタン列 */
export function ratingButtons(onRate, { size = 'sm' } = {}) {
  return h('div', { class: 'rating-row' },
    ...Object.values(RATINGS).map((r) => button(r.label, {
      className: `btn btn--${size} rating-btn rating-btn--${r.id}`,
      onClick: (e) => { e.stopPropagation(); onRate(r.id); },
    })));
}

/**
 * 復習タスクのカード。
 *
 * 「読んでから自己評価」ではなく「思い出してから答え合わせ」にするため、
 * 既定では本文を隠し、［内容を見る］で開いてから評価する。
 */
export function reviewCard({ store, note, review, onOpen, showActions = true }) {
  const state = reviewState(review);
  const total = note.reviews.length;
  const hideBody = store.settings.hideBodyUntilRecall
    && review.status === 'pending'
    && hasHiddenContent(note);

  const card = h('article', {
    class: [
      'note-card',
      state === 'overdue' ? 'note-card--overdue' : '',
      review.status !== 'pending' ? 'note-card--done' : '',
      note.parentId ? 'note-card--child' : '',
    ].filter(Boolean).join(' '),
  });

  card.appendChild(h('div', { class: 'note-card__head' },
    h('span', { class: 'note-card__title' }, recallCue(note)),
    iconButton(icon('more', { size: 20 }), {
      label: 'メモの操作',
      className: 'icon-btn',
      onClick: (e) => { e.stopPropagation(); onOpen?.(note, 'menu'); },
    })));

  const contentSlot = h('div', { class: 'note-card__content' });
  card.appendChild(contentSlot);

  const renderBody = () => {
    const text = note.cue ? note.body : bodyPreview(note);
    if (text) contentSlot.appendChild(h('p', { class: 'note-card__body' }, text));
  };

  const meta = h('div', { class: 'note-card__meta' },
    h('span', { class: 'note-card__step' },
      `${review.extra ? '追加復習' : `${review.step + 1}回目`} / 全${total}回`),
    h('span', {}, `${STATUS_LABEL[state]}・${formatRelative(review.due)}`));
  if (note.tags.length) meta.appendChild(tagChips(note.tags));

  const actionSlot = h('div', { class: 'note-card__actions' });

  const showRating = () => {
    actionSlot.replaceChildren(ratingButtons((rating) => {
      store.rateReview(note.id, review.id, rating);
      const fresh = store.getNote(note.id);
      const next = fresh?.reviews.find((x) => x.status === 'pending');
      const label = RATINGS[rating].label;
      toast(next ? `${label}：次は ${formatRelative(next.due)}` : `${label}：このメモは定着しました`, {
        actionLabel: '取り消す',
        onAction: () => store.undoLastEvent(note.id),
      });
    }));
  };

  if (!showActions) {
    renderBody();
  } else if (review.status !== 'pending') {
    renderBody();
    const label = review.status === 'done'
      ? `${RATINGS[review.rating]?.label ?? '完了'}として記録済み`
      : 'スキップしました';
    actionSlot.append(
      h('span', { class: 'note-card__note' }, label),
      store.canUndo(note.id, lastEventIdFor(note, review))
        ? button('取り消す', {
          className: 'btn btn--sm btn--text',
          onClick: (e) => { e.stopPropagation(); store.undoLastEvent(note.id); },
        })
        : null,
    );
  } else if (hideBody) {
    contentSlot.appendChild(h('p', { class: 'note-card__prompt' }, '内容を思い出せますか？'));
    actionSlot.appendChild(button('内容を見る', {
      className: 'btn btn--tonal btn--sm',
      icon: icon('eye', { size: 18 }),
      onClick: (e) => {
        e.stopPropagation();
        contentSlot.replaceChildren();
        renderBody();
        showRating();
      },
    }));
  } else {
    renderBody();
    showRating();
  }

  card.append(meta, actionSlot);
  card.addEventListener('click', () => onOpen?.(note, 'detail'));
  return card;
}

/** その復習に対応する直近の出来事 ID（取り消せるかの判定に使う） */
function lastEventIdFor(note, review) {
  for (let i = note.events.length - 1; i >= 0; i -= 1) {
    const ev = note.events[i];
    if (ev.reviewKey === review.id) return ev.id;
  }
  return null;
}

/** メモ一覧・日別パネルで使うシンプルなメモカード */
export function noteCard({ store, note, onOpen, subtitle }) {
  const next = note.reviews.find((r) => r.status === 'pending');
  const done = note.reviews.filter((r) => r.status !== 'pending').length;
  const childCount = store.childrenOf(note.id).length;
  const preview = bodyPreview(note);

  return h('article', {
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
  note.cue ? h('p', { class: 'note-card__cue' }, `手掛かり: ${note.cue}`) : null,
  preview ? h('p', { class: 'note-card__body' }, preview) : null,
  h('div', { class: 'note-card__meta' },
    h('span', {}, subtitle || `作成 ${formatMedium(note.anchorDate)}`),
    h('span', { class: 'note-card__step' }, `${done}/${note.reviews.length}`),
    !next ? h('span', {}, '定着') : (subtitle ? null : h('span', {}, `次 ${formatRelative(next.due)}`)),
    childCount ? h('span', {}, `追加メモ ${childCount}`) : null,
    note.tags.length ? tagChips(note.tags) : null));
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
 * 忘却曲線のプレビュー（SVG）。
 * 年単位まで伸びる曲線を 1 枚で見せるため、横軸は対数目盛にしている。
 */
export function curvePreview(intervals, ease = 2.5) {
  const list = sanitizeIntervals(intervals);
  const series = retentionSeries(list, ease);
  const W = 320;
  const H = 130;
  const PAD = { l: 8, r: 8, t: 10, b: 22 };
  const maxT = series[series.length - 1]?.t || 1;
  const scale = (t) => Math.log1p(Math.max(0, t)) / Math.log1p(maxT);
  const x = (t) => PAD.l + scale(t) * (W - PAD.l - PAD.r);
  const y = (r) => PAD.t + (1 - r) * (H - PAD.t - PAD.b);

  const line = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.r).toFixed(1)}`).join('');
  const area = `${line}L${x(maxT).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;
  const marks = list.map((d) => `<circle class="curve-mark" cx="${x(d).toFixed(1)}" cy="${y(1).toFixed(1)}" r="3"/>`).join('');

  // ラベルが重ならないよう、一定間隔以上離れたものだけを描く
  let lastLabelX = -Infinity;
  const labels = list.map((d) => {
    const px = x(d);
    if (px - lastLabelX < 38) return '';
    lastLabelX = px;
    return `<text class="curve-label" x="${px.toFixed(1)}" y="${H - 7}" text-anchor="middle">${formatDuration(d)}</text>`;
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
