/**
 * 復習のリマインド（お知らせ）の段取り。
 *
 * 配信用のサーバーを持たないので、届け方は 2 つある:
 *
 *   1. アプリを開いているあいだ … こちらで時刻を見て、Service Worker から出す
 *   2. 閉じているあいだ … Service Worker が時々起きたときに出す
 *      （periodic background sync。Android の Chrome でホーム画面に追加したときなど、
 *        使える組み合わせが限られる）
 *
 * どちらも「開いているうちに数えておいた予定」（store.saveReminder）を見る。
 * 数を数え直すのはアプリの仕事で、Service Worker は読むだけにしている。
 */
import { reminderMessage, shouldNotify } from '../core/reminders.js';
import { todayKey } from '../core/date.js';

const SYNC_TAG = 'fcc-reminder';
/** 開いているあいだ、時刻を見にいく間隔 */
const TICK_MS = 60_000;
/** 予定を書き出すのを、少しまとめる */
const PLAN_DEBOUNCE = 2000;

export function notificationState() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;   // 'granted' | 'denied' | 'default'
}

/** 通知そのものを出す（Service Worker 経由だと、閉じていても残る） */
async function show(count) {
  const { title, body } = reminderMessage(count);
  const options = {
    body,
    tag: 'fcc-review',
    icon: './assets/icons/icon-192.png',
    badge: './assets/icons/icon-192.png',
    data: { url: './#/calendar' },
    renotify: false,
  };
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg?.showNotification) { await reg.showNotification(title, options); return true; }
  } catch { /* 下の方法で試す */ }
  try {
    // eslint-disable-next-line no-new
    new Notification(title, options);
    return true;
  } catch {
    return false;
  }
}

/** 閉じているあいだも起こしてもらえるよう、お願いしておく（使える端末だけ） */
async function registerPeriodicSync() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (!reg || !('periodicSync' in reg)) return false;
    const status = await navigator.permissions?.query({ name: 'periodic-background-sync' });
    if (status && status.state !== 'granted') return false;
    await reg.periodicSync.register(SYNC_TAG, { minInterval: 6 * 60 * 60 * 1000 });
    return true;
  } catch {
    return false;
  }
}

async function unregisterPeriodicSync() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    await reg?.periodicSync?.unregister(SYNC_TAG);
  } catch { /* 元から無ければ何もしない */ }
}

/**
 * 見張りを始める。
 * 設定・データが変わるたびに予定を書き直し、1 分ごとに時刻を見る。
 */
export function setupReminders(store) {
  let timer = null;
  let planTimer = null;

  const writePlan = async (patch = {}) => {
    const reminder = store.settings.reminder || {};
    await store.saveReminder({
      enabled: reminder.enabled === true,
      time: reminder.time,
      ...store.reminderPlan(),
      ...patch,
    });
  };

  const schedulePlan = () => {
    if (planTimer) return;
    planTimer = setTimeout(() => { planTimer = null; writePlan(); }, PLAN_DEBOUNCE);
  };

  /** 時刻が来ていたら知らせる（見ているあいだは出さない） */
  const tick = async () => {
    if (!store.settings.reminder?.enabled) return;
    if (notificationState() !== 'granted') return;
    // 画面を見ている人に、同じことを重ねて知らせない
    if (document.visibilityState === 'visible') return;

    const record = (await store.loadReminder()) || {};
    const day = todayKey();
    const live = {
      ...record,
      enabled: true,
      time: store.settings.reminder.time,
      todayKey: day,
      todayCount: store.todayQueue(day).items.length,
    };
    const decision = shouldNotify(live, { day });
    if (!decision.notify) return;
    const shown = await show(decision.count);
    if (shown) await store.saveReminder({ ...live, lastNotifiedDay: day });
  };

  const start = () => {
    stop();
    timer = setInterval(() => { tick(); }, TICK_MS);
    // 画面から離れた直後も見る（時刻を過ぎていたら、そこで知らせる）
    document.addEventListener('visibilitychange', onVisibility);
  };

  const stop = () => {
    clearInterval(timer);
    timer = null;
    document.removeEventListener('visibilitychange', onVisibility);
  };

  function onVisibility() {
    if (document.visibilityState === 'hidden') setTimeout(() => tick(), 400);
  }

  const apply = async () => {
    const enabled = store.settings.reminder?.enabled === true;
    await writePlan(enabled ? {} : { lastNotifiedDay: null });
    if (enabled && notificationState() === 'granted') {
      start();
      registerPeriodicSync();
    } else {
      stop();
      if (!enabled) unregisterPeriodicSync();
    }
  };

  /**
   * 予定の数が変わりうる出来事。
   *
   * 個々の名前を並べると、増えたときに書き漏らす（実際 v0.16 では
   * 復習の記録（event:rate など）を取りこぼしていて、数が古いままだった）。
   * かたまりで見て、関係のないもの（ミッション・バックアップ・タブ）だけ外す。
   */
  const affectsPlan = (type) => /^(note:|event:|data:|settings:update)/.test(String(type || ''));

  // 設定やメモが変わったら、数え直して残す
  store.subscribe((event) => {
    if (event?.type === 'settings:update' && event.patch?.reminder) { apply(); return; }
    if (affectsPlan(event?.type)) schedulePlan();
  });

  apply();
  return { apply, tick, stop };
}

/**
 * 受け取る設定にする（必要なら、まず許可をもらう）。
 * @returns {Promise<'granted'|'denied'|'unsupported'>}
 */
export async function requestReminderPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const result = await Notification.requestPermission();
    return result === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

/** 「いま試す」。設定の画面から、届き方を確かめるために使う */
export async function testReminder(store) {
  if (notificationState() !== 'granted') return false;
  const count = store.todayQueue().items.length;
  return show(count || 1);
}
