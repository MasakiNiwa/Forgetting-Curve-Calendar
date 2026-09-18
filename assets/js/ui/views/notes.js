/** メモ一覧画面 */
import { h, button, iconButton, clear } from '../dom.js';
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

/** 直前に編集していたメモ。一覧へ戻ったとき、どれを見ていたか分かるようにする。 */
let focusId = null;

/** 編集画面から一覧へ戻るときに呼ぶ */
export function focusNote(id) {
  focusId = id || null;
}

export function renderNotes(store) {
  const root = h('div', { class: 'page page--narrow' });
  const visible = selectNotes(store);

  // 打つたびに全部を絞り込むと、メモが増えたとき重くなる。少し待ってからまとめて絞る
  let queryTimer = null;
  const searchInput = h('input', {
    type: 'search',
    placeholder: 'メモ・手掛かり・タグを検索',
    value: state.query,
    'aria-label': 'メモを検索',
    onInput: (e) => {
      state.query = e.target.value;
      clearTimeout(queryTimer);
      queryTimer = setTimeout(() => renderList(), 140);
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
      button('書く', {
        className: 'btn btn--tonal btn--sm',
        icon: icon('plus', { size: 18 }),
        onClick: () => openNoteEditor(store),
      }),
      iconButton(icon('download'), {
        label: 'すべて出力',
        onClick: () => openExportDialog(store, visible, { title: 'メモを出力', baseName: 'forgetting-curve-notes' }),
      }))));

  // 検索と絞り込みは、スクロールしても上に残す（長い一覧でも操作を見失わない）
  const sticky = h('div', { class: 'notes-sticky' });
  sticky.appendChild(h('div', { class: 'notes-toolbar' },
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
  sticky.appendChild(filterRow);

  if (state.tag || state.filter !== 'all' || state.query) {
    sticky.appendChild(h('div', { class: 'notes-active-filter' },
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

  // 上に貼り付いたときだけ、影と区切り線を出す
  const sentinel = h('div', { class: 'notes-sticky__sentinel' });
  root.appendChild(sentinel);
  root.appendChild(sticky);
  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver(([entry]) => {
      sticky.dataset.stuck = entry.isIntersecting ? '' : 'true';
    }, { threshold: 1 });
    io.observe(sentinel);
  }

  const list = h('div', { class: 'notes-list' });
  const more = h('div', { class: 'notes-more', hidden: true });
  root.appendChild(list);
  root.appendChild(more);

  /** 一度に描く枚数（メモが増えても、開いた瞬間が重くならないように） */
  const PAGE = 40;
  let moreObserver = null;

  function renderList() {
    const items = applyQuery(selectNotes(store));
    list.replaceChildren();
    clear(more);
    more.hidden = true;
    moreObserver?.disconnect();
    moreObserver = null;
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
    let shown = 0;
    const appendChunk = () => {
      const slice = items.slice(shown, shown + PAGE);
      const frag = document.createDocumentFragment();
      slice.forEach((note) => frag.appendChild(makeCard(note)));
      list.appendChild(frag);
      shown += slice.length;
      updateMore();
    };

    function updateMore() {
      const rest = items.length - shown;
      if (rest <= 0) {
        more.hidden = true;
        clear(more);
        moreObserver?.disconnect();
        moreObserver = null;
        return;
      }
      more.hidden = false;
      clear(more).append(
        button(`さらに ${Math.min(PAGE, rest)} 件を表示（残り ${rest} 件）`, {
          className: 'btn btn--tonal btn--block',
          onClick: () => appendChunk(),
        }),
      );
      // スクロールで下まで来たら、そのまま続きを足す
      if (typeof IntersectionObserver === 'function' && !moreObserver) {
        moreObserver = new IntersectionObserver((entries) => {
          if (entries.some((e) => e.isIntersecting)) appendChunk();
        }, { rootMargin: '400px' });
        moreObserver.observe(more);
      }
    }

    function makeCard(note) {
      const next = note.reviews.find((r) => r.status === 'pending');
      const el = noteCard({
        store,
        note,
        subtitle: subtitleFor(note, next),
        // 選んだら、そのまま全画面の編集画面へ入る
        onOpen: (n, kind) => (kind === 'menu' ? openNoteMenu(store, n) : openNoteEditor(store, { noteId: n.id, returnTo: 'notes' })),
        actions: [
          button('詳細', {
            className: 'btn btn--text btn--sm',
            icon: icon('info', { size: 16 }),
            onClick: (e) => { e.stopPropagation(); openNoteDetail(store, note.id); },
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
      if (note.id === focusId) {
        el.classList.add('note-card--focus');
        el.dataset.focus = 'true';
      }
      return el;
    }

    // 戻ってきたメモが後ろの方にあるときは、そこまで描いてから連れていく
    if (focusId) {
      const at = items.findIndex((n) => n.id === focusId);
      while (shown <= at) appendChunk();
    }
    if (!shown) appendChunk();

    const target = list.querySelector('[data-focus="true"]');
    if (target) {
      requestAnimationFrame(() => {
        target.scrollIntoView({ block: 'nearest' });
        setTimeout(() => target.classList.remove('note-card--focus'), 1600);
      });
      focusId = null;
    }
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
