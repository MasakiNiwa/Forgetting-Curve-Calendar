/**
 * Service Worker — オフラインでも開けるようにするための最小構成。
 *
 * 方針:
 * - ナビゲーションと同一オリジンの GET は「まずネットワーク、だめならキャッシュ」。
 *   GitHub Pages で更新したときに古い画面が残り続けるのを避けるため。
 * - バージョンを変えると古いキャッシュを破棄する。
 * - メモのデータはキャッシュではなく localStorage にあるため、ここでは扱わない。
 */
const VERSION = 'v1.1.2';
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
  './assets/icons/icon-192.png',
  './assets/js/main.js',
  './assets/js/core/config.js',
  './assets/js/core/curve.js',
  './assets/js/core/date.js',
  './assets/js/core/drafts.js',
  './assets/js/core/doc.js',
  './assets/js/core/exporter.js',
  './assets/js/core/inks.js',
  './assets/js/core/markdown.js',
  './assets/js/core/migrations.js',
  './assets/js/core/missions.js',
  './assets/js/core/models.js',
  './assets/js/core/omikuji.js',
  './assets/js/core/reminders.js',
  './assets/js/core/search.js',
  './assets/js/core/storage.js',
  './assets/js/core/tabLock.js',
  './assets/js/core/store.js',
  './assets/js/editor/docEditor.js',
  './assets/js/editor/plainFallback.js',
  './assets/js/editor/textMarks.js',
  // 本文を書くための道具（大きいので、編集画面を開いたときだけ読み込む）
  './assets/vendor/tiptap.bundle.js',
  './assets/js/ui/app.js',
  './assets/js/ui/backstack.js',
  './assets/js/ui/backup.js',
  './assets/js/ui/charts.js',
  './assets/js/ui/components.js',
  './assets/js/ui/docView.js',
  './assets/js/ui/dom.js',
  './assets/js/ui/editor.js',
  './assets/js/ui/exportDialog.js',
  './assets/js/ui/icons.js',
  './assets/js/ui/markdownView.js',
  './assets/js/ui/missions.js',
  './assets/js/ui/openExternal.js',
  './assets/js/ui/overlays.js',
  './assets/js/ui/portal.js',
  './assets/js/ui/reminders.js',
  './assets/js/ui/reviewSession.js',
  './assets/js/ui/router.js',
  './assets/js/ui/tabOwnership.js',
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

/* ------------------------------------------------------------------ */
/* 復習のリマインド（お知らせ）                                        */
/*                                                                      */
/* 閉じているあいだは、アプリの中身が動いていない。                    */
/* そこで「いつ・何件あるか」は開いているうちに数えて IndexedDB に置き、 */
/* ここでは読んで出すだけにしている（数え直さない）。                  */
/* 起こしてもらえるかは端末とブラウザ次第（periodic background sync）。 */
/* ------------------------------------------------------------------ */

const REMINDER_TAG = 'fcc-reminder';

/** 覚え書きの置き場所（アプリと同じ IndexedDB の meta ストア） */
function openDb() {
  return new Promise((resolve, reject) => {
    // バージョンは指定しない（アプリが作った形をそのまま使う）
    const req = indexedDB.open('fcc');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  });
}

function readReminder(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['meta'], 'readonly');
    const req = tx.objectStore('meta').get('reminder');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function writeReminder(db, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['meta'], 'readwrite');
    tx.objectStore('meta').put(record, 'reminder');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function localDayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function maybeNotify() {
  let db;
  try {
    db = await openDb();
  } catch {
    return;
  }
  try {
    const record = await readReminder(db);
    if (!record || record.enabled !== true) return;

    const now = new Date();
    const day = localDayKey(now);
    if (record.lastNotifiedDay === day) return;

    // 決めた時刻を過ぎているか
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(record.time || '20:00'));
    const at = match ? Number(match[1]) * 60 + Number(match[2]) : 20 * 60;
    if (now.getHours() * 60 + now.getMinutes() < at) return;

    // 今日ぶんの件数（アプリが今日数えていればその値、無ければ予定から）
    const count = record.todayKey === day && Number.isFinite(record.todayCount)
      ? record.todayCount
      : (record.days?.[day] ?? 0);
    if (!count) return;

    await self.registration.showNotification('今日の復習があります', {
      body: count === 1 ? '1 件、思い出す時間です。' : `${count} 件、思い出す時間です。`,
      tag: 'fcc-review',
      icon: './assets/icons/icon-192.png',
      badge: './assets/icons/icon-192.png',
      data: { url: './#/calendar' },
    });
    await writeReminder(db, { ...record, lastNotifiedDay: day });
  } catch {
    // 知らせられなくても、アプリ自体には影響させない
  } finally {
    db.close?.();
  }
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag !== REMINDER_TAG) return;
  event.waitUntil(maybeNotify());
});

// 手で起こしたいとき（アプリから「いま確かめる」を押したときなど）
self.addEventListener('sync', (event) => {
  if (event.tag !== REMINDER_TAG) return;
  event.waitUntil(maybeNotify());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.location.href).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((client) => client.url.startsWith(self.location.origin));
    if (open) {
      await open.focus();
      if ('navigate' in open) await open.navigate(target).catch(() => undefined);
      return;
    }
    await self.clients.openWindow(target);
  })());
});
