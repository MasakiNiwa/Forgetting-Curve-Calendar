/** メモの作成・編集・詳細表示 */
import { h, button, iconButton, clear } from './dom.js';
import { icon } from './icons.js';
import { openDialog, openSheet, openMenu, confirmDialog, toast } from './overlays.js';
import { curvePreview, reviewTimeline, noteCard, tagChips } from './components.js';
import { openExportDialog } from './exportDialog.js';
import { PRESETS, getPreset, resolveIntervals, sanitizeIntervals } from '../core/curve.js';
import { displayTitle } from '../core/models.js';
import { addDays, diffDays, formatDateTime, formatLong, formatMedium, formatRelative, formatSmart, todayKey } from '../core/date.js';

/* ------------------------------------------------------------------ */
/* エディタ                                                            */
/* ------------------------------------------------------------------ */

/**
 * メモエディタを開く。
 * @param {Store} store
 * @param {{noteId?:string, parentId?:string, anchorDate?:string}} options
 */
export function openNoteEditor(store, options = {}) {
  const existing = options.noteId ? store.getNote(options.noteId) : null;
  const parent = options.parentId ? store.getNote(options.parentId) : null;
  const settings = store.settings;

  const state = {
    title: existing?.title ?? '',
    body: existing?.body ?? '',
    tags: (existing?.tags ?? parent?.tags ?? []).join(' '),
    anchorDate: existing?.anchorDate ?? options.anchorDate ?? todayKey(),
    presetId: existing?.schedule.presetId ?? settings.presetId,
    intervals: existing ? [...existing.schedule.intervals] : resolveIntervals(settings.presetId, settings),
  };

  const bodyInput = h('textarea', {
    class: 'textarea',
    placeholder: '覚えておきたいことを書きます。1 行目がタイトルとして使われます。',
    value: state.body,
    onInput: (e) => { state.body = e.target.value; },
  });

  const titleInput = h('input', {
    class: 'input',
    type: 'text',
    placeholder: '（省略すると本文の1行目）',
    value: state.title,
    onInput: (e) => { state.title = e.target.value; },
  });

  const tagsInput = h('input', {
    class: 'input',
    type: 'text',
    placeholder: '英語 語彙 仕事（スペース区切り）',
    value: state.tags,
    onInput: (e) => { state.tags = e.target.value; },
  });

  const dateInput = h('input', {
    class: 'input',
    type: 'date',
    value: state.anchorDate,
    onChange: (e) => { state.anchorDate = e.target.value || todayKey(); renderSchedule(); },
  });

  const presetSelect = h('select', {
    class: 'select',
    onChange: (e) => {
      state.presetId = e.target.value;
      state.intervals = state.presetId === 'custom'
        ? sanitizeIntervals(settings.customIntervals)
        : [...getPreset(state.presetId).intervals];
      renderSchedule();
    },
  }, ...PRESETS.map((p) => h('option', { value: p.id, selected: p.id === state.presetId }, `${p.name}（${p.intervals.length}回）`)));

  const scheduleBox = h('div', { class: 'card', style: { background: 'var(--fcc-surface-container)' } });

  function renderSchedule() {
    clear(scheduleBox);
    const preset = getPreset(state.presetId);
    const intervals = sanitizeIntervals(state.intervals);
    scheduleBox.append(
      h('div', { class: 'card__title' }, '復習の予定'),
      h('div', { class: 'card__desc' }, preset.description),
      curvePreview(intervals),
      h('div', { class: 'filter-row', style: { marginTop: '8px', flexWrap: 'wrap' } },
        ...intervals.slice(0, 10).map((d) => h('span', { class: 'chip chip--static' },
          formatSmart(addDays(state.anchorDate, d))))),
      intervals.length > 10 ? h('div', { class: 'field__hint' }, `ほか ${intervals.length - 10} 回`) : null,
      h('div', { class: 'field__hint' }, `合計 ${intervals.length} 回・最終 ${formatSmart(addDays(state.anchorDate, intervals[intervals.length - 1]))}`),
    );
  }
  renderSchedule();

  const content = h('div', {},
    parent ? h('div', {
      class: 'card',
      style: { background: 'var(--fcc-tertiary-container)', color: 'var(--fcc-on-tertiary-container)' },
    },
    h('div', { class: 'card__title' },
      h('span', { html: icon('branch', { size: 18 }), style: { display: 'flex' } }),
      '追加メモ'),
    h('div', { style: { fontSize: '.82rem' } }, `「${displayTitle(parent)}」に紐付けて保存し、このメモ自身の忘却曲線を作ります。`)) : null,

    h('label', { class: 'field' },
      h('span', { class: 'field__label' }, '本文'),
      bodyInput),

    h('label', { class: 'field' },
      h('span', { class: 'field__label' }, 'タイトル（任意）'),
      titleInput),

    h('label', { class: 'field' },
      h('span', { class: 'field__label' }, 'タグ（任意）'),
      tagsInput),

    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } },
      h('label', { class: 'field' },
        h('span', { class: 'field__label' }, '起点の日'),
        dateInput),
      h('label', { class: 'field' },
        h('span', { class: 'field__label' }, '忘却曲線'),
        presetSelect)),

    scheduleBox);

  const dialog = openDialog({
    title: existing ? 'メモを編集' : parent ? '追加メモを書く' : '新しいメモ',
    content,
    actions: [
      { label: 'キャンセル', className: 'btn btn--text', onClick: (close) => close() },
      {
        label: '保存',
        className: 'btn',
        onClick: (close) => {
          if (!state.body.trim() && !state.title.trim()) {
            toast('本文かタイトルを入力してください');
            return;
          }
          if (existing) {
            store.updateNote(existing.id, {
              title: state.title,
              body: state.body,
              tags: state.tags,
              presetId: state.presetId,
              intervals: state.intervals,
            });
            toast('メモを更新しました');
          } else {
            const note = store.addNote({
              title: state.title,
              body: state.body,
              tags: state.tags,
              anchorDate: state.anchorDate,
              parentId: options.parentId || null,
              presetId: state.presetId,
              intervals: state.intervals,
            });
            const first = note.reviews[0];
            toast(first ? `保存しました。次の復習は ${formatRelative(first.due)}` : '保存しました');
          }
          close();
        },
      },
    ],
  });

  setTimeout(() => bodyInput.focus({ preventScroll: true }), 60);
  return dialog;
}

/* ------------------------------------------------------------------ */
/* 詳細表示                                                            */
/* ------------------------------------------------------------------ */

export function openNoteDetail(store, noteId) {
  const render = () => {
    const note = store.getNote(noteId);
    if (!note) return h('div', {}, 'メモが見つかりませんでした。');
    const parent = note.parentId ? store.getNote(note.parentId) : null;
    const children = store.childrenOf(note.id);
    const next = note.reviews.find((r) => r.status === 'pending');

    return h('div', {},
      h('div', { class: 'daypanel__header' },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('h2', { class: 'daypanel__date daypanel__date--clamp' }, displayTitle(note)),
          h('div', { class: 'daypanel__meta' },
            `${formatLong(note.anchorDate)} 作成`,
            note.status === 'graduated' ? '・定着済み' : '',
            note.status === 'archived' ? '・アーカイブ' : '')),
        iconButton(icon('more'), { label: '操作', onClick: () => openNoteMenu(store, note) })),

      parent ? h('button', {
        class: 'chip',
        style: { marginTop: '8px' },
        onClick: () => openNoteDetail(store, parent.id),
      }, `元のメモ: ${displayTitle(parent)}`) : null,

      note.tags.length ? h('div', { style: { marginTop: '10px' } }, tagChips(note.tags)) : null,

      note.body ? h('p', {
        style: {
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: '14px',
          background: 'var(--fcc-surface-container)', padding: '14px',
          borderRadius: 'var(--fcc-radius-m)', fontSize: '.9rem',
        },
      }, note.body) : null,

      h('div', { class: 'note-card__actions', style: { marginTop: '14px' } },
        button('編集', {
          className: 'btn btn--tonal btn--sm',
          icon: icon('edit', { size: 18 }),
          onClick: () => openNoteEditor(store, { noteId: note.id }),
        }),
        button('追加メモ', {
          className: 'btn btn--tonal btn--sm',
          icon: icon('branch', { size: 18 }),
          onClick: () => openNoteEditor(store, { parentId: note.id }),
        }),
        button('出力', {
          className: 'btn btn--text btn--sm',
          icon: icon('download', { size: 18 }),
          onClick: () => openExportDialog(store, [note, ...children], { title: 'このメモを出力', baseName: 'note' }),
        })),

      h('div', { class: 'daypanel__section-title' }, `復習の記録（${note.reviews.filter((r) => r.status !== 'pending').length}/${note.reviews.length}）`),
      next ? h('div', { class: 'field__hint', style: { marginBottom: '8px' } },
        diffDays(todayKey(), next.due) < 0
          ? `次の復習は ${formatSmart(next.due)}（${formatRelative(next.due)}に期限切れ）・定着度 ${note.schedule.ease.toFixed(2)}`
          : `次の復習は ${formatSmart(next.due)}（${formatRelative(next.due)}）・定着度 ${note.schedule.ease.toFixed(2)}`)
        : h('div', { class: 'field__hint', style: { marginBottom: '8px' } }, 'すべての復習が終わりました。'),
      reviewTimeline(store, note),

      note.status === 'graduated' ? button('もう一周する', {
        className: 'btn btn--outlined btn--block',
        icon: icon('refresh', { size: 18 }),
        onClick: () => { store.restartNote(note.id); toast('今日を起点に復習を組み直しました'); },
      }) : null,

      children.length ? h('div', {},
        h('div', { class: 'daypanel__section-title' }, `追加メモ（${children.length}）`),
        ...children.map((c) => noteCard({
          store,
          note: c,
          onOpen: (n, kind) => (kind === 'menu' ? openNoteMenu(store, n) : openNoteDetail(store, n.id)),
        }))) : null,

      h('div', { class: 'field__hint', style: { marginTop: '16px' } },
        `更新 ${formatDateTime(note.updatedAt)}`));
  };

  const sheet = openSheet({ title: 'メモの詳細', content: render() });
  const unsubscribe = store.subscribe(() => {
    if (!store.getNote(noteId)) { sheet.close(); return; }
    clear(sheet.body).appendChild(render());
  });
  const origClose = sheet.close;
  sheet.close = () => { unsubscribe(); origClose(); };
  return sheet;
}

/* ------------------------------------------------------------------ */
/* メニュー                                                            */
/* ------------------------------------------------------------------ */

export function openNoteMenu(store, note) {
  const children = store.childrenOf(note.id);
  openMenu({
    title: displayTitle(note),
    items: [
      { label: '編集する', icon: icon('edit', { size: 20 }), onClick: () => openNoteEditor(store, { noteId: note.id }) },
      { label: '追加メモを書く', icon: icon('branch', { size: 20 }), description: 'このメモから新しい忘却曲線を作る', onClick: () => openNoteEditor(store, { parentId: note.id }) },
      { label: '出力する', icon: icon('download', { size: 20 }), onClick: () => openExportDialog(store, [note, ...children], { title: 'このメモを出力', baseName: 'note' }) },
      { divider: true },
      {
        label: '復習を今日からやり直す',
        icon: icon('refresh', { size: 20 }),
        description: '今日を起点に曲線を組み直す',
        onClick: () => { store.restartNote(note.id); toast('復習を組み直しました'); },
      },
      {
        label: note.status === 'archived' ? 'アーカイブを解除' : 'アーカイブする',
        icon: icon('archive', { size: 20 }),
        description: 'カレンダーから外して保管する',
        onClick: () => {
          store.archiveNote(note.id, note.status !== 'archived');
          toast(note.status === 'archived' ? 'アーカイブを解除しました' : 'アーカイブしました');
        },
      },
      { divider: true },
      {
        label: '削除する',
        icon: icon('trash', { size: 20 }),
        danger: true,
        description: children.length ? `追加メモ ${children.length} 件も削除されます` : undefined,
        onClick: async () => {
          const ok = await confirmDialog({
            title: 'メモを削除しますか？',
            message: children.length
              ? `「${displayTitle(note)}」と追加メモ ${children.length} 件、復習の記録もまとめて削除します。`
              : `「${displayTitle(note)}」と復習の記録を削除します。`,
            confirmLabel: '削除',
            danger: true,
          });
          if (!ok) return;
          const removed = store.deleteNote(note.id);
          toast('削除しました', {
            actionLabel: '元に戻す',
            onAction: () => { store.restoreNotes(removed); toast('復元しました'); },
          });
        },
      },
    ],
  });
}
