/**
 * スキーママイグレーション。
 * 「バージョン n のデータを n+1 にする関数」を順に並べる。
 * 新しいスキーマを導入したら MIGRATIONS に追記し、config.js の
 * SCHEMA_VERSION を上げる。
 */
import { SCHEMA_VERSION } from './config.js';
import { getSpread, localDayOf, seedFromString } from './curve.js';

/**
 * v1 → v2
 * 復習予定を「保存された結果」から「出来事 (events) の再生」へ変更した。
 * 既存メモは完了済み・スキップ済みの復習から出来事を組み立て直す。
 * 出来事には記録日 (completedAt) が入っているため、再生すると
 * v1 と同じ予定日が復元される。
 */
function v1ToV2(data) {
  const notes = (Array.isArray(data.notes) ? data.notes : []).map((note) => {
    if (!note || typeof note !== 'object') return note;
    const reviews = Array.isArray(note.reviews) ? note.reviews : [];

    const events = reviews
      .filter((r) => r && (r.status === 'done' || r.status === 'skipped'))
      .sort((a, b) => String(a.completedAt || '').localeCompare(String(b.completedAt || '')))
      .map((r, i) => {
        const at = r.completedAt || note.createdAt || new Date().toISOString();
        return {
          id: `e_migrated_${note.id || 'n'}_${i}`,
          type: r.status === 'done' ? 'rate' : 'skip',
          at,
          day: localDayOf(at),
          step: Number.isFinite(r.step) ? r.step : 0,
          ...(r.status === 'done' ? { rating: r.rating || 'known' } : {}),
        };
      });

    return {
      ...note,
      cue: typeof note.cue === 'string' ? note.cue : '',
      origin: {
        presetId: note.schedule?.presetId || 'standard',
        intervals: note.schedule?.intervals || [1, 3, 7, 14, 30, 60],
      },
      events,
    };
  });

  return { ...data, schemaVersion: 2, notes };
}

/**
 * v2 → v3
 * 復習日の分散（メモごとのシード）を導入した。
 * 既存メモには id から安定したシードを割り当て、設定の分散の強さを適用する。
 * これにより、同じ日に書いたメモの遠い未来の復習日が散らばるようになる。
 */
function v2ToV3(data) {
  const ratio = getSpread(data.settings?.spreadId).ratio;
  const notes = (Array.isArray(data.notes) ? data.notes : []).map((note) => {
    if (!note || typeof note !== 'object') return note;
    return {
      ...note,
      origin: {
        ...(note.origin || {}),
        spread: note.origin?.spread !== undefined ? note.origin.spread : ratio,
        seed: note.origin?.seed !== undefined ? note.origin.seed : seedFromString(note.id || ''),
      },
    };
  });
  return {
    ...data,
    schemaVersion: 3,
    notes,
    settings: { ...(data.settings || {}), spreadId: data.settings?.spreadId || 'normal' },
  };
}

const MIGRATIONS = {
  1: v1ToV2,
  2: v2ToV3,
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
