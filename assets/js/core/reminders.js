/**
 * 復習のリマインド（お知らせ）。
 *
 * このアプリは端末の中だけで動く（配信用のサーバーを持たない）。
 * だから「決まった時刻に、その日の復習があれば知らせる」ところまでを、
 * ブラウザの力だけでやる:
 *
 *   - アプリを開いているあいだは、こちらで時刻を見て知らせる
 *   - 閉じているあいだは、Service Worker が時々起きたときに知らせる
 *     （periodic background sync。使える端末とブラウザが限られる）
 *
 * ここは日付と数の計算だけを持つ（DOM も通知 API も触らない）。
 * Service Worker 側でも同じ決まりで判断できるよう、素の値だけで完結させている。
 */
import { addDays, todayKey } from './date.js';

/** 何日先ぶんまで数えておくか（閉じているあいだに使う） */
export const PLAN_DAYS = 45;

export const DEFAULT_REMINDER = Object.freeze({ enabled: false, time: '20:00' });

/** 'HH:MM' を分に直す（おかしな値は既定の時刻にする） */
export function timeToMinutes(time, fallback = '20:00') {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? ''));
  if (!m) return timeToMinutes(fallback, '20:00');
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const min = Math.min(59, Math.max(0, Number(m[2])));
  return h * 60 + min;
}

export function normalizeTime(time) {
  const total = timeToMinutes(time);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** 設定として持つ形に整える */
export function normalizeReminder(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: value.enabled === true,
    time: normalizeTime(value.time ?? DEFAULT_REMINDER.time),
  };
}

/**
 * 何日先まで、どの日に何件あるかを数えておく。
 * 閉じているあいだは予定を組み直せないので、開いているうちに残しておく。
 *
 * @param {(key:string)=>{reviews:Array}} bucketOf 日付 -> その日の予定
 * @param {{from?:string, days?:number}} options
 */
export function buildPlanDays(bucketOf, { from = todayKey(), days = PLAN_DAYS } = {}) {
  const out = {};
  for (let i = 0; i < days; i += 1) {
    const key = addDays(from, i);
    const count = (bucketOf(key)?.reviews || []).filter((r) => r.review?.status === 'pending').length;
    if (count) out[key] = count;
  }
  return out;
}

/**
 * いま知らせるべきか。
 *
 * - 受け取る設定になっている
 * - 決めた時刻を過ぎている
 * - その日まだ知らせていない
 * - その日の復習がある
 *
 * @param {object} record 覚えておいたリマインドの記録
 * @param {{now?:Date, day?:string}} context
 */
export function shouldNotify(record, { now = new Date(), day = todayKey() } = {}) {
  const reminder = normalizeReminder(record);
  if (!reminder.enabled) return { notify: false, reason: 'off', count: 0 };
  if (record?.lastNotifiedDay === day) return { notify: false, reason: 'done', count: 0 };

  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes < timeToMinutes(reminder.time)) return { notify: false, reason: 'early', count: 0 };

  const count = countFor(record, day);
  if (!count) return { notify: false, reason: 'none', count: 0 };
  return { notify: true, reason: 'due', count, day };
}

/** その日の件数（今日ぶんは、アプリが数えた正確な値を使う） */
export function countFor(record, day = todayKey()) {
  if (!record || typeof record !== 'object') return 0;
  if (record.todayKey === day && Number.isFinite(record.todayCount)) {
    return Math.max(0, Math.round(record.todayCount));
  }
  const count = record.days?.[day];
  return Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
}

/** 知らせる文面（アプリと Service Worker で同じものを使う） */
export function reminderMessage(count) {
  return {
    title: '今日の復習があります',
    body: count === 1
      ? '1 件、思い出す時間です。'
      : `${count} 件、思い出す時間です。`,
  };
}
