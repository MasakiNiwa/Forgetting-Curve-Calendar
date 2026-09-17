/** エントリポイント */
import { Store } from './core/store.js';
import { mountApp } from './ui/app.js';
import { applyTheme } from './ui/theme.js';
import { APP_NAME, APP_VERSION, STORAGE_KEY } from './core/config.js';
import { toast } from './ui/overlays.js';

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

  watchOtherTabs(store);
  registerServiceWorker();

  // 開発・デバッグ用
  window.__fcc = { store, version: APP_VERSION };
  console.info(`${APP_NAME} v${APP_VERSION}`);
}

/**
 * 別のタブでの変更を取り込む。
 * 同じブラウザで 2 つ開いていても、どちらで書いたメモも失わないようにする。
 */
function watchOtherTabs(store) {
  window.addEventListener('storage', async (event) => {
    if (event.key !== STORAGE_KEY) return;
    const result = await store.reconcile();
    if (result.changed) {
      store.emit({ type: 'view:refresh' });
      const parts = [];
      if (result.added) parts.push(`${result.added} 件を追加`);
      if (result.updated) parts.push(`${result.updated} 件を更新`);
      toast(`別のタブでの変更を取り込みました（${parts.join('・')}）`);
    }
  });

  // タブに戻ってきたときも取り込む（同じ端末の別ウィンドウ対策）
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    const result = await store.reconcile();
    if (result.changed) store.emit({ type: 'view:refresh' });
  });
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
