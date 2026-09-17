/**
 * ドメインモデルの生成と正規化。
 * 外部から読み込んだデータ（バックアップ復元など）は必ず normalize を通す。
 */
import { SCHEMA_VERSION, APP_VERSION } from './config.js';
import { isValidKey, todayKey } from './date.js';
import {
  DEFAULT_PRESET_ID, EASE_DEFAULT, buildSchedule, clampEase, resolveIntervals,
  sanitizeIntervals, sortReviews,
} from './curve.js';

export function makeId(prefix = 'n') {
  const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
    : Math.random().toString(36).slice(2, 12);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export const makeNoteId = () => makeId('n');
export const makeReviewId = () => makeId('r');

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system',            // system | light | dark
  presetId: DEFAULT_PRESET_ID,
  customIntervals: [1, 3, 7, 14, 30, 60],
  adaptive: true,
  weekStart: 0,               // 0=日曜, 1=月曜
  carryOverOverdue: true,
  showCreatedOnCalendar: true,
  defaultExportFormat: 'markdown',
});

export function createEmptyData() {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    notes: [],
    settings: { ...DEFAULT_SETTINGS },
    meta: { createdAt: now, updatedAt: now, appVersion: APP_VERSION },
  };
}

/**
 * 新しいメモを作る。作成と同時に忘却曲線の復習予定を生成する。
 * @param {object} input {title, body, tags, anchorDate, parentId, presetId}
 * @param {object} settings
 */
export function createNote(input, settings) {
  const now = new Date().toISOString();
  const anchorDate = isValidKey(input.anchorDate) ? input.anchorDate : todayKey();
  const presetId = input.presetId || settings.presetId || DEFAULT_PRESET_ID;
  const intervals = presetId === 'custom'
    ? sanitizeIntervals(input.intervals || settings.customIntervals)
    : resolveIntervals(presetId, settings);

  return {
    id: makeNoteId(),
    parentId: input.parentId || null,
    title: (input.title || '').trim(),
    body: (input.body || '').trim(),
    tags: normalizeTags(input.tags),
    anchorDate,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    color: input.color || null,
    schedule: {
      presetId,
      intervals,
      ease: EASE_DEFAULT,
      adaptive: settings.adaptive !== false,
    },
    reviews: buildSchedule(anchorDate, intervals, makeReviewId),
  };
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

/** メモの表示用タイトル（未設定なら本文の 1 行目） */
export function displayTitle(note) {
  if (note.title) return note.title;
  const firstLine = (note.body || '').split('\n').find((l) => l.trim());
  if (!firstLine) return '(無題のメモ)';
  return firstLine.trim().slice(0, 44);
}

/**
 * カード表示用の本文。
 * タイトル未設定のメモは本文 1 行目がタイトルになるため、その分を取り除いて返す。
 */
export function bodyPreview(note) {
  if (note.title) return note.body || '';
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
  s.showCreatedOnCalendar = s.showCreatedOnCalendar !== false;
  s.customIntervals = sanitizeIntervals(s.customIntervals);
  if (!['markdown', 'text', 'csv', 'json'].includes(s.defaultExportFormat)) {
    s.defaultExportFormat = 'markdown';
  }
  return s;
}

export function normalizeNote(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const now = new Date().toISOString();
  const anchorDate = isValidKey(raw.anchorDate) ? raw.anchorDate : todayKey();
  const intervals = sanitizeIntervals(raw.schedule?.intervals);

  const note = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : makeNoteId(),
    parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    tags: normalizeTags(raw.tags),
    anchorDate,
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || raw.createdAt || now,
    status: ['active', 'graduated', 'archived'].includes(raw.status) ? raw.status : 'active',
    color: raw.color || null,
    schedule: {
      presetId: raw.schedule?.presetId || DEFAULT_PRESET_ID,
      intervals,
      ease: clampEase(raw.schedule?.ease),
      adaptive: raw.schedule?.adaptive !== false,
    },
    reviews: Array.isArray(raw.reviews)
      ? raw.reviews.map(normalizeReview).filter(Boolean)
      : buildSchedule(anchorDate, intervals, makeReviewId),
  };

  if (!note.reviews.length && note.status === 'active') {
    note.reviews = buildSchedule(anchorDate, intervals, makeReviewId);
  }
  if (note.status !== 'archived') {
    note.status = note.reviews.some((r) => r.status === 'pending') ? 'active' : 'graduated';
  }
  return sortReviews(note);
}

function normalizeReview(raw) {
  if (!raw || typeof raw !== 'object' || !isValidKey(raw.due)) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : makeReviewId(),
    step: Number.isFinite(raw.step) ? Math.max(0, Math.round(raw.step)) : 0,
    due: raw.due,
    status: ['pending', 'done', 'skipped'].includes(raw.status) ? raw.status : 'pending',
    rating: ['known', 'vague', 'forgot'].includes(raw.rating) ? raw.rating : null,
    completedAt: raw.completedAt || null,
    extra: raw.extra === true,
  };
}

/** 任意の入力データをアプリが扱える形へ整える */
export function normalizeData(raw) {
  const base = createEmptyData();
  if (!raw || typeof raw !== 'object') return base;
  const notes = Array.isArray(raw.notes) ? raw.notes.map(normalizeNote).filter(Boolean) : [];
  // 親が存在しない子メモは孤児にならないよう parentId を落とす
  const ids = new Set(notes.map((n) => n.id));
  notes.forEach((n) => { if (n.parentId && !ids.has(n.parentId)) n.parentId = null; });

  return {
    schemaVersion: SCHEMA_VERSION,
    notes,
    settings: normalizeSettings(raw.settings),
    meta: {
      createdAt: raw.meta?.createdAt || base.meta.createdAt,
      updatedAt: new Date().toISOString(),
      appVersion: APP_VERSION,
    },
  };
}
