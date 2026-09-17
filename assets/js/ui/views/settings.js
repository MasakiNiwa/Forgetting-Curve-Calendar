/** 設定画面 */
import { h, button, iconButton } from '../dom.js';
import { icon } from '../icons.js';
import { curvePreview } from '../components.js';
import { confirmDialog, toast, openDialog } from '../overlays.js';
import { openExportDialog } from '../exportDialog.js';
import { PRESETS, getPreset, sanitizeIntervals, MAX_INTERVAL_DAYS } from '../../core/curve.js';
import { FORMATS, buildFilename, downloadText, readFileAsText, serializeBackup } from '../../core/exporter.js';
import { APP_VERSION } from '../../core/config.js';
import { formatDateTime, formatDuration } from '../../core/date.js';

const THEMES = [
  { id: 'system', label: '端末に合わせる', iconName: 'auto' },
  { id: 'light', label: 'ライト', iconName: 'light' },
  { id: 'dark', label: 'ダーク', iconName: 'dark' },
];

const OVERDUE_LIMITS = [5, 10, 20, 50, 0];

export function renderSettings(store) {
  const s = store.settings;
  const root = h('div', { class: 'page page--narrow' });

  root.appendChild(h('div', { class: 'page__header' },
    h('h1', { class: 'page__title' }, '設定'),
    h('div', { class: 'page__subtitle' }, '表示・忘却曲線・復習・データの管理')));

  /* ---------------- 表示 ---------------- */
  root.appendChild(h('section', { class: 'card' },
    h('div', { class: 'card__title' },
      h('span', { html: icon('light', { size: 18 }), style: { display: 'flex' } }), '表示'),
    h('div', { class: 'card__desc' }, 'テーマと週の始まりを選べます。'),
    h('div', { class: 'filter-row' },
      ...THEMES.map((t) => h('button', {
        type: 'button',
        class: 'chip',
        'aria-pressed': String(s.theme === t.id),
        onClick: () => store.updateSettings({ theme: t.id }),
      }, h('span', { html: icon(t.iconName, { size: 16 }), style: { display: 'flex' } }), t.label))),
    h('div', { class: 'divider' }),
    h('label', { class: 'field', style: { marginBottom: '0' } },
      h('span', { class: 'field__label' }, '週の始まり'),
      h('select', {
        class: 'select',
        onChange: (e) => store.updateSettings({ weekStart: Number(e.target.value) }),
      },
      h('option', { value: '0', selected: s.weekStart === 0 }, '日曜日'),
      h('option', { value: '1', selected: s.weekStart === 1 }, '月曜日'))),
    h('div', { class: 'divider' }),
    switchRow({
      title: '書いた日をカレンダーに表示',
      desc: 'メモを書いた日に印を付けます。',
      checked: s.showCreatedOnCalendar,
      onChange: (v) => store.updateSettings({ showCreatedOnCalendar: v }),
    })));

  /* ---------------- 忘却曲線 ---------------- */
  root.appendChild(renderCurveCard(store));

  /* ---------------- 復習の挙動 ---------------- */
  root.appendChild(h('section', { class: 'card' },
    h('div', { class: 'card__title' },
      h('span', { html: icon('target', { size: 18 }), style: { display: 'flex' } }), '復習のしかた'),
    switchRow({
      title: '思い出してから内容を開く',
      desc: '復習のときは手掛かりだけを表示し、［内容を見る］で本文を開いてから記録します。',
      checked: s.hideBodyUntilRecall,
      onChange: (v) => store.updateSettings({ hideBodyUntilRecall: v }),
    }),
    h('div', { class: 'divider' }),
    switchRow({
      title: '想起の結果で間隔を調整する',
      desc: '「覚えていた / あいまい / 忘れた」に応じて、残りの復習日を自動で伸縮させます。切り替えると既存のメモの予定も組み直されます。',
      checked: s.adaptive,
      onChange: (v) => store.updateSettings({ adaptive: v }),
    }),
    h('div', { class: 'divider' }),
    switchRow({
      title: '思い出し待ちを今日に繰り越す',
      desc: 'やり残した復習を今日のタスクに並べます。カレンダー上の元の日付は変わりません。',
      checked: s.carryOverOverdue,
      onChange: (v) => store.updateSettings({ carryOverOverdue: v }),
    }),
    s.carryOverOverdue ? h('label', { class: 'field', style: { marginTop: '12px', marginBottom: '0' } },
      h('span', { class: 'field__label' }, '1 日に取り戻す件数'),
      h('select', {
        class: 'select',
        onChange: (e) => store.updateSettings({ overdueDailyLimit: Number(e.target.value) }),
      }, ...OVERDUE_LIMITS.map((n) => h('option', {
        value: String(n),
        selected: s.overdueDailyLimit === n,
      }, n === 0 ? 'すべて出す' : `1日 ${n} 件まで`))),
      h('span', { class: 'field__hint' },
        'たまった復習を少しずつ取り戻すための上限です。残りは順番待ちとして保たれます。')) : null));

  /* ---------------- データ ---------------- */
  root.appendChild(renderDataCard(store));

  /* ---------------- 統計 ---------------- */
  const st = store.stats();
  root.appendChild(h('section', { class: 'card' },
    h('div', { class: 'card__title' },
      h('span', { html: icon('data', { size: 18 }), style: { display: 'flex' } }), 'いまの状況'),
    h('div', { class: 'stat-grid' },
      stat(st.total, 'メモ'),
      stat(st.active, '復習中'),
      stat(st.graduated, '定着'),
      stat(st.overdue, '思い出し待ち'),
      stat(st.pendingToday, '今日の復習'),
      stat(st.reviewsDone, '思い出した回数')),
    st.reviewsDone ? h('div', { class: 'field__hint', style: { marginTop: '10px' } },
      `内訳: 覚えていた ${st.ratings.known} / あいまい ${st.ratings.vague} / 忘れた ${st.ratings.forgot}`) : null,
    h('div', { class: 'field__hint', style: { marginTop: '6px' } },
      `保存先: ${store.adapter.label ?? store.adapter.id}　最終更新: ${formatDateTime(store.data.meta.updatedAt)}　v${APP_VERSION}`)));

  return root;
}

/* ------------------------------------------------------------------ */

function renderCurveCard(store) {
  const card = h('section', { class: 'card' });

  const draw = () => {
    const s = store.settings;
    const preset = getPreset(s.presetId);
    const intervals = s.presetId === 'custom' ? sanitizeIntervals(s.customIntervals) : preset.intervals;
    const last = intervals[intervals.length - 1];

    const children = [
      h('div', { class: 'card__title' },
        h('span', { html: icon('curve', { size: 18 }), style: { display: 'flex' } }), '忘却曲線'),
      h('div', { class: 'card__desc' }, '新しく書くメモに使う既定の間隔です。メモごとに個別変更もできます。'),
      h('div', { class: 'filter-row' },
        ...PRESETS.map((p) => h('button', {
          type: 'button',
          class: 'chip',
          'aria-pressed': String(s.presetId === p.id),
          onClick: () => store.updateSettings({ presetId: p.id }),
        }, p.name))),
      h('div', { class: 'field__hint', style: { margin: '10px 0' } }, preset.description),
      curvePreview(intervals),
      h('div', { class: 'field__hint', style: { marginBottom: '10px' } },
        `復習 ${intervals.length} 回・最後は ${formatDuration(last)}後：`
        + `${intervals.map((d) => formatDuration(d)).join(' → ')}`),
      s.presetId === 'custom' ? customIntervalEditor(store) : null,
    ].filter(Boolean);
    card.replaceChildren(...children);
  };

  draw();
  return card;
}

function customIntervalEditor(store) {
  const intervals = sanitizeIntervals(store.settings.customIntervals);
  const input = h('input', {
    class: 'input',
    type: 'number',
    min: '1',
    max: String(MAX_INTERVAL_DAYS),
    placeholder: '日数',
    style: { width: '7em' },
  });

  const add = () => {
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < 1) return;
    store.updateSettings({ customIntervals: [...intervals, value] });
    input.value = '';
  };

  return h('div', {},
    h('div', { class: 'field__label' }, 'カスタム間隔（起点日からの日数）'),
    h('div', { class: 'interval-editor' },
      ...intervals.map((d) => h('span', { class: 'interval-pill' },
        `${formatDuration(d)}`,
        iconButton(icon('close', { size: 14 }), {
          label: `${d}日を削除`,
          className: '',
          onClick: () => store.updateSettings({
            customIntervals: intervals.filter((x) => x !== d),
          }),
        }))),
      input,
      button('追加', { className: 'btn btn--tonal btn--sm', onClick: add })),
    h('div', { class: 'filter-row', style: { marginTop: '8px' } },
      ...[365, 730, 1825, 3650, 10950].map((d) => h('button', {
        type: 'button',
        class: 'chip',
        onClick: () => store.updateSettings({ customIntervals: [...intervals, d] }),
      }, `+ ${formatDuration(d)}`))),
    h('div', { class: 'field__hint' }, `1 日〜${formatDuration(MAX_INTERVAL_DAYS)}。重複と並び順は自動で整理されます。`));
}

function renderDataCard(store) {
  const fileInput = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    style: { display: 'none' },
    onChange: async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        const raw = JSON.parse(await readFileAsText(file));
        openRestoreDialog(store, raw);
      } catch (err) {
        console.error(err);
        toast('ファイルを読み込めませんでした（JSON 形式ではありません）');
      }
    },
  });

  return h('section', { class: 'card' },
    h('div', { class: 'card__title' },
      h('span', { html: icon('data', { size: 18 }), style: { display: 'flex' } }), 'データ'),
    h('div', { class: 'card__desc' },
      'データはこの端末のブラウザ内にのみ保存されます。機種変更やブラウザの初期化に備えて、ときどきバックアップしてください。'),

    store.storageWarning
      ? h('div', { class: 'banner banner--warning', style: { marginBottom: '12px' } },
        h('span', { html: icon('info', { size: 18 }), style: { display: 'flex' } }),
        h('span', {}, store.storageWarning))
      : null,

    h('div', { class: 'note-card__actions', style: { marginTop: '0' } },
      button('バックアップを保存', {
        className: 'btn',
        icon: icon('download', { size: 18 }),
        onClick: () => {
          downloadText(
            buildFilename('forgetting-curve-backup', 'json'),
            serializeBackup(store.exportData()),
            'application/json',
          );
          toast('バックアップを保存しました');
        },
      }),
      button('バックアップから復元', {
        className: 'btn btn--tonal',
        icon: icon('upload', { size: 18 }),
        onClick: () => fileInput.click(),
      })),
    fileInput,

    h('div', { class: 'divider' }),

    h('div', { class: 'note-card__actions', style: { marginTop: '0' } },
      button('メモを書き出す', {
        className: 'btn btn--outlined',
        icon: icon('copy', { size: 18 }),
        onClick: () => openExportDialog(store, store.notes, {
          title: 'すべてのメモを出力',
          baseName: 'forgetting-curve-notes',
        }),
      })),
    h('div', { class: 'field__hint' },
      `対応形式: ${FORMATS.map((f) => f.label).join(' / ')}`),

    h('div', { class: 'divider' }),

    h('label', { class: 'field', style: { marginBottom: '8px' } },
      h('span', { class: 'field__label' }, '出力の既定形式'),
      h('select', {
        class: 'select',
        onChange: (e) => store.updateSettings({ defaultExportFormat: e.target.value }),
      }, ...FORMATS.map((f) => h('option', {
        value: f.id,
        selected: store.settings.defaultExportFormat === f.id,
      }, f.label)))),

    h('div', { class: 'divider' }),

    button('すべてのデータを削除', {
      className: 'btn btn--text',
      icon: icon('trash', { size: 18 }),
      style: { color: 'var(--fcc-error)' },
      onClick: async () => {
        const ok = await confirmDialog({
          title: 'すべて削除しますか？',
          message: 'メモと復習の記録がすべて消えます。この操作は取り消せません。先にバックアップの保存をおすすめします。',
          confirmLabel: '削除する',
          danger: true,
        });
        if (!ok) return;
        await store.clearAll();
        toast('すべてのデータを削除しました');
      },
    }));
}

function openRestoreDialog(store, raw) {
  const count = Array.isArray(raw?.notes) ? raw.notes.length : 0;
  openDialog({
    title: 'バックアップから復元',
    variant: 'alert',
    content: h('div', {},
      h('p', { style: { color: 'var(--fcc-on-surface-variant)' } },
        `${count} 件のメモが見つかりました。復元方法を選んでください。`),
      h('p', { class: 'field__hint' },
        '「置き換え」は今のデータを消して復元します。「追加」は今のデータを残したまま、未登録のメモだけを取り込みます。')),
    actions: [
      { label: 'キャンセル', className: 'btn btn--text', onClick: (close) => close() },
      {
        label: '追加',
        className: 'btn btn--tonal',
        onClick: (close) => {
          const res = store.importData(raw, 'merge');
          toast(`${res.imported} 件を追加しました（重複 ${res.skipped} 件はスキップ）`);
          close();
        },
      },
      {
        label: '置き換え',
        className: 'btn',
        onClick: async (close) => {
          const ok = await confirmDialog({
            title: '置き換えますか？',
            message: '今のメモと復習の記録は削除されます。',
            confirmLabel: '置き換える',
            danger: true,
          });
          if (!ok) return;
          const res = store.importData(raw, 'replace');
          toast(`${res.imported} 件を復元しました`);
          close();
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------ */

function switchRow({ title, desc, checked, onChange }) {
  return h('label', { class: 'switch' },
    h('span', { class: 'switch__text' },
      h('span', { class: 'switch__title' }, title),
      desc ? h('span', { class: 'switch__desc' }, desc) : null),
    h('span', { class: 'switch__control' },
      h('input', {
        type: 'checkbox',
        checked,
        onChange: (e) => onChange(e.target.checked),
      }),
      h('span', { class: 'switch__track' }),
      h('span', { class: 'switch__thumb' })));
}

function stat(value, label) {
  return h('div', { class: 'stat' },
    h('div', { class: 'stat__value' }, String(value)),
    h('div', { class: 'stat__label' }, label));
}
