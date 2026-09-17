/** アプリシェル（アプリバー・ナビゲーション・FAB）と画面の切り替え */
import { h, clear, iconButton } from './dom.js';
import { icon } from './icons.js';
import { toast } from './overlays.js';
import { openNoteEditor } from './editor.js';
import { renderCalendar, focusDate } from './views/calendar.js';
import { renderNotes } from './views/notes.js';
import { renderSettings } from './views/settings.js';
import { renderHelp } from './views/help.js';
import { currentRoute, navigate, startRouter } from './router.js';
import { APP_NAME, APP_TAGLINE } from '../core/config.js';
import { todayKey } from '../core/date.js';

const ROUTES = [
  { id: 'calendar', label: 'カレンダー', iconName: 'calendar', render: renderCalendar },
  { id: 'notes', label: 'メモ', iconName: 'notes', render: renderNotes },
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

  const appbar = h('header', { class: 'appbar' },
    h('div', { class: 'appbar__brand' },
      h('span', { class: 'appbar__logo', html: icon('curve', { size: 26 }), style: { display: 'flex' } }),
      h('div', { style: { minWidth: '0' } },
        h('div', { class: 'appbar__title' }, APP_NAME),
        h('div', { class: 'appbar__tagline' }, APP_TAGLINE))),
    h('div', { class: 'appbar__spacer' }),
    iconButton(icon('target'), {
      label: '今日へ',
      onClick: () => { focusDate(todayKey()); navigate('calendar'); store.emit({ type: 'view:refresh' }); },
    }));

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

  function render() {
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

  store.subscribe((event) => {
    if (event?.type === 'error') toast(event.message);
    render();
  });

  startRouter(render);
  return { render };
}
