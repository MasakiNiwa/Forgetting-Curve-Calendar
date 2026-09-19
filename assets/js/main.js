/** エントリポイント */
import { Store } from './core/store.js';
import { createBestAdapter } from './core/storage.js';
import { guardExit } from './ui/backstack.js';
import { mountApp } from './ui/app.js';
import { applyTheme } from './ui/theme.js';
import { watchViewport } from './ui/viewport.js';
import { APP_NAME, APP_VERSION } from './core/config.js';
import { TabLock } from './core/tabLock.js';
import { setupTabOwnership } from './ui/tabOwnership.js';

async function boot() {
  // 最初の画面で「戻る」を押しても、アプリごと閉じないようにする
  guardExit();
  // 保存先はメモ単位で書ける IndexedDB を優先する（使えなければ localStorage）
  const store = new Store(await createBestAdapter());
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

  watchViewport();
  setupTabOwnership(store, new TabLock({ storage: window.localStorage }));
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
