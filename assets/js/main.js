/** エントリポイント */
import { Store } from './core/store.js';
import { mountApp } from './ui/app.js';
import { applyTheme } from './ui/theme.js';
import { APP_NAME, APP_VERSION } from './core/config.js';

async function boot() {
  const store = new Store();
  await store.load();
  applyTheme(store.settings.theme);

  store.subscribe((event) => {
    if (event?.type === 'settings:update' && event.patch?.theme) {
      applyTheme(store.settings.theme);
    }
  });

  const root = document.getElementById('app');
  mountApp(store, root);

  // 日付が変わったら表示を更新する（日付境界をまたぐ長時間利用への対応）
  let lastDay = new Date().getDate();
  setInterval(() => {
    const day = new Date().getDate();
    if (day !== lastDay) {
      lastDay = day;
      store.emit({ type: 'view:refresh' });
    }
  }, 60_000);

  registerServiceWorker();

  // 開発・デバッグ用
  window.__fcc = { store, version: APP_VERSION };
  console.info(`${APP_NAME} v${APP_VERSION}`);
}

/** オフラインでも開けるようにする（データ自体は端末内の localStorage） */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // file:// で開いたときは登録しない
  if (!['http:', 'https:'].includes(window.location.protocol)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.info('[fcc] オフライン対応は利用できません', err);
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
