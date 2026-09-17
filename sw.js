/**
 * Service Worker — オフラインでも開けるようにするための最小構成。
 *
 * 方針:
 * - ナビゲーションと同一オリジンの GET は「まずネットワーク、だめならキャッシュ」。
 *   GitHub Pages で更新したときに古い画面が残り続けるのを避けるため。
 * - バージョンを変えると古いキャッシュを破棄する。
 * - メモのデータはキャッシュではなく localStorage にあるため、ここでは扱わない。
 */
const VERSION = 'v0.3.0';
const CACHE = `fcc-${VERSION}`;

const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/tokens.css',
  './assets/css/app.css',
  './assets/icons/favicon.svg',
  './assets/js/main.js',
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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
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
