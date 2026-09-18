/**
 * 全画面のメモ編集画面。
 *
 * 画面の大部分を本文に使い、操作はツールバー・ショートカットバー・
 * ステータスバーに寄せる。復習の設定は「メモ情報」パネルへ分ける。
 * 本文の保存と復習予定の変更は、はっきり分けて扱う。
 */
import { h, append, button, iconButton, clear } from '../dom.js';
import { icon } from '../icons.js';
import { openSheet, openMenu, confirmDialog, toast } from '../overlays.js';
import { openExportDialog } from '../exportDialog.js';
import { branchTree, curvePreview, reviewTimeline, tagChips } from '../components.js';
import { navigate, replacePath } from '../router.js';
import { focusNote } from './notes.js';
import { TextEditor } from '../../editor/textEditor.js';
import { EditHistory } from '../../editor/history.js';
import {
  PRESETS, SPREADS, baseIntervalsOf, getPreset, getSpread, randomSeed, resolveIntervals,
  sanitizeIntervals, spreadIdOf, spreadIntervals,
} from '../../core/curve.js';
import { displayTitle } from '../../core/models.js';
import { clearDraft, draftKey, isEmptyDraft, loadDraft, saveDraft } from '../../core/drafts.js';
import {
  addDays, formatDateTime, formatDuration, formatLong, formatRelative, formatSmart, todayKey,
} from '../../core/date.js';

/** メモごとのカーソル位置とスクロール位置を覚えておく */
const positions = new Map();

/**
 * メモごとの編集履歴。
 * 一覧へ戻ってまた開いても「元に戻す」が続けられるように、この画面を離れても捨てない。
 * （タブを閉じるまで。増えすぎないよう、直近のぶんだけ持つ）
 */
const histories = new Map();
const HISTORY_KEEP = 8;

function historyFor(key) {
  let history = histories.get(key);
  if (!history) {
    history = new EditHistory();
    histories.set(key, history);
  } else {
    // 使ったものを新しい側へ回す（古いものから捨てるため）
    histories.delete(key);
    histories.set(key, history);
  }
  while (histories.size > HISTORY_KEEP) {
    histories.delete(histories.keys().next().value);
  }
  return history;
}


/** 現在開いている編集セッション（画面が切り替わるときに片付ける） */
let active = null;

const SAVE_DEBOUNCE = 700;

export function renderNoteEditor(store, { noteId, parentId, anchorDate, returnTo = 'notes' }) {
  if (active) active.dispose();

  const existing = noteId && noteId !== 'new' ? store.getNote(noteId) : null;
  if (noteId && noteId !== 'new' && !existing) {
    // 消されたメモを開こうとした場合は一覧へ戻す
    setTimeout(() => navigate(returnTo), 0);
    return h('div', { class: 'page' }, h('div', { class: 'empty' }, 'このメモは見つかりませんでした。'));
  }

  const parent = parentId ? store.getNote(parentId) : null;
  const key = draftKey({ noteId: existing?.id, parentId, anchorDate });
  const draft = loadDraft(key);

  const state = {
    id: existing?.id || null,
    title: existing?.title ?? '',
    cue: existing?.cue ?? '',
    body: existing?.body ?? '',
    tags: (existing?.tags ?? parent?.tags ?? []).join(' '),
    anchorDate: existing?.anchorDate ?? anchorDate ?? todayKey(),
    presetId: existing?.schedule.presetId ?? store.settings.presetId,
    intervals: existing ? baseIntervalsOf(existing) : resolveIntervals(store.settings.presetId, store.settings),
    spread: existing ? (existing.schedule.spread ?? 0) : getSpread(store.settings.spreadId).ratio,
    seed: existing ? (existing.schedule.seed ?? 0) : randomSeed(),
  };

  // 未保存の書きかけがあれば、それを優先して開く。
  // 既存メモを空にした書きかけも「編集の結果」なので拾う（中身が空でも捨てない）。
  const draftDiffers = Boolean(draft) && String(draft.value?.body ?? '') !== state.body;
  const usableDraft = draft && (!isEmptyDraft(draft.value) || (state.id && draftDiffers));
  const restored = Boolean(usableDraft) && draftDiffers;
  if (usableDraft) Object.assign(state, draft.value);

  let saveTimer = null;
  let dirty = false;
  let lastError = null;
  /** 入力のたびに進む番号。保存の前後で見比べて「保存中の入力」を取りこぼさない。 */
  let revision = 0;
  /** 保存は必ず 1 本の列に並べる（同時に走らせない） */
  let chain = Promise.resolve({ ok: true });

  /* ---------------------------------------------------------- 画面 */

  const titleInput = h('input', {
    class: 'ed__title',
    type: 'text',
    placeholder: 'タイトル',
    value: state.title,
    'aria-label': 'タイトル',
    onInput: (e) => { state.title = e.target.value; markDirty(); },
  });

  const textarea = h('textarea', {
    class: 'ed__body',
    placeholder: '書き始めてください。',
    spellcheck: 'false',
    'aria-label': '本文',
  });
  textarea.value = state.body;

  const statusText = h('span', { class: 'ed__status-text' });
  const statusCount = h('span', { class: 'ed__status-count' });
  const statusCaret = h('span', { class: 'ed__status-caret' });

  const undoBtn = iconButton(icon('undo'), { label: '元に戻す', onClick: () => editor.run('undo') });
  const redoBtn = iconButton(icon('redo'), { label: 'やり直す', onClick: () => editor.run('redo') });

  const findBar = h('div', { class: 'ed__find', hidden: true });
  const shortcutBar = h('div', { class: 'ed__shortcuts' });

  const editorEl = h('div', { class: 'ed' },
    h('header', { class: 'ed__toolbar' },
      iconButton(icon('back'), { label: '一覧へ戻る', onClick: () => leave() }),
      titleInput,
      undoBtn,
      redoBtn,
      iconButton(icon('search'), { label: 'メモ内を検索', onClick: () => toggleFind() }),
      iconButton(icon('info'), { label: 'メモ情報', onClick: () => openInfoPanel() }),
      iconButton(icon('more'), { label: 'その他', onClick: () => openEditorMenu() })),
    restored ? h('div', { class: 'banner banner--info ed__banner' },
      h('span', { html: icon('info', { size: 18 }), style: { display: 'flex' } }),
      h('span', { style: { flex: '1' } }, '保存されていなかった書きかけを復元しました。'),
      button('破棄', {
        className: 'btn btn--text btn--sm',
        onClick: (e) => {
          clearDraft(key);
          state.body = existing?.body ?? '';
          state.title = existing?.title ?? '';
          editor.load(state.body);
          titleInput.value = state.title;
          e.target.closest('.ed__banner').remove();
        },
      })) : null,
    existing?.conflicts?.length ? conflictBanner(store, existing) : null,
    parent ? h('div', { class: 'ed__parent' },
      h('span', { html: icon('branch', { size: 16 }), style: { display: 'flex' } }),
      h('span', {}, `「${displayTitle(parent)}」への追加メモ`)) : null,
    findBar,
    h('div', { class: 'ed__body-wrap' }, textarea),
    shortcutBar,
    h('footer', { class: 'ed__status' }, statusText, h('span', { style: { flex: '1' } }), statusCaret, statusCount));

  /* ---------------------------------------------------------- エディタ */

  const editor = new TextEditor(textarea, {
    onChange: (text, { silent, composing } = {}) => {
      state.body = text;
      updateStats();
      updateHistoryButtons();
      if (!silent && !composing) markDirty();
      else if (composing) updateStats();
    },
    onSelectionChange: () => updateStats(),
    // Esc は、まず検索バーを閉じる。開いていなければ Tab でフォーカスを移せるようにする
    onEscape: () => {
      if (findBar.hidden) return false;
      toggleFind(false);
      return true;
    },
    onTabEscape: () => {
      setStatus('Tab でツールバーへ移動します', 'warn');
      setTimeout(() => { if (!dirty) setStatus(state.id ? '保存済み' : '新しいメモ'); }, 2500);
    },
  }, {
    // 同じメモを開き直したら、さっきまでの「元に戻す」を続けられるようにする
    history: historyFor(key),
  });

  buildShortcuts();
  updateStats();
  updateHistoryButtons();
  setStatus(existing ? '保存済み' : '新しいメモ');

  /* ---------------------------------------------------------- 保存 */

  function markDirty() {
    dirty = true;
    revision += 1;
    setStatus('未保存');
    if (state.id || !isEmptyDraft(state)) {
      // 既存メモは空にした状態も下書きに残す（古い本文が復活しないように）
      const ok = saveDraft(key, state);
      if (!ok) setStatus('書きかけを保存できませんでした', 'warn');
    } else {
      clearDraft(key);
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { save(); }, SAVE_DEBOUNCE);
  }

  /**
   * 保存する。呼び出しは 1 本の列に並べるので、
   * 保存中にもう一度呼んでも「成功した」ことにはならない（取りこぼさない）。
   */
  function save(options) {
    chain = chain.then(() => doSave(options), () => doSave(options));
    return chain;
  }

  async function doSave({ immediate = false } = {}) {
    clearTimeout(saveTimer);
    if (!dirty && state.id) return { ok: true };
    if (isEmptyDraft(state) && !state.id) {
      // 空のまま閉じても、不要なメモを作らない
      setStatus('');
      return { ok: true };
    }

    // ここで見た番号のまま保存できたときだけ「保存済み」にする
    const rev = revision;
    setStatus('保存しています…');

    if (state.id) {
      store.updateNote(state.id, {
        title: state.title,
        cue: state.cue,
        body: state.body,
        tags: state.tags,
      });
    } else {
      // 新規メモの id は一度だけ確保する（再試行で増やさない）
      const created = store.addNote({
        title: state.title,
        cue: state.cue,
        body: state.body,
        tags: state.tags,
        anchorDate: state.anchorDate,
        parentId: parentId || null,
        presetId: state.presetId,
        intervals: state.presetId === 'none' ? [] : state.intervals,
        spread: state.spread,
        seed: state.seed,
      });
      state.id = created.id;
      // 「新規」の履歴を、そのままこのメモの履歴として引き継ぐ
      histories.set(draftKey({ noteId: created.id }), editor.history);
      replacePath(['note', created.id], { from: returnTo });
    }

    const result = await store.flush();

    if (!result.ok) {
      lastError = result.error;
      setStatus('保存できませんでした', 'error');
      showSaveError();
      return result;
    }

    lastError = null;
    if (rev === revision) {
      // 保存中に書き足されていなければ、これで最新が残っている
      dirty = false;
      clearDraft(key);
      setStatus('保存済み');
    } else {
      // 保存中の入力は次の保存で残す（「保存済み」とは言わない）
      setStatus('未保存');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { save(); }, SAVE_DEBOUNCE);
    }
    if (immediate) toast('保存しました');
    return result;
  }

  function showSaveError() {
    if (document.querySelector('.ed__error')) return;
    const box = h('div', { class: 'ed__error' },
      h('span', { html: icon('info', { size: 18 }), style: { display: 'flex' } }),
      h('span', { style: { flex: '1' } },
        '保存できませんでした。本文はこの画面に残っています。'),
      button('再試行', {
        className: 'btn btn--sm',
        onClick: async () => {
          const res = await save({ immediate: true });
          if (res.ok) box.remove();
        },
      }),
      button('本文をコピー', {
        className: 'btn btn--text btn--sm',
        onClick: async () => {
          const { copyText } = await import('../../core/exporter.js');
          const ok = await copyText(state.body);
          toast(ok ? 'コピーしました' : 'コピーできませんでした');
        },
      }));
    editorEl.querySelector('.ed__body-wrap').insertAdjacentElement('beforebegin', box);
  }

  function setStatus(text, tone) {
    statusText.textContent = text;
    statusText.dataset.tone = tone || '';
  }

  function updateStats() {
    const stats = editor.stats();
    statusCount.textContent = stats.selected
      ? `${stats.selected} 字を選択 / ${stats.chars} 字`
      : `${stats.chars} 字・${stats.lines} 行`;
    const { line, column } = editor.caretPosition();
    statusCaret.textContent = `${line}:${column}`;
  }

  function updateHistoryButtons() {
    undoBtn.disabled = !editor.history.canUndo;
    redoBtn.disabled = !editor.history.canRedo;
  }

  /* ---------------------------------------------------------- 検索置換 */

  let findState = { query: '', replacement: '', index: 0 };

  function toggleFind(force) {
    const show = force ?? findBar.hidden;
    findBar.hidden = !show;
    if (!show) return;
    clear(findBar);
    const queryInput = h('input', {
      class: 'input ed__find-input',
      type: 'search',
      placeholder: '検索',
      value: findState.query,
      onInput: (e) => { findState.query = e.target.value; findState.index = 0; },
      onKeyDown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); findNext(); }
        if (e.key === 'Escape') { e.preventDefault(); toggleFind(false); editor.focus(); }
      },
    });
    const replaceInput = h('input', {
      class: 'input ed__find-input',
      type: 'text',
      placeholder: '置換',
      value: findState.replacement,
      onInput: (e) => { findState.replacement = e.target.value; },
    });
    findBar.append(
      queryInput,
      replaceInput,
      button('次へ', { className: 'btn btn--text btn--sm', onClick: () => findNext() }),
      button('置換', { className: 'btn btn--text btn--sm', onClick: () => replaceCurrent() }),
      button('すべて', { className: 'btn btn--text btn--sm', onClick: () => replaceAll() }),
      iconButton(icon('close', { size: 18 }), { label: '検索を閉じる', onClick: () => toggleFind(false) }),
    );
    setTimeout(() => queryInput.focus(), 30);
  }

  function findNext() {
    const { query } = findState;
    if (!query) return;
    const text = editor.text;
    const from = editor.selection.end;
    let at = text.indexOf(query, from);
    if (at === -1) at = text.indexOf(query, 0);
    if (at === -1) { toast('見つかりませんでした'); return; }
    editor.focus({ start: at, end: at + query.length });
    updateStats();
  }

  function replaceCurrent() {
    const { query, replacement } = findState;
    if (!query) return;
    const { start, end } = editor.selection;
    if (editor.text.slice(start, end) === query) {
      editor.replaceRange(start, end, replacement, { select: [start, start + replacement.length] });
    }
    findNext();
  }

  function replaceAll() {
    const { query, replacement } = findState;
    if (!query) return;
    const text = editor.text;
    if (!text.includes(query)) { toast('見つかりませんでした'); return; }
    const count = text.split(query).length - 1;
    // 一括置換も 1 回で元に戻せる
    editor.setText(text.split(query).join(replacement), { kind: 'replaceAll' });
    toast(`${count} か所を置き換えました（元に戻せます）`);
  }

  /* ---------------------------------------------------------- ボタン類 */

  function buildShortcuts() {
    const items = [
      { id: 'bullet', label: 'リスト' },
      { id: 'checkbox', label: 'チェック' },
      { id: 'toggleCheck', label: '完了' },
      { id: 'indent', label: '字下げ' },
      { id: 'outdent', label: '戻す' },
      { id: 'timestamp', label: '日時' },
    ];
    clear(shortcutBar);
    items.forEach(({ id, label }) => {
      const command = editor.commands.get(id);
      shortcutBar.appendChild(h('button', {
        type: 'button',
        class: 'ed__shortcut',
        title: command?.label || label,
        'aria-label': command?.label || label,
        // 押してもキーボードが閉じないようにする
        onMouseDown: (e) => e.preventDefault(),
        onClick: () => { editor.run(id); editor.el.focus({ preventScroll: true }); },
      },
      h('span', { class: 'ed__shortcut-icon', html: icon(command?.icon || 'text', { size: 20 }) }),
      h('span', { class: 'ed__shortcut-label' }, label)));
    });
    shortcutBar.appendChild(h('button', {
      type: 'button',
      class: 'ed__shortcut',
      title: 'その他の編集',
      'aria-label': 'その他の編集',
      onMouseDown: (e) => e.preventDefault(),
      onClick: () => openToolsMenu(),
    },
    h('span', { class: 'ed__shortcut-icon', html: icon('more', { size: 20 }) }),
    h('span', { class: 'ed__shortcut-label' }, 'その他')));
  }

  function openToolsMenu() {
    openMenu({
      title: '編集',
      items: [
        { label: '行を複製', icon: icon('copy', { size: 20 }), onClick: () => editor.run('duplicateLine') },
        { label: '行を削除', icon: icon('trash', { size: 20 }), onClick: () => editor.run('deleteLine') },
        { label: '検索と置換', icon: icon('replace', { size: 20 }), onClick: () => toggleFind(true) },
        { divider: true },
        {
          label: '本文をコピー',
          icon: icon('copy', { size: 20 }),
          onClick: async () => {
            const { copyText } = await import('../../core/exporter.js');
            toast(await copyText(editor.text) ? 'コピーしました' : 'コピーできませんでした');
          },
        },
      ],
    });
  }

  function openEditorMenu() {
    const note = state.id ? store.getNote(state.id) : null;
    openMenu({
      title: state.title || '（無題のメモ）',
      items: [
        { label: '表示設定', icon: icon('text', { size: 20 }), description: '文字サイズと折り返し', onClick: () => openDisplaySettings(store) },
        { label: 'メモ情報', icon: icon('info', { size: 20 }), description: '手掛かり・タグ・復習の設定', onClick: () => openInfoPanel() },
        // メモ帳として使う人が、復習を付けずに書き留められるようにする
        state.presetId === 'none' || note?.status === 'inbox' ? {
          label: '復習を始める',
          icon: icon('play', { size: 20 }),
          description: '今日を起点に忘却曲線を組む',
          onClick: () => {
            state.presetId = store.settings.presetId;
            state.intervals = resolveIntervals(state.presetId, store.settings);
            if (state.id) store.restartNote(state.id, { presetId: state.presetId });
            toast('今日を起点に復習を組みました');
          },
        } : {
          label: '復習を付けない',
          icon: icon('skip', { size: 20 }),
          description: 'メモだけ残して、予定はあとで決める',
          onClick: () => {
            state.presetId = 'none';
            state.intervals = [];
            if (state.id) store.updateNote(state.id, { presetId: 'none', intervals: [] });
            toast('復習を付けずに保存します');
          },
        },
        note ? {
          label: '追加メモを書く',
          icon: icon('branch', { size: 20 }),
          onClick: () => navigate(['note', 'new'], { parent: note.id, from: returnTo }),
        } : null,
        note ? {
          label: '出力する',
          icon: icon('download', { size: 20 }),
          onClick: () => openExportDialog(store, [note], { title: 'このメモを出力', baseName: 'note' }),
        } : null,
        { divider: true },
        note ? {
          label: '削除する',
          icon: icon('trash', { size: 20 }),
          danger: true,
          onClick: async () => {
            const ok = await confirmDialog({
              title: 'メモを削除しますか？',
              message: 'このメモと復習の記録を削除します。',
              confirmLabel: '削除',
              danger: true,
            });
            if (!ok) return;
            const removed = store.deleteNote(note.id);
            clearDraft(key);
            dirty = false;
            navigate(returnTo);
            toast('削除しました', {
              actionLabel: '元に戻す',
              onAction: () => store.restoreNotes(removed),
            });
          },
        } : null,
      ].filter(Boolean),
    });
  }

  /* ---------------------------------------------------------- メモ情報 */

  function openInfoPanel() {
    const note = state.id ? store.getNote(state.id) : null;
    const content = h('div', { class: 'ed-info' });

    const cueInput = h('input', {
      class: 'input',
      type: 'text',
      placeholder: '例）減価償却の3つの方法は？',
      value: state.cue,
      onInput: (e) => { state.cue = e.target.value; markDirty(); },
    });
    const tagsInput = h('input', {
      class: 'input',
      type: 'text',
      placeholder: '英語 語彙 仕事（スペース区切り）',
      value: state.tags,
      list: 'ed-tag-list',
      onInput: (e) => { state.tags = e.target.value; markDirty(); },
    });

    content.append(
      h('h2', { class: 'daypanel__date', style: { marginBottom: '12px' } }, 'メモ情報'),
      h('label', { class: 'field' },
        h('span', { class: 'field__label' }, '思い出すための手掛かり'),
        cueInput,
        h('span', { class: 'field__hint' }, '復習ではこれだけが先に出ます。空欄ならタイトル（本文の1行目）。')),
      h('label', { class: 'field' },
        h('span', { class: 'field__label' }, 'タグ'),
        tagsInput,
        h('datalist', { id: 'ed-tag-list' }, ...store.allTags().map(([t]) => h('option', { value: t })))),
      h('div', { class: 'divider' }),
      scheduleSection(store, state, note, { onChange: () => markDirty() }),
    );

    if (note) {
      const children = store.childrenOf(note.id);
      append(content, [
        h('div', { class: 'divider' }),
        h('div', { class: 'daypanel__section-title' }, '復習の記録'),
        reviewTimeline(store, note),
        (children.length || note.parentId) ? h('div', {},
          h('div', { class: 'daypanel__section-title' }, '記憶の枝'),
          branchTree(store, store.rootOf(note), {
            currentId: note.id,
            onOpen: (target) => {
              if (target.id === note.id) return;
              navigate(['note', target.id], { from: returnTo });
            },
          })) : null,
        h('div', { class: 'field__hint', style: { marginTop: '12px' } },
          `作成 ${formatDateTime(note.createdAt)}／更新 ${formatDateTime(note.contentUpdatedAt || note.updatedAt)}`),
      ]);
    }

    openSheet({ title: 'メモ情報', content });
  }

  /* ---------------------------------------------------------- 後始末 */

  async function leave() {
    const result = await save({ immediate: false });
    if (!result.ok) {
      // 保存できていないのに画面を離れると、再試行もコピーもできなくなる
      showSaveError();
      toast('保存できませんでした。この画面に残ります。');
      return;
    }
    if (state.id) focusNote(state.id);
    navigate(returnTo);
  }

  const onKeyDown = async (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      await save({ immediate: true });
    }
    if (mod && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      toggleFind(true);
    }
    if (event.key === 'Escape' && !findBar.hidden) {
      toggleFind(false);
    }
  };
  document.addEventListener('keydown', onKeyDown);

  // キーボードが出て領域が縮んだとき、入力中の行を見失わないようにする
  const onViewportResize = () => {
    if (document.activeElement !== textarea) return;
    const { start, end } = editor.selection;
    requestAnimationFrame(() => {
      try { textarea.setSelectionRange(start, end); } catch { /* noop */ }
    });
  };
  window.visualViewport?.addEventListener('resize', onViewportResize);

  const onBeforeUnload = (event) => {
    if (!dirty) return;
    save();
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  active = {
    dispose() {
      clearTimeout(saveTimer);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.visualViewport?.removeEventListener('resize', onViewportResize);
      if (state.id) {
        positions.set(state.id, {
          start: editor.selection.start,
          end: editor.selection.end,
          scroll: textarea.scrollTop,
        });
      }
      if (dirty) save();
      active = null;
    },
  };

  // 前回の続きから書けるようにする
  setTimeout(() => {
    const saved = state.id ? positions.get(state.id) : null;
    if (saved) {
      editor.focus({ start: saved.start, end: saved.end });
      textarea.scrollTop = saved.scroll || 0;
    } else {
      editor.focus({ start: state.body.length, end: state.body.length });
    }
    applyDisplaySettings(store, textarea);
  }, 40);

  return editorEl;
}

/** 画面から離れるときに呼ぶ（保存の取りこぼしを防ぐ） */
export function disposeNoteEditor() {
  if (active) active.dispose();
}

/* ------------------------------------------------------------------ */
/* 復習の設定（メモ情報パネル内）                                       */
/* ------------------------------------------------------------------ */

function scheduleSection(store, state, note, { onChange }) {
  const box = h('div', {});
  // シードを振り直しても閉じないよう、開閉の状態を覚えておく
  let detailsOpen = false;

  const apply = () => {
    if (!note) { onChange?.(); return; }
    // 復習の設定変更は、本文の保存とは別の操作として明示的に反映する
    store.updateNote(note.id, {
      presetId: state.presetId,
      intervals: state.presetId === 'none' ? [] : state.intervals,
      spread: state.spread,
      seed: state.seed,
    });
  };

  const currentIntervals = () => {
    const base = state.presetId === 'none' ? [] : sanitizeIntervals(state.intervals);
    return base.length ? spreadIntervals(base, state.seed, state.spread) : [];
  };

  /**
   * シードを振り直したときは、要素を作り直さず中の文字だけを書き換える。
   * DOM が入れ替わらないので、開いた場所もスクロール位置もそのまま残る。
   */
  const previewSlot = h('div', { class: 'schedule-preview' });
  // 2 行ぶんの高さを確保しておく（日付の桁が変わっても行が増減しないように）
  const summaryTotal = h('div', {});
  const summaryLast = h('div', {});
  const summarySlot = h('div', { class: 'field__hint spread-summary' }, summaryTotal, summaryLast);
  const sampleSlot = h('div', { class: 'spread-sample', style: { marginTop: '12px' } });
  /** 行は使い回す（何回振り直しても、同じ要素の文字だけが変わる） */
  const sampleRows = Array.from({ length: 5 }, () => {
    const label = h('span', { class: 'spread-sample__label' });
    const value = h('span', { class: 'spread-sample__value' });
    const row = h('div', { class: 'spread-sample__row' }, label, value);
    sampleSlot.appendChild(row);
    return { row, label, value };
  });
  let seedInput = null;

  const refreshValues = () => {
    const intervals = currentIntervals();
    if (!intervals.length) return;
    const last = intervals[intervals.length - 1];

    clear(previewSlot).append(curvePreview(intervals));
    summaryTotal.textContent = `合計 ${intervals.length} 回`;
    summaryLast.textContent = `最後は ${formatDuration(last)}後の `
      + `${formatSmart(addDays(state.anchorDate, last))}`;

    // 先頭 4 回と、いちばん先の 1 回を見せる
    const shown = intervals.slice(0, 4).map((d, i) => ({ label: `${i + 1}回目`, days: d }));
    if (intervals.length > 4) shown.push({ label: `${intervals.length}回目`, days: last });
    sampleRows.forEach((r, i) => {
      const item = shown[i];
      r.row.hidden = !item;
      if (!item) return;
      r.label.textContent = item.label;
      r.value.textContent = `${formatDuration(item.days)}後　`
        + `${formatSmart(addDays(state.anchorDate, item.days))}`;
    });
    if (seedInput && seedInput.value !== String(state.seed)) seedInput.value = String(state.seed);
  };

  /** 骨組みを作り直す（プリセットや分散の強さを変えたとき） */
  const render = () => {
    const preset = getPreset(state.presetId);
    const intervals = currentIntervals();
    seedInput = state.spread ? h('input', {
      class: 'input',
      type: 'number',
      min: '0',
      max: '9999',
      value: String(state.seed),
      style: { width: '6em' },
      onChange: (e) => { state.seed = Number(e.target.value) || 0; apply(); refreshValues(); },
    }) : null;

    append(clear(box), [
      h('div', { class: 'daypanel__section-title' }, '復習の設定'),
      h('div', { class: 'filter-row' },
        ...PRESETS.map((p) => h('button', {
          type: 'button',
          class: 'chip',
          'aria-pressed': String(p.id === state.presetId),
          onClick: () => {
            state.presetId = p.id;
            state.intervals = p.id === 'custom'
              ? sanitizeIntervals(store.settings.customIntervals)
              : [...p.intervals];
            apply();
            keepScroll(render);
          },
        }, p.name))),
      h('div', { class: 'field__hint', style: { margin: '10px 0' } }, preset.description),
      intervals.length ? previewSlot : null,
      intervals.length ? summarySlot : null,
      intervals.length ? h('details', {
        class: 'editor__details',
        open: detailsOpen,
        onToggle: (e) => { detailsOpen = e.target.open; },
      },
        h('summary', {}, '分散と起点日'),
        h('div', { class: 'spread-row', style: { marginTop: '10px' } },
          h('div', { style: { flex: '1' } }, h('div', { class: 'field__label' }, '復習日の分散')),
          h('select', {
            class: 'select',
            style: { width: 'auto' },
            onChange: (e) => {
              state.spread = getSpread(e.target.value).ratio;
              apply();
              keepScroll(render);
            },
          }, ...SPREADS.map((sp) => h('option', {
            value: sp.id, selected: sp.id === spreadIdOf(state.spread),
          }, sp.label)))),
        seedInput ? h('div', { class: 'spread-row', style: { marginTop: '10px' } },
          h('div', { style: { flex: '1' } }, h('div', { class: 'field__label' }, 'シード')),
          seedInput,
          iconButton(icon('dice', { size: 20 }), {
            label: 'シードを振り直す',
            className: 'icon-btn icon-btn--filled',
            // 振り直しても、開いた場所と並びはそのまま。数字だけが変わる
            onClick: () => { state.seed = randomSeed(); apply(); refreshValues(); },
          })) : null,
        sampleSlot,
        h('div', { class: 'field__hint', style: { marginTop: '10px' } },
          note && !store.canChangeAnchor(note)
            ? `起点日 ${formatLong(state.anchorDate)}（記録があるため変更できません）`
            : `起点日 ${formatLong(state.anchorDate)}`)) : null,
      note && note.status === 'inbox' ? button('復習を始める', {
        className: 'btn btn--tonal btn--block',
        icon: icon('play', { size: 18 }),
        onClick: () => { store.restartNote(note.id); toast('今日を起点に復習を組みました'); render(); },
      }) : null,
      note && note.reviews.some((r) => r.status === 'pending') ? h('div', { class: 'field__hint' },
        `次の復習は ${formatRelative(note.reviews.find((r) => r.status === 'pending').due)}`) : null,
    ]);
    refreshValues();
  };

  /** 骨組みを作り直すときも、シートのスクロール位置は動かさない */
  const keepScroll = (fn) => {
    const scroller = box.closest('.sheet__content, .dialog__content, .dialog__body');
    const top = scroller ? scroller.scrollTop : 0;
    fn();
    if (scroller) scroller.scrollTop = top;
  };

  render();
  return box;
}

/* ------------------------------------------------------------------ */
/* 表示設定                                                            */
/* ------------------------------------------------------------------ */

const DISPLAY_KEY = 'fcc.editor.display';

export function readDisplaySettings() {
  try {
    const raw = window.localStorage.getItem(DISPLAY_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      fontSize: Number(parsed.fontSize) || 16,
      wrap: parsed.wrap !== false,
      mono: parsed.mono === true,
    };
  } catch {
    return { fontSize: 16, wrap: true, mono: false };
  }
}

function writeDisplaySettings(value) {
  try {
    window.localStorage.setItem(DISPLAY_KEY, JSON.stringify(value));
  } catch { /* 保存できなくても表示は変えられる */ }
}

function applyDisplaySettings(store, textarea) {
  const d = readDisplaySettings();
  textarea.style.fontSize = `${d.fontSize}px`;
  textarea.style.whiteSpace = d.wrap ? 'pre-wrap' : 'pre';
  textarea.style.overflowX = d.wrap ? 'hidden' : 'auto';
  textarea.style.fontFamily = d.mono ? 'var(--fcc-font-mono)' : 'var(--fcc-font)';
}

function openDisplaySettings(store) {
  const textarea = document.querySelector('.ed__body');
  const content = h('div', {});
  const render = () => {
    const d = readDisplaySettings();
    clear(content);
    content.append(
      h('h2', { class: 'daypanel__date', style: { marginBottom: '12px' } }, '表示設定'),
      h('div', { class: 'field__label' }, '文字サイズ'),
      h('div', { class: 'filter-row' },
        ...[14, 16, 18, 20, 24].map((size) => h('button', {
          type: 'button',
          class: 'chip',
          'aria-pressed': String(d.fontSize === size),
          onClick: () => { writeDisplaySettings({ ...d, fontSize: size }); applyDisplaySettings(store, textarea); render(); },
        }, `${size}px`))),
      h('div', { class: 'divider' }),
      h('label', { class: 'switch' },
        h('span', { class: 'switch__text' },
          h('span', { class: 'switch__title' }, '折り返す'),
          h('span', { class: 'switch__desc' }, 'オフにすると長い行が横に伸びます。')),
        h('span', { class: 'switch__control' },
          h('input', {
            type: 'checkbox',
            checked: d.wrap,
            onChange: (e) => { writeDisplaySettings({ ...d, wrap: e.target.checked }); applyDisplaySettings(store, textarea); },
          }),
          h('span', { class: 'switch__track' }),
          h('span', { class: 'switch__thumb' }))),
      h('label', { class: 'switch' },
        h('span', { class: 'switch__text' },
          h('span', { class: 'switch__title' }, '等幅フォント'),
          h('span', { class: 'switch__desc' }, 'コードや表を書くときに。')),
        h('span', { class: 'switch__control' },
          h('input', {
            type: 'checkbox',
            checked: d.mono,
            onChange: (e) => { writeDisplaySettings({ ...d, mono: e.target.checked }); applyDisplaySettings(store, textarea); },
          }),
          h('span', { class: 'switch__track' }),
          h('span', { class: 'switch__thumb' }))),
    );
  };
  render();
  openSheet({ title: '表示設定', content });
}

/* ------------------------------------------------------------------ */

function conflictBanner(store, note) {
  const banner = h('div', { class: 'banner banner--warning ed__banner' },
    h('span', { html: icon('info', { size: 18 }), style: { display: 'flex' } }),
    h('span', { style: { flex: '1' } },
      `別のタブでの編集が競合しました（${note.conflicts.length} 件の古い本文を保管しています）。`),
    button('確認', {
      className: 'btn btn--text btn--sm',
      onClick: () => {
        const content = h('div', {},
          h('h2', { class: 'daypanel__date', style: { marginBottom: '8px' } }, '競合した本文'),
          h('p', { class: 'field__hint' }, '別のタブで保存されていた内容です。必要な部分をコピーしてお使いください。'),
          ...note.conflicts.map((c) => h('div', { class: 'card' },
            h('div', { class: 'field__hint' }, formatDateTime(c.at)),
            h('p', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, c.body))),
          button('この保管を消す', {
            className: 'btn btn--text',
            onClick: () => {
              const target = store.getNote(note.id);
              if (target) { target.conflicts = []; store.commit({ type: 'note:update', noteId: note.id }); }
              banner.remove();
              toast('競合の保管を消しました');
            },
          }));
        openSheet({ title: '競合した本文', content });
      },
    }));
  return banner;
}
