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
 * IndexedDB やクラウド同期を将来足せるよう、同期実装でも Promise を返す形に
 * 揃えてある。差し替えは store.setAdapter() だけで済む。
 */
import { STORAGE_KEY } from './config.js';

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

  async load() { return this.data; }
  async token() { return this.data ? (this.data.meta?.saveToken ?? '') : undefined; }
  async save(data) { this.saveSync(data); }
  saveSync(data) { this.data = JSON.parse(JSON.stringify(data)); }
  async clear() { this.data = null; }
}

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
