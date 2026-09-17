/**
 * スキーママイグレーション。
 * 「バージョン n のデータを n+1 にする関数」を順に並べる。
 * 新しいスキーマを導入したら MIGRATIONS に追記し、config.js の
 * SCHEMA_VERSION を上げる。
 */
import { SCHEMA_VERSION } from './config.js';

const MIGRATIONS = {
  // 例: 1: (data) => ({ ...data, schemaVersion: 2, notes: data.notes.map(...) }),
};

export function migrate(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  let data = raw;
  let version = Number(data.schemaVersion) || 1;

  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) {
      console.warn(`[fcc] schema v${version} から先のマイグレーションが未定義です`);
      break;
    }
    data = step(data);
    version = Number(data.schemaVersion) || version + 1;
  }

  if (version > SCHEMA_VERSION) {
    console.warn('[fcc] このアプリより新しい形式のデータです。表示できない項目があるかもしれません。');
  }
  return data;
}
