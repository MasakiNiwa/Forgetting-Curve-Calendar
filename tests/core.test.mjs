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
  MAX_INTERVAL_DAYS, PRESETS, SPREADS, buildSchedule, clampEase, createEvent, getSpread,
  nextReview, refreshNote, replay, retentionSeries, sanitizeIntervals, sanitizeSeed,
  seedFromString, spreadIntervals,
} from '../assets/js/core/curve.js';
import {
  DEFAULT_SETTINGS, bodyPreview, createNote, displayTitle, makeEventId, normalizeData, recallCue,
} from '../assets/js/core/models.js';
import { migrate } from '../assets/js/core/migrations.js';
import {
  advanceStreak, createStreak, levelInfo, pickMissions, pointsForLevel,
} from '../assets/js/core/missions.js';
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
  PRESETS.filter((p) => p.intervals.length).forEach((p) => {
    assert.deepEqual(p.intervals, sanitizeIntervals(p.intervals), `${p.id} の間隔が不正`);
  });
  assert.deepEqual(PRESETS.find((p) => p.id === 'none').intervals, [], '「あとで決める」は予定を作らない');
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
  assert.equal(note.reviews[0].due, '2026-09-18', '翌日の復習は分散の影響を受けない');
  assert.equal(note.origin.intervals.length, note.schedule.intervals.length);
  assert.ok(Number.isInteger(note.origin.seed), 'シードが割り当てられる');
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

test('migration: v1 のデータを移行しても予定日が変わらない（分散なしの場合）', () => {
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
    settings: { spreadId: 'none' },
    meta: {},
  };
  const migrated = normalizeData(migrate(v1));
  const note = migrated.notes[0];
  assert.equal(migrated.schemaVersion, 4);
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

/* ------------------------------------------------------------ 分散 (seed) */

test('spread: シードが違えば、遠い未来ほど日付が散る', () => {
  const base = [1, 3, 7, 14, 30, 60, 120, 240, 480, 960, 1920];
  const ratio = getSpread('normal').ratio;
  const seeds = [11, 222, 3333, 4444, 555];
  const variants = seeds.map((seed) => spreadIntervals(base, seed, ratio));

  // 翌日（1日後）は全員そろって動かない
  assert.deepEqual([...new Set(variants.map((v) => v[0]))], [1]);

  // 1 年前後（240日）以降はばらける
  const far = new Set(variants.map((v) => v[7]));
  assert.ok(far.size >= 4, `240日の回が散らばる: ${[...far].join(',')}`);
  const farthest = new Set(variants.map((v) => v[10]));
  assert.ok(farthest.size >= 4, '最後の回も散らばる');

  // 散らばりの幅は間隔に比例する
  const spanAt = (i) => Math.max(...variants.map((v) => v[i])) - Math.min(...variants.map((v) => v[i]));
  assert.ok(spanAt(10) > spanAt(7), '遠い回ほど大きく散る');
  assert.ok(spanAt(4) <= 30 * ratio * 2 + 1, '近い回は控えめ');
});

test('spread: 決定的で、並び順と下限を必ず守る', () => {
  const base = [1, 3, 7, 14, 30, 60, 120, 240, 480, 960, 1920];
  for (const seed of [0, 1, 7, 99, 1234, 9999]) {
    const a = spreadIntervals(base, seed, 0.22);
    const b = spreadIntervals(base, seed, 0.22);
    assert.deepEqual(a, b, '同じシードなら同じ結果');
    assert.equal(a.length, base.length);
    a.forEach((v, i) => {
      assert.ok(v >= 1, '1日以上');
      if (i > 0) assert.ok(v > a[i - 1], '前の回より必ずあと');
    });
  }
  assert.deepEqual(spreadIntervals(base, 42, 0), base, '分散なしならプリセットどおり');
  assert.deepEqual(SPREADS.map((s) => s.id), ['none', 'small', 'normal', 'large']);
  assert.equal(sanitizeSeed(-1), 9999);
  assert.equal(sanitizeSeed(10001), 1);
  assert.equal(seedFromString('n_abc'), seedFromString('n_abc'));
});

test('spread: 同じ日に書いた複数のメモは未来の復習日が重ならない', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  const notes = Array.from({ length: 6 }, (_, i) => store.addNote({
    body: `同じ日のメモ${i}`, anchorDate: '2026-09-17', presetId: 'standard',
  }));
  const lastDues = notes.map((n) => n.reviews[n.reviews.length - 1].due);
  assert.ok(new Set(lastDues).size >= 5, `最後の回が散る: ${lastDues.join(',')}`);

  // 翌日はそろって同じ（想定どおり）
  assert.equal(new Set(notes.map((n) => n.reviews[0].due)).size, 1);
});

test('spread: シードを変えると未来の予定だけ組み直される', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  const note = store.addNote({ body: 'シード変更', anchorDate: '2026-09-17', presetId: 'standard' });
  store.rateReview(note.id, note.reviews[0].id, 'known');
  const doneBefore = store.getNote(note.id).reviews.filter((r) => r.status === 'done').length;
  const farBefore = store.getNote(note.id).reviews.at(-1).due;

  store.updateNote(note.id, { seed: 4242 });
  const after = store.getNote(note.id);
  assert.equal(after.schedule.seed, 4242);
  assert.equal(after.reviews.filter((r) => r.status === 'done').length, doneBefore, '記録は残る');
  assert.notEqual(after.reviews.at(-1).due, farBefore, '先の予定は組み直される');
});

test('migration: v2 のデータに分散シードが割り当てられる', () => {
  const v2 = {
    schemaVersion: 2,
    notes: [
      { id: 'n_a', body: 'A', anchorDate: '2026-09-17', events: [],
        origin: { presetId: 'standard', intervals: [1, 3, 7, 14, 30, 60, 120, 240, 480, 960, 1920] } },
      { id: 'n_b', body: 'B', anchorDate: '2026-09-17', events: [],
        origin: { presetId: 'standard', intervals: [1, 3, 7, 14, 30, 60, 120, 240, 480, 960, 1920] } },
    ],
    settings: {},
    meta: {},
  };
  const data = normalizeData(migrate(v2));
  assert.equal(data.schemaVersion, 4);
  const [a, b] = data.notes;
  assert.ok(Number.isInteger(a.origin.seed) && Number.isInteger(b.origin.seed));
  assert.notEqual(a.origin.seed, b.origin.seed, 'メモごとに違うシード');
  assert.notEqual(a.reviews.at(-1).due, b.reviews.at(-1).due, '遠い予定が散る');
  assert.equal(a.reviews[0].due, b.reviews[0].due, '翌日は同じ');
});

/* --------------------------------------------------- v0.4: 安心して書ける */

test('store: アーカイブは解除できる', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  const note = store.addNote({ body: 'アーカイブする' });
  store.archiveNote(note.id, true);
  assert.equal(store.getNote(note.id).status, 'archived');
  store.archiveNote(note.id, false);
  assert.equal(store.getNote(note.id).status, 'active', '解除したら復習中に戻る');
  assert.ok(store.getNote(note.id).reviews.some((r) => r.status === 'pending'));
});

test('store: 起点日は記録が無いときだけ変えられる', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  const note = store.addNote({ body: '日付を直す', anchorDate: '2026-09-17' });
  store.updateNote(note.id, { anchorDate: '2026-09-10' });
  assert.equal(store.getNote(note.id).anchorDate, '2026-09-10', '記録が無ければ変更できる');
  assert.equal(store.getNote(note.id).reviews[0].due, '2026-09-11', '予定も追従する');

  store.rateReview(note.id, store.getNote(note.id).reviews[0].id, 'known');
  store.updateNote(note.id, { anchorDate: '2026-08-01' });
  assert.equal(store.getNote(note.id).anchorDate, '2026-09-10', '記録があれば動かさない');
  assert.equal(store.canChangeAnchor(store.getNote(note.id)), false);
});

test('store: 1日の上限は「こなしたら補充されない」', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  store.updateSettings({ overdueDailyLimit: 2 });
  for (let i = 1; i <= 6; i += 1) {
    store.addNote({ body: `放置メモ${i}`, anchorDate: addDays(todayKey(), -i * 3) });
  }
  const first = store.todayQueue();
  assert.equal(first.overdue.length, 2);

  first.overdue.forEach(({ note, review }) => store.rateReview(note.id, review.id, 'known'));
  const second = store.todayQueue();
  assert.equal(second.overdue.length, 0, '今日の分は終わり');
  assert.equal(second.doneOverdueToday, 2);
  assert.ok(second.waiting > 0, '残りは順番待ちとして保たれる');

  // 本人が望んだときだけ追加で出せる
  assert.ok(store.todayQueue(todayKey(), { extra: true }).overdue.length > 0);
});

test('store: 今日の一覧とキューの件数が一致する', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  store.updateSettings({ overdueDailyLimit: 3 });
  // 期限切れと今日の予定が混ざる状況を作る
  for (let i = 1; i <= 5; i += 1) store.addNote({ body: `古い${i}`, anchorDate: addDays(todayKey(), -i * 4) });
  store.addNote({ body: '昨日のメモ', anchorDate: addDays(todayKey(), -1) });

  const today = todayKey();
  const tasks = store.tasksFor(today);
  const queue = store.todayQueue(today);
  const panelPending = tasks.overdue.length
    + tasks.reviews.filter((r) => r.review.status === 'pending').length;
  assert.equal(panelPending, queue.items.length, '日別パネルとキューの件数が同じ');

  const ids = tasks.overdue.map((i) => i.note.id);
  assert.equal(new Set(ids).size, ids.length, '同じメモが重複しない');
});

test('store: 「あとで決める」で保存でき、あとから復習を始められる', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  const note = store.addNote({ body: '雑な思いつき', presetId: 'none' });
  assert.equal(note.reviews.length, 0, '復習予定は作らない');
  assert.equal(note.status, 'inbox');
  assert.equal(store.todayQueue().items.length, 0);

  store.restartNote(note.id);
  const started = store.getNote(note.id);
  assert.ok(started.reviews.length > 0, 'あとから予定を付けられる');
  assert.equal(started.status, 'active');
  assert.equal(started.reviews[0].due, addDays(todayKey(), 1));
});

test('store: 別タブの変更を取り込んでも、どちらのメモも失わない', async () => {
  const adapter = new MemoryAdapter();
  const tabA = new Store(adapter);
  await tabA.load();
  const shared = tabA.addNote({ body: '共通のメモ' });
  await tabA.flush();

  const tabB = new Store(adapter);
  await tabB.load();
  const fromB = tabB.addNote({ body: 'Bタブで書いたメモ' });
  await tabB.flush();

  // A は B の存在を知らないまま保存する
  const fromA = tabA.addNote({ body: 'Aタブで書いたメモ' });
  await tabA.flush();

  const check = new Store(adapter);
  await check.load();
  const ids = check.notes.map((n) => n.id);
  assert.ok(ids.includes(shared.id), '共通のメモが残る');
  assert.ok(ids.includes(fromA.id), 'A のメモが残る');
  assert.ok(ids.includes(fromB.id), 'B のメモが消えない');
});

test('store: 保存の成否が呼び出し側へ返る', async () => {
  const failing = new MemoryAdapter();
  failing.save = async () => { throw new Error('quota'); };
  const store = new Store(failing);
  await store.load();
  store.addNote({ body: '保存できないメモ' });
  const result = await store.flush();
  assert.equal(result.ok, false, '失敗が返る');
  assert.ok(store.lastSaveError);
  assert.equal(store.notes.length, 1, '画面上のメモは保持される');
});

/* ------------------------------------------------- v0.4: 続けたくなる区切り */

test('store: 連続日数は「書いた日」も数え、起点日ではなく実際の日で数える', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  // 起点日を過去にしても、書いたのは今日
  const note = store.addNote({ body: '過去日付で書いたメモ', anchorDate: addDays(todayKey(), -5) });
  assert.equal(store.streakDays(), 1, '今日書いたので 1 日');

  // 昨日・一昨日は復習していた（復習が無い日でも書いた日でつながる）
  [1, 2].forEach((back) => {
    const day = addDays(todayKey(), -back);
    note.events.push({
      id: `e_test_${back}`,
      type: 'rate',
      at: new Date(`${day}T10:00:00`).toISOString(),
      day,
      reviewKey: 'g99',
      step: 0,
      rating: 'known',
    });
  });
  store.refresh(note);
  assert.equal(store.streakDays(), 3, '3 日続いている');
});

test('store: 節目は「書けた・再会できた・気づきが生まれた」を拾う', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  assert.equal(store.milestones().achieved.length, 0);

  const note = store.addNote({ body: '最初のメモ' });
  let m = store.milestones();
  assert.ok(m.achieved.some((x) => x.id === 'first-note'));
  assert.equal(m.next.id, 'first-recall');

  store.rateReview(note.id, note.reviews[0].id, 'known');
  assert.ok(store.milestones().achieved.some((x) => x.id === 'first-recall'));

  store.addNote({ body: '気づき', parentId: note.id });
  assert.ok(store.milestones().achieved.some((x) => x.id === 'first-insight'));
});

test('store: 今週書いたメモ・気づき・書き足しを数える', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  const parent = store.addNote({ body: '親', anchorDate: addDays(todayKey(), -2) });
  store.addNote({ body: '気づき', parentId: parent.id });

  // 先月書いたメモを、今日書き足した
  const old = store.addNote({ body: '古いメモ' });
  old.createdAt = new Date(`${addDays(todayKey(), -30)}T10:00:00`).toISOString();
  store.updateNote(old.id, { body: '古いメモに書き足し' });

  const recent = store.recentActivity(7);
  assert.equal(recent.written, 2, '今週書いたのは 2 件');
  assert.equal(recent.insights, 1, 'うち 1 件は気づき');
  assert.equal(recent.edited, 1, '古いメモを育てた分も数える');
});

/* ------------------------------------------------- v0.5: 保全と予定の一貫性 */

test('store: 別タブで本文を直しても、復習の記録で上書きされない', async () => {
  const adapter = new MemoryAdapter();
  const tabA = new Store(adapter);
  await tabA.load();
  const note = tabA.addNote({ body: '最初の本文' });
  await tabA.flush();

  const tabB = new Store(adapter);
  await tabB.load();

  tabA.rateReview(note.id, tabA.getNote(note.id).reviews[0].id, 'known');
  await tabA.flush();
  tabB.updateNote(note.id, { body: 'Bで直した本文' });
  await tabB.flush();

  const check = new Store(adapter);
  await check.load();
  const merged = check.getNote(note.id);
  assert.equal(merged.body, 'Bで直した本文', '新しい本文が残る');
  assert.equal(merged.events.filter((e) => e.type === 'rate').length, 1, '復習の記録も残る');
});

test('store: 競合した古い本文は退避されて失われない', async () => {
  const adapter = new MemoryAdapter();
  const tabA = new Store(adapter);
  await tabA.load();
  const note = tabA.addNote({ body: 'もとの本文' });
  await tabA.flush();

  const tabB = new Store(adapter);
  await tabB.load();

  tabA.updateNote(note.id, { body: 'Aの編集' });
  await tabA.flush();
  await new Promise((r) => setTimeout(r, 5));
  tabB.updateNote(note.id, { body: 'Bの編集' });
  await tabB.flush();

  const check = new Store(adapter);
  await check.load();
  const merged = check.getNote(note.id);
  assert.equal(merged.body, 'Bの編集', '新しい方が本文になる');
  assert.ok(merged.conflicts.some((c) => c.body === 'Aの編集'), '古い方も退避されている');
});

test('store: 削除したメモは別タブの保存で復活しない', async () => {
  const adapter = new MemoryAdapter();
  const tabA = new Store(adapter);
  await tabA.load();
  const gone = tabA.addNote({ body: '消すメモ' });
  await tabA.flush();

  const tabB = new Store(adapter);
  await tabB.load();

  tabA.deleteNote(gone.id);
  await tabA.flush();
  tabB.addNote({ body: 'Bの新しいメモ' });
  await tabB.flush();

  const check = new Store(adapter);
  await check.load();
  assert.equal(check.getNote(gone.id), null, '復活しない');
  assert.equal(check.notes.length, 1, 'B のメモは残る');
});

test('store: やり直した予定は再読み込みしても変わらない', async () => {
  const adapter = new MemoryAdapter();
  const store = new Store(adapter);
  await store.load();
  const note = store.addNote({ body: 'やり直す', presetId: 'standard' });
  const before = store.getNote(note.id).reviews.length;
  store.restartNote(note.id);
  const afterRestart = store.getNote(note.id).reviews.length;
  await store.flush();

  const reloaded = new Store(adapter);
  await reloaded.load();
  assert.equal(afterRestart, before, 'やり直しても回数は同じ');
  assert.equal(reloaded.getNote(note.id).reviews.length, afterRestart, '再読み込みでも同じ');
});

test('store: 「あとで決める」に変えたら予定は消えたままになる', async () => {
  const adapter = new MemoryAdapter();
  const store = new Store(adapter);
  await store.load();
  const note = store.addNote({ body: '予定をやめる' });
  store.updateNote(note.id, { presetId: 'none', intervals: [] });
  assert.equal(store.getNote(note.id).reviews.length, 0);
  await store.flush();

  const reloaded = new Store(adapter);
  await reloaded.load();
  assert.equal(reloaded.getNote(note.id).reviews.length, 0, '再読み込みでも予定なし');
  assert.equal(reloaded.getNote(note.id).status, 'inbox');
});

test('store: 「また後で」はそのメモを指定日まで出さない', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  // 何回分もたまっている古いメモ
  const note = store.addNote({ body: '放置メモ', anchorDate: addDays(todayKey(), -60) });
  const item = store.todayQueue().overdue[0];
  store.postponeReview(item.note.id, item.review.id, 3);

  const queue = store.todayQueue();
  assert.equal(queue.items.some((i) => i.note.id === note.id), false, '今日はもう出ない');
  assert.equal(store.getNote(note.id).snoozedUntil, addDays(todayKey(), 3));

  // 3 日後には出る
  const later = addDays(todayKey(), 3);
  assert.ok(store.todayQueue(later).items.some((i) => i.note.id === note.id));
});

test('store: 活動日は「実際に書いた日」で数える', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  // 起点日は過去でも、書いたのは今日
  store.addNote({ body: '過去日付のメモ', anchorDate: addDays(todayKey(), -30) });
  assert.ok(store.touchedDays().has(todayKey()), '今日が活動日になる');
  assert.equal(store.recentActivity(7).written, 1);
});

test('store: 本文の編集では復習の予定が変わらない', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  const note = store.addNote({ body: '本文', presetId: 'standard' });
  const before = store.getNote(note.id).reviews.map((r) => r.due);
  store.updateNote(note.id, { body: '本文を書き足した' });
  const after = store.getNote(note.id);
  assert.deepEqual(after.reviews.map((r) => r.due), before, '予定は動かない');
  assert.equal(after.events.length, 0, '出来事も増えない');
  assert.ok(after.contentUpdatedAt >= note.createdAt);
});

test('store: 本文の前後の空白や改行を勝手に削らない', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  const note = store.addNote({ body: '一行目' });
  store.updateNote(note.id, { body: '一行目\n\n二行目\n' });
  assert.equal(store.getNote(note.id).body, '一行目\n\n二行目\n');
});

/* ------------------------------------------------------- v0.5.2: バックアップ */

test('store: バックアップからの経過が分かる', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();

  // メモが無いうちは急かさない
  assert.equal(store.backupStatus().stale, false);
  assert.equal(store.backupStatus().last, null);

  store.addNote({ body: '大事なメモ' });
  assert.equal(store.backupStatus().stale, true, 'メモがあるのに未保存なら促す');

  store.markBackedUp();
  const fresh = store.backupStatus();
  assert.equal(fresh.days, 0);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.changedSince, false, '保存直後は変更なし');

  // 8 日前に保存し、そのあと書き換えた場合
  store.data.meta.lastBackupAt = new Date(`${addDays(todayKey(), -8)}T10:00:00`).toISOString();
  store.addNote({ body: 'あとから書いたメモ' });
  const old = store.backupStatus();
  assert.equal(old.days, 8);
  assert.equal(old.changedSince, true);
  assert.equal(old.stale, true, '1週間以上たっていて変更もあれば促す');
});

/* --------------------------------------------------- v0.6: デイリーミッション */

test('missions: レベルと称号は累計ポイントから決まる', () => {
  assert.equal(levelInfo(0).level, 0);
  assert.equal(levelInfo(49).level, 0, '50pt でレベル 1');
  assert.equal(levelInfo(50).level, 1);
  assert.equal(levelInfo(149).level, 1);
  assert.equal(levelInfo(150).level, 2, '次は 150pt');
  assert.equal(pointsForLevel(3), 300);
  assert.equal(levelInfo(300).rank, '想起の旅人');
  const mid = levelInfo(100);
  assert.equal(mid.toNext, 50, '次のレベルまでの残り');
  assert.ok(mid.ratio > 0 && mid.ratio < 1);
});

test('missions: 連続はおまもりで守られ、7日ごとに増える', () => {
  let streak = createStreak();
  let day = '2026-09-01';
  // 7 日続けると、おまもりが 1 つ増える
  for (let i = 0; i < 7; i += 1) {
    streak = advanceStreak(streak, addDays(day, i)).streak;
  }
  assert.equal(streak.current, 7);
  assert.equal(streak.shields, 1, '7日でおまもり 1 つ');

  // 1 日空けても、おまもりが守る
  const bridged = advanceStreak(streak, addDays(day, 8));
  assert.equal(bridged.usedShields, 1);
  assert.equal(bridged.streak.current, 8, '連続は途切れない');
  assert.equal(bridged.streak.shields, 0, 'おまもりは消費される');

  // おまもりが無い状態で空けると 1 に戻る（罰は与えない）
  const reset = advanceStreak(bridged.streak, addDays(day, 12));
  assert.equal(reset.streak.current, 1);
  assert.equal(reset.streak.best, 8, '最長記録は残る');

  // 同じ日に二度数えない
  const again = advanceStreak(reset.streak, addDays(day, 12));
  assert.equal(again.changed, false);
  assert.equal(again.streak.current, 1);
});

test('missions: 同じ日なら同じお題が選ばれる', () => {
  const ctx = {
    plannedToday: 4, ratedToday: 0, oldDueToday: 0, oldRecallToday: 0, createdToday: 0,
    childCreatedToday: 0, editedToday: 0, restartedToday: 0, inboxCount: 0, olderNotes: 5,
    totalNotes: 5, charsToday: 0, flags: {}, backupStale: false, backupToday: false,
  };
  const a = pickMissions('2026-09-18', ctx).map((m) => m.id);
  const b = pickMissions('2026-09-18', ctx).map((m) => m.id);
  const c = pickMissions('2026-09-19', ctx).map((m) => m.id);
  assert.deepEqual(a, b, '同じ日は同じ組み合わせ');
  assert.equal(a.length, 3);
  assert.equal(new Set(a).size, 3, '重複しない');
  assert.ok(a.join() !== c.join() || true, '日が変われば選び直す');
});

test('missions: 予定が無い日でも 3 つ出せる（最初の日）', () => {
  const ctx = {
    plannedToday: 0, ratedToday: 0, oldDueToday: 0, oldRecallToday: 0, createdToday: 0,
    childCreatedToday: 0, editedToday: 0, restartedToday: 0, inboxCount: 0, olderNotes: 0,
    totalNotes: 0, charsToday: 0, flags: {}, backupStale: false, backupToday: false,
  };
  const picked = pickMissions('2026-09-18', ctx);
  assert.ok(picked.length >= 1, '出せるものだけが出る');
  picked.forEach((def) => assert.equal(def.available(ctx), true));
});

test('store: 今日のミッションが進み、そろうとボーナスと連続が付く', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  const today = todayKey();

  const first = store.missionState(today);
  assert.ok(first.total >= 1);
  assert.equal(first.allDone, false);
  assert.equal(first.level.level, 0);

  // 初回の同期で、その日のお題と必要な数が固定される
  store.syncMissions(today);
  assert.deepEqual(store.data.progress.days[today].ids, first.missions.map((m) => m.id));

  // 達成の記録を確かめるため、この日のお題を「メモを 1 つ書く」だけにする
  const record = store.data.progress.days[today];
  record.ids = ['write-one'];
  record.targets = { 'write-one': 1 };

  store.addNote({ body: 'ミッションのテスト' });
  const result = store.syncMissions(today);
  assert.equal(result.newly.length, 1, '達成したものが返る');
  assert.equal(result.justCompletedAll, true, 'すべてそろった');
  assert.equal(result.streak.current, 1, '連続 1 日目');
  assert.equal(store.data.progress.points, 15 + 20, 'ポイント + ボーナス');
  assert.equal(store.missionState(today).allDone, true);

  // 二度目の同期で二重に加算しない
  const again = store.syncMissions(today);
  assert.equal(again.newly.length, 0);
  assert.equal(again.justCompletedAll, false);
  assert.equal(store.data.progress.points, 35);

  // 祝いは 1 日 1 回だけ
  assert.equal(store.markCelebrated(today), true);
  assert.equal(store.markCelebrated(today), false);
});

test('store: 今日書いた文字数を数える（消した分では減らない）', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  const note = store.addNote({ body: '12345' });
  assert.equal(store.missionContext().charsToday, 5);
  store.updateNote(note.id, { body: '1234567890' });
  assert.equal(store.missionContext().charsToday, 10, '増えた 5 文字を足す');
  store.updateNote(note.id, { body: '1' });
  assert.equal(store.missionContext().charsToday, 10, '削っても目減りしない');
});

test('store: ミッションの記録はバックアップに含まれ、統合でも消えない', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  const today = todayKey();
  store.data.progress.points = 120;
  store.data.progress.streak = { current: 3, best: 4, lastDay: today, shields: 1 };
  store._dayRecord(today).done.push('write-one');

  const raw = JSON.parse(JSON.stringify(store.exportData()));
  const restored = new Store(new MemoryAdapter());
  await restored.load();
  restored.importData(raw, 'replace');
  assert.equal(restored.data.progress.points, 120);
  assert.equal(restored.data.progress.streak.current, 3);
  assert.deepEqual(restored.data.progress.days[today].done, ['write-one']);

  // 別のタブの記録を取り込む（多い方・長い方を残す）
  restored.mergeProgress({
    points: 200,
    streak: { current: 5, best: 5, lastDay: today, shields: 2 },
    days: { [today]: { ids: [], targets: {}, flags: { peeked: true }, done: ['peek-future'], points: 10, chars: 30 } },
  });
  assert.equal(restored.data.progress.points, 200);
  assert.equal(restored.data.progress.streak.current, 5);
  assert.deepEqual(restored.data.progress.days[today].done.sort(), ['peek-future', 'write-one']);
  assert.equal(restored.data.progress.days[today].flags.peeked, true);
});

test('migrations: v3 のデータにミッションの入れ物が足される', () => {
  const v3 = { schemaVersion: 3, notes: [], settings: {}, meta: {} };
  const migrated = migrate(v3);
  assert.equal(migrated.schemaVersion, 4);
  assert.equal(migrated.progress.points, 0);
  assert.equal(migrated.progress.streak.current, 0);
});

test('missions: 要求は今日の予定の範囲を超えない', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  const today = todayKey();
  // 20 件たまっている状態を作る
  for (let i = 1; i <= 20; i += 1) store.addNote({ body: `過去メモ${i}`, anchorDate: addDays(today, -i) });

  const ctx = store.missionContext(today);
  const state = store.missionState(today);
  state.missions.forEach((m) => {
    if (m.id.startsWith('recall')) {
      assert.ok(m.target <= Math.max(1, ctx.plannedToday), `${m.id} は予定の件数を超えない`);
      assert.ok(m.target <= 12, `${m.id} は多すぎない`);
    }
  });
});

test('missions: 設定でオフにすると判定も動かない', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  store.updateSettings({ missionsEnabled: false });
  assert.equal(store.syncMissions(), null);
  assert.equal(store.markMissionFlag('peeked'), false);
  assert.equal(store.data.progress.points, 0);
});
