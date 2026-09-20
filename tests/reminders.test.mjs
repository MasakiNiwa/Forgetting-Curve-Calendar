/**
 * 復習のリマインドの決まりごとのテスト。
 *   npm test
 *
 * 「いつ知らせるか」はアプリと Service Worker の両方で使うので、
 * DOM も通知 API も使わない形に切り出してある。ここではその判断だけを見る。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_REMINDER, buildPlanDays, countFor, normalizeReminder, normalizeTime,
  reminderMessage, shouldNotify, timeToMinutes,
} from '../assets/js/core/reminders.js';
import { MemoryAdapter } from '../assets/js/core/storage.js';
import { Store } from '../assets/js/core/store.js';
import { addDays, todayKey } from '../assets/js/core/date.js';

const at = (h, m) => new Date(2026, 8, 20, h, m);
const DAY = '2026-09-20';

test('reminders: 時刻の読み取り', () => {
  assert.equal(timeToMinutes('20:00'), 1200);
  assert.equal(timeToMinutes('07:05'), 425);
  assert.equal(normalizeTime('9:30'), '09:30');
  // おかしな値は既定（20:00）にする
  assert.equal(normalizeTime('あさ'), '20:00');
  assert.equal(normalizeTime('25:99'), '23:59');
  assert.deepEqual(normalizeReminder(null), DEFAULT_REMINDER);
  assert.deepEqual(normalizeReminder({ enabled: 'yes', time: '07:00' }), { enabled: false, time: '07:00' });
});

test('reminders: 決めた時刻を過ぎて、その日の復習があるときだけ知らせる', () => {
  const record = { enabled: true, time: '20:00', todayKey: DAY, todayCount: 3 };
  assert.equal(shouldNotify(record, { now: at(19, 59), day: DAY }).notify, false);
  const due = shouldNotify(record, { now: at(20, 0), day: DAY });
  assert.equal(due.notify, true);
  assert.equal(due.count, 3);
  // 受け取らない設定／その日ぶんが無い／もう知らせた
  assert.equal(shouldNotify({ ...record, enabled: false }, { now: at(21, 0), day: DAY }).notify, false);
  assert.equal(shouldNotify({ ...record, todayCount: 0 }, { now: at(21, 0), day: DAY }).notify, false);
  assert.equal(shouldNotify({ ...record, lastNotifiedDay: DAY }, { now: at(21, 0), day: DAY }).notify, false);
});

test('reminders: 今日ぶんは数えた値を、先の日は残した予定を使う', () => {
  const record = { enabled: true, time: '20:00', todayKey: DAY, todayCount: 4, days: { [DAY]: 2, '2026-09-21': 5 } };
  assert.equal(countFor(record, DAY), 4, '今日は繰り越しも含めた実際の数');
  assert.equal(countFor(record, '2026-09-21'), 5);
  assert.equal(countFor(record, '2026-09-22'), 0);
  // 日付が変わったあとは、残した予定を見る
  assert.equal(countFor({ ...record, todayKey: '2026-09-19' }, DAY), 2);
});

test('reminders: 文面は件数に合わせる', () => {
  assert.match(reminderMessage(1).body, /1 件/);
  assert.match(reminderMessage(12).body, /12 件/);
});

test('reminders: 予定は、復習のある日だけを数える', () => {
  const bucket = {
    [DAY]: { reviews: [{ review: { status: 'pending' } }, { review: { status: 'done' } }] },
    '2026-09-22': { reviews: [{ review: { status: 'pending' } }] },
  };
  const plan = buildPlanDays((key) => bucket[key], { from: DAY, days: 4 });
  assert.deepEqual(plan, { [DAY]: 1, '2026-09-22': 1 });
});

test('store: 開いているうちに、これからの予定を書き出す', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  const yesterday = addDays(todayKey(), -1);
  store.addNote({ body: '復習のあるメモ', anchorDate: yesterday, presetId: 'standard' });

  const plan = store.reminderPlan();
  assert.equal(plan.todayKey, todayKey());
  assert.equal(plan.todayCount, 1, '今日ぶんは 1 件');
  assert.ok(Object.keys(plan.days).length >= 1);

  const saved = await store.saveReminder({ enabled: true, time: '20:00', ...plan });
  assert.equal(saved.enabled, true);
  const back = await store.loadReminder();
  assert.equal(back.todayCount, 1);
  assert.equal(shouldNotify(back, { now: at(21, 0), day: todayKey() }).notify, true);
});
