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
import { renderNoteEditor, disposeNoteEditor, isEditorShowing } from './views/noteEditor.js';
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

  /** 画面ごとのスクロール位置（往復しても、見ていた場所に戻れるように） */
  const scrollPositions = new Map();
  let shownRoute = null;

  function render() {
    const { segments, params } = parseHash();
    // いま見えている画面の位置を控えてから切り替える
    if (shownRoute) scrollPositions.set(shownRoute, main.scrollTop);

    // メモ編集は全画面（アプリ内の表示領域すべて）を使う
    if (segments[0] === 'note') {
      // 同じメモをすでに開いているなら、作り直さない。
      // （重なりを閉じたときなど、URL だけが前の形に戻ることがある）
      if (isEditorShowing(segments[1], params.get('parent') || null)) {
        document.documentElement.dataset.mode = 'editor';
        return;
      }
      document.documentElement.dataset.mode = 'editor';
      clear(main).appendChild(renderNoteEditor(store, {
        noteId: segments[1],
        parentId: params.get('parent') || null,
        anchorDate: params.get('date') || null,
        returnTo: params.get('from') || 'notes',
      }));
      main.scrollTop = 0;
      shownRoute = null;
      // タブのタイトルは編集画面が自分で出す（いま書いているメモの名前）
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
    clear(main).appendChild(def.render(store));
    // 一覧やカレンダーは、戻ってきたときに同じ場所から続けられるようにする
    main.scrollTop = scrollPositions.get(route) || 0;
    shownRoute = route;
    document.title = `${def.label}｜${APP_NAME}`;
    flushCelebration();
  }

  // ミッションの判定は保存のたびに走るので、自分の commit で再入しないようにする
  let syncing = false;
  /** 書いている最中の祝いは邪魔なので、編集画面を出るまで預かる */
  let pendingCelebration = null;

  function inEditor() {
    return document.documentElement.dataset.mode === 'editor';
  }

  function syncMissions() {
    if (syncing || !store.settings.missionsEnabled) { mission.update(); return; }
    syncing = true;
    try {
      const result = store.syncMissions();
      mission.update();
      announceMissions(result);
      if (result?.justCompletedAll && inEditor()) {
        // 本文の入力を止めない。小さな知らせだけ出して、あとで祝う
        pendingCelebration = result;
        toast('今日のミッションがそろいました');
      } else {
        celebrate(store, result);
      }
    } finally {
      syncing = false;
    }
  }

  /** 編集画面から戻ったら、預かっていた祝いを出す */
  function flushCelebration() {
    if (!pendingCelebration || inEditor()) return;
    const result = pendingCelebration;
    pendingCelebration = null;
    setTimeout(() => celebrate(store, result), 260);
  }

  /**
   * 描画は 1 フレームに 1 回にまとめる。
   * まとめて記録したときなど、短い間に何度も変更が起きても画面作りは 1 回で済む。
   */
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (document.documentElement.dataset.mode === 'editor') return;
      render();
    });
  }

  store.subscribe((event) => {
    if (event?.type === 'error') toast(event.message);
    updateBackupBadge();
    syncMissions();
    // 編集画面は自分で描画を持っているので、保存のたびに作り直さない
    if (document.documentElement.dataset.mode === 'editor') return;
    scheduleRender();
  });

  startRouter(render);
  syncMissions();
  return { render };
}
