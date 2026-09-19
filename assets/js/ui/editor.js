/** メモの詳細表示・操作メニューと、編集画面への入口 */
import { bodyView } from './markdownView.js';
import { h, button, iconButton, clear } from './dom.js';
import { icon } from './icons.js';
import { openDialog, openSheet, openMenu, confirmDialog, closeAllOverlays, toast } from './overlays.js';
import { branchTree, reviewTimeline, tagChips } from './components.js';
import { openExportDialog } from './exportDialog.js';
import { navigate, parseHash } from './router.js';
import { displayTitle, recallCue } from '../core/models.js';
import { clearDraft, draftKey, isEmptyDraft, loadDraft, saveDraft } from '../core/drafts.js';
import { localDayOf } from '../core/curve.js';
import {
  diffDays, formatDateTime, formatLong, formatMedium, formatRelative, formatSmart, todayKey,
} from '../core/date.js';

/**
 * メモの編集を開く。
 * v0.5 から、編集は全画面の専用画面（#/note/<id>）で行う。
 * 呼び出し側を変えずに済むよう、関数名と引数はそのままにしてある。
 */
export function openNoteEditor(store, options = {}) {
  // 詳細シートなどを開いたまま遷移しないように、先に閉じる
  closeAllOverlays();
  const from = options.returnTo || currentSection();
  if (options.noteId) {
    // 昔のメモを開き直したことを、ミッションの判定に伝える
    const note = store.getNote(options.noteId);
    if (note && localDayOf(note.createdAt) !== todayKey()) store.markMissionFlag('opened');
    navigate(['note', options.noteId], { from });
    return null;
  }
  navigate(['note', 'new'], {
    parent: options.parentId || undefined,
    date: options.anchorDate || undefined,
    from,
  });
  return null;
}

/** いまいる画面（編集を終えたら、ここへ戻る） */
function currentSection() {
  const { segments } = parseHash();
  const head = segments[0];
  if (!head || head === 'note') return 'notes';
  return head;
}

/**
 * その場でさっと書き足すための小さな入力（集中復習の途中など）。
 * 全画面の編集へ移らずに、気づきだけ残せるようにする。
 */
export function openQuickCapture(store, { parentId = null, anchorDate = null } = {}) {
  const parent = parentId ? store.getNote(parentId) : null;
  const key = draftKey({ parentId, anchorDate: anchorDate || 'quick' });
  const draft = loadDraft(key);
  let text = draft && !isEmptyDraft(draft.value) ? draft.value.body : '';

  const textarea = h('textarea', {
    class: 'textarea',
    placeholder: parent ? '気づいたことを書き残す' : 'さっとメモする',
    value: text,
    rows: '5',
    onInput: (e) => {
      text = e.target.value;
      if (text.trim()) saveDraft(key, { body: text });
      else clearDraft(key);
    },
  });

  const dialog = openDialog({
    title: parent ? '気づきを追記' : 'さっとメモ',
    variant: 'alert',
    content: h('div', {},
      parent ? h('p', { class: 'field__hint', style: { marginTop: '0' } },
        `「${displayTitle(parent)}」に紐づけて保存します。`) : null,
      textarea),
    actions: [
      { label: 'キャンセル', className: 'btn btn--text', onClick: (close) => close() },
      {
        label: '保存',
        className: 'btn',
        onClick: async (close) => {
          if (!text.trim()) { toast('本文を入力してください'); return; }
          store.addNote({ body: text, parentId, anchorDate: anchorDate || undefined });
          const result = await store.flush();
          if (!result.ok) { toast('保存できませんでした。もう一度お試しください。'); return; }
          clearDraft(key);
          toast(parent ? '気づきを追記しました' : '保存しました');
          close();
        },
      },
    ],
  });
  setTimeout(() => textarea.focus(), 50);
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
        class: 'chip chip--truncate',
        style: { marginTop: '8px' },
        onClick: () => openNoteDetail(store, parent.id),
      }, `元のメモ: ${displayTitle(parent)}`) : null,

      note.tags.length ? h('div', { style: { marginTop: '10px' } }, tagChips(note.tags)) : null,

      note.cue ? h('div', { class: 'detail-cue' },
        h('span', { class: 'detail-cue__label' }, '手掛かり'),
        h('span', {}, recallCue(note))) : null,

      note.body ? h('div', { class: 'detail-body' },
        bodyView(note.body, store.settings, { className: 'detail-body__text' })) : null,

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

      (children.length || note.parentId) ? h('div', {},
        h('div', { class: 'daypanel__section-title' },
          h('span', { html: icon('branch', { size: 16 }), style: { display: 'flex' } }),
          '記憶の枝'),
        h('div', { class: 'field__hint', style: { marginBottom: '8px' } },
          children.length
            ? `このメモから ${store.descendantsOf(note.id).length} 個の気づきが生まれました。`
            : '元のメモから枝分かれした気づきです。'),
        branchTree(store, store.rootOf(note), {
          currentId: note.id,
          onOpen: (target) => { if (target.id !== note.id) openNoteDetail(store, target.id); },
        })) : null,

      h('div', { class: 'field__hint', style: { marginTop: '16px' } },
        `更新 ${formatDateTime(note.updatedAt)}`));
  };

  let unsubscribe = () => {};
  const sheet = openSheet({
    title: 'メモの詳細',
    content: render(),
    // 背景のタップや Esc で閉じたときも、必ず購読を解除する
    onClose: () => unsubscribe(),
  });
  unsubscribe = store.subscribe(() => {
    if (!store.getNote(noteId)) { sheet.close(); return; }
    clear(sheet.body).appendChild(render());
  });
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
