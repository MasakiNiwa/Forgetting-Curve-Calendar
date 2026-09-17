/**
 * コアロジックのテスト（DOM 非依存）。
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addDays, diffDays, formatDuration, isValidKey, monthMatrix, toKey, todayKey, weekdayLabels,
} from '../assets/js/core/date.js';
import {
  MAX_INTERVAL_DAYS, PRESETS, buildSchedule, clampEase, createEvent, nextReview,
  refreshNote, replay, retentionSeries, sanitizeIntervals,
} from '../assets/js/core/curve.js';
import {
  DEFAULT_SETTINGS, bodyPreview, createNote, displayTitle, makeEventId, normalizeData, recallCue,
} from '../assets/js/core/models.js';
import { migrate } from '../assets/js/core/migrations.js';
import { serializeNotes, toCsv } from '../assets/js/core/exporter.js';
import { MemoryAdapter } from '../assets/js/core/storage.js';
import { Store } from '../assets/js/core/store.js';

const settings = { ...DEFAULT_SETTINGS };
const newStore = async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  return store;
};

/* ------------------------------------------------------------------ date */

test('date: 日付キーの加算と差分', () => {
  assert.equal(addDays('2026-09-17', 3), '2026-09-20');
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(diffDays('2026-09-17', '2026-09-20'), 3);
  assert.equal(diffDays('2026-09-20', '2026-09-17'), -3);
});

test('date: 月末・うるう年・数十年先でもずれない', () => {
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2027-02-28', 1), '2027-03-01');
  assert.equal(addDays('2026-09-17', 10950), '2056-09-09');
  assert.equal(toKey(new Date(2026, 0, 1)), '2026-01-01');
  assert.ok(isValidKey(todayKey()));
  assert.equal(isValidKey('2026-9-1'), false);
});

test('date: 月カレンダーは常に 42 セル、週の開始曜日を反映する', () => {
  const sunday = monthMatrix(2026, 8, 0);
  const monday = monthMatrix(2026, 8, 1);
  assert.equal(sunday.length, 42);
  assert.equal(sunday[0].weekday, 0);
  assert.equal(monday[0].weekday, 1);
  assert.equal(weekdayLabels(1)[0].label, '月');
});

test('date: 期間の表示は単位が切り替わる', () => {
  assert.equal(formatDuration(3), '3日');
  assert.equal(formatDuration(14), '2週間');
  assert.equal(formatDuration(120), '4ヶ月');
  assert.equal(formatDuration(365), '1年');
  assert.equal(formatDuration(10950), '30年');
});

/* ----------------------------------------------------------------- curve */

test('curve: 間隔の正規化（年単位まで許容）', () => {
  assert.deepEqual(sanitizeIntervals([7, 1, 3, 3, 0, -5, 'x']), [1, 3, 7]);
  assert.deepEqual(sanitizeIntervals([]), [1, 3, 7]);
  assert.deepEqual(sanitizeIntervals([1, 10950, MAX_INTERVAL_DAYS + 1]), [1, 10950]);
  assert.equal(clampEase(9), 3.0);
  assert.equal(clampEase(0.1), 1.3);
});

test('curve: プリセットは昇順の正の整数で、長期まで伸びる', () => {
  PRESETS.forEach((p) => {
    assert.deepEqual(p.intervals, sanitizeIntervals(p.intervals), `${p.id} の間隔が不正`);
  });
  const lifelong = PRESETS.find((p) => p.id === 'lifelong');
  assert.ok(lifelong.intervals[lifelong.intervals.length - 1] >= 3650, '一生ものは 10 年以上先まで続く');
  const standard = PRESETS.find((p) => p.id === 'standard');
  assert.ok(standard.intervals[standard.intervals.length - 1] >= 1825, '標準も年単位まで伸びる');
  assert.ok(standard.intervals.length <= 12, '回数は増えすぎない');
});

test('curve: 起点日から復習予定を生成する', () => {
  let i = 0;
  const reviews = buildSchedule('2026-09-17', [1, 3, 7], () => `g${i++}`);
  assert.deepEqual(reviews.map((r) => r.due), ['2026-09-18', '2026-09-20', '2026-09-24']);
  assert.deepEqual(reviews.map((r) => r.step), [0, 1, 2]);
  assert.deepEqual(reviews.map((r) => r.id), ['g0', 'g1', 'g2']);
});

const makeNote = (intervals = [1, 3, 7, 14], events = []) => refreshNote({
  anchorDate: '2026-09-17',
  status: 'active',
  origin: { presetId: 'standard', intervals },
  schedule: {},
  events,
  reviews: [],
}, { adaptive: true });

const rate = (note, reviewId, rating, at) => {
  const review = note.reviews.find((r) => r.id === reviewId);
  note.events.push({ id: makeEventId(), ...createEvent('rate', { reviewKey: review.id, step: review.step, rating }, at) });
  return refreshNote(note, { adaptive: true });
};

test('curve: 再生は決定的（同じ出来事なら同じ予定）', () => {
  const note = makeNote();
  rate(note, 'g0', 'known', new Date('2026-09-18T09:00:00'));
  const a = replay(note, { adaptive: true });
  const b = replay(note, { adaptive: true });
  assert.deepEqual(a.reviews, b.reviews);
  assert.equal(a.ease, b.ease);
});

test('curve: 「覚えていた」で ease が上がり残りが後ろにずれる', () => {
  const note = makeNote();
  rate(note, 'g0', 'known', new Date('2026-09-18T09:00:00'));
  assert.equal(note.schedule.ease, 2.6);
  const done = note.reviews.find((r) => r.id === 'g0');
  assert.equal(done.status, 'done');
  assert.equal(done.rating, 'known');
  const pending = note.reviews.filter((r) => r.status === 'pending');
  assert.equal(pending.length, 3);
  // 記録日 (9/18) を起点に組み直される
  assert.equal(pending[0].due, '2026-09-20');
});

test('curve: 「あいまい」は同じステップの追加復習を挟む', () => {
  const note = makeNote();
  rate(note, 'g1', 'vague', new Date('2026-09-20T09:00:00'));
  const extra = note.reviews.filter((r) => r.extra);
  assert.equal(extra.length, 1);
  assert.equal(extra[0].step, 1);
  assert.equal(extra[0].status, 'pending');
  assert.ok(note.schedule.ease < 2.5);
});

test('curve: 「忘れた」は記録日を起点に組み直す', () => {
  const note = makeNote();
  rate(note, 'g2', 'forgot', new Date('2026-09-24T09:00:00'));
  const pending = note.reviews.filter((r) => r.status === 'pending');
  assert.deepEqual(pending.map((r) => r.step), [0, 1, 2, 3]);
  assert.equal(pending[0].due, '2026-09-25');
  assert.equal(note.schedule.ease, 2.25);
});

test('curve: adaptive が無効なら予定は動かない', () => {
  const note = makeNote();
  const before = note.reviews.map((r) => r.due);
  note.events.push({ id: makeEventId(), ...createEvent('rate', { reviewKey: 'g0', step: 0, rating: 'known' }) });
  refreshNote(note, { adaptive: false });
  assert.equal(note.schedule.ease, 2.5);
  assert.deepEqual(note.reviews.map((r) => r.due), before);
});

test('curve: 全ステップ完了で定着、restart で今日から復活する', () => {
  const note = makeNote([1, 3]);
  rate(note, 'g0', 'known', new Date('2026-09-18T09:00:00'));
  rate(note, note.reviews.find((r) => r.status === 'pending').id, 'known', new Date('2026-09-21T09:00:00'));
  assert.equal(note.status, 'graduated');
  note.events.push({ id: makeEventId(), ...createEvent('restart', {}) });
  refreshNote(note, { adaptive: true });
  assert.equal(note.status, 'active');
  assert.equal(nextReview(note).due, addDays(todayKey(), 1));
  assert.equal(note.schedule.ease, 2.5, 'restart で定着度も戻る');
});

test('curve: reschedule は完了済みの履歴を保ったまま先の予定を作り直す', () => {
  const note = makeNote([1, 3, 7, 14]);
  rate(note, 'g0', 'known', new Date('2026-09-18T09:00:00'));
  note.events.push({ id: makeEventId(), ...createEvent('reschedule', { presetId: 'light', intervals: [1, 7, 30] }) });
  refreshNote(note, { adaptive: true });
  assert.equal(note.reviews.filter((r) => r.status === 'done').length, 1);
  assert.deepEqual(note.schedule.intervals, [1, 7, 30]);
  assert.deepEqual(note.reviews.filter((r) => r.status === 'pending').map((r) => r.step), [1, 2]);
});

test('curve: 保持率グラフは 0〜1 に収まり、復習時点で 1 に戻る', () => {
  const points = retentionSeries([1, 3, 7, 14]);
  assert.ok(points.length > 50);
  assert.ok(points.every((p) => p.r >= 0 && p.r <= 1));
  assert.equal(points.filter((p) => p.review).length, 4);
});

/* ----------------------------------------------------------------- store */

test('store: 取り消すと定着度も未来の予定も完全に元へ戻る', async () => {
  const store = await newStore();
  const note = store.addNote({ body: '覚えたいこと', anchorDate: '2026-09-17', presetId: 'standard' });
  const before = {
    ease: note.schedule.ease,
    reviews: JSON.parse(JSON.stringify(note.reviews)),
  };

  // 「忘れた」は曲線を丸ごと組み直す = 最も戻しにくいケース
  store.rateReview(note.id, note.reviews[0].id, 'forgot');
  const after = store.getNote(note.id);
  assert.notDeepEqual(after.reviews.map((r) => r.due), before.reviews.map((r) => r.due));
  assert.equal(after.schedule.ease, 2.25);

  store.undoLastEvent(note.id);
  const restored = store.getNote(note.id);
  assert.equal(restored.schedule.ease, before.ease);
  assert.deepEqual(restored.reviews, before.reviews);
  assert.equal(restored.events.length, 0);
});

test('store: 取り消せるのは直前の出来事だけ', async () => {
  const store = await newStore();
  const note = store.addNote({ body: 'A', anchorDate: '2026-09-17' });
  store.rateReview(note.id, note.reviews[0].id, 'known');
  const firstEvent = store.getNote(note.id).events[0];
  store.rateReview(note.id, store.getNote(note.id).reviews.find((r) => r.status === 'pending').id, 'known');
  assert.equal(store.canUndo(note.id, firstEvent.id), false);
  assert.equal(store.undoLastEvent(note.id, firstEvent.id), null);
  assert.equal(store.getNote(note.id).events.length, 2);
});

test('store: 今日のキューは期限切れを上限まで取り戻す', async () => {
  const store = await newStore();
  store.updateSettings({ overdueDailyLimit: 3 });
  for (let i = 1; i <= 6; i += 1) {
    store.addNote({ body: `過去メモ${i}`, anchorDate: addDays(todayKey(), -i * 2) });
  }
  const queue = store.todayQueue();
  assert.equal(queue.overdue.length, 3);
  assert.ok(queue.waiting > 0);
  assert.equal(queue.overdue.length + queue.waiting, queue.overdueTotal);

  store.updateSettings({ overdueDailyLimit: 0 });
  assert.equal(store.todayQueue().overdue.length, store.todayQueue().overdueTotal);
});

test('store: 追加メモは親に紐付き、自分の曲線を持つ', async () => {
  const store = await newStore();
  const parent = store.addNote({ body: '親メモ' });
  const child = store.addNote({ body: '気づき', parentId: parent.id });
  assert.equal(store.childrenOf(parent.id).length, 1);
  assert.ok(child.reviews.length > 0);
  assert.equal(store.descendantsOf(parent.id).length, 1);
});

test('store: 削除と復元', async () => {
  const store = await newStore();
  const parent = store.addNote({ body: '親' });
  store.addNote({ body: '子', parentId: parent.id });
  const removed = store.deleteNote(parent.id);
  assert.equal(store.notes.length, 0);
  store.restoreNotes(removed);
  assert.equal(store.notes.length, 2);
});

test('store: 保存できない環境では警告を出す', async () => {
  const store = await newStore();
  assert.match(store.storageWarning, /保存できません/);
});

/* ---------------------------------------------------------------- models */

test('models: メモ作成時に復習予定が作られる', () => {
  const note = createNote({ body: '本文', anchorDate: '2026-09-17', tags: 'a b a' }, settings);
  assert.equal(note.reviews.length, note.schedule.intervals.length);
  assert.deepEqual(note.tags, ['a', 'b']);
  assert.equal(note.status, 'active');
  assert.equal(note.reviews[0].due, '2026-09-18');
  assert.deepEqual(note.origin.intervals, note.schedule.intervals);
});

test('models: 手掛かりと本文', () => {
  const plain = createNote({ body: '1行目のタイトル\n2行目の本文' }, settings);
  assert.equal(displayTitle(plain), '1行目のタイトル');
  assert.equal(recallCue(plain), '1行目のタイトル');
  assert.equal(bodyPreview(plain), '2行目の本文');

  const cued = createNote({ cue: '減価償却の3つの方法は？', body: '定額法、定率法、生産高比例法' }, settings);
  assert.equal(recallCue(cued), '減価償却の3つの方法は？');
  assert.equal(bodyPreview(cued), '定額法、定率法、生産高比例法');
});

test('models: 壊れたデータを読み込んでも復旧できる', () => {
  const data = normalizeData({
    schemaVersion: 2,
    notes: [
      { id: 'a', body: 'ok', anchorDate: 'おかしな日付', events: [{ type: '???' }] },
      null,
      { id: 'b', body: 'child', parentId: 'いない親' },
      'not an object',
    ],
    settings: { theme: 'ねこ', weekStart: 9, customIntervals: [3, 1, 1], overdueDailyLimit: -3 },
  });
  assert.equal(data.notes.length, 2);
  assert.equal(data.notes[1].parentId, null);
  assert.equal(data.settings.theme, 'system');
  assert.equal(data.settings.weekStart, 0);
  assert.deepEqual(data.settings.customIntervals, [1, 3]);
  assert.equal(data.settings.overdueDailyLimit, 10);
  assert.ok(data.notes[0].reviews.length > 0);
});

/* ------------------------------------------------------------ migrations */

test('migration: v1 のデータを v2 へ移しても予定日が変わらない', () => {
  const v1 = {
    schemaVersion: 1,
    notes: [{
      id: 'n1',
      parentId: null,
      title: '',
      body: '古いメモ',
      tags: [],
      anchorDate: '2026-09-01',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      status: 'active',
      schedule: { presetId: 'standard', intervals: [1, 3, 7, 14], ease: 2.6, adaptive: true },
      reviews: [
        { id: 'r1', step: 0, due: '2026-09-02', status: 'done', rating: 'known', completedAt: '2026-09-02T04:00:00.000Z', extra: false },
        { id: 'r2', step: 1, due: '2026-09-04', status: 'pending', rating: null, completedAt: null, extra: false },
        { id: 'r3', step: 2, due: '2026-09-08', status: 'pending', rating: null, completedAt: null, extra: false },
        { id: 'r4', step: 3, due: '2026-09-16', status: 'pending', rating: null, completedAt: null, extra: false },
      ],
    }],
    settings: {},
    meta: {},
  };
  const migrated = normalizeData(migrate(v1));
  const note = migrated.notes[0];
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(note.events.length, 1);
  assert.equal(note.events[0].type, 'rate');
  assert.equal(note.schedule.ease, 2.6, '定着度が再現される');
  assert.equal(note.reviews.filter((r) => r.status === 'done').length, 1);
  assert.deepEqual(
    note.reviews.filter((r) => r.status === 'pending').map((r) => r.due),
    ['2026-09-04', '2026-09-08', '2026-09-16'],
    'v1 と同じ予定日になる',
  );
});

/* -------------------------------------------------------------- exporter */

test('exporter: 各形式で出力できる', () => {
  const notes = [createNote({ title: 'タイトル', cue: '手掛かり', body: '本文\n2行目', tags: ['tag'] }, settings)];
  const md = serializeNotes(notes, 'markdown');
  assert.match(md, /## タイトル/);
  assert.match(md, /#tag/);
  assert.match(md, /手掛かり/);
  assert.match(serializeNotes(notes, 'text'), /■ タイトル/);
  const json = JSON.parse(serializeNotes(notes, 'json'));
  assert.equal(json.notes.length, 1);
});

test('exporter: CSV のエスケープ', () => {
  const note = createNote({ title: 'a"b,c', body: '改行\nあり' }, settings);
  const csv = toCsv([note]);
  assert.equal(csv.split('\r\n')[0].split(',')[0], 'id');
  assert.ok(csv.includes('"a""b,c"'));
  assert.ok(csv.includes('"改行\nあり"'));
});

test('store: 同じメモの期限切れは 1 件にまとめる', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  // 30 日前のメモは 1日後・3日後・7日後… が全部期限切れになっている
  const note = store.addNote({ body: 'ずっと放置したメモ', anchorDate: addDays(todayKey(), -30) });
  const rawOverdue = note.reviews.filter((r) => r.status === 'pending' && r.due < todayKey());
  assert.ok(rawOverdue.length > 1, '前提: 複数回分たまっている');

  const queue = store.todayQueue();
  assert.equal(queue.overdue.length, 1, 'キューには 1 件だけ出す');
  assert.equal(queue.overdue[0].review.due, rawOverdue[0].due, 'いちばん古い回を出す');
  assert.equal(queue.items.filter((i) => i.note.id === note.id).length, 1);
});
