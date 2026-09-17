/**
 * アプリ状態の単一の真実の源。
 * UI は subscribe() で購読し、変更通知を受けて再描画する。
 * ドメイン操作はすべてこのモジュール経由で行う（UI から直接データを触らない）。
 *
 * 復習スケジュールはメモに積んだ出来事 (events) から毎回導出する（curve.js の replay）。
 * そのため「取り消す」は最後の出来事を取り除くだけで、ease も未来の予定も正確に戻る。
 */
import { APP_VERSION } from './config.js';
import { addDays, diffDays, fromKey as fromKeyLocal, todayKey } from './date.js';
import {
  baseIntervalsOf, createEvent, isOverdue, nextReview, refreshNote, resolveIntervals,
  sanitizeIntervals, sanitizeSeed,
} from './curve.js';
import {
  createEmptyData, createNote, makeEventId, normalizeData, normalizeNote,
  normalizeSettings, normalizeTags,
} from './models.js';
import { migrate } from './migrations.js';
import { createDefaultAdapter } from './storage.js';

export class Store {
  constructor(adapter = createDefaultAdapter()) {
    this.adapter = adapter;
    this.data = createEmptyData();
    this.listeners = new Set();
    this._index = null;
  }

  /* ---------------------------------------------------------- lifecycle */

  async load() {
    const raw = await this.adapter.load();
    this.data = raw ? normalizeData(migrate(raw)) : createEmptyData();
    this._index = null;
    return this.data;
  }

  /** アダプタを差し替える（将来の同期実装用） */
  async setAdapter(adapter, { migrateData = true } = {}) {
    this.adapter = adapter;
    if (migrateData) await this.persist();
  }

  /** 保存先が端末に残らない場合の警告文（問題なければ null） */
  get storageWarning() {
    return this.adapter.persistent === false
      ? 'このブラウザではデータを保存できません。タブを閉じるとメモが失われます。'
      : null;
  }

  async persist() {
    this.data.meta.updatedAt = new Date().toISOString();
    this.data.meta.appVersion = APP_VERSION;
    try {
      await this.adapter.save(this.data);
    } catch (err) {
      console.error('[fcc] 保存に失敗しました', err);
      this.emit({ type: 'error', message: '保存できませんでした。ブラウザの空き容量をご確認ください。' });
    }
  }

  /* ---------------------------------------------------------- pub / sub */

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event = { type: 'change' }) {
    this.listeners.forEach((fn) => fn(event, this));
  }

  /** 変更を保存し、インデックスを捨てて通知する */
  commit(event = { type: 'change' }) {
    this._index = null;
    this.emit(event);
    this.persist();
  }

  /* ---------------------------------------------------------- accessors */

  get settings() { return this.data.settings; }
  get notes() { return this.data.notes; }

  getNote(id) { return this.data.notes.find((n) => n.id === id) || null; }

  childrenOf(noteId) {
    return this.data.notes.filter((n) => n.parentId === noteId);
  }

  /** メモから派生した追加メモを再帰的に数える（記憶の枝） */
  descendantsOf(noteId, seen = new Set()) {
    if (seen.has(noteId)) return [];
    seen.add(noteId);
    return this.childrenOf(noteId).flatMap((c) => [c, ...this.descendantsOf(c.id, seen)]);
  }

  rootOf(note) {
    let current = note;
    const seen = new Set();
    while (current?.parentId && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = this.getNote(current.parentId);
      if (!parent) break;
      current = parent;
    }
    return current;
  }

  allTags() {
    const counts = new Map();
    this.data.notes.forEach((n) => n.tags.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  /* ---------------------------------------------------------- indexing */

  /**
   * 日付 -> { reviews: [{note, review}], created: [note] } のインデックス。
   * 変更時に破棄して遅延再構築する。
   */
  get index() {
    if (this._index) return this._index;
    const byDate = new Map();
    const ensure = (key) => {
      if (!byDate.has(key)) byDate.set(key, { reviews: [], created: [] });
      return byDate.get(key);
    };
    this.data.notes.forEach((note) => {
      if (note.status === 'archived') return;
      ensure(note.anchorDate).created.push(note);
      note.reviews.forEach((review) => ensure(review.due).reviews.push({ note, review }));
    });
    byDate.forEach((bucket) => {
      bucket.reviews.sort((a, b) => a.review.step - b.review.step
        || a.note.createdAt.localeCompare(b.note.createdAt));
    });
    this._index = byDate;
    return byDate;
  }

  dayBucket(dateKey) {
    return this.index.get(dateKey) || { reviews: [], created: [] };
  }

  /**
   * 期限切れ（今日より前の pending）を古い順に集める。
   * 同じメモが何回分もたまっている場合は、いちばん古い 1 件だけを出す。
   * （1 件記録すれば残りは自動で組み直されるため、同じメモが並ぶのを防ぐ）
   */
  overdueItems(base = todayKey(), { perNote = true } = {}) {
    const items = [];
    this.data.notes.forEach((note) => {
      if (note.status === 'archived') return;
      const overdue = note.reviews.filter((review) => isOverdue(review, base));
      if (!overdue.length) return;
      const picked = perNote ? [overdue[0]] : overdue;
      picked.forEach((review) => items.push({ note, review }));
    });
    return items.sort((a, b) => (a.review.due < b.review.due ? -1 : 1));
  }

  /**
   * 今日の復習キュー。
   * 期限切れは設定の上限まで（少しずつ取り戻す）。予定日は元のまま保つ。
   */
  todayQueue(base = todayKey()) {
    const limit = this.settings.overdueDailyLimit;
    const overdueAll = this.settings.carryOverOverdue ? this.overdueItems(base) : [];
    const overdue = limit > 0 ? overdueAll.slice(0, limit) : overdueAll;
    // 同じメモが「期限切れ」と「今日」の両方に出ないようにする
    const seen = new Set(overdue.map((i) => i.note.id));
    const due = this.dayBucket(base).reviews
      .filter((r) => r.review.status === 'pending' && !seen.has(r.note.id));
    return {
      overdue,
      due,
      waiting: Math.max(0, overdueAll.length - overdue.length),
      overdueTotal: overdueAll.length,
      items: [...overdue, ...due],
    };
  }

  /** 指定日のタスク一覧（今日は期限切れを繰り越して先頭に置く） */
  tasksFor(dateKey) {
    const bucket = this.dayBucket(dateKey);
    const today = todayKey();
    const queue = dateKey === today ? this.todayQueue(today) : null;
    return {
      overdue: queue ? queue.overdue : [],
      waiting: queue ? queue.waiting : 0,
      reviews: bucket.reviews,
      created: bucket.created,
    };
  }

  stats() {
    const today = todayKey();
    const notes = this.data.notes.filter((n) => n.status !== 'archived');
    const todayBucket = this.dayBucket(today);
    const pendingToday = todayBucket.reviews.filter((r) => r.review.status === 'pending').length;
    const doneToday = this.data.notes.reduce((acc, note) => acc + note.events.filter(
      (e) => e.type === 'rate' && e.day === today,
    ).length, 0);
    const upcoming7 = Array.from({ length: 7 }, (_, i) => this.dayBucket(addDays(today, i))
      .reviews.filter((r) => r.review.status === 'pending').length)
      .reduce((a, b) => a + b, 0);
    const ratings = { known: 0, vague: 0, forgot: 0 };
    this.data.notes.forEach((n) => n.events.forEach((e) => {
      if (e.type === 'rate' && ratings[e.rating] !== undefined) ratings[e.rating] += 1;
    }));
    return {
      total: notes.length,
      active: notes.filter((n) => n.status === 'active').length,
      graduated: notes.filter((n) => n.status === 'graduated').length,
      overdue: this.overdueItems(today).length,
      pendingToday,
      doneToday,
      upcoming7,
      ratings,
      reviewsDone: ratings.known + ratings.vague + ratings.forgot,
    };
  }

  /* ------------------------------------------------------------ 集計 */

  /** 日付 -> 想起結果の内訳。記録画面のヒートマップ用。 */
  activityByDay(fromKey, toKey) {
    const map = new Map();
    this.data.notes.forEach((note) => note.events.forEach((ev) => {
      if (ev.type !== 'rate' && ev.type !== 'skip') return;
      if (ev.day < fromKey || ev.day > toKey) return;
      const entry = map.get(ev.day) || { known: 0, vague: 0, forgot: 0, skipped: 0, total: 0 };
      if (ev.type === 'skip') entry.skipped += 1;
      else entry[ev.rating] = (entry[ev.rating] || 0) + 1;
      entry.total += 1;
      map.set(ev.day, entry);
    }));
    return map;
  }

  /** 何日続けて思い出しているか（今日まだでも、昨日まで続いていれば継続とみなす） */
  streakDays(base = todayKey()) {
    const days = new Set();
    this.data.notes.forEach((note) => note.events.forEach((ev) => {
      if (ev.type === 'rate') days.add(ev.day);
    }));
    if (!days.size) return 0;
    let cursor = days.has(base) ? base : addDays(base, -1);
    if (!days.has(cursor)) return 0;
    let count = 0;
    while (days.has(cursor)) {
      count += 1;
      cursor = addDays(cursor, -1);
    }
    return count;
  }

  /** これから先の月ごとの復習件数。負荷が散っているかを見る。 */
  upcomingMonths(months = 12, base = todayKey()) {
    const start = new Date(fromKeyLocal(base).getFullYear(), fromKeyLocal(base).getMonth(), 1);
    const buckets = Array.from({ length: months }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
      return {
        year: d.getFullYear(),
        month: d.getMonth(),
        prefix: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        count: 0,
      };
    });
    const byPrefix = new Map(buckets.map((b) => [b.prefix, b]));
    this.data.notes.forEach((note) => {
      if (note.status === 'archived') return;
      note.reviews.forEach((r) => {
        if (r.status !== 'pending' || r.due < base) return;
        const bucket = byPrefix.get(r.due.slice(0, 7));
        if (bucket) bucket.count += 1;
      });
    });
    return buckets;
  }

  /** タグごとの状況 */
  tagStats() {
    const map = new Map();
    this.data.notes.forEach((note) => {
      if (note.status === 'archived') return;
      note.tags.forEach((tag) => {
        const entry = map.get(tag) || { tag, notes: 0, reviews: 0, graduated: 0 };
        entry.notes += 1;
        entry.reviews += note.events.filter((e) => e.type === 'rate').length;
        if (note.status === 'graduated') entry.graduated += 1;
        map.set(tag, entry);
      });
    });
    return [...map.values()].sort((a, b) => b.notes - a.notes || a.tag.localeCompare(b.tag));
  }

  /* ---------------------------------------------------------- mutations */

  addNote(input) {
    const note = createNote(input, this.settings);
    this.data.notes.push(note);
    this.commit({ type: 'note:add', noteId: note.id });
    return note;
  }

  updateNote(id, patch) {
    const note = this.getNote(id);
    if (!note) return null;
    if (patch.title !== undefined) note.title = String(patch.title).trim();
    if (patch.cue !== undefined) note.cue = String(patch.cue).trim();
    if (patch.body !== undefined) note.body = String(patch.body).trim();
    if (patch.tags !== undefined) note.tags = normalizeTags(patch.tags);
    if (patch.color !== undefined) note.color = patch.color || null;

    // 曲線に関わる変更（プリセット・間隔・分散・シード）は reschedule として記録する
    const presetId = patch.presetId || note.schedule.presetId;
    const baseIntervals = baseIntervalsOf(note);
    const intervals = patch.intervals
      ? sanitizeIntervals(patch.intervals)
      : (patch.presetId && patch.presetId !== note.schedule.presetId
        ? resolveIntervals(presetId, this.settings)
        : baseIntervals);
    const seed = patch.seed !== undefined ? sanitizeSeed(patch.seed) : note.schedule.seed;
    const spread = patch.spread !== undefined ? Number(patch.spread) || 0 : note.schedule.spread;

    const changed = (patch.presetId && patch.presetId !== note.schedule.presetId)
      || intervals.join(',') !== baseIntervals.join(',')
      || seed !== note.schedule.seed
      || spread !== note.schedule.spread;

    if (changed) {
      this.appendEvent(note, 'reschedule', { presetId, intervals, seed, spread }, { silent: true });
    }
    note.updatedAt = new Date().toISOString();
    this.refresh(note);
    this.commit({ type: 'note:update', noteId: id });
    return note;
  }

  deleteNote(id, { withChildren = true } = {}) {
    const removed = [];
    const collect = (noteId) => {
      removed.push(noteId);
      if (withChildren) this.childrenOf(noteId).forEach((c) => collect(c.id));
    };
    collect(id);
    const removedNotes = this.data.notes.filter((n) => removed.includes(n.id))
      .map((n) => JSON.parse(JSON.stringify(n)));
    this.data.notes = this.data.notes.filter((n) => !removed.includes(n.id));
    if (!withChildren) this.data.notes.forEach((n) => { if (n.parentId === id) n.parentId = null; });
    this.commit({ type: 'note:delete', noteId: id });
    return removedNotes;
  }

  /** deleteNote の取り消し用 */
  restoreNotes(notes) {
    notes.map((n) => normalizeNote(n, this.settings)).filter(Boolean).forEach((n) => {
      if (!this.getNote(n.id)) this.data.notes.push(n);
    });
    this.commit({ type: 'note:restore' });
  }

  /* ------------------------------------------------- 復習（出来事の記録） */

  /** メモに出来事を積み、スケジュールを組み直す */
  appendEvent(note, type, payload = {}, { silent = false } = {}) {
    const event = { id: makeEventId(), ...createEvent(type, payload) };
    note.events.push(event);
    note.updatedAt = event.at;
    this.refresh(note);
    if (!silent) this.commit({ type: `event:${type}`, noteId: note.id, eventId: event.id });
    return event;
  }

  refresh(note) {
    return refreshNote(note, { adaptive: this.settings.adaptive });
  }

  /** すべてのメモのスケジュールを再生し直す（設定変更時など） */
  refreshAll() {
    this.data.notes.forEach((n) => this.refresh(n));
    this._index = null;
  }

  rateReview(noteId, reviewId, rating) {
    const note = this.getNote(noteId);
    const review = note?.reviews.find((r) => r.id === reviewId);
    if (!note || !review) return null;
    this.appendEvent(note, 'rate', { reviewKey: review.id, step: review.step, rating });
    return note;
  }

  skipReview(noteId, reviewId) {
    const note = this.getNote(noteId);
    const review = note?.reviews.find((r) => r.id === reviewId);
    if (!note || !review) return null;
    this.appendEvent(note, 'skip', { reviewKey: review.id, step: review.step });
    return note;
  }

  postponeReview(noteId, reviewId, days = 1) {
    const note = this.getNote(noteId);
    const review = note?.reviews.find((r) => r.id === reviewId);
    if (!note || !review) return null;
    this.appendEvent(note, 'postpone', {
      reviewKey: review.id,
      step: review.step,
      due: addDays(todayKey(), Math.max(1, days)),
    });
    return note;
  }

  restartNote(noteId) {
    const note = this.getNote(noteId);
    if (!note) return null;
    this.appendEvent(note, 'restart', {});
    return note;
  }

  /** 直前の出来事を取り消せるか */
  canUndo(noteId, eventId = null) {
    const note = this.getNote(noteId);
    if (!note || !note.events.length) return false;
    const last = note.events[note.events.length - 1];
    return eventId ? last.id === eventId : true;
  }

  /**
   * 直前の出来事を取り消す。
   * スケジュールは出来事から再生されるため、ease も未来の予定も記録前の状態に戻る。
   */
  undoLastEvent(noteId, eventId = null) {
    const note = this.getNote(noteId);
    if (!note || !note.events.length) return null;
    const last = note.events[note.events.length - 1];
    if (eventId && last.id !== eventId) return null;
    note.events.pop();
    note.updatedAt = new Date().toISOString();
    this.refresh(note);
    this.commit({ type: 'event:undo', noteId, eventId: last.id });
    return note;
  }

  archiveNote(noteId, archived = true) {
    const note = this.getNote(noteId);
    if (!note) return null;
    if (archived) {
      note.status = 'archived';
    } else {
      this.refresh(note);
    }
    note.updatedAt = new Date().toISOString();
    this.commit({ type: 'note:archive', noteId });
    return note;
  }

  updateSettings(patch) {
    this.data.settings = normalizeSettings({ ...this.data.settings, ...patch });
    // adaptive は全メモの予定に影響するため、再生し直す
    if (patch.adaptive !== undefined) this.refreshAll();
    this.commit({ type: 'settings:update', patch });
    return this.data.settings;
  }

  /* ---------------------------------------------------------- bulk data */

  exportData() {
    return JSON.parse(JSON.stringify(this.data));
  }

  /**
   * バックアップの復元。
   * @param {object} raw
   * @param {'replace'|'merge'} mode
   */
  importData(raw, mode = 'replace') {
    const incoming = normalizeData(migrate(raw));
    if (mode === 'merge') {
      const existing = new Set(this.data.notes.map((n) => n.id));
      const added = incoming.notes.filter((n) => !existing.has(n.id));
      this.data.notes = [...this.data.notes, ...added];
      this.commit({ type: 'data:import', mode, count: added.length });
      return { imported: added.length, skipped: incoming.notes.length - added.length };
    }
    this.data = incoming;
    this.commit({ type: 'data:import', mode, count: incoming.notes.length });
    return { imported: incoming.notes.length, skipped: 0 };
  }

  async clearAll() {
    const settings = { ...this.data.settings };
    this.data = createEmptyData();
    this.data.settings = settings;
    await this.adapter.clear();
    this.commit({ type: 'data:clear' });
  }
}

/** 便利関数: 復習の状態ラベル用 */
export function reviewState(review, base = todayKey()) {
  if (review.status === 'done') return 'done';
  if (review.status === 'skipped') return 'skipped';
  const d = diffDays(base, review.due);
  if (d < 0) return 'overdue';
  if (d === 0) return 'due';
  return 'upcoming';
}

export { nextReview };
