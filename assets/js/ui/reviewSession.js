/**
 * 集中復習モード。
 *
 * 今日の復習をまとめて 1 件ずつ進める全画面フロー。
 *   手掛かりを見る → 頭の中で思い出す → 内容を開く → 想起結果を記録 → 次へ
 * 最後に「また忘れる頃に会いましょう」で締めることで、1 日の区切りを作る。
 */
import { noteBodyView } from './docView.js';
import { h, append, button, iconButton, clear } from './dom.js';
import { icon } from './icons.js';
import { openDialog, toast } from './overlays.js';
import { ratingButtons } from './components.js';
import { openQuickCapture } from './editor.js';
import { RATINGS } from '../core/curve.js';
import { recallCue } from '../core/models.js';
import { formatRelative, formatSmart } from '../core/date.js';

/**
 * @param {Store} store
 * @param {{items?: Array<{note:object, review:object}>, title?: string}} options
 */
export function startReviewSession(store, options = {}) {
  const queue = options.items || store.todayQueue().items;
  if (!queue.length) {
    toast('今日の復習はありません');
    return null;
  }

  // 出来事を記録するとスケジュールが変わるため、対象は開始時点で固定する
  const plan = queue.map(({ note, review }) => ({ noteId: note.id, reviewId: review.id }));
  // 本文は開いたときに読む作り。答え合わせで待たせないよう、この列のぶんは先に読む
  store.ensureDocs(queue.map((item) => item.note));
  const results = { known: 0, vague: 0, forgot: 0, skipped: 0 };
  let cursor = 0;
  let revealed = false;

  const body = h('div', { class: 'session' });
  const dialog = openDialog({
    title: '今日の復習',
    content: body,
    dismissible: false,
    leading: iconButton(icon('close'), {
      label: '中断する',
      onClick: () => finish({ aborted: true }),
    }),
  });

  function current() {
    const { noteId, reviewId } = plan[cursor];
    const note = store.getNote(noteId);
    const review = note?.reviews.find((r) => r.id === reviewId);
    return { note, review };
  }

  function advance() {
    cursor += 1;
    revealed = false;
    if (cursor >= plan.length) finish({ aborted: false });
    else render();
  }

  function record(rating) {
    const { note, review } = current();
    if (note && review && review.status === 'pending') {
      store.rateReview(note.id, review.id, rating);
      results[rating] += 1;
    }
    advance();
  }

  /** 「また後で」= 飛ばすのではなく、近いうちにもう一度出す */
  function later() {
    const { note, review } = current();
    if (note && review && review.status === 'pending') {
      store.postponeReview(note.id, review.id, 3);
      results.skipped += 1;
    }
    advance();
  }

  function render() {
    const { note, review } = current();
    if (!note || !review) { advance(); return; }

    // 答え合わせでは、省略せずに原文をそのまま出す
    const text = (note.body || '').trim();
    const answer = h('div', { class: 'session__answer' });
    const actions = h('div', { class: 'session__actions' });

    const reveal = () => {
      revealed = true;
      append(clear(answer), [
        // 明示的なタイトルがあるときだけ見出しを添える（本文と重複させない）
        note.cue && note.title ? h('div', { class: 'session__answer-label' }, note.title) : null,
        text
          ? noteBodyView(note, { text, store, className: 'session__body' })
          : h('p', { class: 'session__body' }, '（本文はありません）'),
      ]);
      append(clear(actions), [
        h('p', { class: 'session__ask' }, '思い出せましたか？'),
        ratingButtons(record, { size: '' }),
        // 読み返して気づいたことを、その場で残せるようにする
        h('div', { class: 'session__extra' },
          button('気づきを追記', {
            className: 'btn btn--text btn--sm',
            icon: icon('branch', { size: 16 }),
            onClick: () => openQuickCapture(store, { parentId: note.id }),
          })),
      ]);
    };

    if (revealed) {
      reveal();
    } else {
      answer.appendChild(h('p', { class: 'session__hint' }, '内容を思い出してから開きましょう'));
      actions.appendChild(button('内容を見る', {
        className: 'btn btn--block',
        icon: icon('eye', { size: 20 }),
        onClick: reveal,
      }));
    }

    append(clear(body), [
      h('div', { class: 'session__progress' },
        h('div', { class: 'session__bar' },
          h('span', { style: { width: `${(cursor / plan.length) * 100}%` } })),
        h('div', { class: 'session__count' }, `${cursor + 1} / ${plan.length}`)),
      h('div', { class: 'session__meta' },
        `${review.extra ? '追加復習' : `${review.step + 1}回目`}・予定日 ${formatSmart(review.due)}（${formatRelative(review.due)}）`),
      h('h2', { class: 'session__cue' }, recallCue(note)),
      note.tags.length ? h('div', { class: 'session__tags' },
        ...note.tags.map((t) => h('span', { class: 'chip chip--static' }, `#${t}`))) : null,
      answer,
      actions,
      h('div', { class: 'session__footer' },
        button('また後で（3日後に）', { className: 'btn btn--text btn--sm', onClick: later })),
    ]);
  }

  function finish({ aborted }) {
    const done = results.known + results.vague + results.forgot;
    if (aborted && done === 0) {
      dialog.close();
      return;
    }
    append(clear(body), [
      h('div', { class: 'session__done' },
        h('div', { class: 'session__done-icon', html: icon('sparkle', { size: 48 }) }),
        h('h2', { class: 'session__done-title' }, aborted ? `${done} 件まで進みました` : '今日の復習、おつかれさまでした'),
        h('div', { class: 'session__summary' },
          summaryItem(RATINGS.known.label, results.known, 'var(--fcc-rating-known)'),
          summaryItem(RATINGS.vague.label, results.vague, 'var(--fcc-rating-vague)'),
          summaryItem(RATINGS.forgot.label, results.forgot, 'var(--fcc-rating-forgot)')),
        results.skipped ? h('p', { class: 'field__hint' }, `${results.skipped} 件は 3 日後にまた出ます`) : null,
        h('p', { class: 'session__closing' }, 'また忘れる頃に会いましょう。'),
        button('閉じる', { className: 'btn btn--block', onClick: () => dialog.close() })),
    ]);
  }

  render();
  return dialog;
}

function summaryItem(label, value, color) {
  return h('div', { class: 'session__summary-item' },
    h('div', { class: 'session__summary-value', style: { color } }, String(value)),
    h('div', { class: 'session__summary-label' }, label));
}
