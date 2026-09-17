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
  baseIntervalsOf, createEvent, isOverdue, localDayOf, nextReview, refreshNote,
  resolveIntervals, sanitizeIntervals, sanitizeSeed,
} from './curve.js';
import {
  createEmptyData, createNote, makeEventId, normalizeData, normalizeNote,
  normalizeSettings, normalizeTags, normalizeTombstones,
} from './models.js';
import { migrate } from './migrations.js';
import { createDefaultAdapter } from './storage.js';

/**
 * 同じメモの 2 つの版を統合する。
 * 出来事は和集合、中身は新しい方。食い違った古い中身は conflicts に退避する。
 */
function mergeNote(ours, theirs) {
  const seen = new Set(ours.events.map((e) => e.id));
  const extraEvents = theirs.events.filter((e) => !seen.has(e.id));
  const events = [...ours.events, ...extraEvents]
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const ourStamp = ours.contentUpdatedAt || ours.updatedAt;
  const theirStamp = theirs.contentUpdatedAt || theirs.updatedAt;
  const theirContentNewer = theirStamp > ourStamp;
  const contentDiffers = ours.body !== theirs.body
    || ours.title !== theirs.title
    || ours.cue !== theirs.cue
    || ours.tags.join(',') !== theirs.tags.join(',');

  const winner = theirContentNewer ? theirs : ours;
  const loser = theirContentNewer ? ours : theirs;
  const conflicted = contentDiffers && ours.body !== theirs.body;

  const note = {
    ...ours,
    title: winner.title,
    cue: winner.cue,
    body: winner.body,
    tags: [...winner.tags],
    color: winner.color,
    anchorDate: winner.anchorDate,
    origin: { ...winner.origin },
    status: ours.status === 'archived' || theirs.status === 'archived' ? 'archived' : ours.status,
    contentUpdatedAt: theirContentNewer ? theirStamp : ourStamp,
    updatedAt: theirs.updatedAt > ours.updatedAt ? theirs.updatedAt : ours.updatedAt,
    events,
    conflicts: [...(ours.conflicts || [])],
  };

  if (conflicted) {
    const already = note.conflicts.some((c) => c.body === loser.body);
    if (!already) {
      note.conflicts = [{ at: new Date().toISOString(), body: loser.body }, ...note.conflicts].slice(0, 5);
    }
  }

  const changed = extraEvents.length > 0 || theirContentNewer || conflicted;
  return { note, changed, conflicted };
}

/** 保存ごとの固有の印。どのタブが書いた内容かを見分けるために使う。 */
function makeSaveToken() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class Store {
  constructor(adapter = createDefaultAdapter()) {
    this.adapter = adapter;
    this.data = createEmptyData();
    this.listeners = new Set();
    this._index = null;
    /**
     * 最後に保存／読み込みできた内容の印。
     * 時刻だけだと同じミリ秒の保存を取りこぼすため、保存ごとの固有トークンで見る。
     */
    this.syncedToken = null;
    /** 直近の保存でエラーが出たか */
    this.lastSaveError = null;
    this._saving = null;
  }

  /* ---------------------------------------------------------- lifecycle */

  async load() {
    const raw = await this.adapter.load();
    this.data = raw ? normalizeData(migrate(raw)) : createEmptyData();
    this.syncedToken = raw?.meta?.saveToken ?? null;
    this._index = null;
    return this.data;
  }

  /**
   * 別のタブが保存した内容を取り込む。
   *
   * メモを丸ごと入れ替えると、片方の本文か片方の復習記録が消える。
   * そこで「本文などの中身」と「復習の出来事」を別々に統合する。
   *   - 出来事: id の和集合（記録は足し算で失われない）
   *   - 中身  : contentUpdatedAt が新しい方を採用し、
   *             食い違った古い方は conflicts に退避して本人に見せる
   *   - 削除  : 墓標（deleted）を見て、古いタブの保存で復活させない
   */
  async reconcile() {
    const raw = await this.adapter.load();
    if (!raw) return { changed: false, added: 0, updated: 0, conflicts: 0 };
    const token = raw?.meta?.saveToken ?? null;
    if (token !== null && token === this.syncedToken) {
      return { changed: false, added: 0, updated: 0, conflicts: 0 };
    }
    const incoming = normalizeData(migrate(raw));

    const tombstones = { ...normalizeTombstones(this.data.deleted), ...incoming.deleted };
    const mine = new Map(this.data.notes.map((n) => [n.id, n]));
    let added = 0;
    let updated = 0;
    let conflicts = 0;

    incoming.notes.forEach((theirs) => {
      const ours = mine.get(theirs.id);
      if (!ours) {
        // こちらで消したメモは、相手の古い保存では復活させない
        const tomb = tombstones[theirs.id];
        if (tomb && tomb >= theirs.updatedAt) return;
        mine.set(theirs.id, theirs);
        added += 1;
        return;
      }
      const result = mergeNote(ours, theirs);
      if (result.changed) updated += 1;
      if (result.conflicted) conflicts += 1;
      mine.set(theirs.id, result.note);
    });

    // 相手が消したメモは、こちらでも消す（こちらの方が新しい編集なら残す）
    Object.entries(incoming.deleted || {}).forEach(([id, at]) => {
      const ours = mine.get(id);
      if (ours && at >= (ours.contentUpdatedAt || ours.updatedAt)) {
        mine.delete(id);
        updated += 1;
      }
    });

    const nextNotes = [...mine.values()];
    const changed = added > 0 || updated > 0
      || nextNotes.length !== this.data.notes.length;
    this.data.deleted = tombstones;
    if (changed) {
      this.data.notes = nextNotes;
      this.data.notes.forEach((n) => this.refresh(n));
      this._index = null;
    }
    this.syncedToken = token;
    if (changed) this.emit({ type: 'data:reconciled', added, updated, conflicts });
    return { changed, added, updated, conflicts };
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

  /**
   * 保存する。結果を返すので、呼び出し側は成功を待ってから画面を閉じられる。
   * 別タブが先に書いていた場合は、上書きせず先に取り込んでから保存する。
   */
  async persist() {
    this._saving = (async () => {
      try {
        const stored = await this.adapter.load();
        const storedToken = stored?.meta?.saveToken ?? null;
        if (stored && storedToken !== this.syncedToken) {
          // 別のタブが先に保存している。上書きせず、取り込んでから書く
          await this.reconcile();
        }
        const token = makeSaveToken();
        this.data.meta.updatedAt = new Date().toISOString();
        this.data.meta.appVersion = APP_VERSION;
        this.data.meta.saveToken = token;
        await this.adapter.save(this.data);
        this.syncedToken = token;
        if (this.lastSaveError) {
          this.lastSaveError = null;
          this.emit({ type: 'save:recovered' });
        }
        return { ok: true };
      } catch (err) {
        console.error('[fcc] 保存に失敗しました', err);
        this.lastSaveError = err;
        this.emit({
          type: 'error',
          message: '保存できませんでした。ブラウザの空き容量や、プライベートモードの設定をご確認ください。',
        });
        return { ok: false, error: err };
      }
    })();
    return this._saving;
  }

  /** 進行中の保存を待ち、結果を返す */
  async flush() {
    const result = await (this._saving || this.persist());
    return result;
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
      // 「また後で」と言われたメモは、その日まで出さない
      if (note.snoozedUntil && note.snoozedUntil > base) return;
      const overdue = note.reviews.filter((review) => isOverdue(review, base));
      if (!overdue.length) return;
      const picked = perNote ? [overdue[0]] : overdue;
      picked.forEach((review) => items.push({ note, review }));
    });
    return items.sort((a, b) => (a.review.due < b.review.due ? -1 : 1));
  }

  /**
   * 今日の復習キュー。
   *
   * 期限切れ（思い出し待ち）は 1 日あたりの上限まで。
   * 上限は「今日すでに取り戻した数」を差し引いて数えるので、
   * こなしても次が補充されない＝「今日はここまで」が守られる。
   * `extra` を true にすると、本人が望んだときだけ追加分を出す。
   */
  todayQueue(base = todayKey(), { extra = false } = {}) {
    const limit = this.settings.overdueDailyLimit;
    const overdueAll = this.settings.carryOverOverdue ? this.overdueItems(base) : [];
    const doneOverdueToday = this.overdueClearedToday(base);
    const room = limit > 0 ? Math.max(0, limit - doneOverdueToday) : overdueAll.length;
    const overdue = extra ? overdueAll : overdueAll.slice(0, room);

    // 同じメモが「期限切れ」と「今日」の両方に出ないようにする
    const seen = new Set(overdue.map((i) => i.note.id));
    const due = this.dayBucket(base).reviews
      .filter((r) => r.review.status === 'pending'
        && !seen.has(r.note.id)
        && !(r.note.snoozedUntil && r.note.snoozedUntil > base));

    return {
      overdue,
      due,
      waiting: Math.max(0, overdueAll.length - overdue.length),
      overdueTotal: overdueAll.length,
      limit,
      doneOverdueToday,
      items: [...overdue, ...due],
    };
  }

  /** 今日、予定日を過ぎていた復習をいくつ取り戻したか */
  overdueClearedToday(base = todayKey()) {
    let count = 0;
    this.data.notes.forEach((note) => note.events.forEach((ev) => {
      if ((ev.type === 'rate' || ev.type === 'skip') && ev.day === base && ev.dueWas && ev.dueWas < base) {
        count += 1;
      }
    }));
    return count;
  }

  /**
   * 指定日のタスク一覧。
   * 今日の分は todayQueue と必ず同じ内容にする（件数・まとめて復習とずれないように）。
   */
  tasksFor(dateKey) {
    const bucket = this.dayBucket(dateKey);
    const today = todayKey();
    if (dateKey !== today) {
      return { overdue: [], waiting: 0, reviews: bucket.reviews, created: bucket.created };
    }
    const queue = this.todayQueue(today);
    // 復習 ID はメモごとの連番なので、メモ ID と組にして識別する
    const queued = new Set(queue.due.map((i) => `${i.note.id}:${i.review.id}`));
    const rest = bucket.reviews.filter((r) => r.review.status !== 'pending'
      || queued.has(`${r.note.id}:${r.review.id}`));
    return {
      overdue: queue.overdue,
      waiting: queue.waiting,
      reviews: rest,
      created: bucket.created,
      queue,
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

  /**
   * このアプリに触れた日の集合。
   *
   * 「書いた日」は復習の起点日ではなく、実際に手を動かした日で数える。
   * （過去の日付を起点にして今日書いた場合も、活動は今日）
   * 既存メモを今日書き足した場合も、その日を活動として数える。
   */
  touchedDays() {
    const days = new Set();
    this.data.notes.forEach((note) => {
      days.add(localDayOf(note.createdAt));
      if (note.contentUpdatedAt) days.add(localDayOf(note.contentUpdatedAt));
      note.events.forEach((ev) => {
        if (ev.type === 'rate' || ev.type === 'skip') days.add(ev.day);
      });
    });
    return days;
  }

  /** 何日続けて触れているか（今日まだでも、昨日まで続いていれば継続とみなす） */
  streakDays(base = todayKey()) {
    const days = this.touchedDays();
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

  /** 直近 n 日で書いたメモ・育てたメモ・生まれた気づき */
  recentActivity(days = 7, base = todayKey()) {
    const from = addDays(base, -(days - 1));
    const inRange = (iso) => {
      if (!iso) return false;
      const day = localDayOf(iso);
      return day >= from && day <= base;
    };
    const written = this.data.notes.filter((n) => inRange(n.createdAt));
    const edited = this.data.notes.filter((n) => !inRange(n.createdAt) && inRange(n.contentUpdatedAt));
    return {
      written: written.length,
      edited: edited.length,
      insights: written.filter((n) => n.parentId).length,
      reviewed: this.data.notes.reduce((acc, n) => acc + n.events.filter(
        (e) => e.type === 'rate' && e.day >= from && e.day <= base,
      ).length, 0),
      notes: written,
    };
  }

  /**
   * 節目。数字を追いかけさせるのではなく、
   * 「書けた」「戻ってこられた」「新しい気づきが生まれた」を拾う。
   */
  milestones(base = todayKey()) {
    const notes = this.data.notes;
    const rates = notes.flatMap((n) => n.events.filter((e) => e.type === 'rate'));
    const children = notes.filter((n) => n.parentId);
    const lateInsight = children.some((c) => {
      const parent = this.getNote(c.parentId);
      return parent && diffDays(parent.anchorDate, c.anchorDate) >= 30;
    });
    const graduated = notes.filter((n) => n.status === 'graduated').length;
    const streak = this.streakDays(base);
    const touched = this.touchedDays().size;

    const defs = [
      { id: 'first-note', label: '最初のメモを書いた', done: notes.length >= 1, icon: 'edit' },
      { id: 'first-recall', label: '初めての再会', desc: '書いたメモと、後日また出会えました', done: rates.length >= 1, icon: 'sparkle' },
      { id: 'recall-3', label: '3回 思い出した', done: rates.length >= 3, icon: 'target' },
      { id: 'first-insight', label: '追加メモが生まれた', desc: '読み返して、新しい気づきを足せました', done: children.length >= 1, icon: 'branch' },
      { id: 'notes-10', label: 'メモが10件たまった', done: notes.length >= 10, icon: 'notes' },
      { id: 'recall-25', label: '25回 思い出した', done: rates.length >= 25, icon: 'target' },
      { id: 'touched-7', label: '7日 このアプリに触れた', done: touched >= 7, icon: 'calendar' },
      { id: 'late-insight', label: '1ヶ月前のメモに気づきを足した', done: lateInsight, icon: 'layers' },
      { id: 'streak-7', label: '7日続けて触れた', done: streak >= 7, icon: 'flag' },
      { id: 'first-graduate', label: '初めて定着した', done: graduated >= 1, icon: 'graduate' },
      { id: 'recall-100', label: '100回 思い出した', done: rates.length >= 100, icon: 'target' },
    ];
    return {
      achieved: defs.filter((d) => d.done),
      next: defs.find((d) => !d.done) || null,
    };
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

  /** 復習の記録がまだ無い（起点日を動かしても履歴が壊れない）か */
  canChangeAnchor(note) {
    return !note.events.some((e) => e.type === 'rate' || e.type === 'skip');
  }

  updateNote(id, patch) {
    const note = this.getNote(id);
    if (!note) return null;
    if (patch.anchorDate && patch.anchorDate !== note.anchorDate && this.canChangeAnchor(note)) {
      note.anchorDate = patch.anchorDate;
    }
    // 中身の変更だけ contentUpdatedAt を進める（復習の記録とは別に扱う）
    let contentChanged = false;
    const setField = (key, value) => {
      if (note[key] === value) return;
      note[key] = value;
      contentChanged = true;
    };
    if (patch.title !== undefined) setField('title', String(patch.title).trim());
    if (patch.cue !== undefined) setField('cue', String(patch.cue).trim());
    // 本文は前後の空白・改行を勝手に削らない（書いたとおりに残す）
    if (patch.body !== undefined) setField('body', String(patch.body));
    if (patch.tags !== undefined) {
      const tags = normalizeTags(patch.tags);
      if (tags.join(',') !== note.tags.join(',')) { note.tags = tags; contentChanged = true; }
    }
    if (patch.color !== undefined) setField('color', patch.color || null);

    // 曲線に関わる変更（プリセット・間隔・分散・シード）は reschedule として記録する
    const presetId = patch.presetId || note.schedule.presetId;
    const baseIntervals = baseIntervalsOf(note);
    // 「予定なし」は空配列。未指定（キーなし）と区別する
    const intervals = Array.isArray(patch.intervals)
      ? (patch.intervals.length ? sanitizeIntervals(patch.intervals) : [])
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
    const now = new Date().toISOString();
    note.updatedAt = now;
    if (contentChanged) note.contentUpdatedAt = now;
    this.refresh(note);
    this.commit({ type: 'note:update', noteId: id, contentChanged });
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
    // 墓標を残し、別タブの古い保存で復活しないようにする
    const at = new Date().toISOString();
    if (!this.data.deleted) this.data.deleted = {};
    removed.forEach((noteId) => { this.data.deleted[noteId] = at; });
    this.commit({ type: 'note:delete', noteId: id });
    return removedNotes;
  }

  /** deleteNote の取り消し用（明示的な復元なので墓標を外す） */
  restoreNotes(notes) {
    notes.map((n) => normalizeNote(n, this.settings)).filter(Boolean).forEach((n) => {
      if (this.data.deleted) delete this.data.deleted[n.id];
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
    this.appendEvent(note, 'rate', {
      reviewKey: review.id, step: review.step, rating, dueWas: review.due,
    });
    return note;
  }

  skipReview(noteId, reviewId) {
    const note = this.getNote(noteId);
    const review = note?.reviews.find((r) => r.id === reviewId);
    if (!note || !review) return null;
    this.appendEvent(note, 'skip', { reviewKey: review.id, step: review.step, dueWas: review.due });
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

  /**
   * 今日を起点に復習を組み直す。
   * 「あとで決める」で保存したメモに予定を付けるときにも使う。
   */
  restartNote(noteId, { presetId, intervals } = {}) {
    const note = this.getNote(noteId);
    if (!note) return null;
    const payload = {};
    if (presetId) {
      payload.presetId = presetId;
      payload.intervals = intervals || resolveIntervals(presetId, this.settings);
    } else if (!note.schedule.intervals.length) {
      // 予定がまだ無いメモは、設定の既定プリセットで始める
      payload.presetId = this.settings.presetId;
      payload.intervals = resolveIntervals(this.settings.presetId, this.settings);
    }
    this.appendEvent(note, 'restart', payload);
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
      // 先にアーカイブを外してから、予定にもとづいて状態を計算し直す
      note.status = 'active';
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
