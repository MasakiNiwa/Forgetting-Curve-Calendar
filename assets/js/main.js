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
import { setupReminders } from './ui/reminders.js';

async function boot() {
  // 最初の画面で「戻る」を押しても、アプリごと閉じないようにする
  guardExit();
  // オフラインの備えは、保存先を読むより先に頼んでおく
  registerServiceWorker();
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
  await setupTabOwnership(store, new TabLock({ storage: window.localStorage }));
  // 復習のリマインド（受け取る設定のときだけ動く）
  setupReminders(store);

  // 開発・デバッグ用
  window.__fcc = { store, version: APP_VERSION };
  console.info(`${APP_NAME} v${APP_VERSION}`);
}

/**
 * オフラインでも開けるようにする（データ自体は端末内に保存されている）。
 *
 * 読み込みが終わるのを待ってから登録するが、**待つ相手がもう終わっていることがある**。
 * 起動の途中で保存先を読むようになってから、ここへ来る頃には load が済んでいて、
 * 待ち続けたまま登録されない状態になっていた。いまの状態を見てから決める。
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // file:// で開いたときは登録しない
  if (!['http:', 'https:'].includes(window.location.protocol)) return;
  const register = () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.info('[fcc] オフライン対応は利用できません', err);
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
