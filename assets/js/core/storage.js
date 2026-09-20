/**
 * 永続化層。
 *
 * StorageAdapter インタフェース（すべて非同期）:
 *   async load(): object|null
 *   async save(data): void
 *   async clear(): void
 *   readonly id: string
 *   readonly persistent: boolean   // 端末に残るか（false ならタブを閉じると消える）
 *
 * 任意で実装できるもの:
 *   async token(): string|null|undefined      // 最後に保存したタブの印だけを読む
 *   async saveDelta(plan): void               // 変わったメモだけを書く（下記）
 *   saveSync(data, plan): void                // 閉じる直前の同期保存
 *
 * saveDelta の plan は store.js が作る:
 *   { full: boolean, notes: Note[], removed: string[], rest: object }
 *   full なら「全部置き換え」。そうでなければ notes（変わったメモ）と
 *   removed（消えたメモの id）だけを書き、rest（設定・進捗など）は毎回書く。
 *   これで 1 文字の変更でも、書き直すのは 1 件ぶんだけになる。
 *
 * 差し替えは store.setAdapter() だけで済む。
 */
import { STORAGE_KEY } from './config.js';

/** IndexedDB が使えないときの同期保存の置き場（閉じる直前の取りこぼし防止） */
export const JOURNAL_KEY = `${STORAGE_KEY}.journal`;
/** IndexedDB へ移したあと、localStorage に残しておく移行前の控え */
export const SNAPSHOT_KEY = `${STORAGE_KEY}.pre-idb`;

/** データを「メモ」と「それ以外」に分ける */
export function splitData(data) {
  const { notes = [], ...rest } = data || {};
  return { notes, rest };
}

/** 全部を書き直す plan にする（初回や取り込みのとき） */
function splitDataAsPlan(data) {
  const { notes, rest } = splitData(data);
  return { notes, rest };
}

export class LocalStorageAdapter {
  constructor(key = STORAGE_KEY) {
    this.id = 'localStorage';
    this.label = 'このブラウザ（端末内）';
    this.persistent = true;
    this.key = key;
  }

  async load() {
    try {
      const raw = window.localStorage.getItem(this.key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.warn('[fcc] 保存データの読み込みに失敗しました', err);
      return null;
    }
  }

  /**
   * 最後に保存したタブの印だけを読む。
   * 別タブの保存を見張るために、毎回すべてを読み解くのは重いので、
   * 小さなキーを別に置いてここだけを見る。
   * まだ印が無い（このしくみの前に保存されたデータ）ときは undefined を返す。
   */
  async token() {
    try {
      const raw = window.localStorage.getItem(`${this.key}.token`);
      return raw === null ? undefined : raw;
    } catch {
      return undefined;
    }
  }

  async save(data) {
    this.saveSync(data);
  }

  /** タブを閉じる直前など、待っていられない場面のための同期保存 */
  saveSync(data) {
    window.localStorage.setItem(this.key, JSON.stringify(data));
    window.localStorage.setItem(`${this.key}.token`, data?.meta?.saveToken ?? '');
  }

  async clear() {
    window.localStorage.removeItem(this.key);
    window.localStorage.removeItem(`${this.key}.token`);
  }
}

/** localStorage が使えない環境（プライベートモード等）のフォールバック */
export class MemoryAdapter {
  constructor() {
    this.id = 'memory';
    this.label = 'メモリ（保存されません）';
    this.persistent = false;
    this.data = null;
  }

  /**
   * 本物の保存先（IndexedDB）と同じく、本文は別に持つ。
   * 読み込みでは本文を返さず、要るときに loadDocs で渡す。
   */
  async load() {
    if (!this.data) return null;
    const copy = JSON.parse(JSON.stringify(this.data));
    copy.notes = (copy.notes || []).map((note) => {
      const { doc, ...rest } = note;
      return rest;
    });
    return copy;
  }

  async loadDocs(ids) {
    const out = new Map();
    const wanted = new Set(ids || []);
    (this.data?.notes || []).forEach((note) => {
      if (wanted.has(note.id) && note.doc) out.set(note.id, JSON.parse(JSON.stringify(note.doc)));
    });
    return out;
  }

  async token() { return this.data ? (this.data.meta?.saveToken ?? '') : undefined; }
  async save(data) { this.saveSync(data); }

  /** メモ単位の保存。実装の確認用に、本物のアダプタと同じ形で受ける。 */
  async saveDelta(plan) {
    const copy = (v) => JSON.parse(JSON.stringify(v));
    const before = new Map((this.data?.notes || []).map((n) => [n.id, n.doc]));
    // 本文が付いていないメモは、いま持っている本文をそのまま残す
    const withDocs = (list) => list.map((note) => (
      note.doc === undefined && before.has(note.id) && before.get(note.id) !== undefined
        ? { ...note, doc: before.get(note.id) }
        : note
    ));
    if (plan.full || !this.data) {
      this.data = copy({ ...plan.rest, notes: withDocs(plan.notes) });
      return;
    }
    const notes = this.data.notes ? [...this.data.notes] : [];
    const at = new Map(notes.map((n, i) => [n.id, i]));
    plan.removed.forEach((id) => {
      if (at.has(id)) notes[at.get(id)] = null;
    });
    withDocs(plan.notes).forEach((note) => {
      if (at.has(note.id)) notes[at.get(note.id)] = copy(note);
      else notes.push(copy(note));
    });
    this.data = copy({ ...plan.rest, notes: notes.filter(Boolean) });
  }

  saveSync(data) { this.data = JSON.parse(JSON.stringify(data)); }
  async clear() { this.data = null; }
}

/* ------------------------------------------------------------------ */
/* IndexedDB                                                          */
/* ------------------------------------------------------------------ */

const DB_NAME = 'fcc';
const DB_VERSION = 2;
const NOTES_STORE = 'notes';
const META_STORE = 'meta';
/** 本文（文書データ）だけを置くところ。開いたときに読む */
const BODIES_STORE = 'bodies';

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB の読み書きに失敗しました'));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('IndexedDB の書き込みが中断されました'));
    tx.onerror = () => reject(tx.error || new Error('IndexedDB の書き込みに失敗しました'));
  });
}

/**
 * 全部を書き直すとき、もう無いメモの本文を片づける。
 * 「持っているメモの本文だけ消す」のではなく「持っていないものを消す」ので、
 * まだ読み込んでいない本文を巻き込まない。
 */
function pruneBodies(bodies, keep) {
  return new Promise((resolve, reject) => {
    const req = bodies.openKeyCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      if (!keep.has(cursor.key)) bodies.delete(cursor.key);
      cursor.continue();
    };
    req.onerror = () => reject(req.error || new Error('本文の片づけに失敗しました'));
  });
}

/**
 * メモ 1 件を 1 レコードとして持つ保存先。
 *
 * localStorage は「文字列 1 本」なので、1 文字の修正でも全メモを
 * 書き直すことになる。メモが増えるほど重くなり、上限（数 MB）も近い。
 * IndexedDB ならメモごとに置けるので、変わった 1 件だけを書けばよい。
 *
 * 弱点は「同期で書けない」こと。タブを閉じる直前は待ってもらえないので、
 * そのときだけ localStorage に控え（journal）を synchronous に置き、
 * 次回の読み込みで重ねて取り戻す。
 *
 * v0.15 から、本文（文書データ）は別のところ（bodies）に置く。
 * 一覧・カレンダー・検索に要るのは「題・手掛かり・素の文字・予定」だけで、
 * 本文そのものは開いたときに 1 件読めばよい。起動で読む量がその分減る。
 */
export class IndexedDbAdapter {
  constructor({ name = DB_NAME, journalKey = JOURNAL_KEY } = {}) {
    this.id = 'indexedDB';
    this.label = 'このブラウザ（端末内・メモごと）';
    this.persistent = true;
    /**
     * saveSync は「控えを置くところまで」しか同期で確かめられない。
     * 本体に入ったかは分からないので、呼び出し側は変更の記録を消さない。
     */
    this.syncWriteIsDeferred = true;
    this.name = name;
    this.journalKey = journalKey;
    this.db = null;
    this._opening = null;
  }

  open() {
    if (this.db) return Promise.resolve(this.db);
    if (this._opening) return this._opening;
    this._opening = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined' || !indexedDB) {
        reject(new Error('IndexedDB がありません'));
        return;
      }
      let req;
      try {
        req = indexedDB.open(this.name, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      // プライベートモードの Firefox などでは、開こうとしたまま返ってこないことがある
      const timer = setTimeout(() => reject(new Error('IndexedDB を開けませんでした（時間切れ）')), 4000);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(NOTES_STORE)) db.createObjectStore(NOTES_STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
        // 本文の置き場（v0.15〜）。中身の移し替えは、次の保存でまとめて行う
        if (!db.objectStoreNames.contains(BODIES_STORE)) db.createObjectStore(BODIES_STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => {
        clearTimeout(timer);
        const db = req.result;
        // 別タブが作り直そうとしたら、こちらは手を引く（壊さないため）
        db.onversionchange = () => { db.close(); this.db = null; this._opening = null; };
        this.db = db;
        resolve(db);
      };
      req.onerror = () => { clearTimeout(timer); reject(req.error || new Error('IndexedDB を開けませんでした')); };
      req.onblocked = () => { clearTimeout(timer); reject(new Error('IndexedDB が他のタブに使われています')); };
    }).catch((err) => { this._opening = null; throw err; });
    return this._opening;
  }

  /** メモの件数（移行するかどうかの判断に使う） */
  async countNotes() {
    const db = await this.open();
    const tx = db.transaction([NOTES_STORE], 'readonly');
    return request(tx.objectStore(NOTES_STORE).count());
  }

  /** すでに中身があるか（移行するかどうかの判断に使う） */
  async hasData() {
    const db = await this.open();
    const tx = db.transaction([NOTES_STORE, META_STORE], 'readonly');
    const [count, rest] = await Promise.all([
      request(tx.objectStore(NOTES_STORE).count()),
      request(tx.objectStore(META_STORE).get('rest')),
    ]);
    return count > 0 || Boolean(rest);
  }

  async load() {
    const db = await this.open();
    const tx = db.transaction([NOTES_STORE, META_STORE], 'readonly');
    const [notes, rest] = await Promise.all([
      request(tx.objectStore(NOTES_STORE).getAll()),
      request(tx.objectStore(META_STORE).get('rest')),
    ]);
    // まだ何も無いときは null（＝初回）。ただし控えが残っていればそれを使う
    if (!rest && !notes.length) return this.readJournal() ? this.applyJournal(null) : null;
    return this.applyJournal({ ...rest, notes });
  }

  async token() {
    const db = await this.open();
    const tx = db.transaction([META_STORE], 'readonly');
    const value = await request(tx.objectStore(META_STORE).get('token'));
    if (value === undefined) {
      // 控えだけが残っている（閉じる直前の書き込みが間に合わなかった）場合もある
      const journal = this.readJournal();
      return journal ? journal.token : undefined;
    }
    return value;
  }

  /**
   * 本文（文書データ）を、要るぶんだけ読む。
   * @param {string[]} ids
   * @returns {Promise<Map<string, object>>}
   */
  async loadDocs(ids) {
    const out = new Map();
    const wanted = [...new Set((ids || []).filter(Boolean))];
    if (!wanted.length) return out;
    const db = await this.open();
    const tx = db.transaction([BODIES_STORE], 'readonly');
    const store = tx.objectStore(BODIES_STORE);
    await Promise.all(wanted.map(async (id) => {
      const record = await request(store.get(id));
      if (record && record.doc) out.set(id, record.doc);
    }));
    return out;
  }

  async save(data) {
    const { notes, rest } = splitData(data);
    return this.saveDelta({ full: true, notes, removed: [], rest });
  }

  /** 変わったメモだけを書く（rest は小さいので毎回まとめて書く） */
  async saveDelta(plan) {
    const db = await this.open();
    const tx = db.transaction([NOTES_STORE, META_STORE, BODIES_STORE], 'readwrite');
    const notes = tx.objectStore(NOTES_STORE);
    const bodies = tx.objectStore(BODIES_STORE);
    if (plan.full) {
      notes.clear();
      // 本文は消さない。いま持っていないメモの本文も、保存先には残っているため。
      // 無くなったメモのぶんだけ、あとで消す（下の pruneBodies）
    }
    (plan.removed || []).forEach((id) => { notes.delete(id); bodies.delete(id); });
    (plan.notes || []).forEach((note) => {
      const { doc, ...rest } = note;
      notes.put(rest);
      // 読んでいないメモ（doc が付いていない）は、保存先の本文をそのままにする
      if (doc !== undefined) {
        if (doc) bodies.put({ id: note.id, doc });
        else bodies.delete(note.id);
      }
    });
    const meta = tx.objectStore(META_STORE);
    meta.put(plan.rest, 'rest');
    meta.put(plan.rest?.meta?.saveToken ?? '', 'token');
    if (plan.full) await pruneBodies(bodies, new Set((plan.notes || []).map((n) => n.id)));
    await transactionDone(tx);
    // ここまで来たら控えは要らない
    this.clearJournal();
  }

  /**
   * 閉じる直前の同期保存。
   * IndexedDB は待ってもらえないので、控えを localStorage に置いてから
   * 念のため本体にも書きに行く（間に合えば控えは消える）。
   */
  saveSync(data, plan) {
    const target = plan && !plan.full ? plan : { full: true, removed: [], ...splitDataAsPlan(data) };
    const journal = {
      token: target.rest?.meta?.saveToken ?? '',
      full: Boolean(target.full),
      notes: target.notes,
      removed: target.removed || [],
      rest: target.rest,
    };
    try {
      window.localStorage.setItem(this.journalKey, JSON.stringify(journal));
    } catch (err) {
      // 控えが置けなくても、本体への書き込みは試す
      console.warn('[fcc] 閉じる直前の控えを置けませんでした', err);
    }
    this.saveDelta(target)
      .catch((err) => console.warn('[fcc] 閉じる直前の保存に失敗しました（控えから戻します）', err));
  }

  readJournal() {
    try {
      const raw = window.localStorage.getItem(this.journalKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  clearJournal() {
    try { window.localStorage.removeItem(this.journalKey); } catch { /* 消せなくても困らない */ }
  }

  /** 閉じる直前に書けなかったぶんを、読み込んだ内容に重ねる */
  applyJournal(data) {
    const journal = this.readJournal();
    if (!journal) return data;
    const storedToken = data?.meta?.saveToken ?? null;
    if (journal.token && storedToken === journal.token) {
      // 本体への書き込みは間に合っていた
      this.clearJournal();
      return data;
    }
    console.info('[fcc] 閉じる直前の変更を控えから取り戻しました');
    if (journal.full || !data) return { ...(journal.rest || {}), notes: journal.notes || [] };
    const map = new Map((data.notes || []).map((n) => [n.id, n]));
    (journal.removed || []).forEach((id) => map.delete(id));
    (journal.notes || []).forEach((note) => map.set(note.id, note));
    return { ...data, ...(journal.rest || {}), notes: [...map.values()] };
  }

  async clear() {
    this.clearJournal();
    // 「全部消す」なので、移行前の控えも残さない
    try { window.localStorage.removeItem(SNAPSHOT_KEY); } catch { /* 消せなくても進む */ }
    const db = await this.open();
    const tx = db.transaction([NOTES_STORE, META_STORE], 'readwrite');
    tx.objectStore(NOTES_STORE).clear();
    tx.objectStore(META_STORE).clear();
    await transactionDone(tx);
  }
}

/* ------------------------------------------------------------------ */
/* 保存先の選択と、localStorage からの移行                             */
/* ------------------------------------------------------------------ */

export function createDefaultAdapter() {
  try {
    const probe = '__fcc_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return new LocalStorageAdapter();
  } catch {
    console.warn('[fcc] localStorage が使えないため、データは今回のセッション限りになります。');
    return new MemoryAdapter();
  }
}

/** localStorage の本体を「移行前の控え」へ寄せる（読み込み先は IndexedDB になる） */
function moveToSnapshot(key = STORAGE_KEY) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return;
    window.localStorage.setItem(SNAPSHOT_KEY, raw);
    window.localStorage.removeItem(key);
    window.localStorage.removeItem(`${key}.token`);
  } catch (err) {
    // 控えが置けないなら、本体はそのまま残す（消してしまわない）
    console.warn('[fcc] 移行前の控えを残せませんでした', err);
  }
}

/** IndexedDB が使えないときは、控えを本体に戻してから localStorage を使う */
function restoreSnapshot(key = STORAGE_KEY) {
  try {
    if (window.localStorage.getItem(key)) return;
    const snapshot = window.localStorage.getItem(SNAPSHOT_KEY);
    if (!snapshot) return;
    window.localStorage.setItem(key, snapshot);
    console.info('[fcc] IndexedDB が使えないため、移行前の控えから戻しました');
  } catch { /* どうにもならないので、そのまま進む */ }
}

/**
 * 使える中でいちばん良い保存先を選ぶ。
 *
 * 1. IndexedDB が開けて、すでにメモがあるならそれを使う
 * 2. メモが無ければ、localStorage の本体から移す
 *    （まっさらなときだけ、移行前の控えも移行元として見る）
 * 3. 開けなければ localStorage（それも駄目ならメモリ）
 */
export async function createBestAdapter({ key = STORAGE_KEY } = {}) {
  const idb = new IndexedDbAdapter();
  try {
    await idb.open();
    if (!(await idb.countNotes())) {
      // 本体が残っているなら、それが最新（移したあとは本体を片付けるので、古いものは残らない）
      let raw = readPayload(key);
      // まっさらなときだけ、移行前の控えも見る（全消去したデータを復活させないため）
      if (!raw?.notes?.length && !(await idb.hasData())) raw = readPayload(SNAPSHOT_KEY);
      if (raw) {
        await idb.save(raw);
        moveToSnapshot(key);
        console.info('[fcc] 保存先を IndexedDB へ移しました（メモ単位で保存します）');
      }
    }
    return idb;
  } catch (err) {
    console.warn('[fcc] IndexedDB が使えないため、これまでの保存先を使います', err);
    restoreSnapshot(key);
    return createDefaultAdapter();
  }
}

/** localStorage の 1 つのキーからデータを読む（壊れていたら null） */
function readPayload(key) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}
