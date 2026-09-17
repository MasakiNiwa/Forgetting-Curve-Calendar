/** カレンダー画面 */
import { h, button, iconButton, clear } from '../dom.js';
import { icon } from '../icons.js';
import { reviewCard, noteCard, emptyState } from '../components.js';
import { openNoteEditor, openNoteDetail, openNoteMenu } from '../editor.js';
import { startReviewSession } from '../reviewSession.js';
import { openDialog, openSheet } from '../overlays.js';
import {
  diffDays, formatLong, formatMonth, formatRelative, monthMatrix, todayKey, weekdayLabels,
} from '../../core/date.js';

/** 画面をまたいで保持するローカル状態 */
const state = { year: null, month: null, selected: null };

const isCompact = () => window.innerWidth < 1000;

function ensureState() {
  if (state.year === null) {
    const now = new Date();
    state.year = now.getFullYear();
    state.month = now.getMonth();
    state.selected = todayKey();
  }
}

/** 指定日にカレンダーを合わせる（他画面からの遷移用） */
export function focusDate(key) {
  const [y, m] = key.split('-').map(Number);
  state.year = y;
  state.month = m - 1;
  state.selected = key;
}

export function renderCalendar(store) {
  ensureState();
  const today = todayKey();
  const settings = store.settings;

  const root = h('div', { class: 'page' });
  root.appendChild(todayCard(store));

  const layout = h('div', { class: 'calendar-layout' });
  const calendar = h('section', { class: 'calendar', 'aria-label': 'カレンダー' });

  const shiftMonth = (delta) => {
    const d = new Date(state.year, state.month + delta, 1);
    state.year = d.getFullYear();
    state.month = d.getMonth();
    store.emit({ type: 'view:refresh' });
  };

  calendar.appendChild(h('div', { class: 'calendar__toolbar' },
    h('button', {
      type: 'button',
      class: 'calendar__month',
      'aria-label': '年月を選ぶ',
      onClick: () => openMonthPicker(store),
    },
    formatMonth(state.year, state.month),
    h('span', { class: 'calendar__month-caret', html: icon('chevronDown', { size: 18 }) })),
    h('div', { style: { flex: '1' } }),
    iconButton(icon('chevronLeft'), { label: '前の月', onClick: () => shiftMonth(-1) }),
    button('今日', {
      className: 'btn btn--text btn--sm',
      onClick: () => { focusDate(today); store.emit({ type: 'view:refresh' }); },
    }),
    iconButton(icon('chevronRight'), { label: '次の月', onClick: () => shiftMonth(1) })));

  const weekdays = h('div', { class: 'calendar__weekdays' });
  weekdayLabels(settings.weekStart).forEach(({ label, index }) => {
    weekdays.appendChild(h('div', {
      class: [
        'calendar__weekday',
        index === 0 ? 'calendar__weekday--sun' : '',
        index === 6 ? 'calendar__weekday--sat' : '',
      ].filter(Boolean).join(' '),
    }, label));
  });
  calendar.appendChild(weekdays);

  const grid = h('div', { class: 'calendar__grid' });
  let monthPending = 0;

  monthMatrix(state.year, state.month, settings.weekStart).forEach((cell) => {
    const bucket = store.dayBucket(cell.key);
    const pending = bucket.reviews.filter((r) => r.review.status === 'pending');
    const done = bucket.reviews.filter((r) => r.review.status === 'done');
    const overdue = pending.length > 0 && diffDays(today, cell.key) < 0;
    if (cell.inMonth) monthPending += pending.length;

    grid.appendChild(h('button', {
      type: 'button',
      class: [
        'day',
        cell.inMonth ? '' : 'day--outside',
        cell.key === today ? 'day--today' : '',
        cell.key === state.selected ? 'day--selected' : '',
        cell.weekday === 0 ? 'day--sun' : '',
        cell.weekday === 6 ? 'day--sat' : '',
      ].filter(Boolean).join(' '),
      'aria-label': `${formatLong(cell.key)} 復習${pending.length}件`,
      'aria-pressed': String(cell.key === state.selected),
      onClick: () => selectDay(store, cell.key),
    },
    h('span', { class: 'day__num' }, String(cell.day)),
    h('span', { class: 'day__badges' },
      pending.length
        ? h('span', { class: `day__count ${overdue ? 'day__count--overdue' : ''}` }, String(pending.length))
        : null,
      !pending.length && done.length
        ? h('span', { class: 'day__count day__count--done', html: icon('check', { size: 12 }) })
        : null,
      settings.showCreatedOnCalendar && bucket.created.length
        ? h('span', { class: 'day__new', title: `${bucket.created.length} 件のメモ` })
        : null)));
  });
  calendar.appendChild(grid);

  calendar.appendChild(h('div', { class: 'calendar__legend' },
    h('span', { class: 'legend__item' },
      h('span', { class: 'legend__swatch', style: { background: 'var(--fcc-primary-container)' } }), '復習の予定'),
    h('span', { class: 'legend__item' },
      h('span', { class: 'legend__swatch', style: { background: 'var(--fcc-error-container)' } }), '思い出し待ち'),
    h('span', { class: 'legend__item' },
      h('span', { class: 'legend__swatch', style: { background: 'var(--fcc-tertiary)' } }), 'メモを書いた日'),
    h('span', { class: 'legend__item' }, `この月の復習 ${monthPending} 件`)));

  layout.appendChild(calendar);
  layout.appendChild(h('div', { class: 'calendar-layout__panel' }, renderDayPanel(store, state.selected)));
  root.appendChild(layout);
  return root;
}

/* ------------------------------------------------------------------ */
/* 今日カード                                                          */
/* ------------------------------------------------------------------ */

function todayCard(store) {
  const today = todayKey();
  const queue = store.todayQueue(today);
  const count = queue.items.length;
  const doneToday = store.stats().doneToday;

  if (!count) {
    // 「今日はここまで」を守る。追加は本人が望んだときだけ。
    const extra = queue.waiting > 0;
    return h('section', { class: 'today-card today-card--clear' },
      h('div', { class: 'today-card__icon', html: icon(doneToday ? 'check' : 'sparkle', { size: 22 }) }),
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('div', { class: 'today-card__title' },
          doneToday ? '今日の分は終わりました' : '今日の復習はありません'),
        h('div', { class: 'today-card__desc' },
          doneToday
            ? `${doneToday} 件を思い出しました。また忘れる頃に。`
            : 'メモを書くと、忘れた頃に戻ってきます。'),
        extra ? h('div', { class: 'today-card__desc' },
          `思い出し待ちが ${queue.waiting} 件ありますが、続きは明日で大丈夫です。`) : null),
      extra ? button('もう少しやる', {
        className: 'btn btn--text btn--sm',
        onClick: () => startReviewSession(store, {
          items: store.todayQueue(today, { extra: true }).items,
        }),
      }) : null);
  }

  return h('section', { class: 'today-card' },
    h('div', { class: 'today-card__main' },
      h('div', { class: 'today-card__label' }, '今日の記憶'),
      h('div', { class: 'today-card__counts' },
        h('span', { class: 'today-card__big' }, String(count)),
        h('span', { class: 'today-card__unit' }, '件'),
        queue.overdue.length
          ? h('span', { class: 'today-card__chip today-card__chip--overdue' }, `思い出し待ち ${queue.overdue.length}`)
          : null,
        doneToday ? h('span', { class: 'today-card__chip' }, `完了 ${doneToday}`) : null),
      queue.waiting
        ? h('div', { class: 'today-card__desc' }, `ほかに ${queue.waiting} 件は順番待ちです。今日はこの ${count} 件だけで大丈夫。`)
        : h('div', { class: 'today-card__desc' }, '思い出してから答え合わせをしましょう。')),
    button('思い出し始める', {
      className: 'btn today-card__cta',
      icon: icon('play', { size: 18 }),
      onClick: () => startReviewSession(store),
    }));
}

/* ------------------------------------------------------------------ */
/* 日付の選択                                                          */
/* ------------------------------------------------------------------ */

function selectDay(store, key) {
  state.selected = key;
  if (isCompact()) {
    openDaySheet(store, key);
    store.emit({ type: 'view:refresh' });
  } else {
    store.emit({ type: 'view:refresh' });
  }
}

/** モバイル: 日付をタップしたらボトムシートでその日の内容を出す */
function openDaySheet(store, key) {
  let unsubscribe = () => {};
  const sheet = openSheet({
    title: formatLong(key),
    content: renderDayPanel(store, key, { inSheet: true }),
    // 背景のタップや Esc で閉じたときも、必ず購読を解除する
    onClose: () => unsubscribe(),
  });
  unsubscribe = store.subscribe(() => {
    clear(sheet.body).appendChild(renderDayPanel(store, key, { inSheet: true }));
  });
  return sheet;
}

function renderDayPanel(store, dateKey, { inSheet = false } = {}) {
  const today = todayKey();
  const { overdue, waiting, reviews, created } = store.tasksFor(dateKey);
  const pending = reviews.filter((r) => r.review.status === 'pending');
  const finished = reviews.filter((r) => r.review.status !== 'pending');
  const open = (note, kind) => (kind === 'menu' ? openNoteMenu(store, note) : openNoteDetail(store, note.id));

  const panel = h('section', { class: `daypanel ${inSheet ? 'daypanel--sheet' : ''}`, 'aria-label': '選択した日の内容' });

  panel.appendChild(h('div', { class: 'daypanel__header' },
    h('div', { style: { flex: '1', minWidth: '0' } },
      h('h2', { class: 'daypanel__date' }, formatLong(dateKey)),
      h('div', { class: 'daypanel__meta' },
        `${formatRelative(dateKey, today)}・復習 ${pending.length + overdue.length} 件`)),
    iconButton(icon('plus'), {
      label: 'この日にメモを書く',
      className: 'icon-btn icon-btn--filled',
      onClick: () => openNoteEditor(store, { anchorDate: dateKey }),
    })));

  if (overdue.length + pending.length > 1) {
    panel.appendChild(button(`${overdue.length + pending.length} 件をまとめて復習`, {
      className: 'btn btn--tonal btn--block',
      icon: icon('play', { size: 18 }),
      onClick: () => startReviewSession(store, { items: [...overdue, ...pending] }),
    }));
  }

  const section = (iconName, label, items, renderItem, hint) => {
    if (!items.length) return;
    panel.appendChild(h('div', { class: 'daypanel__section-title' },
      h('span', { html: icon(iconName, { size: 16 }), style: { display: 'flex' } }),
      `${label}（${items.length}）`));
    if (hint) panel.appendChild(h('div', { class: 'field__hint', style: { marginBottom: '8px' } }, hint));
    items.forEach((item) => panel.appendChild(renderItem(item)));
  };

  section('clock', '思い出し待ち', overdue,
    ({ note, review }) => reviewCard({ store, note, review, onOpen: open }),
    waiting ? `ほかに ${waiting} 件は順番待ちです。今日の分を終えたら、続きは明日で大丈夫です。` : null);
  section('target', '思い出し直すメモ', pending, ({ note, review }) => reviewCard({ store, note, review, onOpen: open }));
  section('check', '終わった復習', finished, ({ note, review }) => reviewCard({ store, note, review, onOpen: open }));
  section('edit', 'この日に書いたメモ', created, (note) => noteCard({ store, note, onOpen: open, subtitle: 'この日に作成' }));

  if (!overdue.length && !pending.length && !finished.length && !created.length) {
    panel.appendChild(emptyState({
      iconName: 'sparkle',
      title: 'この日の予定はありません',
      text: dateKey === today
        ? 'メモを書くと、忘却曲線に沿って未来の日付に復習が並びます。'
        : 'メモを書くと、この先の日付に復習が積み上がっていきます。',
      action: button('メモを書く', {
        className: 'btn',
        icon: icon('plus', { size: 18 }),
        onClick: () => openNoteEditor(store, { anchorDate: dateKey }),
      }),
    }));
  }

  return panel;
}

/* ------------------------------------------------------------------ */
/* 年月ピッカー                                                        */
/* ------------------------------------------------------------------ */

const MONTH_LABELS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

export function openMonthPicker(store) {
  ensureState();
  let year = state.year;
  const content = h('div', { class: 'monthpicker' });
  let dialog;

  const jump = (y, m) => {
    state.year = y;
    state.month = m;
    const target = `${y}-${String(m + 1).padStart(2, '0')}`;
    // 選択日はその月の中に収める
    if (!state.selected.startsWith(target)) state.selected = `${target}-01`;
    dialog.close();
    store.emit({ type: 'view:refresh' });
  };

  const render = () => {
    const yearInput = h('input', {
      class: 'input monthpicker__year-input',
      type: 'number',
      value: String(year),
      min: '1900',
      max: '2999',
      'aria-label': '年',
      onChange: (e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v) && v >= 1900 && v <= 2999) { year = Math.round(v); render(); }
      },
    });

    const months = h('div', { class: 'monthpicker__months' },
      ...MONTH_LABELS.map((label, i) => {
        const count = countMonth(store, year, i);
        return h('button', {
          type: 'button',
          class: `monthpicker__month ${year === state.year && i === state.month ? 'monthpicker__month--current' : ''}`,
          onClick: () => jump(year, i),
        },
        h('span', {}, label),
        count ? h('span', { class: 'monthpicker__count' }, String(count)) : null);
      }));

    clear(content).append(
      h('div', { class: 'monthpicker__year' },
        iconButton(icon('chevronLeft'), { label: '前の年', onClick: () => { year -= 1; render(); } }),
        yearInput,
        iconButton(icon('chevronRight'), { label: '次の年', onClick: () => { year += 1; render(); } })),
      h('div', { class: 'monthpicker__jumps' },
        ...quickJumps(store).map(({ label, key }) => h('button', {
          type: 'button',
          class: 'chip',
          onClick: () => {
            const [y, m] = key.split('-').map(Number);
            state.selected = key;
            jump(y, m - 1);
          },
        }, label))),
      months,
      h('div', { class: 'field__hint' }, '数字は、その月に予定されている復習の件数です。'),
    );
  };

  render();
  dialog = openDialog({ title: '年月を選ぶ', content, variant: 'alert' });
  return dialog;
}

function countMonth(store, year, month) {
  const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  let count = 0;
  store.index.forEach((bucket, key) => {
    if (key.startsWith(prefix)) count += bucket.reviews.filter((r) => r.review.status === 'pending').length;
  });
  return count;
}

/** 「今日」「最初のメモ」「最後の復習」への近道 */
function quickJumps(store) {
  const jumps = [{ label: '今日', key: todayKey() }];
  const dates = [...store.index.keys()].sort();
  if (dates.length) {
    const created = store.notes.map((n) => n.anchorDate).sort();
    if (created.length) jumps.push({ label: '最初のメモ', key: created[0] });
    const lastPending = store.notes
      .flatMap((n) => n.reviews.filter((r) => r.status === 'pending').map((r) => r.due))
      .sort();
    if (lastPending.length) jumps.push({ label: '最後の復習', key: lastPending[lastPending.length - 1] });
  }
  return jumps;
}

export { state as calendarState };
