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
  createEmptyData, createNote, createProgress, makeEventId, normalizeActivity, normalizeData,
  normalizeNote, normalizeSettings, normalizeTags, normalizeTombstones, toStoredData, toStoredNote,
} from './models.js';
import {
  COMPLETE_BONUS, advanceStreak, evaluateMission, getMissionDef, levelInfo, pickMissions,
  pruneDays, streakAlive,
} from './missions.js';
import { drawOmikuji, readOmikuji } from './omikuji.js';
import { migrate } from './migrations.js';
import { normalizeDoc } from './doc.js';
import { createDefaultAdapter, splitData } from './storage.js';

/** 保存をまとめる時間。入力のたびに全部を書き出すと重いので少し待つ。 */
const SAVE_COALESCE_MS = 400;

/**
 * すぐ保存する出来事。
 * 入力は少しまとめてよいが、「記録した」「消した」「復元した」は
 * その場で確定させる（直後にタブを閉じても残るように）。
 */
const IMMEDIATE_EVENTS = new Set([
  'event:rate', 'event:skip', 'event:postpone', 'event:restart', 'event:reschedule',
  'note:add', 'note:delete', 'note:restore', 'note:archive',
  'data:import', 'data:clear', 'backup:saved',
  'missions:omikuji', 'missions:update', 'settings:update',
]);

/**
 * メモに触らない出来事。
 * これらは「メモ以外」（設定・進み具合・活動記録）だけを書けば足りる。
 * ここに無い・メモの id も分からない出来事は、安全側に倒して全部書き直す。
 */
const REST_ONLY_EVENTS = new Set([
  'settings:update', 'backup:saved',
  'missions:update', 'missions:flag', 'missions:omikuji', 'missions:celebrated',
]);

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

/** メモの版を覚えておく（id -> updatedAt） */
function stampsOf(notes = []) {
  return new Map(notes.map((n) => [n.id, n.updatedAt]));
}

/** 前回の保存以降に変わったものの記録 */
function freshDirty() {
  return { notes: new Set(), removed: new Set(), rest: false, all: false };
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
    /** 保存の予約（まとめて 1 回で書くため） */
    this._saveTimer = null;
    this._pendingSave = false;
    /** 親 id -> 子メモの数（一覧の描画で毎回数え直さない） */
    this._children = null;
    /** 変更のたびに進む番号。同じ内容の数え直しを避けるために使う。 */
    this._revision = 0;
    this._contextCache = null;
    /**
     * 保存できているメモの版（id -> updatedAt）。
     * 次の保存で「どのメモが変わったか」を見分けるために持つ。
     * null は「まだ何も保存できていない（＝全部書く）」。
     */
    this._savedStamp = null;
    /** 前回の保存以降に変わったもの */
    this._dirty = freshDirty();
    /**
     * 「このタブが書いてよい」ことを保存先で確かめたか。
     * 書けるタブは 1 つだけなので、読み込み直後に一度だけ確かめれば足りる。
     * 毎回確かめると、保存のたびに余計な読み出しが増えて遅くなる。
     */
    this._verifiedWriter = false;
    /**
     * 「見るだけ」のタブか。
     * 同じデータを 2 つのタブが書くと取り返しがつかないので、書けるのは 1 つだけにする。
     */
    this.readOnly = false;
  }

  /** 覚えておいた集計を捨てる（読み込み・統合・変更のたびに必ず通す） */
  invalidate({ schedule = true } = {}) {
    if (schedule) this._index = null;
    this._children = null;
    this._contextCache = null;
    this._revision += 1;
  }

  /** このタブで書いてよいかを切り替える */
  setReadOnly(value) {
    // 書けるタブに戻ったときは、保存先の状態をもう一度確かめる
    if (this.readOnly && !value) this._verifiedWriter = false;
    this.readOnly = Boolean(value);
    this.emit({ type: 'tab:mode', readOnly: this.readOnly });
  }

  /* ---------------------------------------------------------- lifecycle */

  async load() {
    const raw = await this.adapter.load();
    this.data = raw ? normalizeData(migrate(raw)) : createEmptyData();
    this.syncedToken = raw?.meta?.saveToken ?? null;
    // 読み込んだ直後は「保存先と同じ」。ただし移行や修復で形が変わることがあるので、
    // 初回（保存先が空）は全部書く扱いにする。
    this._dirty = freshDirty();
    this._verifiedWriter = false;
    if (raw) this._savedStamp = stampsOf(this.data.notes);
    else { this._savedStamp = null; this._dirty.all = true; }
    // 予定まで書き込まれた古い形（v0.9.0 まで）なら、軽い形へ一度だけ書き直す。
    // 起動のたびに読み捨てる値を、読み込まずに済むようにするため。
    if (raw?.notes?.some((n) => n && n.reviews !== undefined)) {
      this._dirty.all = true;
      // 最初の描画の邪魔をしないよう、少し待ってから
      setTimeout(() => this.schedulePersist(), 1500);
    }
    this.invalidate();
    return this.data;
  }

  /**
   * 保存先の内容で丸ごと読み直す（編集できるタブを移したときなど）。
   * 統合はしない。「いま保存されているもの」が正しいとして扱う。
   */
  async reload() {
    await this.load();
    this.emit({ type: 'data:reloaded' });
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

    // ミッションの進み具合と活動記録も、失わないように統合する
    const progressChanged = this.mergeProgress(incoming.progress);
    const activityChanged = this.mergeActivity(incoming.activity);

    const nextNotes = [...mine.values()];
    const changed = added > 0 || updated > 0 || progressChanged || activityChanged
      || nextNotes.length !== this.data.notes.length;
    this.data.deleted = tombstones;
    if (changed) {
      this.data.notes = nextNotes;
      this.data.notes.forEach((n) => this.refresh(n));
    }
    // 取り込んだあとは、どのメモが動いたか追い切れないので全部書き直す
    if (changed) this._dirty.all = true;
    // 覚えておいた集計は、取り込みのあと必ず捨てる（古い数字を見せない）
    this.invalidate();
    this.syncedToken = token;
    if (changed) this.emit({ type: 'data:reconciled', added, updated, conflicts });
    return { changed, added, updated, conflicts };
  }

  /** アダプタを差し替える（将来の同期実装用） */
  async setAdapter(adapter, { migrateData = true } = {}) {
    this.adapter = adapter;
    // 新しい保存先には、いちど全部を書く
    this._savedStamp = null;
    this._dirty.all = true;
    this._verifiedWriter = false;
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
    // ここから先は「今の中身」を書きに行くので、予約は解除する
    this._pendingSave = false;
    clearTimeout(this._saveTimer);
    this._saveTimer = null;

    // 見るだけのタブは、ぜったいに書かない（別のタブの変更を消さないため）
    if (this.readOnly) return { ok: false, readOnly: true };

    const run = async () => {
      let planned = null;
      try {
        // 読み込んでから最初の 1 回だけ、別タブが先に書いていないかを確かめる
        // （書けるタブは 1 つだけなので、そのあとは確かめ直さなくてよい）
        if (!this._verifiedWriter) {
          // 別タブの保存は、小さな印だけ見て気づく（毎回すべてを読み解かない）
          let storedToken;
          if (typeof this.adapter.token === 'function') {
            storedToken = await this.adapter.token();
            // 印がまだ無いデータは、いちど中身を見て確かめる
            if (storedToken === undefined) {
              const stored = await this.adapter.load();
              storedToken = stored ? (stored.meta?.saveToken ?? null) : undefined;
            }
          } else {
            const stored = await this.adapter.load();
            storedToken = stored ? (stored.meta?.saveToken ?? null) : undefined;
          }
          if (storedToken !== undefined && storedToken !== this.syncedToken) {
            // 別のタブが先に保存している。上書きせず、取り込んでから書く
            await this.reconcile();
          }
        }
        // 何を書くかは、取り込みが済んだ「書く直前」に決める
        // （待っている間に増えた変更も、次の保存で必ず拾えるようにする）
        planned = this._takeSavePlan();
        const token = makeSaveToken();
        this.data.meta.updatedAt = new Date().toISOString();
        this.data.meta.appVersion = APP_VERSION;
        this.data.meta.saveToken = token;
        // メモ単位で書ける保存先なら、変わったメモだけを書く
        if (typeof this.adapter.saveDelta === 'function') {
          // meta（印や更新時刻）はいま書き換えたので、あらためて取り直す
          planned.plan.rest = splitData(this.data).rest;
          await this.adapter.saveDelta(planned.plan);
        } else {
          await this.adapter.save(toStoredData(this.data));
        }
        this.syncedToken = token;
        this._savedStamp = planned.stamps;
        this._verifiedWriter = true;
        if (this.lastSaveError) {
          this.lastSaveError = null;
          this.emit({ type: 'save:recovered' });
        }
        return { ok: true };
      } catch (err) {
        console.error('[fcc] 保存に失敗しました', err);
        // 書けなかったぶんは「まだ変わったまま」に戻す（次の保存で書き直す）
        if (planned) this._restoreDirty(planned.dirty);
        this.lastSaveError = err;
        this.emit({
          type: 'error',
          message: '保存できませんでした。ブラウザの空き容量や、プライベートモードの設定をご確認ください。',
        });
        return { ok: false, error: err };
      }
    };

    // 保存は 1 本の列に並べる（同時に走らせない）
    this._saving = (this._saving || Promise.resolve()).then(run, run);
    return this._saving;
  }

  /**
   * 保存を予約する。
   * 1 文字ごとに全部を書き出すと重いので、少しまとめてから 1 回で書く。
   */
  schedulePersist(delay = SAVE_COALESCE_MS) {
    if (this.readOnly) return;
    this._pendingSave = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this._pendingSave) this.persist();
    }, delay);
  }

  /**
   * 待っていられない場面（タブを閉じる直前）のための同期保存。
   * 書けるタブは 1 つだけなので、別タブの確認はしない。
   * @returns {boolean} 書けたか
   */
  flushSync() {
    if (this.readOnly) return false;
    if (!this._pendingSave && !this._saveTimer) return false;
    if (typeof this.adapter.saveSync !== 'function') { this.flush(); return false; }
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    this._pendingSave = false;
    const planned = this._takeSavePlan();
    try {
      const token = makeSaveToken();
      this.data.meta.updatedAt = new Date().toISOString();
      this.data.meta.appVersion = APP_VERSION;
      this.data.meta.saveToken = token;
      planned.plan.rest = splitData(this.data).rest;
      this.adapter.saveSync(toStoredData(this.data), planned.plan);
      this.syncedToken = token;
      if (this.adapter.syncWriteIsDeferred) {
        // 控えは置けたが、本体に入ったかは分からない。
        // 変更の記録は残しておき、次の保存でもう一度書く（控えは書けてから捨てられる）
        this._restoreDirty(planned.dirty);
      } else {
        this._savedStamp = planned.stamps;
      }
      return true;
    } catch (err) {
      console.error('[fcc] 保存に失敗しました', err);
      this._restoreDirty(planned.dirty);
      this.lastSaveError = err;
      return false;
    }
  }

  /** 予約ぶんも含めて必ず書き出し、結果を待つ */
  async flush() {
    if (this.readOnly) return { ok: false, readOnly: true };
    if (this._pendingSave || this._saveTimer) return this.persist();
    return this._saving || { ok: true };
  }

  /* ------------------------------------------------------ 差分の書き出し */

  /**
   * この出来事で何が変わったかを記録する。
   *
   * メモの id が分かる出来事はそのメモだけ、設定やミッションだけの出来事は
   * 「メモ以外」だけを書けばよい。どちらとも言えない出来事は全部書き直す
   * （書き忘れるより、多めに書く方が安全）。
   */
  _markDirty(event) {
    const type = event?.type || '';
    if (event?.noteId) {
      this._dirty.notes.add(event.noteId);
      // 消したときは、保存先からも消してもらう
      if (type === 'note:delete') this._dirty.removed.add(event.noteId);
      // 活動記録やミッションも一緒に動くので、メモ以外もまとめて書く
      this._dirty.rest = true;
      return;
    }
    if (REST_ONLY_EVENTS.has(type)) { this._dirty.rest = true; return; }
    this._dirty.all = true;
  }

  /**
   * 次に書く内容を決めて、記録をいったん空にする。
   * 書き込みが失敗したら _restoreDirty で戻す。
   */
  _takeSavePlan() {
    const dirty = this._dirty;
    this._dirty = freshDirty();
    const { notes, rest } = splitData(this.data);
    const stamps = stampsOf(notes);
    if (dirty.all || !this._savedStamp) {
      return { plan: { full: true, notes: notes.map(toStoredNote), removed: [], rest }, stamps, dirty };
    }
    const removed = [];
    const alive = new Set(notes.map((n) => n.id));
    this._savedStamp.forEach((_stamp, id) => { if (!alive.has(id)) removed.push(id); });
    dirty.removed.forEach((id) => { if (!alive.has(id) && !removed.includes(id)) removed.push(id); });
    // 印が変わったメモ（＝中身が動いたメモ）と、出来事から分かったメモを書く
    const changed = notes.filter((n) => dirty.notes.has(n.id)
      || this._savedStamp.get(n.id) !== n.updatedAt);
    return { plan: { full: false, notes: changed.map(toStoredNote), removed, rest }, stamps, dirty };
  }

  /** 書けなかったぶんを、変更の記録に戻す */
  _restoreDirty(dirty) {
    if (!dirty) return;
    dirty.notes.forEach((id) => this._dirty.notes.add(id));
    dirty.removed.forEach((id) => this._dirty.removed.add(id));
    if (dirty.rest) this._dirty.rest = true;
    if (dirty.all) this._dirty.all = true;
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
  /**
   * 変更を確定して、購読者へ知らせ、保存を予約する。
   * @param {object} event
   * @param {{schedule?:boolean}} options schedule:false は「予定は変わっていない」
   *   （本文だけの編集など）。日付ごとの索引を作り直さずに済む。
   */
  commit(event = { type: 'change' }, { schedule = true } = {}) {
    this.invalidate({ schedule });
    this._markDirty(event);
    this.emit(event);
    if (this.readOnly) return;
    // 確定の操作は待たせずに書き始める。本文の入力だけ少しまとめる。
    // （閉じる直前の取りこぼしは flushSync で守る）
    if (IMMEDIATE_EVENTS.has(event?.type)) this.persist();
    else this.schedulePersist();
  }

  /* ---------------------------------------------------------- accessors */

  get settings() { return this.data.settings; }
  get notes() { return this.data.notes; }

  getNote(id) { return this.data.notes.find((n) => n.id === id) || null; }

  /** 親 id -> 子メモの数。一覧のカードで使うので、1 回だけ数えて使い回す。 */
  childCountOf(noteId) {
    if (!this._children) {
      this._children = new Map();
      this.data.notes.forEach((n) => {
        if (!n.parentId) return;
        this._children.set(n.parentId, (this._children.get(n.parentId) || 0) + 1);
      });
    }
    return this._children.get(noteId) || 0;
  }

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
    // 日ごとの記録（v0.6.1 以降はこれが本命。過去の日が後の編集で消えない）
    Object.keys(this.data.activity || {}).forEach((day) => days.add(day));
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
    this.recordTouch(note.id, note.body.length);
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
    let anchorChanged = false;
    if (patch.anchorDate && patch.anchorDate !== note.anchorDate && this.canChangeAnchor(note)) {
      note.anchorDate = patch.anchorDate;
      anchorChanged = true;
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
    // 本文の正本は文書データ。中身が同じなら触らない（保存の回数を増やさない）
    if (patch.doc !== undefined) {
      const nextDoc = normalizeDoc(patch.doc);
      if (JSON.stringify(note.doc ?? null) !== JSON.stringify(nextDoc ?? null)) {
        note.doc = nextDoc;
        contentChanged = true;
      }
    }
    // 本文は前後の空白・改行を勝手に削らない（書いたとおりに残す）
    let charDelta = 0;
    if (patch.body !== undefined) {
      const before = note.body.length;
      setField('body', String(patch.body));
      // 「今日書いた量」は増えた分だけ数える（消した分で目減りさせない）
      charDelta = note.body.length - before;
    }
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

    const changed = anchorChanged
      || (patch.presetId && patch.presetId !== note.schedule.presetId)
      || intervals.join(',') !== baseIntervals.join(',')
      || seed !== note.schedule.seed
      || spread !== note.schedule.spread;

    if (changed) {
      this.appendEvent(note, 'reschedule', { presetId, intervals, seed, spread }, { silent: true });
    }
    const now = new Date().toISOString();
    note.updatedAt = now;
    if (contentChanged) {
      note.contentUpdatedAt = now;
      // 「この日に手を動かした」記録は日ごとに残す（後の編集で消えないように）
      this.recordTouch(note.id, charDelta);
    }
    // 予定に関わる変更があったときだけ、組み直す（本文だけの編集では触らない）
    if (changed) this.refresh(note);
    this.commit({ type: 'note:update', noteId: id, contentChanged }, { schedule: changed });
    return note;
  }

  deleteNote(id, { withChildren = true } = {}) {
    const removed = [];
    const seen = new Set();
    const collect = (noteId) => {
      // 万一たどり直しになっても止まらなくならないようにする（壊れたデータ対策）
      if (seen.has(noteId)) return;
      seen.add(noteId);
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
    // 予定は全メモで組み直したので、保存も全メモぶん必要になる
    this._dirty.all = true;
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

  /* ------------------------------------------------- デイリーミッション */

  get progress() {
    if (!this.data.progress) this.data.progress = createProgress();
    return this.data.progress;
  }

  /** その日の記録の入れ物（無ければ作る。commit はしない） */
  _dayRecord(day) {
    const progress = this.progress;
    if (!progress.days[day]) {
      progress.days[day] = {
        ids: [], targets: {}, flags: {}, done: [], points: 0,
        streakAt: null, bonusAt: null, celebrated: false, omikuji: null,
      };
    }
    return progress.days[day];
  }

  /**
   * その日に手を動かした記録を残す。
   * メモの「最終更新日時」は上書きされてしまうので、日ごとの記録を別に持つ。
   */
  recordTouch(noteId, charDelta = 0, day = todayKey()) {
    if (!this.data.activity) this.data.activity = {};
    const entry = this.data.activity[day] || { notes: [], chars: 0 };
    if (noteId && !entry.notes.includes(noteId)) entry.notes.push(noteId);
    const n = Math.round(Number(charDelta) || 0);
    if (n > 0) entry.chars += n;
    this.data.activity[day] = entry;
    return entry;
  }

  /** その日の活動（触れたメモと、増えた文字数） */
  activityOf(day = todayKey()) {
    return this.data.activity?.[day] || { notes: [], chars: 0 };
  }

  /**
   * ミッションの判定に使う「その日の事実」。
   * すべて今のデータから数え直す（別の場所に二重に持たない）。
   */
  missionContext(day = todayKey()) {
    // 同じ内容のまま何度も数え直さない（メモが増えても重くならないように）
    const cacheKey = `${day}:${this._revision}`;
    if (this._contextCache && this._contextCache.key === cacheKey) return this._contextCache.value;
    const queue = this.todayQueue(day);
    const oldLine = addDays(day, -30);
    let ratedToday = 0;
    let knownToday = 0;
    let oldRecallToday = 0;
    let restartedToday = 0;
    let createdToday = 0;
    let childCreatedToday = 0;
    let editedToday = 0;
    let olderNotes = 0;
    let inboxCount = 0;
    const touched = new Set(this.activityOf(day).notes);

    this.data.notes.forEach((note) => {
      const born = localDayOf(note.createdAt);
      if (born === day) {
        createdToday += 1;
        if (note.parentId) childCreatedToday += 1;
      } else {
        olderNotes += 1;
        if (note.contentUpdatedAt && localDayOf(note.contentUpdatedAt) === day) editedToday += 1;
      }
      if (note.status === 'inbox') inboxCount += 1;
      note.events.forEach((ev) => {
        if (ev.day !== day) return;
        if (ev.type === 'rate') {
          ratedToday += 1;
          if (ev.rating === 'known') knownToday += 1;
          if (note.anchorDate <= oldLine) oldRecallToday += 1;
        }
        if (ev.type === 'rate' || ev.type === 'skip') touched.add(note.id);
        if (ev.type === 'restart') restartedToday += 1;
      });
    });

    const backup = this.backupStatus(day);
    const record = this.progress.days[day];
    const value = {
      day,
      // その日に向き合う予定だった数（終わった分を含む＝進めても減らない）
      plannedToday: ratedToday + queue.items.length,
      ratedToday,
      knownToday,
      // 今日さわったメモの数（書く・読み返す・思い出す をまとめて数える）
      touchedToday: touched.size,
      oldDueToday: queue.items.filter((it) => it.note.anchorDate <= oldLine).length + oldRecallToday,
      oldRecallToday,
      createdToday,
      childCreatedToday,
      editedToday,
      restartedToday,
      inboxCount,
      olderNotes,
      totalNotes: this.data.notes.length,
      charsToday: this.activityOf(day).chars,
      flags: record?.flags || {},
      backupStale: backup.stale,
      backupToday: Boolean(backup.last) && localDayOf(backup.last) === day,
    };
    this._contextCache = { key: cacheKey, value };
    return value;
  }

  /**
   * その日の積み重ね。
   * 数字を追わせるためではなく「今日はこれだけ記憶に触れた」を返すために使う。
   */
  recap(day = todayKey()) {
    const ctx = this.missionContext(day);
    const activity = this.activityOf(day);
    return {
      chars: activity.chars,
      touched: activity.notes.length,
      reviewed: ctx.ratedToday,
      reunions: ctx.oldRecallToday,
      insights: ctx.childCreatedToday,
      written: ctx.createdToday,
    };
  }

  /** 今日のミッションと、レベル・連続の状態（読み取り専用） */
  missionState(day = todayKey()) {
    const ctx = this.missionContext(day);
    const record = this.progress.days[day];
    const locked = record?.ids?.length ? record.ids.map(getMissionDef).filter(Boolean) : [];
    const picked = locked.length ? locked : pickMissions(day, ctx);
    const missions = picked.map((def) => evaluateMission(def, ctx, record?.targets?.[def.id]));
    const doneCount = missions.filter((m) => m.done).length;
    return {
      day,
      missions,
      doneCount,
      total: missions.length,
      allDone: missions.length > 0 && doneCount === missions.length,
      earnedToday: record?.points || 0,
      celebrated: record?.celebrated === true,
      // やる気くじ：全部そろえた日に 1 回だけ引ける
      omikuji: readOmikuji(record?.omikuji),
      canDrawOmikuji: missions.length > 0 && doneCount === missions.length && !record?.omikuji,
      level: levelInfo(this.progress.points),
      streak: { ...this.progress.streak, alive: streakAlive(this.progress.streak, day) },
      context: ctx,
    };
  }

  /** ミッションの達成を記録に焼き付ける。UI は戻り値を見て祝う。 */
  syncMissions(day = todayKey()) {
    if (!this.settings.missionsEnabled) return null;
    const before = levelInfo(this.progress.points).level;
    const record = this._dayRecord(day);
    let changed = false;

    const state = this.missionState(day);
    if (!record.ids.length && state.missions.length) {
      // その日のお題と必要な数は、最初に見たときに決めて動かさない
      record.ids = state.missions.map((m) => m.id);
      state.missions.forEach((m) => { record.targets[m.id] = m.target; });
      changed = true;
    }

    const newly = state.missions.filter((m) => m.done && !record.done.includes(m.id));
    newly.forEach((m) => {
      record.done.push(m.id);
      record.points += m.points;
      this.progress.points += m.points;
      changed = true;
    });

    // 意味のある行動が 1 つでもあれば、その日は「続いた日」として数える。
    // 全部そろえるのは、そこに乗るボーナス。
    let streakResult = null;
    if (record.done.length && !record.streakAt) {
      record.streakAt = new Date().toISOString();
      streakResult = advanceStreak(this.progress.streak, day);
      this.progress.streak = streakResult.streak;
      changed = true;
    }

    let justCompletedAll = false;
    if (state.allDone && !record.bonusAt) {
      record.bonusAt = new Date().toISOString();
      record.points += COMPLETE_BONUS;
      this.progress.points += COMPLETE_BONUS;
      justCompletedAll = true;
      changed = true;
    }

    if (changed) {
      this.progress.days = pruneDays(this.progress.days, day);
      this.commit({ type: 'missions:update', day });
    }

    return {
      newly,
      justCompletedAll,
      streak: this.progress.streak,
      usedShields: streakResult?.usedShields || 0,
      awardedShield: streakResult?.awardedShield || false,
      leveledUp: levelInfo(this.progress.points).level > before,
      state: this.missionState(day),
    };
  }

  /**
   * 別のタブのミッション記録を取り込む。
   * ポイントは多い方、連続は長い方、日ごとの達成は和集合にして、どちらの努力も消さない。
   */
  mergeProgress(theirs) {
    if (!theirs || typeof theirs !== 'object') return false;
    const ours = this.progress;
    let changed = false;

    if ((theirs.points || 0) > ours.points) { ours.points = theirs.points; changed = true; }
    const mineStreak = ours.streak || {};
    const yours = theirs.streak || {};
    if ((yours.current || 0) > (mineStreak.current || 0)
      || (yours.lastDay || '') > (mineStreak.lastDay || '')) {
      ours.streak = {
        current: Math.max(mineStreak.current || 0, yours.current || 0),
        best: Math.max(mineStreak.best || 0, yours.best || 0),
        lastDay: (yours.lastDay || '') > (mineStreak.lastDay || '') ? yours.lastDay : mineStreak.lastDay,
        shields: Math.max(mineStreak.shields || 0, yours.shields || 0),
      };
      changed = true;
    }

    Object.entries(theirs.days || {}).forEach(([day, record]) => {
      const mineDay = ours.days[day];
      if (!mineDay) { ours.days[day] = record; changed = true; return; }
      const done = [...new Set([...mineDay.done, ...record.done])];
      if (done.length !== mineDay.done.length) { mineDay.done = done; changed = true; }
      if (record.points > mineDay.points) { mineDay.points = record.points; changed = true; }
      if (!mineDay.ids.length && record.ids.length) {
        mineDay.ids = record.ids;
        mineDay.targets = record.targets;
        changed = true;
      }
      Object.keys(record.flags || {}).forEach((f) => {
        if (!mineDay.flags[f]) { mineDay.flags[f] = true; changed = true; }
      });
      if (record.bonusAt && !mineDay.bonusAt) { mineDay.bonusAt = record.bonusAt; changed = true; }
      if (record.streakAt && !mineDay.streakAt) { mineDay.streakAt = record.streakAt; changed = true; }
      if (record.omikuji && !mineDay.omikuji) { mineDay.omikuji = record.omikuji; changed = true; }
    });
    return changed;
  }

  /**
   * 別のタブの活動記録を取り込む。触れたメモは和集合、文字数は多い方を採る。
   */
  mergeActivity(theirs) {
    const incoming = normalizeActivity(theirs);
    if (!this.data.activity) this.data.activity = {};
    let changed = false;
    Object.entries(incoming).forEach(([day, entry]) => {
      const mine = this.data.activity[day];
      if (!mine) { this.data.activity[day] = entry; changed = true; return; }
      const notes = [...new Set([...mine.notes, ...entry.notes])];
      if (notes.length !== mine.notes.length) { mine.notes = notes; changed = true; }
      if (entry.chars > mine.chars) { mine.chars = entry.chars; changed = true; }
    });
    return changed;
  }

  /** 画面の操作で満たすミッション（先を眺めた・昔のメモを開いた）に印を付ける */
  markMissionFlag(name, day = todayKey()) {
    if (!this.settings.missionsEnabled) return false;
    const record = this._dayRecord(day);
    if (record.flags[name]) return false;
    record.flags[name] = true;
    this.commit({ type: 'missions:flag', day, name });
    return true;
  }

  /**
   * やる気くじを引く。
   * 全部そろえた日に 1 回だけ。引いた結果はその日ぶん残る。
   */
  drawOmikuji(day = todayKey(), rand = Math.random) {
    const state = this.missionState(day);
    if (!state.allDone) return null;
    const record = this._dayRecord(day);
    if (record.omikuji) return readOmikuji(record.omikuji);

    // 直近に出た言葉は避ける（毎日ちがう言葉に出会えるように）
    const recent = Object.entries(this.progress.days)
      .filter(([key]) => key !== day)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 10)
      .map(([, rec]) => rec.omikuji?.fortune)
      .filter((n) => Number.isInteger(n));

    record.omikuji = drawOmikuji(rand, recent);
    this.commit({ type: 'missions:omikuji', day });
    return readOmikuji(record.omikuji);
  }

  /** 祝いを出したことを覚えておく（1 日に 1 回だけ） */
  markCelebrated(day = todayKey()) {
    const record = this._dayRecord(day);
    if (record.celebrated) return false;
    record.celebrated = true;
    this.commit({ type: 'missions:celebrated', day });
    return true;
  }

  /* ---------------------------------------------------------- bulk data */

  exportData() {
    // 復習の予定は出来事から組み直せるので、控えには入れない（ファイルが小さくなる）
    return JSON.parse(JSON.stringify(toStoredData(this.data)));
  }

  /** バックアップを保存したことを記録する */
  markBackedUp(at = new Date().toISOString()) {
    this.data.meta.lastBackupAt = at;
    this.commit({ type: 'backup:saved' });
    return at;
  }

  /**
   * バックアップの状況。
   * 「最後に保存してから何日たったか」をアプリバーに出すために使う。
   */
  backupStatus(base = todayKey()) {
    const last = this.data.meta.lastBackupAt || null;
    const notes = this.data.notes.length;
    if (!last) {
      return {
        last: null,
        days: null,
        notes,
        // メモがあるのに一度も保存していなければ、そっと促す
        stale: notes > 0,
        changedSince: notes > 0,
      };
    }
    const days = Math.max(0, diffDays(localDayOf(last), base));
    // 最後のバックアップ以降に書き換えがあったか
    const changedSince = (this.data.meta.updatedAt || '') > last;
    return { last, days, notes, stale: changedSince && days >= 7, changedSince };
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
    this._dirty.all = true;
    this.invalidate();
    this.commit({ type: 'data:import', mode, count: incoming.notes.length });
    return { imported: incoming.notes.length, skipped: 0 };
  }

  async clearAll() {
    const settings = { ...this.data.settings };
    this.data = createEmptyData();
    this.data.settings = settings;
    this._savedStamp = null;
    this._dirty = freshDirty();
    this._dirty.all = true;
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
