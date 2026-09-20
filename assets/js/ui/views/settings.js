/** 設定画面 */
import { h, button, iconButton, clear } from '../dom.js';
import { icon } from '../icons.js';
import { curvePreview } from '../components.js';
import { confirmDialog, toast, openDialog } from '../overlays.js';
import { openExportDialog } from '../exportDialog.js';
import {
  MAX_INTERVAL_DAYS, PRESETS, SPREADS, getPreset, getSpread, sanitizeIntervals, spreadIntervals,
} from '../../core/curve.js';
import { FORMATS } from '../../core/exporter.js';
import { backupLabel, pickBackupFile, saveBackupFile } from '../backup.js';
import { notificationState, requestReminderPermission, testReminder } from '../reminders.js';
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

  /* ---------------- リマインド ---------------- */
  root.appendChild(reminderCard(store));

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

  /* ---------------- 続ける仕組み ---------------- */
  const missionState = s.missionsEnabled ? store.missionState() : null;
  root.appendChild(h('section', { class: 'card' },
    h('div', { class: 'card__title' },
      h('span', { html: icon('mission', { size: 18 }), style: { display: 'flex' } }), '続ける仕組み'),
    switchRow({
      title: 'デイリーミッション',
      desc: '毎日 3 つまでの小さなお題が出ます。予定の範囲を超える要求はせず、できない日があっても罰はありません。',
      checked: s.missionsEnabled,
      onChange: (v) => store.updateSettings({ missionsEnabled: v }),
    }),
    missionState ? h('div', { class: 'field__hint', style: { marginTop: '10px' } },
      `今日 ${missionState.doneCount}/${missionState.total} 達成`
      + `・連続 ${missionState.streak.current || 0}日`
      + `・${missionState.level.rank}（Lv.${missionState.level.level}／${missionState.level.points} pt）`)
      : h('div', { class: 'field__hint', style: { marginTop: '10px' } },
        'オフにすると、アプリバーとカレンダーからミッションの表示が消えます。記録は残ります。')));

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
      h('div', { class: 'divider' }),
      spreadSection(store, intervals),
    ].filter(Boolean);
    card.replaceChildren(...children);
  };

  draw();
  return card;
}

/** 復習日の分散 */
function spreadSection(store, intervals) {
  const s = store.settings;
  const current = getSpread(s.spreadId);
  // 同じ日に 4 件書いたと仮定して、最後の回がどのくらい散るかを見せる
  const samples = [17, 431, 2088, 7345].map((seed) => spreadIntervals(intervals, seed, current.ratio));
  const lastStep = intervals.length - 1;
  const spanDays = current.ratio
    ? Math.max(...samples.map((v) => v[lastStep])) - Math.min(...samples.map((v) => v[lastStep]))
    : 0;

  return h('div', {},
    h('div', { class: 'card__title', style: { fontSize: '.88rem' } },
      h('span', { html: icon('dice', { size: 18 }), style: { display: 'flex' } }), '復習日の分散'),
    h('div', { class: 'card__desc' },
      '同じ日に何件もメモを書くと、そのままでは未来の復習日まで同じ日に重なります。'
      + 'メモごとのシードで、先の予定ほど前後にずらします。'),
    h('div', { class: 'filter-row' },
      ...SPREADS.map((sp) => h('button', {
        type: 'button',
        class: 'chip',
        'aria-pressed': String(s.spreadId === sp.id),
        onClick: () => store.updateSettings({ spreadId: sp.id }),
      }, sp.label))),
    h('div', { class: 'field__hint', style: { marginTop: '10px' } }, current.description),
    h('div', { class: 'spread-sample' },
      ...samples.map((v, i) => h('div', { class: 'spread-sample__row' },
        h('span', { class: 'spread-sample__label' }, `メモ${i + 1}`),
        h('span', { class: 'spread-sample__value' },
          `${formatDuration(v[0])}後 … ${formatDuration(v[lastStep])}後`)))),
    h('div', { class: 'field__hint' },
      current.ratio
        ? `同じ日に書いた場合でも、最後の回は ${formatDuration(spanDays)} ほどの幅に散ります（翌日の復習は動きません）。`
        : '分散なし。同じ日に書いたメモは、未来でも同じ日に復習することになります。'),
    h('div', { class: 'field__hint' }, 'この設定は、これから書くメモに使われます。メモごとの変更は編集画面から行えます。'));
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

    h('div', { class: 'backup-status', style: { marginBottom: '12px' } },
      h('span', {
        class: `backup-status__dot ${store.backupStatus().stale ? 'backup-status__dot--stale' : ''}`,
      }),
      h('div', {},
        h('div', { class: 'backup-status__label' }, backupLabel(store.backupStatus())),
        store.backupStatus().last
          ? h('div', { class: 'field__hint' }, formatDateTime(store.backupStatus().last))
          : null)),

    h('div', { class: 'note-card__actions', style: { marginTop: '0' } },
      button('バックアップを保存', {
        className: 'btn',
        icon: icon('download', { size: 18 }),
        onClick: () => saveBackupFile(store),
      }),
      button('バックアップから復元', {
        className: 'btn btn--tonal',
        icon: icon('upload', { size: 18 }),
        onClick: () => pickBackupFile(store),
      })),

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

/* ------------------------------------------------------------------ */

/**
 * 復習のリマインド。
 *
 * 配信用のサーバーを持たないので、届き方は端末とブラウザによって変わる。
 * できること・できないことを、ここではっきり書いておく。
 */
function reminderCard(store) {
  const card = h('section', { class: 'card' });

  const render = () => {
    const reminder = store.settings.reminder || {};
    const permission = notificationState();
    const supported = permission !== 'unsupported';

    const timeInput = h('input', {
      class: 'input',
      type: 'time',
      value: reminder.time || '20:00',
      style: { width: 'auto' },
      disabled: !reminder.enabled,
      onChange: (e) => {
        store.updateSettings({ reminder: { ...reminder, time: e.target.value } });
        toast(`${e.target.value} に知らせます`);
      },
    });

    const rows = [
      h('div', { class: 'card__title' },
        h('span', { html: icon('clock', { size: 18 }), style: { display: 'flex' } }), '復習のリマインド'),
      switchRow({
        title: '毎日のリマインドを受け取る',
        desc: 'その日の復習があるときだけ、決めた時刻にお知らせします。',
        checked: reminder.enabled === true,
        onChange: async (value) => {
          if (!value) {
            store.updateSettings({ reminder: { ...reminder, enabled: false } });
            render();
            return;
          }
          const result = await requestReminderPermission();
          if (result !== 'granted') {
            toast(result === 'unsupported'
              ? 'このブラウザではお知らせを出せません'
              : 'ブラウザの設定で、通知が止められています');
            render();
            return;
          }
          store.updateSettings({ reminder: { ...reminder, enabled: true } });
          toast('リマインドを受け取ります');
          render();
        },
      }),
    ];

    if (reminder.enabled) {
      rows.push(
        h('label', { class: 'field', style: { marginTop: '12px', marginBottom: '0' } },
          h('span', { class: 'field__label' }, '知らせる時刻'),
          timeInput),
        h('div', { class: 'note-card__actions', style: { marginTop: '12px' } },
          button('いま試す', {
            className: 'btn btn--tonal btn--sm',
            icon: icon('play', { size: 16 }),
            onClick: async () => {
              const ok = await testReminder(store);
              toast(ok ? 'お知らせを出しました' : 'お知らせを出せませんでした');
            },
          })),
      );
    }

    rows.push(h('div', { class: 'field__hint', style: { marginTop: '12px' } },
      !supported
        ? 'このブラウザはお知らせに対応していません。'
        : permission === 'denied'
          ? 'ブラウザの設定で通知が止められています。サイトの設定から許可すると受け取れます。'
          : '届き方は端末によって変わります。アプリを開いているあいだは必ず届きます。'
            + '閉じているあいだに届けられるかは、ブラウザ次第です'
            + '（ホーム画面に追加しておくと届きやすくなります）。'));

    clear(card).append(...rows);
  };

  render();
  return card;
}

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
