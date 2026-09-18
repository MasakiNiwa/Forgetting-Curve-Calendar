/**
 * Service Worker — オフラインでも開けるようにするための最小構成。
 *
 * 方針:
 * - ナビゲーションと同一オリジンの GET は「まずネットワーク、だめならキャッシュ」。
 *   GitHub Pages で更新したときに古い画面が残り続けるのを避けるため。
 * - バージョンを変えると古いキャッシュを破棄する。
 * - メモのデータはキャッシュではなく localStorage にあるため、ここでは扱わない。
 */
const VERSION = 'v0.7.0';
const PREFIX = 'fcc-';
const CACHE = `${PREFIX}${VERSION}`;

// main.js だけでは足りない。ES Modules の依存もすべて入れておく
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/tokens.css',
  './assets/css/app.css',
  './assets/icons/favicon.svg',
  './assets/js/main.js',
  './assets/js/core/config.js',
  './assets/js/core/curve.js',
  './assets/js/core/date.js',
  './assets/js/core/drafts.js',
  './assets/js/editor/history.js',
  './assets/js/editor/textEditor.js',
  './assets/js/core/exporter.js',
  './assets/js/core/migrations.js',
  './assets/js/core/missions.js',
  './assets/js/core/models.js',
  './assets/js/core/storage.js',
  './assets/js/core/store.js',
  './assets/js/ui/app.js',
  './assets/js/ui/backup.js',
  './assets/js/ui/charts.js',
  './assets/js/ui/components.js',
  './assets/js/ui/dom.js',
  './assets/js/ui/editor.js',
  './assets/js/ui/exportDialog.js',
  './assets/js/ui/icons.js',
  './assets/js/ui/missions.js',
  './assets/js/ui/overlays.js',
  './assets/js/ui/reviewSession.js',
  './assets/js/ui/router.js',
  './assets/js/ui/theme.js',
  './assets/js/ui/viewport.js',
  './assets/js/ui/views/calendar.js',
  './assets/js/ui/views/help.js',
  './assets/js/ui/views/noteEditor.js',
  './assets/js/ui/views/notes.js',
  './assets/js/ui/views/settings.js',
  './assets/js/ui/views/stats.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // 同じドメインで動く他のアプリのキャッシュには触れない
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached
        || caches.match('./index.html')
        || Response.error())),
  );
});
