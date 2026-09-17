/**
 * アプリ状態の単一の真実の源。
 * UI は subscribe() で購読し、変更通知を受けて再描画する。
 * ドメイン操作はすべてこのモジュール経由で行う（UI から直接データを触らない）。
 */
import { APP_VERSION } from './config.js';
import { addDays, diffDays, todayKey } from './date.js';
import {
  applyReviewResult, isOverdue, nextReview, postponeReview, restartSchedule,
  resolveIntervals, rewriteSchedule, sanitizeIntervals, skipReview, sortReviews, undoReview,
} from './curve.js';
import {
  createEmptyData, createNote, makeReviewId, normalizeData, normalizeNote,
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

  load() {
    const raw = this.adapter.load();
    this.data = raw ? normalizeData(migrate(raw)) : createEmptyData();
    this._index = null;
    return this.data;
  }

  /** アダプタを差し替える（将来の同期実装用） */
  setAdapter(adapter, { migrateData = true } = {}) {
    this.adapter = adapter;
    if (migrateData) this.persist();
  }

  persist() {
    this.data.meta.updatedAt = new Date().toISOString();
    this.data.meta.appVersion = APP_VERSION;
    try {
      this.adapter.save(this.data);
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
    this.persist();
    this.emit(event);
  }

  /* ---------------------------------------------------------- accessors */

  get settings() { return this.data.settings; }
  get notes() { return this.data.notes; }

  getNote(id) { return this.data.notes.find((n) => n.id === id) || null; }

  childrenOf(noteId) {
    return this.data.notes.filter((n) => n.parentId === noteId);
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

  /** 期限切れ（今日より前の pending）をすべて集める */
  overdueItems(base = todayKey()) {
    const items = [];
    this.data.notes.forEach((note) => {
      if (note.status === 'archived') return;
      note.reviews.forEach((review) => {
        if (isOverdue(review, base)) items.push({ note, review });
      });
    });
    return items.sort((a, b) => (a.review.due < b.review.due ? -1 : 1));
  }

  /** 指定日のタスク一覧（設定に応じて期限切れを今日へ繰り越す） */
  tasksFor(dateKey) {
    const bucket = this.dayBucket(dateKey);
    const today = todayKey();
    const carry = this.settings.carryOverOverdue && dateKey === today
      ? this.overdueItems(today)
      : [];
    return { overdue: carry, reviews: bucket.reviews, created: bucket.created };
  }

  stats() {
    const today = todayKey();
    const notes = this.data.notes.filter((n) => n.status !== 'archived');
    const todayBucket = this.dayBucket(today);
    const pendingToday = todayBucket.reviews.filter((r) => r.review.status === 'pending').length;
    const doneToday = this.data.notes.reduce((acc, note) => acc + note.reviews.filter(
      (r) => r.status === 'done' && r.completedAt && r.completedAt.slice(0, 10) === today,
    ).length, 0);
    const upcoming7 = Array.from({ length: 7 }, (_, i) => this.dayBucket(addDays(today, i))
      .reviews.filter((r) => r.review.status === 'pending').length)
      .reduce((a, b) => a + b, 0);
    return {
      total: notes.length,
      active: notes.filter((n) => n.status === 'active').length,
      graduated: notes.filter((n) => n.status === 'graduated').length,
      overdue: this.overdueItems(today).length,
      pendingToday,
      doneToday,
      upcoming7,
    };
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
    if (patch.body !== undefined) note.body = String(patch.body).trim();
    if (patch.tags !== undefined) note.tags = normalizeTags(patch.tags);
    if (patch.color !== undefined) note.color = patch.color || null;

    const presetChanged = patch.presetId && patch.presetId !== note.schedule.presetId;
    const intervalsChanged = patch.intervals
      && sanitizeIntervals(patch.intervals).join(',') !== note.schedule.intervals.join(',');
    if (presetChanged || intervalsChanged) {
      const intervals = patch.presetId === 'custom'
        ? sanitizeIntervals(patch.intervals || this.settings.customIntervals)
        : resolveIntervals(patch.presetId || note.schedule.presetId, this.settings);
      rewriteSchedule(note, patch.presetId || note.schedule.presetId, intervals, makeReviewId);
    }
    note.updatedAt = new Date().toISOString();
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
    const removedNotes = this.data.notes.filter((n) => removed.includes(n.id));
    this.data.notes = this.data.notes.filter((n) => !removed.includes(n.id));
    // 子を残す設定なら親リンクだけ外す
    if (!withChildren) this.data.notes.forEach((n) => { if (n.parentId === id) n.parentId = null; });
    this.commit({ type: 'note:delete', noteId: id });
    return removedNotes;
  }

  /** deleteNote の取り消し用 */
  restoreNotes(notes) {
    notes.map(normalizeNote).filter(Boolean).forEach((n) => {
      if (!this.getNote(n.id)) this.data.notes.push(n);
    });
    this.commit({ type: 'note:restore' });
  }

  rateReview(noteId, reviewId, rating) {
    const note = this.getNote(noteId);
    if (!note) return null;
    applyReviewResult(note, reviewId, rating, { adaptive: this.settings.adaptive }, makeReviewId);
    this.commit({ type: 'review:rate', noteId, reviewId, rating });
    return note;
  }

  skipReview(noteId, reviewId) {
    const note = this.getNote(noteId);
    if (!note) return null;
    skipReview(note, reviewId);
    this.commit({ type: 'review:skip', noteId, reviewId });
    return note;
  }

  undoReview(noteId, reviewId) {
    const note = this.getNote(noteId);
    if (!note) return null;
    undoReview(note, reviewId);
    sortReviews(note);
    this.commit({ type: 'review:undo', noteId, reviewId });
    return note;
  }

  postponeReview(noteId, reviewId, days = 1) {
    const note = this.getNote(noteId);
    if (!note) return null;
    postponeReview(note, reviewId, days);
    this.commit({ type: 'review:postpone', noteId, reviewId });
    return note;
  }

  restartNote(noteId) {
    const note = this.getNote(noteId);
    if (!note) return null;
    restartSchedule(note, note.schedule.intervals, makeReviewId);
    this.commit({ type: 'note:restart', noteId });
    return note;
  }

  archiveNote(noteId, archived = true) {
    const note = this.getNote(noteId);
    if (!note) return null;
    if (archived) {
      note.status = 'archived';
    } else {
      note.status = note.reviews.some((r) => r.status === 'pending') ? 'active' : 'graduated';
    }
    note.updatedAt = new Date().toISOString();
    this.commit({ type: 'note:archive', noteId });
    return note;
  }

  updateSettings(patch) {
    this.data.settings = normalizeSettings({ ...this.data.settings, ...patch });
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

  clearAll() {
    const settings = { ...this.data.settings };
    this.data = createEmptyData();
    this.data.settings = settings;
    this.adapter.clear();
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
