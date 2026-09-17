/** メモ一覧画面 */
import { h, button, iconButton } from '../dom.js';
import { icon } from '../icons.js';
import { noteCard, emptyState } from '../components.js';
import { openNoteEditor, openNoteDetail, openNoteMenu } from '../editor.js';
import { openExportDialog } from '../exportDialog.js';
import { displayTitle } from '../../core/models.js';
import { formatMedium, formatRelative, formatSmart } from '../../core/date.js';

const FILTERS = [
  { id: 'all', label: 'すべて' },
  { id: 'active', label: '復習中' },
  { id: 'graduated', label: '定着' },
  { id: 'archived', label: 'アーカイブ' },
];

const SORTS = [
  { id: 'next', label: '次の復習が近い順' },
  { id: 'new', label: '新しい順' },
  { id: 'old', label: '古い順' },
  { id: 'title', label: 'タイトル順' },
];

const state = { query: '', filter: 'all', tag: null, sort: 'next' };

export function renderNotes(store) {
  const root = h('div', { class: 'page page--narrow' });

  const notes = selectNotes(store);

  /* ---------------- ツールバー ---------------- */
  const searchInput = h('input', {
    type: 'search',
    placeholder: 'メモを検索',
    value: state.query,
    'aria-label': 'メモを検索',
    onInput: (e) => {
      state.query = e.target.value;
      renderList();
    },
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
      iconButton(icon('download'), {
        label: 'すべて出力',
        onClick: () => openExportDialog(store, notes, { title: 'メモを出力', baseName: 'forgetting-curve-notes' }),
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
      onClick: () => {
        state.filter = f.id;
        store.emit({ type: 'view:refresh' });
      },
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

  /* ---------------- 一覧 ---------------- */
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
      list.appendChild(noteCard({
        store,
        note,
        subtitle: next
          ? `次の復習 ${formatSmart(next.due)}（${formatRelative(next.due)}）`
          : `作成 ${formatMedium(note.anchorDate)}`,
        onOpen: (n, kind) => (kind === 'menu' ? openNoteMenu(store, n) : openNoteDetail(store, n.id)),
      }));
    });
  }

  renderList();
  return root;
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
    items = items.filter((n) => `${displayTitle(n)}\n${n.body}\n${n.tags.join(' ')}`
      .toLowerCase().includes(q));
  }
  const nextDue = (n) => n.reviews.find((r) => r.status === 'pending')?.due ?? '9999-12-31';
  const sorters = {
    next: (a, b) => nextDue(a).localeCompare(nextDue(b)),
    new: (a, b) => b.createdAt.localeCompare(a.createdAt),
    old: (a, b) => a.createdAt.localeCompare(b.createdAt),
    title: (a, b) => displayTitle(a).localeCompare(displayTitle(b), 'ja'),
  };
  return [...items].sort(sorters[state.sort] || sorters.next);
}

export { state as notesState };
