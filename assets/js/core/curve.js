/**
 * 忘却曲線エンジン。
 *
 * このモジュールは純関数のみで構成する（DOM・ストレージに依存しない）。
 * 将来 SM-2 / FSRS などのアルゴリズムを追加する場合は
 *   - プリセットを PRESETS に足す
 *   - rescheduleAfterReview を差し替え可能なストラテジとして export する
 * の 2 点で拡張できる。
 */
import { addDays, diffDays, todayKey } from './date.js';

/** 忘却曲線プリセット（間隔は起点日からの日数） */
export const PRESETS = [
  {
    id: 'standard',
    name: '標準',
    description: 'エビングハウスの忘却曲線に沿った王道の間隔。まず迷ったらこれ。',
    intervals: [1, 3, 7, 14, 30, 60, 120],
  },
  {
    id: 'intensive',
    name: '集中',
    description: '短期間に厚く復習する。試験前や覚え込みたいことに。',
    intervals: [1, 2, 4, 7, 12, 20, 32, 50],
  },
  {
    id: 'light',
    name: 'ゆるめ',
    description: '回数は少なめ。日々のメモを忘れた頃に見返したいときに。',
    intervals: [1, 7, 30, 90, 180],
  },
  {
    id: 'longterm',
    name: '長期定着',
    description: '1 年かけてゆっくり定着させる。知識を長く保ちたいときに。',
    intervals: [1, 3, 7, 21, 60, 180, 365],
  },
  {
    id: 'custom',
    name: 'カスタム',
    description: '自分で間隔を決める。',
    intervals: [1, 3, 7, 14, 30, 60],
  },
];

export const DEFAULT_PRESET_ID = 'standard';

/** 想起結果の定義 */
export const RATINGS = {
  known: { id: 'known', label: '覚えていた', short: '○', easeDelta: 0.1, behavior: 'advance' },
  vague: { id: 'vague', label: 'あいまい', short: '△', easeDelta: -0.1, behavior: 'repeat' },
  forgot: { id: 'forgot', label: '忘れた', short: '×', easeDelta: -0.25, behavior: 'restart' },
};

export const EASE_DEFAULT = 2.5;
export const EASE_MIN = 1.3;
export const EASE_MAX = 3.0;

export function getPreset(presetId) {
  return PRESETS.find((p) => p.id === presetId) || PRESETS[0];
}

/**
 * 設定からプリセットの実効間隔を取り出す。
 * custom の場合は設定側の値を使う。
 */
export function resolveIntervals(presetId, settings = {}) {
  if (presetId === 'custom') {
    return sanitizeIntervals(settings.customIntervals || getPreset('custom').intervals);
  }
  return [...getPreset(presetId).intervals];
}

/** 正の整数・昇順・重複なしに整える */
export function sanitizeIntervals(list) {
  const cleaned = (Array.isArray(list) ? list : [])
    .map((n) => Math.round(Number(n)))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 3650);
  const unique = [...new Set(cleaned)].sort((a, b) => a - b);
  return unique.length ? unique : [1, 3, 7];
}

export function clampEase(ease) {
  if (!Number.isFinite(ease)) return EASE_DEFAULT;
  return Math.min(EASE_MAX, Math.max(EASE_MIN, Math.round(ease * 100) / 100));
}

/**
 * 起点日と間隔から復習予定を生成する。
 * @returns {Array<{step:number, due:string, status:string, rating:null, extra:boolean}>}
 */
export function buildSchedule(anchorDate, intervals, makeId) {
  return intervals.map((days, step) => ({
    id: makeId(),
    step,
    due: addDays(anchorDate, days),
    status: 'pending',
    rating: null,
    completedAt: null,
    extra: false,
  }));
}

/**
 * 復習の想起結果を反映し、未完了の復習を再スケジュールする。
 * note は破壊的に更新する（呼び出し側で clone 済みの前提）。
 *
 * @param {object} note
 * @param {string} reviewId
 * @param {'known'|'vague'|'forgot'} rating
 * @param {{adaptive:boolean}} options
 * @param {() => string} makeId
 * @returns {object} 更新後の note
 */
export function applyReviewResult(note, reviewId, rating, options, makeId) {
  const review = note.reviews.find((r) => r.id === reviewId);
  if (!review) return note;

  const now = new Date().toISOString();
  const completedKey = todayKey();
  const ratingDef = RATINGS[rating] || RATINGS.known;

  review.status = 'done';
  review.rating = ratingDef.id;
  review.completedAt = now;

  const adaptive = options?.adaptive !== false && note.schedule.adaptive !== false;
  if (adaptive) {
    note.schedule.ease = clampEase((note.schedule.ease ?? EASE_DEFAULT) + ratingDef.easeDelta);
  }

  const intervals = sanitizeIntervals(note.schedule.intervals);
  const factor = adaptive ? (note.schedule.ease ?? EASE_DEFAULT) / EASE_DEFAULT : 1;
  const step = Math.min(review.step, intervals.length - 1);
  const pending = note.reviews.filter((r) => r.status === 'pending');

  // adaptive が無効なときは、作成時に決めた予定をそのまま保つ
  if (adaptive && ratingDef.behavior === 'restart') {
    // 完了日を新たな起点にして最初から組み直す
    note.reviews = note.reviews.filter((r) => r.status !== 'pending');
    buildSchedule(completedKey, intervals, makeId).forEach((r) => note.reviews.push(r));
  } else if (adaptive) {
    // 残りのステップを完了日基準でずらす
    pending.forEach((r) => {
      const base = intervals[Math.min(r.step, intervals.length - 1)] - intervals[step];
      const shifted = Math.max(1, Math.round(base * factor));
      r.due = addDays(completedKey, shifted);
    });

    if (ratingDef.behavior === 'repeat') {
      // 同じステップをもう一度、短い間隔で挟む
      const gap = Math.max(1, Math.round((intervals[step] * 0.5) * factor));
      note.reviews.push({
        id: makeId(),
        step,
        due: addDays(completedKey, gap),
        status: 'pending',
        rating: null,
        completedAt: null,
        extra: true,
      });
    }
  }

  sortReviews(note);
  note.status = note.reviews.some((r) => r.status === 'pending') ? 'active' : 'graduated';
  note.updatedAt = now;
  return note;
}

/** 復習をスキップする（曲線は変更しない） */
export function skipReview(note, reviewId) {
  const review = note.reviews.find((r) => r.id === reviewId);
  if (!review) return note;
  review.status = 'skipped';
  review.completedAt = new Date().toISOString();
  note.status = note.reviews.some((r) => r.status === 'pending') ? 'active' : 'graduated';
  note.updatedAt = new Date().toISOString();
  return note;
}

/** 完了/スキップを取り消して pending に戻す */
export function undoReview(note, reviewId) {
  const review = note.reviews.find((r) => r.id === reviewId);
  if (!review) return note;
  review.status = 'pending';
  review.rating = null;
  review.completedAt = null;
  note.status = 'active';
  note.updatedAt = new Date().toISOString();
  return note;
}

/** 復習を今日から n 日後へ延期する */
export function postponeReview(note, reviewId, days = 1) {
  const review = note.reviews.find((r) => r.id === reviewId);
  if (!review) return note;
  review.due = addDays(todayKey(), Math.max(1, days));
  sortReviews(note);
  note.updatedAt = new Date().toISOString();
  return note;
}

/** 定着済みのメモの曲線を、今日を起点に組み直す */
export function restartSchedule(note, intervals, makeId) {
  const list = sanitizeIntervals(intervals || note.schedule.intervals);
  note.schedule.intervals = list;
  note.schedule.ease = EASE_DEFAULT;
  note.reviews = note.reviews.filter((r) => r.status !== 'pending');
  buildSchedule(todayKey(), list, makeId).forEach((r) => note.reviews.push(r));
  sortReviews(note);
  note.status = 'active';
  note.updatedAt = new Date().toISOString();
  return note;
}

/**
 * メモの間隔設定を変更し、未完了の復習を作り直す。
 * 完了済みの履歴は保持する。
 */
export function rewriteSchedule(note, presetId, intervals, makeId) {
  const list = sanitizeIntervals(intervals);
  note.schedule.presetId = presetId;
  note.schedule.intervals = list;
  const doneSteps = note.reviews.filter((r) => r.status !== 'pending').map((r) => r.step);
  const maxDone = doneSteps.length ? Math.max(...doneSteps) : -1;
  note.reviews = note.reviews.filter((r) => r.status !== 'pending');
  buildSchedule(note.anchorDate, list, makeId)
    .filter((r) => r.step > maxDone)
    .forEach((r) => note.reviews.push(r));
  sortReviews(note);
  note.status = note.reviews.some((r) => r.status === 'pending') ? 'active' : 'graduated';
  note.updatedAt = new Date().toISOString();
  return note;
}

export function sortReviews(note) {
  note.reviews.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.step - b.step));
  return note;
}

/** 次に控えている復習 */
export function nextReview(note) {
  return note.reviews.find((r) => r.status === 'pending') || null;
}

/** 進捗率 0..1 */
export function progressOf(note) {
  const total = note.reviews.length || 1;
  const done = note.reviews.filter((r) => r.status !== 'pending').length;
  return done / total;
}

/**
 * 忘却曲線（保持率）のイメージを表す折れ線。プレビュー描画専用。
 *
 * R = e^(-t / S) の指数的減衰を、復習のたびに保持力 S が伸びる形で描く。
 * 実際のスケジューリングには使わない（あくまで説明用のグラフ）。
 */
export function retentionSeries(intervals, ease = EASE_DEFAULT, samples = 240) {
  const list = sanitizeIntervals(intervals);
  const horizon = list[list.length - 1] * 1.3;
  const stepSize = horizon / samples;
  // 次の復習までにおよそ半分まで落ちるように保持力を決める
  const decayTarget = 0.7;
  const strengthFor = (idx) => {
    const from = idx === 0 ? 0 : list[idx - 1];
    const to = list[idx] ?? (list[list.length - 1] + (list[list.length - 1] - (list[list.length - 2] ?? 0)));
    return Math.max(0.4, (to - from) / decayTarget) * (ease / EASE_DEFAULT);
  };

  const points = [];
  let last = 0;
  let idx = 0;
  let strength = strengthFor(0);

  for (let t = 0; t <= horizon + stepSize / 2; t += stepSize) {
    while (idx < list.length && t >= list[idx]) {
      const at = list[idx];
      points.push({ t: at, r: Math.exp(-(at - last) / strength), review: false });
      points.push({ t: at, r: 1, review: true });
      last = at;
      idx += 1;
      strength = strengthFor(idx);
    }
    points.push({ t, r: Math.exp(-(t - last) / strength), review: false });
  }
  return points;
}

/** overdue 判定 */
export function isOverdue(review, base = todayKey()) {
  return review.status === 'pending' && diffDays(base, review.due) < 0;
}
