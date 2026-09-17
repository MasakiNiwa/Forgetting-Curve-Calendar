/**
 * コアロジックのテスト（DOM 非依存）。
 *   node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { addDays, diffDays, isValidKey, monthMatrix, toKey, todayKey, weekdayLabels } from '../assets/js/core/date.js';
import {
  PRESETS, applyReviewResult, buildSchedule, clampEase, nextReview, restartSchedule,
  retentionSeries, rewriteSchedule, sanitizeIntervals, skipReview, undoReview,
} from '../assets/js/core/curve.js';
import { bodyPreview, createNote, displayTitle, normalizeData, DEFAULT_SETTINGS } from '../assets/js/core/models.js';
import { serializeNotes, toCsv } from '../assets/js/core/exporter.js';

let counter = 0;
const makeId = () => `r_${++counter}`;
const settings = { ...DEFAULT_SETTINGS };

/* ------------------------------------------------------------------ date */

test('date: 日付キーの加算と差分', () => {
  assert.equal(addDays('2026-09-17', 3), '2026-09-20');
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(diffDays('2026-09-17', '2026-09-20'), 3);
  assert.equal(diffDays('2026-09-20', '2026-09-17'), -3);
});

test('date: 月末・うるう年をまたいでもずれない', () => {
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2027-02-28', 1), '2027-03-01');
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

/* ----------------------------------------------------------------- curve */

test('curve: 間隔の正規化', () => {
  assert.deepEqual(sanitizeIntervals([7, 1, 3, 3, 0, -5, 'x']), [1, 3, 7]);
  assert.deepEqual(sanitizeIntervals([]), [1, 3, 7]);
  assert.equal(clampEase(9), 3.0);
  assert.equal(clampEase(0.1), 1.3);
});

test('curve: 起点日から復習予定を生成する', () => {
  const reviews = buildSchedule('2026-09-17', [1, 3, 7], makeId);
  assert.deepEqual(reviews.map((r) => r.due), ['2026-09-18', '2026-09-20', '2026-09-24']);
  assert.deepEqual(reviews.map((r) => r.step), [0, 1, 2]);
  assert.ok(reviews.every((r) => r.status === 'pending'));
});

const makeNote = (intervals = [1, 3, 7, 14]) => ({
  anchorDate: '2026-09-17',
  status: 'active',
  updatedAt: '',
  schedule: { presetId: 'standard', intervals, ease: 2.5, adaptive: true },
  reviews: buildSchedule('2026-09-17', intervals, makeId),
});

test('curve: 「覚えていた」で ease が上がり残りが後ろにずれる', () => {
  const note = makeNote();
  applyReviewResult(note, note.reviews[0].id, 'known', { adaptive: true }, makeId);
  assert.equal(note.schedule.ease, 2.6);
  assert.equal(note.reviews[0].status, 'done');
  assert.equal(note.reviews[0].rating, 'known');
  const pending = note.reviews.filter((r) => r.status === 'pending');
  assert.equal(pending.length, 3);
  // 完了日（今日）を起点に再配置される
  assert.ok(pending.every((r) => diffDays(todayKey(), r.due) > 0));
});

test('curve: 「あいまい」は同じステップの追加復習を挟む', () => {
  const note = makeNote();
  applyReviewResult(note, note.reviews[1].id, 'vague', { adaptive: true }, makeId);
  const extra = note.reviews.filter((r) => r.extra);
  assert.equal(extra.length, 1);
  assert.equal(extra[0].step, 1);
  assert.equal(extra[0].status, 'pending');
  assert.ok(note.schedule.ease < 2.5);
});

test('curve: 「忘れた」は今日を起点に組み直す', () => {
  const note = makeNote();
  applyReviewResult(note, note.reviews[2].id, 'forgot', { adaptive: true }, makeId);
  const pending = note.reviews.filter((r) => r.status === 'pending');
  assert.deepEqual(pending.map((r) => r.step), [0, 1, 2, 3]);
  assert.equal(pending[0].due, addDays(todayKey(), 1));
  assert.equal(note.schedule.ease, 2.25);
});

test('curve: adaptive が無効なら間隔は動かない', () => {
  const note = makeNote();
  const before = note.reviews.map((r) => r.due);
  applyReviewResult(note, note.reviews[0].id, 'known', { adaptive: false }, makeId);
  assert.equal(note.schedule.ease, 2.5);
  assert.deepEqual(note.reviews.slice(1).map((r) => r.due), before.slice(1));
});

test('curve: 全ステップ完了で定着、やり直しで復活する', () => {
  const note = makeNote([1, 3]);
  note.reviews.slice().forEach((r) => applyReviewResult(note, r.id, 'known', { adaptive: false }, makeId));
  assert.equal(note.status, 'graduated');
  restartSchedule(note, [1, 3], makeId);
  assert.equal(note.status, 'active');
  assert.equal(nextReview(note).due, addDays(todayKey(), 1));
});

test('curve: スキップと取り消し', () => {
  const note = makeNote([1, 3]);
  skipReview(note, note.reviews[0].id);
  assert.equal(note.reviews[0].status, 'skipped');
  undoReview(note, note.reviews[0].id);
  assert.equal(note.reviews[0].status, 'pending');
  assert.equal(note.status, 'active');
});

test('curve: 間隔を変更しても完了済みの履歴は残る', () => {
  const note = makeNote([1, 3, 7, 14]);
  applyReviewResult(note, note.reviews[0].id, 'known', { adaptive: false }, makeId);
  rewriteSchedule(note, 'light', [1, 7, 30], makeId);
  assert.equal(note.reviews.filter((r) => r.status === 'done').length, 1);
  assert.deepEqual(note.schedule.intervals, [1, 7, 30]);
  // 完了済みステップ (0) より先のステップだけが再生成される
  assert.deepEqual(note.reviews.filter((r) => r.status === 'pending').map((r) => r.step), [1, 2]);
});

test('curve: プリセットはすべて昇順の正の整数', () => {
  PRESETS.forEach((p) => {
    assert.deepEqual(p.intervals, sanitizeIntervals(p.intervals), `${p.id} の間隔が不正`);
  });
});

test('curve: 保持率グラフは 0〜1 に収まり、復習時点で 1 に戻る', () => {
  const points = retentionSeries([1, 3, 7, 14]);
  assert.ok(points.length > 50);
  assert.ok(points.every((p) => p.r >= 0 && p.r <= 1));
  assert.equal(points.filter((p) => p.review).length, 4);
});

/* ---------------------------------------------------------------- models */

test('models: メモ作成時に復習予定が作られる', () => {
  const note = createNote({ body: '本文', anchorDate: '2026-09-17', tags: 'a b a' }, settings);
  assert.equal(note.reviews.length, settings.customIntervals.length === 0 ? 0 : note.schedule.intervals.length);
  assert.deepEqual(note.tags, ['a', 'b']);
  assert.equal(note.status, 'active');
  assert.equal(note.reviews[0].due, '2026-09-18');
});

test('models: タイトル未設定なら本文 1 行目が使われ、プレビューは重複しない', () => {
  const note = createNote({ body: '1行目のタイトル\n2行目の本文' }, settings);
  assert.equal(displayTitle(note), '1行目のタイトル');
  assert.equal(bodyPreview(note), '2行目の本文');
  const titled = createNote({ title: 'タイトル', body: '本文' }, settings);
  assert.equal(displayTitle(titled), 'タイトル');
  assert.equal(bodyPreview(titled), '本文');
});

test('models: 壊れたデータを読み込んでも復旧できる', () => {
  const data = normalizeData({
    notes: [
      { id: 'a', body: 'ok', anchorDate: 'おかしな日付', reviews: [{ due: 'x' }] },
      null,
      { id: 'b', body: 'child', parentId: 'いない親' },
      'not an object',
    ],
    settings: { theme: 'ねこ', weekStart: 9, customIntervals: [3, 1, 1] },
  });
  assert.equal(data.notes.length, 2);
  assert.equal(data.notes[1].parentId, null);
  assert.equal(data.settings.theme, 'system');
  assert.equal(data.settings.weekStart, 0);
  assert.deepEqual(data.settings.customIntervals, [1, 3]);
  assert.ok(data.notes[0].reviews.length > 0);
});

/* -------------------------------------------------------------- exporter */

test('exporter: 各形式で出力できる', () => {
  const notes = [createNote({ title: 'タイトル', body: '本文\n2行目', tags: ['tag'] }, settings)];
  const md = serializeNotes(notes, 'markdown');
  assert.match(md, /## タイトル/);
  assert.match(md, /#tag/);
  assert.match(serializeNotes(notes, 'text'), /■ タイトル/);
  const json = JSON.parse(serializeNotes(notes, 'json'));
  assert.equal(json.notes.length, 1);
});

test('exporter: CSV のエスケープ', () => {
  const note = createNote({ title: 'a"b,c', body: '改行\nあり' }, settings);
  const csv = toCsv([note]);
  const header = csv.split('\r\n')[0];
  assert.equal(header.split(',')[0], 'id');
  assert.ok(csv.includes('"a""b,c"'));
  assert.ok(csv.includes('"改行\nあり"'));
});
