/**
 * デイリーミッションの UI。
 *
 * 置き場所は 3 つ:
 *   - アプリバーのリング（今日の達成数がひと目で分かる入口）
 *   - カレンダーの帯（ホームに戻ったときの「今日やること」）
 *   - ボトムシート（内訳・連続・レベル）
 */
import { h, append, clear } from './dom.js';
import { icon } from './icons.js';
import { openSheet, openDialog, toast } from './overlays.js';
import { svgFromMarkup } from './components.js';
import { MAX_SHIELDS, SHIELD_EVERY, COMPLETE_BONUS } from '../core/missions.js';
import { formatLong, todayKey } from '../core/date.js';

const RING = 2 * Math.PI * 15.5;

/** 達成数を輪で表す小さなリング（0〜1） */
function ringNode(ratio, { size = 30 } = {}) {
  const dash = Math.max(0, Math.min(1, ratio)) * RING;
  return svgFromMarkup(`<svg class="mission-ring__svg" viewBox="0 0 36 36" width="${size}" height="${size}"
    aria-hidden="true" focusable="false">
    <circle cx="18" cy="18" r="15.5" fill="none" stroke="currentColor" stroke-width="3" opacity=".22"/>
    <circle cx="18" cy="18" r="15.5" fill="none" stroke="currentColor" stroke-width="3"
      stroke-linecap="round" stroke-dasharray="${dash.toFixed(2)} ${(RING - dash).toFixed(2)}"
      transform="rotate(-90 18 18)"/>
  </svg>`);
}

/* ------------------------------------------------------------------ */
/* アプリバーの入口                                                     */
/* ------------------------------------------------------------------ */

export function missionButton(store) {
  const ring = h('span', { class: 'mission-ring' });
  const element = h('button', {
    type: 'button',
    class: 'appbar__mission',
    onClick: () => openMissionSheet(store),
  }, ring);

  function update() {
    if (!store.settings.missionsEnabled) {
      element.hidden = true;
      return;
    }
    element.hidden = false;
    const state = store.missionState();
    const ratio = state.total ? state.doneCount / state.total : 0;
    append(clear(ring), [
      ringNode(ratio),
      h('span', {
        class: 'mission-ring__count',
        html: state.allDone ? icon('check', { size: 14 }) : null,
      }, state.allDone ? null : `${state.doneCount}`),
    ]);
    element.dataset.complete = state.allDone ? 'true' : '';
    const label = `デイリーミッション（${state.doneCount}/${state.total} 達成`
      + `${state.streak.current ? `・連続 ${state.streak.current}日` : ''}）`;
    element.setAttribute('aria-label', label);
    element.title = label;
  }

  update();
  return { element, update };
}

/* ------------------------------------------------------------------ */
/* カレンダーの帯                                                       */
/* ------------------------------------------------------------------ */

export function missionStrip(store) {
  if (!store.settings.missionsEnabled) return null;
  const state = store.missionState();
  if (!state.total) return null;

  return h('button', {
    type: 'button',
    class: 'mission-strip',
    'aria-label': '今日のミッションを開く',
    onClick: () => openMissionSheet(store),
  },
  h('span', { class: 'mission-strip__icon', html: icon(state.allDone ? 'check' : 'mission', { size: 20 }) }),
  h('span', { class: 'mission-strip__body' },
    h('span', { class: 'mission-strip__title' },
      state.allDone ? '今日のミッション達成！' : '今日のミッション',
      h('span', { class: 'mission-strip__count' }, `${state.doneCount}/${state.total}`)),
    h('span', { class: 'mission-strip__bars' },
      ...state.missions.map((m) => h('span', {
        class: `mission-strip__bar ${m.done ? 'is-done' : ''}`,
        title: m.title,
      }, h('span', { style: { width: `${Math.round((m.progress / m.target) * 100)}%` } })))),
    h('span', { class: 'mission-strip__desc' },
      state.allDone
        ? `${state.streak.current ? `連続 ${state.streak.current}日目。` : ''}また明日、新しいお題が出ます。`
        : (state.missions.find((m) => !m.done)?.title || ''))),
  h('span', { class: 'mission-strip__chev', html: icon('chevronRight', { size: 18 }) }));
}

/* ------------------------------------------------------------------ */
/* ボトムシート                                                         */
/* ------------------------------------------------------------------ */

export function openMissionSheet(store) {
  const content = h('div', {});
  const render = () => {
    const state = store.missionState();
    const { level, streak } = state;
    append(clear(content), [
      h('h2', { class: 'daypanel__date', style: { marginBottom: '2px' } }, 'デイリーミッション'),
      h('div', { class: 'field__hint' }, `${formatLong(todayKey())}・毎日 0:00 に新しくなります`),

      /* 連続とレベル */
      h('div', { class: 'mission-head' },
        h('div', { class: `mission-streak ${streak.alive ? 'is-alive' : ''}` },
          h('span', { class: 'mission-streak__icon', html: icon('flame', { size: 20 }) }),
          h('span', { class: 'mission-streak__value' }, String(streak.current || 0)),
          h('span', { class: 'mission-streak__unit' }, '日連続')),
        h('div', { class: 'mission-level' },
          h('div', { class: 'mission-level__top' },
            h('span', { class: 'mission-level__rank' }, level.rank),
            h('span', { class: 'mission-level__lv' }, `Lv.${level.level}`)),
          h('div', { class: 'meter' }, h('span', { style: { width: `${Math.round(level.ratio * 100)}%` } })),
          h('div', { class: 'field__hint' },
            `${level.points} pt・次のレベルまで あと ${level.toNext} pt`))),

      streak.shields || streak.current >= 2
        ? h('div', { class: 'mission-shields' },
          h('span', { class: 'mission-shields__icons' },
            ...Array.from({ length: MAX_SHIELDS }, (_, i) => h('span', {
              class: `mission-shield ${i < streak.shields ? 'is-held' : ''}`,
              html: icon('shield', { size: 16 }),
            }))),
          h('span', { class: 'field__hint', style: { flex: '1' } },
            streak.shields
              ? `おまもりが ${streak.shields} 個。できない日があっても、連続を 1 日ぶん守ります。`
              : `${SHIELD_EVERY}日 続けるごとに、連続を守る「おまもり」がもらえます。`))
        : null,

      /* 今日のお題 */
      h('div', { class: 'mission-list' },
        ...state.missions.map((m) => h('div', { class: `mission-card ${m.done ? 'is-done' : ''}` },
          h('span', { class: 'mission-card__icon', html: icon(m.done ? 'check' : m.icon, { size: 20 }) }),
          h('div', { class: 'mission-card__body' },
            h('div', { class: 'mission-card__title' }, m.title),
            h('div', { class: 'mission-card__desc' }, m.desc),
            h('div', { class: 'meter meter--sm' },
              h('span', { style: { width: `${Math.round((m.progress / m.target) * 100)}%` } })),
            h('div', { class: 'mission-card__meta' },
              h('span', {}, `${m.progress} / ${m.target} ${m.unit}`),
              h('span', { class: 'mission-card__points' }, `+${m.points} pt`))))),
      ),

      state.allDone
        ? h('div', { class: 'banner banner--success', style: { marginTop: '12px' } },
          h('span', { html: icon('sparkle', { size: 18 }), style: { display: 'flex' } }),
          h('span', { style: { flex: '1' } },
            `今日のぶんは達成しました（+${COMPLETE_BONUS} pt のボーナス込みで ${state.earnedToday} pt）。`))
        : h('div', { class: 'field__hint', style: { marginTop: '12px' } },
          '全部そろえると、ボーナスと連続日数がつきます。できない日は、おまもりが守ります。'),

      h('div', { class: 'field__hint', style: { marginTop: '10px' } },
        'ミッションは「今日の予定の範囲」でしか出ません。増やすためではなく、続けるための目安です。'),
    ]);
  };

  render();
  // 開いている間に達成したら、その場で表示を更新する
  const unsubscribe = store.subscribe(() => render());
  return openSheet({ title: 'デイリーミッション', content, onClose: unsubscribe });
}

/* ------------------------------------------------------------------ */
/* 達成の知らせ                                                         */
/* ------------------------------------------------------------------ */

/** 1 つ達成するたび、静かに知らせる */
export function announceMissions(result) {
  if (!result) return;
  if (result.justCompletedAll) return;   // 全部そろったときは祝いの方で出す
  const first = result.newly[0];
  if (!first) return;
  const more = result.newly.length > 1 ? `ほか ${result.newly.length - 1} 件` : '';
  toast(`ミッション達成：${first.title} +${first.points}pt ${more}`.trim());
}

/** その日いちどだけ、全部そろったことを祝う */
export function celebrate(store, result) {
  if (!result?.justCompletedAll) return;
  if (!store.markCelebrated()) return;
  const state = store.missionState();
  const { level, streak } = state;

  openDialog({
    title: '',
    variant: 'alert',
    content: h('div', { class: 'celebrate' },
      h('div', { class: 'celebrate__burst', html: icon('sparkle', { size: 34 }) }),
      h('h2', { class: 'celebrate__title' }, '今日のミッション、そろいました'),
      h('div', { class: 'celebrate__streak' },
        h('span', { html: icon('flame', { size: 18 }), style: { display: 'flex' } }),
        `連続 ${streak.current} 日目`),
      h('p', { class: 'celebrate__text' },
        `今日は ${state.earnedToday} pt（ボーナス +${COMPLETE_BONUS} pt 込み）。`
        + `${level.rank}・Lv.${level.level}`),
      result.leveledUp
        ? h('p', { class: 'celebrate__level' }, `レベルが上がりました！ 称号は「${level.rank}」`)
        : null,
      result.awardedShield
        ? h('p', { class: 'celebrate__text' }, `${SHIELD_EVERY}日 続いたので、おまもりを 1 つ受け取りました。`)
        : null,
      result.usedShields
        ? h('p', { class: 'celebrate__text' }, `空いた ${result.usedShields} 日は、おまもりが守りました。`)
        : null,
      h('p', { class: 'celebrate__text celebrate__text--muted' },
        'また明日、新しいお題が出ます。忘れた頃に、ここで会いましょう。')),
    actions: [
      { label: '内訳を見る', className: 'btn btn--text', onClick: (close) => { close(); openMissionSheet(store); } },
      { label: 'ありがとう', className: 'btn', onClick: (close) => close() },
    ],
  });
}
