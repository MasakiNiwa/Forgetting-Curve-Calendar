/**
 * ドメインモデルの生成と正規化。
 * 外部から読み込んだデータ（バックアップ復元など）は必ず normalize を通す。
 */
import { SCHEMA_VERSION, APP_VERSION } from './config.js';
import { isValidKey, todayKey } from './date.js';
import { MAX_SHIELDS, createStreak, pruneDays } from './missions.js';
import {
  DEFAULT_PRESET_ID, DEFAULT_SPREAD_ID, EASE_DEFAULT, EVENT_TYPES, clampEase, getSpread,
  localDayOf, randomSeed, refreshNote, resolveIntervals, sanitizeIntervals, sanitizeSeed,
  seedFromString,
} from './curve.js';

export function makeId(prefix = 'n') {
  const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
    : Math.random().toString(36).slice(2, 12);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export const makeNoteId = () => makeId('n');
export const makeEventId = () => makeId('e');

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system',            // system | light | dark
  presetId: DEFAULT_PRESET_ID,
  spreadId: DEFAULT_SPREAD_ID,   // 復習日の分散の強さ
  customIntervals: [1, 3, 7, 14, 30, 60, 120, 365, 1095],
  adaptive: true,
  weekStart: 0,               // 0=日曜, 1=月曜
  carryOverOverdue: true,
  overdueDailyLimit: 10,      // 1 日に取り戻す期限切れの上限（0 = 制限なし）
  hideBodyUntilRecall: true,  // 復習時に本文を隠して思い出してから開く
  showCreatedOnCalendar: true,
  defaultExportFormat: 'markdown',
  missionsEnabled: true,      // デイリーミッション（毎日の小さな目標）
});

/** 墓標（削除済みメモの id -> 削除時刻）。古すぎるものは捨てる。 */
export function normalizeTombstones(raw, keepDays = 180) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const limit = Date.now() - keepDays * 86400000;
  Object.entries(raw).forEach(([id, at]) => {
    if (typeof id !== 'string' || typeof at !== 'string') return;
    const t = Date.parse(at);
    if (Number.isFinite(t) && t >= limit) out[id] = at;
  });
  return out;
}

/** デイリーミッションの進み具合（ポイント・連続・日ごとの記録） */
export function createProgress() {
  return { points: 0, streak: createStreak(), days: {} };
}

/** 日ごとの記録を 1 日ぶん整える */
function normalizeDayRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ids = Array.isArray(raw.ids) ? raw.ids.filter((v) => typeof v === 'string').slice(0, 8) : [];
  const targets = {};
  if (raw.targets && typeof raw.targets === 'object') {
    Object.entries(raw.targets).forEach(([k, v]) => {
      const n = Number(v);
      if (typeof k === 'string' && Number.isFinite(n) && n > 0) targets[k] = Math.round(n);
    });
  }
  const flags = {};
  if (raw.flags && typeof raw.flags === 'object') {
    Object.entries(raw.flags).forEach(([k, v]) => { if (v === true) flags[k] = true; });
  }
  return {
    ids,
    targets,
    flags,
    done: Array.isArray(raw.done) ? raw.done.filter((v) => typeof v === 'string').slice(0, 8) : [],
    points: Math.max(0, Math.round(Number(raw.points) || 0)),
    chars: Math.max(0, Math.round(Number(raw.chars) || 0)),
    bonusAt: typeof raw.bonusAt === 'string' ? raw.bonusAt : null,
    celebrated: raw.celebrated === true,
  };
}

export function normalizeProgress(raw, today = todayKey()) {
  const base = createProgress();
  if (!raw || typeof raw !== 'object') return base;
  const streakRaw = raw.streak && typeof raw.streak === 'object' ? raw.streak : {};
  const days = {};
  Object.entries(raw.days && typeof raw.days === 'object' ? raw.days : {}).forEach(([key, value]) => {
    if (!isValidKey(key)) return;
    const record = normalizeDayRecord(value);
    if (record) days[key] = record;
  });
  return {
    points: Math.max(0, Math.round(Number(raw.points) || 0)),
    streak: {
      current: Math.max(0, Math.round(Number(streakRaw.current) || 0)),
      best: Math.max(0, Math.round(Number(streakRaw.best) || 0)),
      lastDay: isValidKey(streakRaw.lastDay) ? streakRaw.lastDay : null,
      shields: Math.max(0, Math.min(MAX_SHIELDS, Math.round(Number(streakRaw.shields) || 0))),
    },
    days: pruneDays(days, today),
  };
}

export function createEmptyData() {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    notes: [],
    deleted: {},
    settings: { ...DEFAULT_SETTINGS },
    progress: createProgress(),
    meta: { createdAt: now, updatedAt: now, appVersion: APP_VERSION, lastBackupAt: null },
  };
}

/**
 * 新しいメモを作る。作成と同時に忘却曲線の復習予定を生成する。
 * @param {object} input {title, cue, body, tags, anchorDate, parentId, presetId, intervals}
 * @param {object} settings
 */
export function createNote(input, settings) {
  const now = new Date().toISOString();
  const anchorDate = isValidKey(input.anchorDate) ? input.anchorDate : todayKey();
  const presetId = input.presetId || settings.presetId || DEFAULT_PRESET_ID;
  const intervals = presetId === 'custom'
    ? sanitizeIntervals(input.intervals || settings.customIntervals)
    : resolveIntervals(presetId, settings);
  const spread = input.spread !== undefined
    ? Number(input.spread) || 0
    : getSpread(settings.spreadId).ratio;
  const seed = input.seed !== undefined ? sanitizeSeed(input.seed) : randomSeed();

  const note = {
    id: makeNoteId(),
    parentId: input.parentId || null,
    title: (input.title || '').trim(),
    cue: (input.cue || '').trim(),
    body: (input.body || '').trim(),
    tags: normalizeTags(input.tags),
    anchorDate,
    createdAt: now,
    updatedAt: now,
    contentUpdatedAt: now,   // 本文・タイトルなど「中身」を最後に直した時刻
    status: 'active',
    color: input.color || null,
    origin: { presetId, intervals, spread, seed },
    schedule: { presetId, intervals, ease: EASE_DEFAULT, seed, spread, adaptive: settings.adaptive !== false },
    events: [],
    reviews: [],
  };
  return refreshNote(note, { adaptive: settings.adaptive !== false });
}

export function normalizeTags(tags) {
  if (typeof tags === 'string') {
    tags = tags.split(/[,、\s]+/);
  }
  if (!Array.isArray(tags)) return [];
  const cleaned = tags
    .map((t) => String(t).trim().replace(/^#/, ''))
    .filter(Boolean)
    .slice(0, 24);
  return [...new Set(cleaned)];
}

/** タイトルとして表示する最大文字数（本文の 1 行目から作るとき） */
export const TITLE_MAX = 44;

/** メモの表示用タイトル（未設定なら本文の 1 行目） */
export function displayTitle(note) {
  if (note.title) return note.title;
  const firstLine = (note.body || '').split('\n').find((l) => l.trim());
  if (!firstLine) return '(無題のメモ)';
  const trimmed = firstLine.trim();
  return trimmed.length > TITLE_MAX ? `${trimmed.slice(0, TITLE_MAX)}…` : trimmed;
}

/**
 * 思い出すための手掛かり。
 * 明示的な手掛かりがなければタイトル（＝本文 1 行目）を使う。
 */
export function recallCue(note) {
  return note.cue?.trim() || displayTitle(note);
}

/**
 * 手掛かりを見ただけでは中身が分からない状態か（隠す意味があるか）。
 * 一行しかない短いメモは、隠しても思い出す余地がないので隠さない。
 */
export function hasHiddenContent(note) {
  const body = (note.body || '').trim();
  if (!body) return false;
  if (note.cue?.trim() || note.title?.trim()) return true;
  const lines = body.split('\n').filter((l) => l.trim());
  return lines.length > 1 || lines[0].trim().length > TITLE_MAX;
}

/**
 * カード表示用の本文。
 * タイトル未設定のメモは本文 1 行目がタイトルになるため、その分を取り除いて返す。
 */
export function bodyPreview(note) {
  if (note.title || note.cue) return note.body || '';
  const lines = (note.body || '').split('\n');
  const firstIdx = lines.findIndex((l) => l.trim());
  if (firstIdx === -1) return '';
  // 1 行目はタイトルとして表示済みなので、続きの行だけを返す
  return lines.slice(firstIdx + 1).join('\n').trim();
}

/* ------------------------------------------------------------------ */
/* 正規化                                                              */
/* ------------------------------------------------------------------ */

export function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!['system', 'light', 'dark'].includes(s.theme)) s.theme = 'system';
  s.weekStart = s.weekStart === 1 ? 1 : 0;
  s.adaptive = s.adaptive !== false;
  s.carryOverOverdue = s.carryOverOverdue !== false;
  s.hideBodyUntilRecall = s.hideBodyUntilRecall !== false;
  s.showCreatedOnCalendar = s.showCreatedOnCalendar !== false;
  s.missionsEnabled = s.missionsEnabled !== false;
  s.customIntervals = sanitizeIntervals(s.customIntervals);
  s.spreadId = getSpread(s.spreadId).id;
  const limit = Number(s.overdueDailyLimit);
  s.overdueDailyLimit = Number.isFinite(limit) && limit >= 0 ? Math.round(limit) : 10;
  if (!['markdown', 'text', 'csv', 'json'].includes(s.defaultExportFormat)) {
    s.defaultExportFormat = 'markdown';
  }
  return s;
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || !EVENT_TYPES.includes(raw.type)) return null;
  const at = typeof raw.at === 'string' ? raw.at : new Date().toISOString();
  const event = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : makeEventId(),
    type: raw.type,
    at,
    day: isValidKey(raw.day) ? raw.day : localDayOf(at),
  };
  if (raw.reviewKey) event.reviewKey = String(raw.reviewKey);
  if (Number.isFinite(raw.step)) event.step = Math.max(0, Math.round(raw.step));
  if (raw.type === 'rate') event.rating = ['known', 'vague', 'forgot'].includes(raw.rating) ? raw.rating : 'known';
  if (isValidKey(raw.dueWas)) event.dueWas = raw.dueWas;
  if (raw.type === 'postpone' && isValidKey(raw.due)) event.due = raw.due;
  if (raw.type === 'reschedule' || raw.type === 'restart') {
    // 未指定（キーが無い）はそのまま未指定として残す。空配列は「予定なし」。
    if (Array.isArray(raw.intervals)) {
      event.intervals = raw.intervals.length ? sanitizeIntervals(raw.intervals) : [];
    }
    if (raw.presetId) event.presetId = raw.presetId;
    if (raw.spread !== undefined) event.spread = Number(raw.spread) || 0;
    if (raw.seed !== undefined) event.seed = sanitizeSeed(raw.seed);
  }
  return event;
}

export function normalizeNote(raw, settings = DEFAULT_SETTINGS) {
  if (!raw || typeof raw !== 'object') return null;
  const now = new Date().toISOString();
  const anchorDate = isValidKey(raw.anchorDate) ? raw.anchorDate : todayKey();
  const rawIntervals = raw.origin?.intervals ?? raw.schedule?.intervals;
  // 「あとで決める」で保存したメモは間隔なし。それ以外は正規化する
  const originIntervals = Array.isArray(rawIntervals) && rawIntervals.length === 0
    ? []
    : sanitizeIntervals(rawIntervals);

  const note = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : makeNoteId(),
    parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
    title: typeof raw.title === 'string' ? raw.title : '',
    cue: typeof raw.cue === 'string' ? raw.cue : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    tags: normalizeTags(raw.tags),
    anchorDate,
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || raw.createdAt || now,
    contentUpdatedAt: raw.contentUpdatedAt || raw.updatedAt || raw.createdAt || now,
    conflicts: Array.isArray(raw.conflicts)
      ? raw.conflicts.filter((c) => c && typeof c.body === 'string').slice(0, 5)
      : [],
    status: ['active', 'graduated', 'archived', 'inbox'].includes(raw.status) ? raw.status : 'active',
    color: raw.color || null,
    origin: {
      presetId: raw.origin?.presetId || raw.schedule?.presetId || DEFAULT_PRESET_ID,
      intervals: originIntervals,
      // 分散の設定がないデータ（v0.2 以前）は、id から安定したシードを割り当てる
      spread: raw.origin?.spread !== undefined
        ? Number(raw.origin.spread) || 0
        : getSpread(settings.spreadId).ratio,
      seed: raw.origin?.seed !== undefined
        ? sanitizeSeed(raw.origin.seed)
        : seedFromString(raw.id || Math.random()),
    },
    schedule: {
      presetId: raw.schedule?.presetId || raw.origin?.presetId || DEFAULT_PRESET_ID,
      intervals: sanitizeIntervals(raw.schedule?.intervals || originIntervals),
      ease: clampEase(raw.schedule?.ease),
      adaptive: settings.adaptive !== false,
    },
    events: Array.isArray(raw.events) ? raw.events.map(normalizeEvent).filter(Boolean) : [],
    reviews: [],
  };

  return refreshNote(note, { adaptive: settings.adaptive !== false });
}

/** 任意の入力データをアプリが扱える形へ整える */
export function normalizeData(raw) {
  const base = createEmptyData();
  if (!raw || typeof raw !== 'object') return base;
  const settings = normalizeSettings(raw.settings);
  const notes = Array.isArray(raw.notes)
    ? raw.notes.map((n) => normalizeNote(n, settings)).filter(Boolean)
    : [];

  // 親が存在しない子メモは孤児にならないよう parentId を落とす
  const ids = new Set(notes.map((n) => n.id));
  notes.forEach((n) => { if (n.parentId && !ids.has(n.parentId)) n.parentId = null; });

  return {
    schemaVersion: SCHEMA_VERSION,
    notes,
    // 削除したメモの墓標。別タブの古い保存で復活しないようにする
    deleted: normalizeTombstones(raw.deleted),
    settings,
    // デイリーミッションの進み具合（バックアップにも含める）
    progress: normalizeProgress(raw.progress),
    meta: {
      createdAt: raw.meta?.createdAt || base.meta.createdAt,
      updatedAt: raw.meta?.updatedAt || new Date().toISOString(),
      appVersion: APP_VERSION,
      saveToken: raw.meta?.saveToken ?? null,
      // 最後にバックアップを保存した時刻（アプリバーの表示に使う）
      lastBackupAt: raw.meta?.lastBackupAt ?? null,
    },
  };
}
