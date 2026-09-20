/**
 * スキーママイグレーション。
 * 「バージョン n のデータを n+1 にする関数」を順に並べる。
 * 新しいスキーマを導入したら MIGRATIONS に追記し、config.js の
 * SCHEMA_VERSION を上げる。
 */
import { SCHEMA_VERSION } from './config.js';
import { getSpread, localDayOf, seedFromString } from './curve.js';
import { docToText, markdownToDoc } from './doc.js';

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

/**
 * v3 → v4
 * デイリーミッション（毎日の小さな目標）を追加した。
 * 既存データには空の進み具合を用意するだけで、メモには手を触れない。
 */
function v3ToV4(data) {
  return {
    ...data,
    schemaVersion: 4,
    progress: data.progress && typeof data.progress === 'object'
      ? data.progress
      : { points: 0, streak: { current: 0, best: 0, lastDay: null, shields: 0 }, days: {} },
  };
}

/**
 * v4 → v5
 * 「その日に手を動かした記録」を日ごとに持つようにした（activity）。
 * ミッションの日次記録に入れていた文字数は、こちらへ移す。
 */
function v4ToV5(data) {
  const activity = { ...(data.activity && typeof data.activity === 'object' ? data.activity : {}) };
  const days = data.progress?.days;
  if (days && typeof days === 'object') {
    Object.entries(days).forEach(([day, record]) => {
      const chars = Number(record?.chars) || 0;
      if (!chars) return;
      const entry = activity[day] || { notes: [], chars: 0 };
      activity[day] = { notes: entry.notes || [], chars: Math.max(entry.chars || 0, chars) };
    });
  }
  return { ...data, schemaVersion: 5, activity };
}

/**
 * v5 → v6
 * 本文を「文書データ」（doc）でも持てるようにした。
 *
 * ここでは既存のメモに手を触れない。書いてあった文字（body）はそのまま残し、
 * 文書データはそのメモを編集画面で開いたときに作る。
 * いっせいに作り直すと、数が多いときに待たされるうえ、
 * 読み取りの取りこぼしがあっても気づけないため。
 */
function v5ToV6(data) {
  return { ...data, schemaVersion: 6 };
}

/**
 * v6 → v7
 * 本文を、全部のメモで「文書データ」に揃える。
 *
 * v0.12 では「触ったメモから順に」文書データへ移していたが、
 * そのために「古いメモを Markdown として読む」という設定を残す必要があった。
 * 読む人にとっては、どちらで保存されているかは知らなくてよいこと。
 * ここで一度だけ全部を読み直し、設定ごと無くす。
 *
 * 読み直すのは記号の解釈だけで、書いてあった文字は落とさない
 * （読めない書き方は、記号もろとも「ただの文字」として残る）。
 */
function v6ToV7(data) {
  const notes = (Array.isArray(data.notes) ? data.notes : []).map((note) => {
    if (!note || typeof note !== 'object' || note.doc) return note;
    const doc = markdownToDoc(typeof note.body === 'string' ? note.body : '');
    return { ...note, doc, body: docToText(doc) };
  });
  // 要らなくなった設定は持ち越さない
  const settings = { ...(data.settings && typeof data.settings === 'object' ? data.settings : {}) };
  delete settings.markdown;
  delete settings.editorMode;
  return { ...data, schemaVersion: 7, notes, settings };
}

const MIGRATIONS = {
  1: v1ToV2,
  2: v2ToV3,
  3: v3ToV4,
  4: v4ToV5,
  5: v5ToV6,
  6: v6ToV7,
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
