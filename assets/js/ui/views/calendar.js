/** カレンダー画面 */
import { h, button, iconButton } from '../dom.js';
import { icon } from '../icons.js';
import { reviewCard, noteCard, emptyState } from '../components.js';
import { openNoteEditor, openNoteDetail, openNoteMenu } from '../editor.js';
import {
  diffDays, formatLong, formatMonth, formatRelative, monthMatrix, todayKey, weekdayLabels,
} from '../../core/date.js';

/** 画面をまたいで保持するローカル状態 */
const state = { year: null, month: null, selected: null, scrollToPanel: false };

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
  const layout = h('div', { class: 'calendar-layout' });

  const calendar = h('section', { class: 'calendar', 'aria-label': 'カレンダー' });

  const shiftMonth = (delta) => {
    const d = new Date(state.year, state.month + delta, 1);
    state.year = d.getFullYear();
    state.month = d.getMonth();
    store.emit({ type: 'view:refresh' });
  };

  calendar.appendChild(h('div', { class: 'calendar__toolbar' },
    h('div', { class: 'calendar__month' }, formatMonth(state.year, state.month)),
    h('div', { style: { flex: 1 } }),
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
      onClick: () => {
        state.selected = cell.key;
        state.scrollToPanel = true;
        store.emit({ type: 'view:refresh' });
      },
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
      h('span', { class: 'legend__swatch', style: { background: 'var(--fcc-error-container)' } }), '期限切れ'),
    h('span', { class: 'legend__item' },
      h('span', { class: 'legend__swatch', style: { background: 'var(--fcc-tertiary)' } }), 'メモを書いた日'),
    h('span', { class: 'legend__item' }, `この月の復習 ${monthPending} 件`)));

  const panel = renderDayPanel(store, state.selected);
  layout.appendChild(calendar);
  layout.appendChild(panel);
  root.appendChild(layout);

  // モバイルでは日付を選んだら、その日のタスクまでスクロールする
  if (state.scrollToPanel) {
    state.scrollToPanel = false;
    if (window.innerWidth < 1000) {
      requestAnimationFrame(() => panel.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  }

  return root;
}

/* ------------------------------------------------------------------ */

function renderDayPanel(store, dateKey) {
  const today = todayKey();
  const { overdue, reviews, created } = store.tasksFor(dateKey);
  const pending = reviews.filter((r) => r.review.status === 'pending');
  const finished = reviews.filter((r) => r.review.status !== 'pending');
  const open = (note, kind) => (kind === 'menu' ? openNoteMenu(store, note) : openNoteDetail(store, note.id));

  const panel = h('section', { class: 'daypanel', 'aria-label': '選択した日の内容' });

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

  const section = (iconName, label, items, renderItem) => {
    if (!items.length) return;
    panel.appendChild(h('div', { class: 'daypanel__section-title' },
      h('span', { html: icon(iconName, { size: 16 }), style: { display: 'flex' } }),
      `${label}（${items.length}）`));
    items.forEach((item) => panel.appendChild(renderItem(item)));
  };

  section('clock', '期限切れの復習', overdue, ({ note, review }) => reviewCard({ store, note, review, onOpen: open }));
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

export { state as calendarState };
