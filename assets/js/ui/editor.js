/** メモの作成・編集・詳細表示 */
import { h, button, iconButton, clear } from './dom.js';
import { icon } from './icons.js';
import { openDialog, openSheet, openMenu, confirmDialog, toast } from './overlays.js';
import { branchTree, curvePreview, reviewTimeline, tagChips } from './components.js';
import { openExportDialog } from './exportDialog.js';
import {
  PRESETS, SPREADS, baseIntervalsOf, getPreset, getSpread, randomSeed, resolveIntervals,
  sanitizeIntervals, spreadIdOf, spreadIntervals,
} from '../core/curve.js';
import { displayTitle, recallCue } from '../core/models.js';
import { clearDraft, draftKey, isEmptyDraft, loadDraft, saveDraft } from '../core/drafts.js';
import {
  addDays, diffDays, formatDateTime, formatDuration, formatLong, formatRelative, formatSmart, todayKey,
} from '../core/date.js';

/* ------------------------------------------------------------------ */
/* エディタ                                                            */
/* ------------------------------------------------------------------ */

/**
 * メモエディタを開く。
 *
 * 方針:
 * - 本文が主役。開いたらすぐ書ける。タイトル・手掛かり・タグは必要なときだけ出す
 * - 復習の設定は畳んでおく（既定のままで困らない）
 * - 入力は下書きとして自動保存し、閉じても消えない
 * - 保存が終わるまで画面を閉じない（保存できていないのに閉じない）
 *
 * @param {Store} store
 * @param {{noteId?:string, parentId?:string, anchorDate?:string}} options
 */
export function openNoteEditor(store, options = {}) {
  const existing = options.noteId ? store.getNote(options.noteId) : null;
  const parent = options.parentId ? store.getNote(options.parentId) : null;
  const settings = store.settings;
  const key = draftKey({
    noteId: options.noteId,
    parentId: options.parentId,
    anchorDate: options.anchorDate,
  });

  const base = {
    title: existing?.title ?? '',
    cue: existing?.cue ?? '',
    body: existing?.body ?? '',
    tags: (existing?.tags ?? parent?.tags ?? []).join(' '),
    anchorDate: existing?.anchorDate ?? options.anchorDate ?? todayKey(),
    presetId: existing?.schedule.presetId ?? settings.presetId,
    intervals: existing ? baseIntervalsOf(existing) : resolveIntervals(settings.presetId, settings),
    spread: existing ? (existing.schedule.spread ?? 0) : getSpread(settings.spreadId).ratio,
    seed: existing ? (existing.schedule.seed ?? 0) : randomSeed(),
  };

  const draft = loadDraft(key);
  const restored = draft && !isEmptyDraft(draft.value);
  const state = restored ? { ...base, ...draft.value } : { ...base };
  const canChangeAnchor = !existing || store.canChangeAnchor(existing);

  let saving = false;
  let dirty = restored;

  /* ---------------- 下書き ---------------- */

  const persistDraft = () => {
    if (saving) return;
    dirty = true;
    if (isEmptyDraft(state)) clearDraft(key);
    else saveDraft(key, state);
    updateStatus();
  };

  const statusLine = h('span', { class: 'editor__status' });
  function updateStatus(text) {
    statusLine.textContent = text ?? (isEmptyDraft(state)
      ? ''
      : (dirty ? '書きかけを保存しました' : ''));
  }

  /* ---------------- 本文 ---------------- */

  const bodyInput = h('textarea', {
    class: 'textarea textarea--main',
    placeholder: '思いついたことを、そのまま書いてください。',
    value: state.body,
    rows: '8',
    onInput: (e) => {
      state.body = e.target.value;
      autoGrow(e.target);
      persistDraft();
    },
  });

  const optionalFields = h('div', { class: 'editor__optional' });
  const addRow = h('div', { class: 'editor__add-row' });

  const fieldDefs = [
    {
      id: 'cue',
      label: '思い出すための手掛かり',
      addLabel: '手掛かり',
      iconName: 'eye',
      placeholder: '例）減価償却の3つの方法は？',
      hint: '復習ではこれだけが先に出ます。空欄ならタイトル（本文の1行目）が使われます。',
    },
    {
      id: 'title',
      label: 'タイトル',
      addLabel: 'タイトル',
      iconName: 'note',
      placeholder: '（省略すると本文の1行目）',
    },
    {
      id: 'tags',
      label: 'タグ',
      addLabel: 'タグ',
      iconName: 'tag',
      placeholder: '英語 語彙 仕事（スペース区切り）',
      datalist: store.allTags().map(([tag]) => tag),
    },
  ];

  const shown = new Set(fieldDefs.filter((f) => String(state[f.id] || '').trim()).map((f) => f.id));

  function renderOptional() {
    clear(optionalFields);
    clear(addRow);
    fieldDefs.forEach((def) => {
      if (!shown.has(def.id)) {
        addRow.appendChild(button(def.addLabel, {
          className: 'chip',
          icon: icon('plus', { size: 16 }),
          onClick: () => { shown.add(def.id); renderOptional(); focusField(def.id); },
        }));
        return;
      }
      const input = h('input', {
        class: 'input',
        type: 'text',
        id: `editor-${def.id}`,
        placeholder: def.placeholder,
        value: state[def.id] || '',
        list: def.datalist?.length ? `list-${def.id}` : null,
        onInput: (e) => { state[def.id] = e.target.value; persistDraft(); },
      });
      optionalFields.appendChild(h('label', { class: 'field' },
        h('span', { class: 'field__label' }, def.label),
        input,
        def.datalist?.length
          ? h('datalist', { id: `list-${def.id}` }, ...def.datalist.map((t) => h('option', { value: t })))
          : null,
        def.hint ? h('span', { class: 'field__hint' }, def.hint) : null));
    });
  }

  function focusField(id) {
    setTimeout(() => document.getElementById(`editor-${id}`)?.focus(), 30);
  }

  renderOptional();

  /* ---------------- 復習の設定 ---------------- */

  const scheduleBox = h('div', { class: 'editor__schedule' });
  const scheduleSummary = h('span', { class: 'editor__schedule-summary' });

  function currentIntervals() {
    const baseList = state.presetId === 'none' ? [] : sanitizeIntervals(state.intervals);
    return baseList.length ? spreadIntervals(baseList, state.seed, state.spread) : [];
  }

  function renderSchedule() {
    const preset = getPreset(state.presetId);
    const intervals = currentIntervals();
    scheduleSummary.textContent = intervals.length
      ? `${preset.name}・${intervals.length}回・最長 ${formatDuration(intervals[intervals.length - 1])}後`
      : '復習の予定を作りません';

    clear(scheduleBox);
    scheduleBox.append(
      h('div', { class: 'filter-row' },
        ...PRESETS.map((p) => h('button', {
          type: 'button',
          class: 'chip',
          'aria-pressed': String(p.id === state.presetId),
          onClick: () => {
            state.presetId = p.id;
            state.intervals = p.id === 'custom'
              ? sanitizeIntervals(settings.customIntervals)
              : [...p.intervals];
            persistDraft();
            renderSchedule();
          },
        }, p.name))),
      h('div', { class: 'field__hint', style: { margin: '10px 0' } }, preset.description),
    );

    if (!intervals.length) return;

    scheduleBox.append(
      curvePreview(intervals),
      h('div', { class: 'filter-row', style: { marginTop: '8px', flexWrap: 'wrap' } },
        ...intervals.slice(0, 6).map((d) => h('span', { class: 'chip chip--static' },
          `${formatDuration(d)}後 ${formatSmart(addDays(state.anchorDate, d))}`))),
      h('div', { class: 'field__hint' },
        `合計 ${intervals.length} 回・最後は ${formatDuration(intervals[intervals.length - 1])}後の `
        + `${formatSmart(addDays(state.anchorDate, intervals[intervals.length - 1]))}`),
      h('details', { class: 'editor__details' },
        h('summary', {}, '分散と起点日'),
        h('div', { class: 'spread-row', style: { marginTop: '10px' } },
          h('div', { style: { flex: '1', minWidth: '0' } },
            h('div', { class: 'field__label', style: { marginBottom: '2px' } }, '復習日の分散'),
            h('div', { class: 'field__hint' }, '同じ日に書いたメモと重ならないよう、先の予定ほどずらします。')),
          h('select', {
            class: 'select',
            style: { width: 'auto' },
            'aria-label': '復習日の分散',
            onChange: (e) => { state.spread = getSpread(e.target.value).ratio; persistDraft(); renderSchedule(); },
          }, ...SPREADS.map((sp) => h('option', {
            value: sp.id, selected: sp.id === spreadIdOf(state.spread),
          }, sp.label)))),
        state.spread ? h('div', { class: 'spread-row', style: { marginTop: '10px' } },
          h('div', { style: { flex: '1', minWidth: '0' } },
            h('div', { class: 'field__label', style: { marginBottom: '2px' } }, 'シード'),
            h('div', { class: 'field__hint' }, 'ずらし方を決める数字です。')),
          h('input', {
            class: 'input',
            type: 'number',
            min: '0',
            max: '9999',
            value: String(state.seed),
            style: { width: '6em' },
            'aria-label': '分散のシード',
            onChange: (e) => { state.seed = Number(e.target.value) || 0; persistDraft(); renderSchedule(); },
          }),
          iconButton(icon('dice', { size: 20 }), {
            label: 'シードを振り直す',
            className: 'icon-btn icon-btn--filled',
            onClick: () => { state.seed = randomSeed(); persistDraft(); renderSchedule(); },
          })) : null,
        h('label', { class: 'field', style: { marginTop: '12px', marginBottom: '0' } },
          h('span', { class: 'field__label' }, '起点の日'),
          canChangeAnchor
            ? h('input', {
              class: 'input',
              type: 'date',
              value: state.anchorDate,
              onChange: (e) => {
                state.anchorDate = e.target.value || todayKey();
                persistDraft();
                renderSchedule();
              },
            })
            : h('div', {},
              h('div', { class: 'input', style: { color: 'var(--fcc-on-surface-variant)' } },
                formatLong(state.anchorDate)),
              h('span', { class: 'field__hint' },
                'すでに復習の記録があるため、起点日は変更できません。'
                + '組み直したいときは「復習を今日からやり直す」を使ってください。')))),
    );
  }
  renderSchedule();

  /* ---------------- 組み立て ---------------- */

  const restoredBanner = restored
    ? h('div', { class: 'banner banner--info editor__restored' },
      h('span', { html: icon('info', { size: 18 }), style: { display: 'flex' } }),
      h('span', { style: { flex: '1' } }, '書きかけを復元しました。'),
      button('破棄', {
        className: 'btn btn--text btn--sm',
        onClick: () => {
          clearDraft(key);
          Object.assign(state, base);
          bodyInput.value = state.body;
          autoGrow(bodyInput);
          shown.clear();
          fieldDefs.filter((f) => String(state[f.id] || '').trim()).forEach((f) => shown.add(f.id));
          renderOptional();
          renderSchedule();
          restoredBanner.remove();
          dirty = false;
          updateStatus('');
        },
      }))
    : null;

  const content = h('div', { class: 'editor' },
    restoredBanner,
    parent ? h('div', { class: 'editor__parent' },
      h('span', { html: icon('branch', { size: 18 }), style: { display: 'flex' } }),
      h('span', {}, `「${displayTitle(parent)}」への追加メモ`)) : null,
    bodyInput,
    addRow,
    optionalFields,
    h('details', { class: 'editor__details editor__details--schedule' },
      h('summary', {},
        h('span', {}, '復習の設定'),
        scheduleSummary),
      scheduleBox));

  const errorBox = h('div', { class: 'editor__error', hidden: true });
  content.append(errorBox, statusLine);

  const dialog = openDialog({
    title: existing ? 'メモを編集' : parent ? '追加メモ' : '新しいメモ',
    content,
    leading: iconButton(icon('close'), {
      label: '閉じる',
      onClick: () => {
        // 書きかけは下書きとして残す（消さない）
        if (!isEmptyDraft(state) && dirty) toast('書きかけを保存しました。次に開くと続きから書けます。');
        dialog.close();
      },
    }),
    actions: [
      { label: 'キャンセル', className: 'btn btn--text', onClick: () => dialog.close() },
      { label: '保存', className: 'btn', onClick: () => save() },
    ],
  });

  async function save() {
    if (saving) return;
    if (!state.body.trim() && !state.title.trim() && !state.cue.trim()) {
      toast('本文を入力してください');
      bodyInput.focus();
      return;
    }
    saving = true;
    errorBox.hidden = true;
    updateStatus('保存しています…');

    let note = existing;
    if (existing) {
      store.updateNote(existing.id, {
        title: state.title,
        cue: state.cue,
        body: state.body,
        tags: state.tags,
        anchorDate: state.anchorDate,
        presetId: state.presetId,
        intervals: state.presetId === 'none' ? [] : state.intervals,
        spread: state.spread,
        seed: state.seed,
      });
      note = store.getNote(existing.id);
    } else {
      note = store.addNote({
        title: state.title,
        cue: state.cue,
        body: state.body,
        tags: state.tags,
        anchorDate: state.anchorDate,
        parentId: options.parentId || null,
        presetId: state.presetId,
        intervals: state.presetId === 'none' ? [] : state.intervals,
        spread: state.spread,
        seed: state.seed,
      });
    }

    // 保存が終わるまで閉じない
    const result = await store.flush();
    saving = false;

    if (!result.ok) {
      updateStatus('');
      errorBox.hidden = false;
      clear(errorBox).append(
        h('span', { html: icon('info', { size: 18 }), style: { display: 'flex' } }),
        h('span', { style: { flex: '1' } },
          '保存できませんでした。本文は残っています。もう一度お試しいただくか、本文をコピーして保管してください。'),
        button('再試行', { className: 'btn btn--sm', onClick: () => save() }),
        button('本文をコピー', {
          className: 'btn btn--text btn--sm',
          onClick: async () => {
            const { copyText } = await import('../core/exporter.js');
            const ok = await copyText(state.body);
            toast(ok ? 'コピーしました' : 'コピーできませんでした');
          },
        }),
      );
      return;
    }

    clearDraft(key);
    dirty = false;
    const next = note?.reviews.find((r) => r.status === 'pending');
    if (existing) toast('保存しました');
    else if (next) toast(`保存しました。次の復習は ${formatRelative(next.due)}`);
    else toast('保存しました。復習の予定はまだありません。');
    dialog.close();
  }

  setTimeout(() => {
    bodyInput.focus({ preventScroll: true });
    autoGrow(bodyInput);
    const len = bodyInput.value.length;
    bodyInput.setSelectionRange(len, len);
  }, 60);

  return dialog;
}

/** 入力に合わせて本文欄を伸ばす */
function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight + 2, Math.max(240, window.innerHeight * 0.45))}px`;
}
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
