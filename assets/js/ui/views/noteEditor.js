/**
 * 全画面のメモ編集画面。
 *
 * 画面の大部分を本文に使い、操作はツールバー・ショートカットバー・
 * ステータスバーに寄せる。復習の設定は「メモ情報」パネルへ分ける。
 * 本文の保存と復習予定の変更は、はっきり分けて扱う。
 *
 * 本文は 1 枚の編集面だけ（v0.12 から、記号を書く画面は無くした）。
 * 見たまま書いて、そのまま残る。中身は文書データ（JSON）で持つ。
 */
import { h, append, button, iconButton, clear } from '../dom.js';
import { icon } from '../icons.js';
import { openSheet, openMenu, openDialog, openPopover, confirmDialog, toast } from '../overlays.js';
import { openExportDialog } from '../exportDialog.js';
import { branchTree, curvePreview, reviewTimeline } from '../components.js';
import { createDocEditor } from '../../editor/docEditor.js';
import { createPlainSurface } from '../../editor/plainFallback.js';
import { navigate, replacePath } from '../router.js';
import { focusNote } from './notes.js';
import {
  PRESETS, SPREADS, baseIntervalsOf, getPreset, getSpread, randomSeed, resolveIntervals,
  sanitizeIntervals, spreadIdOf, spreadIntervals,
} from '../../core/curve.js';
import { displayTitle } from '../../core/models.js';
import { APP_NAME } from '../../core/config.js';
import { markdownToDoc, normalizeDoc } from '../../core/doc.js';
import { clearDraft, draftKey, isEmptyDraft, loadDraft, saveDraft } from '../../core/drafts.js';
import {
  addDays, formatDateTime, formatDuration, formatLong, formatRelative, formatSmart, todayKey,
} from '../../core/date.js';

/** メモごとのカーソル位置とスクロール位置を覚えておく */
const positions = new Map();

/** 現在開いている編集セッション（画面が切り替わるときに片付ける） */
let active = null;

const SAVE_DEBOUNCE = 700;
/** 書きかけの控えを残す間隔（本体の保存より早く、入力ごとよりは少なく） */
const DRAFT_DEBOUNCE = 350;

/**
 * 直前に、この画面で作られたメモ。
 *
 * 新しいメモは、最初の保存ではじめて id が決まり、URL もそこで差し替わる。
 * その前に積まれた履歴（シートを開いた時など）には古い URL が残るので、
 * シートを閉じて戻ったときに「id の無い新規メモ」に見えてしまう。
 * そうなったら、いま作ったメモへ連れ戻す。
 */
let lastCreated = null;

export function renderNoteEditor(store, { noteId, parentId, anchorDate, returnTo = 'notes' }) {
  if (active) active.dispose();

  // 新規のつもりで開いたが、さっきここで作ったメモがあるならそれを開く
  if ((!noteId || noteId === 'new') && lastCreated && store.getNote(lastCreated.id)
    && lastCreated.parentId === (parentId || null)) {
    noteId = lastCreated.id;
    replacePath(['note', lastCreated.id], { from: returnTo });
  }

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
    // 本文の正本。undefined なら「まだ読んでいない」（開くときに読む）
    doc: existing?.doc,
    // 探す・数える・書き出すための写し
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
  // 本文だけでなく、タイトル・手掛かり・タグの違いも見る。
  const draftDiffers = Boolean(draft) && ['body', 'title', 'cue', 'tags']
    .some((k) => String(draft.value?.[k] ?? '') !== String(state[k] ?? ''));
  const usableDraft = draft && (!isEmptyDraft(draft.value) || (state.id && draftDiffers));
  const restored = Boolean(usableDraft) && draftDiffers;
  if (usableDraft) {
    Object.assign(state, draft.value);
    // 控えは書き換えられる置き場所にあるので、形を確かめてから使う
    // （控えに本文が無ければ、保存されているものを読む＝undefined のまま）
    state.doc = state.doc === undefined ? undefined : normalizeDoc(state.doc);
    state.body = typeof state.body === 'string' ? state.body : '';
  }

  /**
   * 編集面に最初に載せる文書データを用意する。
   *
   * 本文は開いたときに読む作りなので（v0.15）、まずここで 1 件だけ読む。
   * 書きかけの控えがあるときは、そちらが優先（もう手元にある）。
   * 文書データを持たない古い形なら、素の文字から組み立てる。
   */
  async function loadInitialDoc() {
    if (state.doc) return state.doc;
    if (state.doc === undefined && existing) {
      const loaded = await store.ensureDoc(existing);
      if (loaded) {
        state.doc = loaded;
        return loaded;
      }
    }
    return markdownToDoc(state.body);
  }

  let saveTimer = null;
  let dirty = false;
  /** この編集画面を離れたか（離れたあとに URL を書き換えないため） */
  let disposed = false;
  /** 入力のたびに進む番号。保存の前後で見比べて「保存中の入力」を取りこぼさない。 */
  let revision = 0;
  /** 保存は必ず 1 本の列に並べる（同時に走らせない） */
  let chain = Promise.resolve({ ok: true });
  /** ステータスバーの更新待ち */
  let statsTimer = null;
  /** 書きかけの控えの書き出し待ち */
  let draftTimer = null;
  /** 本文の編集面（読み込みが終わるまで null） */
  let surface = null;
  /** state.doc / state.body が、いまの編集面と一致しているか */
  let synced = true;

  /* ---------------------------------------------------------- 画面 */

  const titleInput = h('input', {
    class: 'ed__title',
    type: 'text',
    placeholder: 'タイトル',
    value: state.title,
    'aria-label': 'タイトル',
    onInput: (e) => { state.title = e.target.value; markDirty(); },
    // Enter / ↓ で手掛かりへ、そのまま書き進められるようにする
    onKeyDown: (e) => {
      // 日本語の変換を確定する Enter とぶつからないようにする
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); cueInput.focus(); }
    },
  });

  // 手掛かりは復習の主役なので、開いた瞬間に必ず目に入る場所へ置く
  const cueInput = h('input', {
    class: 'ed__cue-input',
    type: 'text',
    placeholder: '思い出すための手掛かり',
    value: state.cue,
    'aria-label': '思い出すための手掛かり',
    onInput: (e) => { state.cue = e.target.value; markDirty(); },
    onKeyDown: (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        focusBody();
      }
      if (e.key === 'ArrowUp') { e.preventDefault(); titleInput.focus(); }
    },
  });

  // 書き方は、手掛かりに触れたときだけそっと出す（ふだんは静かにしておく）
  const cueHint = h('div', { class: 'ed__cue-hint', hidden: true },
    '復習では、まずこれだけが出ます。例）減価償却の3つの方法は？');
  cueInput.addEventListener('focus', () => { cueHint.hidden = false; });
  cueInput.addEventListener('blur', () => { cueHint.hidden = true; });

  const cueRow = h('div', { class: 'ed__cue' },
    h('span', { class: 'ed__cue-icon', html: icon('target', { size: 16 }) }),
    cueInput);

  /** 編集面の置き場所。道具が載るまでは、書いてあった文字をそのまま見せる */
  const mount = h('div', { class: 'ed__mount' });
  const loading = h('div', { class: 'rt ed__loading' }, state.body || '');
  const rich = h('div', { class: 'ed__rich' }, loading, mount);

  // タイトル・手掛かり・本文は 1 枚の紙として一緒にスクロールする
  const docInner = h('div', { class: 'ed__doc-inner' },
    h('div', { class: 'ed__head' }, titleInput, cueRow, cueHint),
    rich);
  const doc = h('div', { class: 'ed__doc' }, docInner);

  const statusText = h('span', { class: 'ed__status-text' });
  const statusCount = h('button', {
    type: 'button',
    class: 'ed__status-count',
    title: '文字数の詳細',
    onClick: () => openCountSheet(),
  });

  const undoBtn = iconButton(icon('undo'), {
    label: '元に戻す',
    onClick: () => run((s) => s.commands.undo()),
  });
  const redoBtn = iconButton(icon('redo'), {
    label: 'やり直す',
    onClick: () => run((s) => s.commands.redo()),
  });

  const findBar = h('div', { class: 'ed__find', hidden: true });
  // 表の中にカーソルがあるときだけ出る、行と列の操作
  const tableBar = h('div', { class: 'ed__tablebar', hidden: true });
  const shortcutBar = h('div', { class: 'ed__shortcuts' });

  const editorEl = h('div', { class: 'ed', dataset: { loading: 'true' } },
    h('header', { class: 'ed__toolbar' },
      iconButton(icon('back'), { label: '一覧へ戻る', onClick: () => leave() }),
      h('div', { class: 'ed__toolbar-gap' }),
      undoBtn,
      redoBtn,
      iconButton(icon('notes'), { label: '見出しへ移動', onClick: () => openOutline() }),
      iconButton(icon('search'), { label: 'メモ内を検索', onClick: () => toggleFind() }),
      iconButton(icon('format'), { label: '表示設定', onClick: () => openDisplaySettings() }),
      iconButton(icon('info'), { label: 'メモ情報', onClick: () => openInfoPanel() }),
      iconButton(icon('more'), { label: 'その他', onClick: () => openEditorMenu() })),
    restored ? h('div', { class: 'banner banner--info ed__banner' },
      h('span', { html: icon('info', { size: 18 }), style: { display: 'flex' } }),
      h('span', { style: { flex: '1' } }, '保存されていなかった書きかけを復元しました。'),
      button('破棄', {
        className: 'btn btn--text btn--sm',
        onClick: (e) => {
          clearDraft(key);
          state.doc = existing?.doc;
          state.body = existing?.body ?? '';
          state.title = existing?.title ?? '';
          state.cue = existing?.cue ?? '';
          loadInitialDoc().then((doc) => surface?.setDoc(doc));
          titleInput.value = state.title;
          cueInput.value = state.cue;
          synced = true;
          updateStats({ immediate: true });
          e.target.closest('.ed__banner').remove();
        },
      })) : null,
    existing?.conflicts?.length ? conflictBanner(store, existing) : null,
    parent ? h('div', { class: 'ed__parent' },
      h('span', { html: icon('branch', { size: 16 }), style: { display: 'flex' } }),
      h('span', {}, `「${displayTitle(parent)}」への追加メモ`)) : null,
    findBar,
    doc,
    tableBar,
    shortcutBar,
    h('footer', { class: 'ed__status' }, statusText, h('span', { style: { flex: '1' } }), statusCount));

  /* ---------------------------------------------------------- 編集面 */

  /** 編集面があるときだけ動かす（読み込み中の空振りを黙って捨てる） */
  function run(fn) {
    if (!surface) return;
    fn(surface);
    updateButtons();
  }

  /** 編集面の中身を state に写す（保存・文字数・控えの前に呼ぶ） */
  function syncState() {
    if (synced || !surface) return;
    state.doc = surface.getDoc();
    state.body = surface.getText();
    synced = true;
  }

  function onSurfaceChange() {
    synced = false;
    markDirty();
    updateStats();
  }

  function attachSurface(next) {
    surface = next;
    loading.remove();
    editorEl.dataset.loading = '';
    applyDisplaySettings(editorEl);
    applyReadOnly();
    buildShortcuts();
    updateStats({ immediate: true });
    updateButtons();
    restorePosition();
  }

  loadInitialDoc().then((initialDoc) => {
    if (disposed) return null;
    return createDocEditor(mount, {
      doc: initialDoc,
      editable: !store.readOnly,
      placeholder: '書き始めてください。',
      onChange: onSurfaceChange,
      onSelectionChange: () => { updateButtons(); updateStats(); },
    }).then((next) => {
      if (disposed) { next.destroy(); return; }
      attachSurface(next);
    }).catch((error) => {
      console.warn('[fcc] 本文の編集の道具を読み込めませんでした', error);
      if (disposed) return;
      // 書けないままにしない。ふつうの入力欄として続けられるようにする
      attachSurface(createPlainSurface(mount, {
        doc: initialDoc,
        editable: !store.readOnly,
        placeholder: '書き始めてください。',
        onChange: onSurfaceChange,
        onSelectionChange: () => updateStats(),
      }));
      setStatus('見たままの編集は読み込めませんでした（文字だけで書けます）', 'warn');
    });
  });

  buildShortcuts();
  updateStats({ immediate: true });
  updateDocumentTitle();
  setStatus(existing ? '保存済み' : '新しいメモ');

  // 書きかけを復元したときは、本体にはまだ入っていない。未保存として保存を始める
  if (restored) setTimeout(() => markDirty(), 0);

  /**
   * 見るだけのタブでは、書けないことがすぐ分かるようにする。
   * 書ける／見るだけは途中でも入れ替わる（別のタブへ譲ったとき）ので、
   * そのたびに映し直す。
   */
  function applyReadOnly() {
    const viewer = Boolean(store.readOnly);
    titleInput.readOnly = viewer;
    cueInput.readOnly = viewer;
    surface?.setEditable(!viewer);
    if (viewer) setStatus('別のタブで編集中（このタブは見るだけ）', 'warn');
    else if (!dirty) setStatus(state.id ? '保存済み' : '新しいメモ');
  }
  applyReadOnly();

  const offTabMode = store.subscribe((event) => {
    if (event?.type === 'tab:mode') applyReadOnly();
  });

  /** 書いているところが隠れないように、必要なときだけスクロールする */
  function scrollCaret() {
    surface?.scrollCaret?.();
  }

  /** 表示設定や画面サイズが変わったときに、整え直す */
  function refreshLayout() {
    scrollCaret();
  }

  const onWindowResize = () => refreshLayout();
  window.addEventListener('resize', onWindowResize);

  /* ---------------------------------------------------------- 保存 */

  function markDirty() {
    dirty = true;
    revision += 1;
    syncState();
    updateDocumentTitle();
    setStatus('未保存');
    scheduleDraft();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { save(); }, SAVE_DEBOUNCE);
  }

  /**
   * 書きかけの控えを残す。
   * 1 文字ごとに本文全体を書き出すと長文で重くなるので、少しまとめる。
   * 本体への保存より早めにして、閉じたときの取りこぼしを防ぐ。
   */
  function scheduleDraft() {
    if (draftTimer) return;
    draftTimer = setTimeout(() => { draftTimer = null; writeDraft(); }, DRAFT_DEBOUNCE);
  }

  function writeDraft() {
    clearTimeout(draftTimer);
    draftTimer = null;
    if (!dirty) return;
    syncState();
    if (state.id || !isEmptyDraft(state)) {
      // 既存メモは空にした状態も下書きに残す（古い本文が復活しないように）
      const ok = saveDraft(key, state);
      if (!ok) setStatus('書きかけを保存できませんでした', 'warn');
    } else {
      clearDraft(key);
    }
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
    syncState();
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
        doc: state.doc,
        body: state.body,
        tags: state.tags,
      });
    } else {
      // 新規メモの id は一度だけ確保する（再試行で増やさない）
      const created = store.addNote({
        title: state.title,
        cue: state.cue,
        doc: state.doc,
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
      lastCreated = { id: created.id, parentId: parentId || null };
      // すでに画面を離れていたら URL は触らない（戻った先から引き戻さない）
      if (!disposed) replacePath(['note', created.id], { from: returnTo });
    }

    const result = await store.flush();

    if (!result.ok) {
      setStatus('保存できませんでした', 'error');
      showSaveError();
      return result;
    }

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
          syncState();
          const ok = await copyText(state.body);
          toast(ok ? 'コピーしました' : 'コピーできませんでした');
        },
      }));
    editorEl.querySelector('.ed__doc').insertAdjacentElement('beforebegin', box);
  }

  /** 本文へカーソルを移す */
  function focusBody() {
    surface?.focus();
  }

  /** ツールバーとショートカットバーに、いまの状態を映す */
  function updateButtons() {
    const st = surface?.state();
    undoBtn.disabled = !st?.canUndo;
    redoBtn.disabled = !st?.canRedo;
    if (!st) return;
    // いまのカーソルに関わりのあるまとまりに、そっと色を置く
    const on = {
      heading: st.heading > 0,
      format: st.bold || st.italic || st.strike || st.code || st.link,
      list: st.bullet || st.ordered || st.task,
      insert: st.inTable || st.quote || st.codeBlock,
    };
    shortcutBar.querySelectorAll('[data-group]').forEach((btn) => {
      btn.classList.toggle('ed__shortcut--on', Boolean(on[btn.dataset.group]));
    });
    tableBar.hidden = !st.inTable;
  }

  /** タブのタイトルを、いま書いているメモに合わせる */
  function updateDocumentTitle() {
    const first = (state.title || state.body.split('\n').find((l) => l.trim()) || '').trim();
    const name = first ? (first.length > 30 ? `${first.slice(0, 30)}…` : first) : 'メモ';
    document.title = `${name}｜${APP_NAME}`;
  }

  function setStatus(text, tone) {
    statusText.textContent = text;
    statusText.dataset.tone = tone || '';
  }

  /**
   * ステータスバーの数字。
   * 入力のたびに数え直すと長いメモで重くなるので、少し間引いて出す。
   */
  function updateStats({ immediate = false } = {}) {
    if (statsTimer) return;
    const compute = () => {
      statsTimer = null;
      syncState();
      const stats = surface?.stats() || { chars: state.body.length, lines: 0, selected: 0 };
      statusCount.textContent = stats.selected
        ? `${stats.selected} 字を選択 / ${stats.chars} 字`
        : `${stats.chars} 字・${stats.lines} 行`;
    };
    if (immediate) { compute(); return; }
    statsTimer = setTimeout(compute, 150);
  }

  /* ---------------------------------------------------------- 検索置換 */

  /**
   * メモの中を探す。
   *
   * 見つかったところは全部に色が付き、いま見ているものだけ濃くなる。
   * 入力欄にカーソルを置いたまま ↑↓（Enter / Shift+Enter）で行き来できる。
   * 置換はひと目で分かるよう、開いたときだけ 2 段目に出す。
   */
  const find = {
    query: '',
    replacement: '',
    exact: false,      // 大文字小文字・かなを区別するか
    showReplace: false,
    ranges: [],
    index: 0,
    timer: null,
  };
  let findUI = null;

  function toggleFind(force) {
    const show = force ?? findBar.hidden;
    if (!show) { closeFind(); return; }
    if (findBar.hidden) buildFindBar();
    findBar.hidden = false;
    runFind({ keepIndex: true });
    setTimeout(() => { findUI?.query.focus(); findUI?.query.select(); }, 30);
  }

  function closeFind() {
    clearTimeout(find.timer);
    find.timer = null;
    findBar.hidden = true;
    surface?.clearHighlight();
    // いま見ていたところへカーソルを置いて、そのまま書き続けられるようにする
    const range = find.ranges[find.index];
    if (range) surface?.placeCaret(range);
    else focusBody();
    find.ranges = [];
  }

  function buildFindBar() {
    clear(findBar);
    const query = h('input', {
      class: 'input ed__find-input',
      type: 'text',
      placeholder: 'メモ内を検索',
      value: find.query,
      'aria-label': 'メモ内を検索',
      enterkeyhint: 'search',
      onInput: (e) => {
        find.query = e.target.value;
        clearTimeout(find.timer);
        find.timer = setTimeout(() => runFind(), 120);
      },
      onKeyDown: (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
        if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
      },
    });
    const count = h('span', { class: 'ed__find-count' });
    const replaceInput = h('input', {
      class: 'input ed__find-input',
      type: 'text',
      placeholder: '置き換える言葉',
      value: find.replacement,
      'aria-label': '置き換える言葉',
      onInput: (e) => { find.replacement = e.target.value; },
      onKeyDown: (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') { e.preventDefault(); replaceCurrent(); }
        if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
      },
    });

    const exactBtn = iconButton(icon('format', { size: 18 }), {
      label: '大文字・かなを区別する',
      className: 'icon-btn icon-btn--sm',
      onClick: () => {
        find.exact = !find.exact;
        exactBtn.setAttribute('aria-pressed', String(find.exact));
        runFind();
      },
    });
    exactBtn.setAttribute('aria-pressed', String(find.exact));

    const replaceBtn = iconButton(icon('replace', { size: 18 }), {
      label: '置換を表示',
      className: 'icon-btn icon-btn--sm',
      onClick: () => {
        find.showReplace = !find.showReplace;
        replaceRow.hidden = !find.showReplace;
        replaceBtn.setAttribute('aria-pressed', String(find.showReplace));
        if (find.showReplace) setTimeout(() => replaceInput.focus(), 20);
      },
    });
    replaceBtn.setAttribute('aria-pressed', String(find.showReplace));

    const row = h('div', { class: 'ed__find-row' },
      h('span', { class: 'ed__find-icon', html: icon('search', { size: 18 }) }),
      query,
      count,
      exactBtn,
      iconButton(icon('chevronDown', { size: 18 }), {
        label: '前へ',
        className: 'icon-btn icon-btn--sm ed__find-prev',
        onClick: () => step(-1),
      }),
      iconButton(icon('chevronDown', { size: 18 }), {
        label: '次へ',
        className: 'icon-btn icon-btn--sm',
        onClick: () => step(1),
      }),
      replaceBtn,
      iconButton(icon('close', { size: 18 }), {
        label: '検索を閉じる',
        className: 'icon-btn icon-btn--sm',
        onClick: () => closeFind(),
      }));

    const replaceRow = h('div', { class: 'ed__find-row ed__find-row--replace', hidden: !find.showReplace },
      h('span', { class: 'ed__find-icon', html: icon('replace', { size: 18 }) }),
      replaceInput,
      button('置き換える', { className: 'btn btn--text btn--sm', onClick: () => replaceCurrent() }),
      button('すべて', { className: 'btn btn--text btn--sm', onClick: () => replaceAll() }));

    findBar.append(row, replaceRow);
    findUI = { query, count, replaceInput, replaceRow };
  }

  /** 探し直して、色と数字を出し直す */
  function runFind({ keepIndex = false } = {}) {
    if (!surface || findBar.hidden) return;
    const ranges = find.query ? surface.findMatches(find.query, { exact: find.exact }) : [];
    find.ranges = ranges;
    if (!ranges.length) find.index = 0;
    else if (keepIndex) find.index = Math.min(find.index, ranges.length - 1);
    else find.index = surface.matchIndexAfterCaret(ranges);
    surface.highlight(ranges, ranges.length ? find.index : -1);
    if (ranges.length) surface.revealRange(ranges[find.index]);
    updateFindCount();
  }

  function updateFindCount() {
    if (!findUI) return;
    const total = find.ranges.length;
    findUI.count.textContent = find.query
      ? (total ? `${find.index + 1} / ${total}` : '0 件')
      : '';
    findUI.count.dataset.miss = find.query && !total ? 'true' : '';
    findUI.query.dataset.miss = find.query && !total ? 'true' : '';
  }

  /** 次・前の当たりへ */
  function step(delta) {
    if (!surface) return;
    if (!find.ranges.length) { runFind(); return; }
    const total = find.ranges.length;
    find.index = (find.index + delta + total) % total;
    surface.highlight(find.ranges, find.index);
    surface.revealRange(find.ranges[find.index]);
    updateFindCount();
  }

  function replaceCurrent() {
    if (!surface || !find.ranges.length) return;
    const range = find.ranges[find.index];
    const at = find.index;
    surface.replaceRange(range, find.replacement);
    onSurfaceChange();
    // 置き換えたぶん位置がずれるので、探し直してから次へ進む
    runFind({ keepIndex: true });
    if (find.ranges.length) {
      find.index = Math.min(at, find.ranges.length - 1);
      surface.highlight(find.ranges, find.index);
      surface.revealRange(find.ranges[find.index]);
      updateFindCount();
    }
  }

  function replaceAll() {
    if (!surface || !find.ranges.length) return;
    const count = surface.replaceRanges(find.ranges, find.replacement);
    onSurfaceChange();
    runFind({ keepIndex: true });
    toast(`${count} か所を置き換えました（元に戻せます）`);
  }

  /* ------------------------------------------------- 見出しと文字数 */

  function openOutline() {
    const items = surface?.headings() || [];
    if (!items.length) {
      openMenu({
        title: '見出し',
        items: [{
          label: '見出しを作る',
          icon: icon('heading', { size: 20 }),
          description: '下のバーの「見出し」で、いまの行を見出しにできます',
          onClick: () => run((s) => s.commands.heading(2)),
        }],
      });
      return;
    }
    openMenu({
      title: '見出しへ移動',
      items: items.map((item) => ({
        label: `${'　'.repeat(item.level - 1)}${item.text || '（空の見出し）'}`,
        icon: icon('heading', { size: 20 }),
        onClick: () => surface?.goTo(item.pos),
      })),
    });
  }

  function openCountSheet() {
    syncState();
    const text = state.body;
    const stats = surface?.stats() || { chars: text.length, lines: 0, selected: 0 };
    const charsNoSpace = text.replace(/\s/g, '').length;
    const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim()).length;
    const words = (text.match(/[A-Za-z0-9_'-]+/g) || []).length;
    // 日本語はおよそ 500 字／分で読む目安
    const minutes = Math.max(1, Math.round(stats.chars / 500));
    const row = (label, value) => h('div', { class: 'version-row' },
      h('span', { class: 'version-row__key' }, label),
      h('span', { class: 'version-row__value' }, value));

    openSheet({
      title: '文字数',
      content: h('div', {},
        h('h2', { class: 'daypanel__date', style: { marginBottom: '8px' } }, '文字数'),
        row('文字数', `${stats.chars} 字`),
        row('空白を除く', `${charsNoSpace} 字`),
        row('行', `${stats.lines} 行`),
        row('段落', `${paragraphs} 段落`),
        words ? row('英単語', `${words} 語`) : null,
        row('読む目安', `約 ${minutes} 分`),
        stats.selected ? row('選択中', `${stats.selected} 字`) : null,
        h('div', { class: 'field__hint', style: { marginTop: '10px' } },
          '読む目安は 1 分あたり 500 字で計算しています。')),
    });
  }

  /* ---------------------------------------------------------- ボタン類 */

  /**
   * 下のバー。
   *
   * ボタンを並べきると、どれが何なのか読み取れなくなる。
   * 近いものを 1 つにまとめ、「まとまりを押す → やりたいことを選ぶ」の 2 手にした。
   * 開くのは画面を覆うシートではなく、その場の小さなメニュー（カーソルは本文のまま）。
   */
  function buildShortcuts() {
    const groups = [
      { id: 'heading', label: '見出し', icon: 'heading', open: openHeadingMenu },
      { id: 'format', label: '文字', icon: 'bold', open: openFormatMenu },
      { id: 'list', label: 'リスト', icon: 'list', open: openListMenu },
      { id: 'insert', label: '入れる', icon: 'plus', open: openInsertMenu },
      { id: 'tools', label: 'その他', icon: 'more', open: openToolsMenu },
    ];
    clear(shortcutBar);
    groups.forEach(({ id, label, icon: name, open }) => {
      const btn = h('button', {
        type: 'button',
        class: 'ed__shortcut',
        'data-group': id,
        title: label,
        'aria-label': label,
        'aria-haspopup': 'menu',
        // 押してもキーボードが閉じない・カーソルが外れないようにする
        onMouseDown: (e) => e.preventDefault(),
        onClick: () => open(btn),
      },
      h('span', { class: 'ed__shortcut-icon', html: icon(name, { size: 20 }) }),
      h('span', { class: 'ed__shortcut-label' }, label));
      shortcutBar.appendChild(btn);
    });
    buildTableBar();
  }

  /** 表の中にいるときだけ出る、行と列の操作 */
  function buildTableBar() {
    const items = [
      { label: '行を足す', icon: 'rowAdd', run: (s) => s.commands.addRow() },
      { label: '列を足す', icon: 'columnAdd', run: (s) => s.commands.addColumn() },
      { label: '行を削除', icon: 'rowRemove', run: (s) => s.commands.removeRow() },
      { label: '列を削除', icon: 'columnRemove', run: (s) => s.commands.removeColumn() },
      { label: '表を削除', icon: 'tableRemove', run: (s) => s.commands.removeTable(), danger: true },
    ];
    clear(tableBar);
    tableBar.appendChild(h('span', { class: 'ed__tablebar-label', html: icon('table', { size: 18 }) }));
    items.forEach(({ label, icon: name, run: fn, danger }) => {
      tableBar.appendChild(h('button', {
        type: 'button',
        class: `ed__tablebtn${danger ? ' ed__tablebtn--danger' : ''}`,
        title: label,
        'aria-label': label,
        onMouseDown: (e) => e.preventDefault(),
        onClick: () => run(fn),
      },
      h('span', { class: 'ed__tablebtn-icon', html: icon(name, { size: 18 }) }),
      h('span', {}, label)));
    });
  }

  /** メニューの 1 行（押したら本文に効かせて、ボタンの色も映し直す） */
  function cmdItem(label, name, fn, extra = {}) {
    return { label, icon: icon(name, { size: 20 }), onClick: () => run(fn), ...extra };
  }

  function openHeadingMenu(anchor) {
    const st = surface?.state() || {};
    openPopover({
      anchor,
      title: '見出し',
      items: [
        cmdItem('大見出し', 'heading', (s) => s.commands.heading(1), { active: st.heading === 1, hint: 'H1' }),
        cmdItem('中見出し', 'heading', (s) => s.commands.heading(2), { active: st.heading === 2, hint: 'H2' }),
        cmdItem('小見出し', 'heading', (s) => s.commands.heading(3), { active: st.heading === 3, hint: 'H3' }),
        { divider: true },
        cmdItem('ふつうの文章にする', 'text', (s) => s.commands.plain()),
      ],
    });
  }

  function openFormatMenu(anchor) {
    const st = surface?.state() || {};
    openPopover({
      anchor,
      title: '文字',
      items: [
        cmdItem('太字', 'bold', (s) => s.commands.bold(), { active: st.bold }),
        cmdItem('斜体', 'italic', (s) => s.commands.italic(), { active: st.italic }),
        cmdItem('打ち消し線', 'strike', (s) => s.commands.strike(), { active: st.strike }),
        cmdItem('コード（行の中）', 'codeTag', (s) => s.commands.code(), { active: st.code }),
        { divider: true },
        st.link
          ? cmdItem('リンクを外す', 'linkOff', (s) => s.commands.unlink())
          : { label: 'リンク', icon: icon('link', { size: 20 }), onClick: () => askLink() },
      ],
    });
  }

  function openListMenu(anchor) {
    const st = surface?.state() || {};
    const inList = st.bullet || st.ordered || st.task;
    openPopover({
      anchor,
      title: 'リスト',
      items: [
        cmdItem('箇条書き', 'list', (s) => s.commands.bullet(), { active: st.bullet }),
        cmdItem('番号つき', 'listNumber', (s) => s.commands.ordered(), { active: st.ordered }),
        cmdItem('チェック', 'checkbox', (s) => s.commands.task(), { active: st.task }),
        inList ? { divider: true } : null,
        inList ? cmdItem('項目の中で行を分ける', 'lineBreak', (s) => s.commands.lineBreak(),
          { hint: 'Shift+Enter' }) : null,
        st.canIndent ? cmdItem('字下げする', 'indent', (s) => s.commands.indent()) : null,
        st.canOutdent ? cmdItem('字下げを戻す', 'outdent', (s) => s.commands.outdent()) : null,
        st.task ? { divider: true } : null,
        // 「済んだこと」を消し込みたい人と、記録として残しておきたい人がいる
        st.task ? cmdItem(
          st.taskStrike ? '済みに取り消し線を引かない' : '済みに取り消し線を引く',
          'strike',
          (s) => s.commands.taskStrike(!st.taskStrike),
        ) : null,
      ].filter(Boolean),
    });
  }

  function openInsertMenu(anchor) {
    const st = surface?.state() || {};
    openPopover({
      anchor,
      title: '入れる',
      items: [
        cmdItem('表', 'table', (s) => s.commands.table(), { active: st.inTable }),
        cmdItem('引用', 'quote', (s) => s.commands.quote(), { active: st.quote }),
        cmdItem('コードのかたまり', 'codeTag', (s) => s.commands.codeBlock(), { active: st.codeBlock }),
        cmdItem('区切り線', 'rule', (s) => s.commands.rule()),
        { divider: true },
        cmdItem('行を分ける', 'lineBreak', (s) => s.commands.lineBreak(), { hint: 'Shift+Enter' }),
        cmdItem('日時', 'clock', (s) => s.commands.timestamp(
          formatDateTime(new Date().toISOString()),
        )),
      ],
    });
  }

  function openToolsMenu(anchor) {
    openPopover({
      anchor,
      title: 'その他',
      align: 'right',
      items: [
        { label: '検索と置換', icon: icon('replace', { size: 20 }), onClick: () => toggleFind(true) },
        { label: '見出しへ移動', icon: icon('heading', { size: 20 }), onClick: () => openOutline() },
        { label: '文字数', icon: icon('data', { size: 20 }), onClick: () => openCountSheet() },
        {
          label: '本文をコピー',
          icon: icon('copy', { size: 20 }),
          onClick: async () => {
            const { copyText } = await import('../../core/exporter.js');
            syncState();
            toast(await copyText(state.body) ? 'コピーしました' : 'コピーできませんでした');
          },
        },
      ],
    });
  }

  /** リンクの URL を聞いてから貼る */
  function askLink() {
    const input = h('input', { class: 'input', type: 'url', placeholder: 'https://' });
    openDialog({
      title: 'リンクを貼る',
      variant: 'alert',
      content: h('div', {}, input, h('div', { class: 'field__hint' }, 'えらんだ文字がリンクになります。')),
      actions: [
        { label: 'キャンセル', onClick: (close) => close() },
        {
          label: '貼る',
          className: 'btn btn--text',
          onClick: (close) => {
            const url = input.value;
            close();
            // 押した時点の選択のまま貼る（ダイアログを閉じてから動かす）
            setTimeout(() => {
              const ok = surface?.commands.link(url);
              if (ok === false) toast('この URL は貼れません');
              updateButtons();
            }, 0);
          },
        },
      ],
    });
    setTimeout(() => input.focus(), 40);
  }

  function openEditorMenu() {
    const note = state.id ? store.getNote(state.id) : null;
    openMenu({
      title: state.title || '（無題のメモ）',
      // 「表示設定」と「メモ情報」は、上のツールバーから直接開ける（ここには並べない）
      items: [
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
      h('div', { class: 'field__hint', style: { marginBottom: '12px' } },
        '「思い出すための手掛かり」は、本文の上（タイトルの下）で直接書けます。'),
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
    if (mod && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openOutline();
    }
    if (event.key === 'Escape' && !findBar.hidden) {
      toggleFind(false);
    }
  };
  document.addEventListener('keydown', onKeyDown);

  // キーボードが出て領域が縮んだとき、入力中の行を見失わないようにする
  const onViewportResize = () => { refreshLayout(); };
  window.visualViewport?.addEventListener('resize', onViewportResize);

  const onBeforeUnload = (event) => {
    if (!dirty) return;
    // 閉じる直前は、待たずにその場で残す
    writeDraft();
    store.flushSync() || save();
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  /**
   * 開いたときの居場所。
   *
   * 同じ立ち上げのあいだに開き直したときは、さっきの続きから。
   * アプリを開き直したあと（覚えていないとき）は、メモの始まりを見せる。
   * 読み返すために開くことが多いので、勝手に末尾へ飛ばさない。
   */
  function restorePosition() {
    const saved = state.id ? positions.get(state.id) : null;
    if (saved) {
      surface.select(saved.from, saved.to);
      doc.scrollTop = saved.scroll || 0;
      return;
    }
    if (state.body) {
      // 始まりを見せる。カーソルは置かない（開いただけでキーボードを出さない）
      doc.scrollTop = 0;
      return;
    }
    if (!state.title) {
      // 新しいメモは、まずタイトルから書き始められるようにする
      titleInput.focus({ preventScroll: true });
      return;
    }
    surface.focus();
  }

  active = {
    dispose() {
      disposed = true;
      // 画面を離れるときは、控えを必ず残してから片づける
      writeDraft();
      clearTimeout(saveTimer);
      clearTimeout(statsTimer);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('resize', onWindowResize);
      window.visualViewport?.removeEventListener('resize', onViewportResize);
      offTabMode();
      if (state.id && surface) {
        const sel = surface.selection();
        positions.set(state.id, { from: sel.from, to: sel.to, scroll: doc.scrollTop });
      }
      if (dirty) save();
      // 道具の後始末（見張りを残さない）
      surface?.destroy();
      surface = null;
      active = null;
    },
    /**
     * いま開いているのが、この行き先と同じメモか。
     * 同じなら画面を作り直さない（作り直すと、書いている途中の状態が消える）。
     */
    matches(wantedId, wantedParent) {
      const id = state.id || null;
      const same = wantedId && wantedId !== 'new' ? wantedId === id : Boolean(id);
      return same && (parentId || null) === (wantedParent || null);
    },
    refreshLayout,
  };

  return editorEl;
}

/** その行き先のメモを、いま開いているか */
export function isEditorShowing(noteId, parentId) {
  return Boolean(active?.matches?.(noteId, parentId));
}

export function disposeNoteEditor() {
  if (active) active.dispose();
  // 編集画面から出たら、「さっき作ったメモ」は忘れる（次の新規メモと混ざらないように）
  lastCreated = null;
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
  const fallback = { fontSize: 16, lineHeight: 1.9, wrap: true, mono: false, bare: false };
  try {
    const raw = window.localStorage.getItem(DISPLAY_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      fontSize: Number(parsed.fontSize) || fallback.fontSize,
      lineHeight: Number(parsed.lineHeight) || fallback.lineHeight,
      wrap: parsed.wrap !== false,
      mono: parsed.mono === true,
      // 集中モード：ショートカットバーを隠して、本文だけにする
      bare: parsed.bare === true,
    };
  } catch {
    return { ...fallback };
  }
}

/**
 * 変えた項目だけを書き換える。
 * パネルを開いた時点の値をまとめて書き戻すと、先に変えた設定が元に戻ってしまう。
 */
function patchDisplaySettings(patch) {
  writeDisplaySettings({ ...readDisplaySettings(), ...patch });
}

function writeDisplaySettings(value) {
  try {
    window.localStorage.setItem(DISPLAY_KEY, JSON.stringify(value));
  } catch { /* 保存できなくても表示は変えられる */ }
}

/**
 * 文字サイズ・行間などを本文の編集面へ映す。
 * 編集面は 1 枚だけなので、そこにまとめて当てる。
 */
function applyDisplaySettings(root) {
  const el = root || document.querySelector('.ed');
  const d = readDisplaySettings();
  const rich = el?.querySelector('.ed__rich');
  if (rich) {
    rich.style.fontSize = `${d.fontSize}px`;
    rich.style.lineHeight = String(d.lineHeight);
    rich.style.fontFamily = d.mono ? 'var(--fcc-font-mono)' : 'var(--fcc-font)';
    rich.style.whiteSpace = d.wrap ? 'pre-wrap' : 'pre';
    rich.style.overflowX = d.wrap ? 'hidden' : 'auto';
  }
  if (el) el.dataset.bare = d.bare ? 'true' : '';
  // 書いているところが隠れていないか、整え直す
  active?.refreshLayout?.();
}

function openDisplaySettings() {
  const root = document.querySelector('.ed');
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
          onClick: () => { patchDisplaySettings({ fontSize: size }); applyDisplaySettings(root); render(); },
        }, `${size}px`))),
      h('div', { class: 'field__label', style: { marginTop: '14px' } }, '行の間隔'),
      h('div', { class: 'filter-row' },
        ...[{ v: 1.7, label: '詰める' }, { v: 1.9, label: 'ふつう' }, { v: 2.2, label: 'ゆったり' }]
          .map(({ v, label }) => h('button', {
            type: 'button',
            class: 'chip',
            'aria-pressed': String(d.lineHeight === v),
            onClick: () => { patchDisplaySettings({ lineHeight: v }); applyDisplaySettings(root); render(); },
          }, label))),
      h('div', { class: 'divider' }),
      h('label', { class: 'switch' },
        h('span', { class: 'switch__text' },
          h('span', { class: 'switch__title' }, '折り返す'),
          h('span', { class: 'switch__desc' }, 'オフにすると長い行が横に伸びます。')),
        h('span', { class: 'switch__control' },
          h('input', {
            type: 'checkbox',
            checked: d.wrap,
            onChange: (e) => { patchDisplaySettings({ wrap: e.target.checked }); applyDisplaySettings(root); },
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
            onChange: (e) => { patchDisplaySettings({ mono: e.target.checked }); applyDisplaySettings(root); },
          }),
          h('span', { class: 'switch__track' }),
          h('span', { class: 'switch__thumb' }))),
      h('label', { class: 'switch' },
        h('span', { class: 'switch__text' },
          h('span', { class: 'switch__title' }, '集中モード'),
          h('span', { class: 'switch__desc' }, 'ショートカットバーを隠して、本文だけにします。')),
        h('span', { class: 'switch__control' },
          h('input', {
            type: 'checkbox',
            checked: d.bare,
            onChange: (e) => { patchDisplaySettings({ bare: e.target.checked }); applyDisplaySettings(root); },
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
