/** メモ一覧画面 */
import { h, button, iconButton } from '../dom.js';
import { icon } from '../icons.js';
import { noteCard, emptyState } from '../components.js';
import { openNoteEditor, openNoteDetail, openNoteMenu } from '../editor.js';
import { openExportDialog } from '../exportDialog.js';
import { toast } from '../overlays.js';
import { displayTitle } from '../../core/models.js';
import { formatRelative, formatSmart } from '../../core/date.js';

const FILTERS = [
  { id: 'all', label: 'すべて' },
  { id: 'active', label: '復習中' },
  { id: 'inbox', label: '復習なし' },
  { id: 'graduated', label: '定着' },
  { id: 'archived', label: 'アーカイブ' },
];

const SORTS = [
  { id: 'updated', label: '最近さわった順' },
  { id: 'next', label: '次の復習が近い順' },
  { id: 'new', label: '書いた順（新しい）' },
  { id: 'old', label: '書いた順（古い）' },
  { id: 'title', label: 'タイトル順' },
];

const state = { query: '', filter: 'all', tag: null, sort: 'updated' };

export function renderNotes(store) {
  const root = h('div', { class: 'page page--narrow' });
  const visible = selectNotes(store);

  const searchInput = h('input', {
    type: 'search',
    placeholder: 'メモ・手掛かり・タグを検索',
    value: state.query,
    'aria-label': 'メモを検索',
    onInput: (e) => { state.query = e.target.value; renderList(); },
  });

  const sortSelect = h('select', {
    class: 'select',
    style: { width: 'auto', minWidth: '11em', alignSelf: 'flex-start' },
    'aria-label': '並び替え',
    onChange: (e) => { state.sort = e.target.value; renderList(); },
  }, ...SORTS.map((s) => h('option', { value: s.id, selected: s.id === state.sort }, s.label)));

  root.appendChild(h('div', { class: 'page__header' },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
      h('div', { style: { flex: '1' } },
        h('h1', { class: 'page__title' }, 'メモ'),
        h('div', { class: 'page__subtitle' }, `全 ${store.notes.length} 件`)),
      button('書く', {
        className: 'btn btn--tonal btn--sm',
        icon: icon('plus', { size: 18 }),
        onClick: () => openNoteEditor(store),
      }),
      iconButton(icon('download'), {
        label: 'すべて出力',
        onClick: () => openExportDialog(store, visible, { title: 'メモを出力', baseName: 'forgetting-curve-notes' }),
      }))));

  root.appendChild(h('div', { class: 'notes-toolbar' },
    h('div', { class: 'search' },
      h('span', { html: icon('search', { size: 20 }), style: { display: 'flex' } }),
      searchInput),
    sortSelect));

  const filterRow = h('div', { class: 'filter-row' });
  FILTERS.forEach((f) => {
    filterRow.appendChild(h('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': String(state.filter === f.id),
      onClick: () => { state.filter = f.id; store.emit({ type: 'view:refresh' }); },
    }, f.label));
  });
  store.allTags().slice(0, 20).forEach(([tag, count]) => {
    filterRow.appendChild(h('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': String(state.tag === tag),
      onClick: () => {
        state.tag = state.tag === tag ? null : tag;
        store.emit({ type: 'view:refresh' });
      },
    }, `#${tag} ${count}`));
  });
  root.appendChild(filterRow);

  if (state.tag || state.filter !== 'all' || state.query) {
    root.appendChild(h('div', { class: 'notes-active-filter' },
      h('span', {}, `絞り込み中: ${[
        state.filter !== 'all' ? FILTERS.find((f) => f.id === state.filter).label : null,
        state.tag ? `#${state.tag}` : null,
        state.query ? `「${state.query}」` : null,
      ].filter(Boolean).join(' / ')}`),
      button('すべて解除', {
        className: 'btn btn--text btn--sm',
        onClick: () => {
          state.tag = null;
          state.filter = 'all';
          state.query = '';
          store.emit({ type: 'view:refresh' });
        },
      })));
  }

  const list = h('div', { style: { marginTop: '16px' } });
  root.appendChild(list);

  function renderList() {
    const items = applyQuery(selectNotes(store));
    list.replaceChildren();
    if (!items.length) {
      list.appendChild(emptyState({
        iconName: store.notes.length ? 'search' : 'sparkle',
        title: store.notes.length ? '条件に合うメモがありません' : 'まだメモがありません',
        text: store.notes.length
          ? '検索語やフィルタを変えてみてください。'
          : '最初のメモを書くと、忘却曲線に沿った復習がカレンダーに並びます。',
        action: store.notes.length ? null : button('メモを書く', {
          className: 'btn',
          icon: icon('plus', { size: 18 }),
          onClick: () => openNoteEditor(store),
        }),
      }));
      return;
    }
    items.forEach((note) => {
      const next = note.reviews.find((r) => r.status === 'pending');
      const card = noteCard({
        store,
        note,
        subtitle: subtitleFor(note, next),
        onOpen: (n, kind) => (kind === 'menu' ? openNoteMenu(store, n) : openNoteDetail(store, n.id)),
        actions: [
          button('編集', {
            className: 'btn btn--text btn--sm',
            icon: icon('edit', { size: 16 }),
            onClick: (e) => { e.stopPropagation(); openNoteEditor(store, { noteId: note.id }); },
          }),
          button('追加メモ', {
            className: 'btn btn--text btn--sm',
            icon: icon('branch', { size: 16 }),
            onClick: (e) => { e.stopPropagation(); openNoteEditor(store, { parentId: note.id }); },
          }),
          note.status === 'inbox' ? button('復習を始める', {
            className: 'btn btn--text btn--sm',
            icon: icon('play', { size: 16 }),
            onClick: (e) => {
              e.stopPropagation();
              store.restartNote(note.id);
              toast('今日を起点に復習を組みました');
            },
          }) : null,
        ].filter(Boolean),
      });
      list.appendChild(card);
    });
  }

  renderList();
  return root;
}

function subtitleFor(note, next) {
  if (note.status === 'inbox') return '復習の予定なし';
  if (note.status === 'archived') return 'アーカイブ';
  if (next) return `次の復習 ${formatSmart(next.due)}（${formatRelative(next.due)}）`;
  return '定着';
}

function selectNotes(store) {
  return store.notes.filter((n) => {
    if (state.filter === 'all') return n.status !== 'archived';
    return n.status === state.filter;
  });
}

function applyQuery(notes) {
  const q = state.query.trim().toLowerCase();
  let items = notes;
  if (state.tag) items = items.filter((n) => n.tags.includes(state.tag));
  if (q) {
    items = items.filter((n) => `${displayTitle(n)}\n${n.cue}\n${n.body}\n${n.tags.join(' ')}`
      .toLowerCase().includes(q));
  }
  const nextDue = (n) => n.reviews.find((r) => r.status === 'pending')?.due ?? '9999-12-31';
  const sorters = {
    updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    next: (a, b) => nextDue(a).localeCompare(nextDue(b)),
    new: (a, b) => b.createdAt.localeCompare(a.createdAt),
    old: (a, b) => a.createdAt.localeCompare(b.createdAt),
    title: (a, b) => displayTitle(a).localeCompare(displayTitle(b), 'ja'),
  };
  return [...items].sort(sorters[state.sort] || sorters.updated);
}

export { state as notesState };
