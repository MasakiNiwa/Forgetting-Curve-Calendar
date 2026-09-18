/** アプリシェル（アプリバー・ナビゲーション・FAB）と画面の切り替え */
import { h, clear, iconButton } from './dom.js';
import { icon } from './icons.js';
import { toast } from './overlays.js';
import { openNoteEditor } from './editor.js';
import { renderCalendar } from './views/calendar.js';
import { renderNotes } from './views/notes.js';
import { renderStats } from './views/stats.js';
import { renderSettings } from './views/settings.js';
import { renderHelp } from './views/help.js';
import { currentRoute, navigate, parseHash, startRouter } from './router.js';
import { renderNoteEditor, disposeNoteEditor } from './views/noteEditor.js';
import { openBackupSheet, backupLabel } from './backup.js';
import { missionButton, announceMissions, celebrate } from './missions.js';
import { APP_NAME, APP_TAGLINE } from '../core/config.js';

const ROUTES = [
  { id: 'calendar', label: 'カレンダー', iconName: 'calendar', render: renderCalendar },
  { id: 'notes', label: 'メモ', iconName: 'notes', render: renderNotes },
  { id: 'stats', label: '記録', iconName: 'data', render: renderStats },
  { id: 'settings', label: '設定', iconName: 'settings', render: renderSettings },
  { id: 'help', label: 'ヘルプ', iconName: 'help', render: renderHelp },
];

export function mountApp(store, root) {
  let route = currentRoute(ROUTES, 'calendar');

  const main = h('main', { class: 'app__main', id: 'main' });
  const nav = h('nav', { class: 'nav', 'aria-label': 'メインナビゲーション' });
  const navItems = new Map();

  ROUTES.forEach((r) => {
    const item = h('a', {
      class: 'nav__item',
      href: `#/${r.id}`,
      onClick: (e) => { e.preventDefault(); navigate(r.id); },
    },
    h('span', { class: 'nav__indicator', html: icon(r.iconName) }),
    h('span', { class: 'nav__label' }, r.label));
    navItems.set(r.id, item);
    nav.appendChild(item);
  });

  // データは端末内にしかないので、バックアップへの入口は常に見える場所に置く
  const backupAge = h('span', { class: 'appbar__backup-age' });
  const backupButton = h('button', {
    type: 'button',
    class: 'appbar__backup',
    onClick: () => openBackupSheet(store),
  }, h('span', { class: 'appbar__backup-icon', html: icon('download') }), backupAge);

  function updateBackupBadge() {
    const status = store.backupStatus();
    backupButton.dataset.stale = status.stale ? 'true' : '';
    // 間が空いているときは、日数をその場に出す（開かなくても分かるように）
    backupAge.textContent = status.stale && status.days !== null ? `${status.days}日` : '';
    const label = `バックアップ（${backupLabel(status)}）`;
    backupButton.setAttribute('aria-label', label);
    backupButton.title = label;
  }
  updateBackupBadge();

  // 毎日ここへ戻ってくる理由（デイリーミッション）への入口
  const mission = missionButton(store);

  const appbar = h('header', { class: 'appbar' },
    h('div', { class: 'appbar__brand' },
      h('span', { class: 'appbar__logo', html: icon('curve', { size: 26 }), style: { display: 'flex' } }),
      h('div', { style: { minWidth: '0' } },
        h('div', { class: 'appbar__title' }, APP_NAME),
        h('div', { class: 'appbar__tagline' }, APP_TAGLINE))),
    h('div', { class: 'appbar__spacer' }),
    mission.element,
    backupButton);

  const fab = h('button', {
    class: 'fab',
    type: 'button',
    'aria-label': '新しいメモ',
    onClick: () => openNoteEditor(store),
  },
  h('span', { html: icon('plus'), style: { display: 'flex' } }),
  h('span', { class: 'fab__label' }, 'メモを書く'));

  const app = h('div', { class: 'app' }, appbar, main, nav);
  clear(root).append(app, fab);

  // 保存できない環境（プライベートモード等）では、失われる前に必ず知らせる
  if (store.storageWarning) {
    const banner = h('div', { class: 'banner banner--warning banner--sticky', role: 'alert' },
      h('span', { html: icon('info', { size: 18 }), style: { display: 'flex' } }),
      h('span', { style: { flex: '1' } }, store.storageWarning),
      iconButton(icon('close', { size: 18 }), {
        label: '閉じる',
        onClick: () => banner.remove(),
      }));
    appbar.insertAdjacentElement('afterend', banner);
  }

  function render() {
    const { segments, params } = parseHash();

    // メモ編集は全画面（アプリ内の表示領域すべて）を使う
    if (segments[0] === 'note') {
      document.documentElement.dataset.mode = 'editor';
      clear(main).appendChild(renderNoteEditor(store, {
        noteId: segments[1],
        parentId: params.get('parent') || null,
        anchorDate: params.get('date') || null,
        returnTo: params.get('from') || 'notes',
      }));
      main.scrollTop = 0;
      document.title = `メモ｜${APP_NAME}`;
      return;
    }

    disposeNoteEditor();
    delete document.documentElement.dataset.mode;

    route = currentRoute(ROUTES, 'calendar');
    const def = ROUTES.find((r) => r.id === route) || ROUTES[0];
    navItems.forEach((el, id) => {
      if (id === route) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });
    const scroll = main.scrollTop;
    clear(main).appendChild(def.render(store));
    main.scrollTop = route === 'calendar' ? scroll : 0;
    document.title = `${def.label}｜${APP_NAME}`;
  }

  // ミッションの判定は保存のたびに走るので、自分の commit で再入しないようにする
  let syncing = false;
  function syncMissions() {
    if (syncing || !store.settings.missionsEnabled) { mission.update(); return; }
    syncing = true;
    try {
      const result = store.syncMissions();
      mission.update();
      announceMissions(result);
      celebrate(store, result);
    } finally {
      syncing = false;
    }
  }

  store.subscribe((event) => {
    if (event?.type === 'error') toast(event.message);
    updateBackupBadge();
    syncMissions();
    // 編集画面は自分で描画を持っているので、保存のたびに作り直さない
    if (document.documentElement.dataset.mode === 'editor') return;
    render();
  });

  startRouter(render);
  syncMissions();
  return { render };
}
