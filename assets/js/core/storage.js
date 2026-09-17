/**
 * 永続化層。
 *
 * StorageAdapter インタフェース:
 *   load(): object|null
 *   save(data): void
 *   clear(): void
 *   readonly id: string
 *
 * 将来のクラウド同期・ファイル保存はこのインタフェースを実装したアダプタを
 * setAdapter() で差し替えるだけで対応できるようにしている。
 */
import { STORAGE_KEY } from './config.js';

export class LocalStorageAdapter {
  constructor(key = STORAGE_KEY) {
    this.id = 'localStorage';
    this.key = key;
  }

  load() {
    try {
      const raw = window.localStorage.getItem(this.key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.warn('[fcc] 保存データの読み込みに失敗しました', err);
      return null;
    }
  }

  save(data) {
    window.localStorage.setItem(this.key, JSON.stringify(data));
  }

  clear() {
    window.localStorage.removeItem(this.key);
  }
}

/** localStorage が使えない環境（プライベートモード等）のフォールバック */
export class MemoryAdapter {
  constructor() {
    this.id = 'memory';
    this.data = null;
  }

  load() { return this.data; }
  save(data) { this.data = JSON.parse(JSON.stringify(data)); }
  clear() { this.data = null; }
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
