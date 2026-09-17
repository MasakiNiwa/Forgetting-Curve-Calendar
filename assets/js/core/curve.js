/**
 * 忘却曲線エンジン。
 *
 * このモジュールは純関数のみで構成する（DOM・ストレージに依存しない）。
 *
 * ## スケジュールの決め方（v0.2 でイベント方式へ変更）
 *
 * 復習予定は「保存された結果」ではなく、
 *   起点 (origin) + 出来事の並び (events) → 再生 (replay) → 現在の予定 (reviews)
 * として毎回導出する。想起結果の記録・取り消し・曲線の変更はすべて events の
 * 追加／削除として表現されるため、取り消しても過去の状態へ正確に戻れる。
 * 別のアルゴリズム（FSRS 等）を足す場合も、replay の中身を差し替えるだけで済む。
 */
import { addDays, diffDays, todayKey } from './date.js';

/** 忘却曲線プリセット（間隔は起点日からの日数） */
export const PRESETS = [
  {
    id: 'standard',
    name: '標準',
    description: '間隔反復の標準的な配分。数日 → 数週間 → 数ヶ月 → 数年と、少しずつ間隔を広げます。',
    intervals: [1, 3, 7, 14, 30, 60, 120, 240, 480, 960, 1920],
  },
  {
    id: 'intensive',
    name: '集中',
    description: '最初の 1 ヶ月を厚く復習してから、年単位へ移行します。試験前や覚え込みたいことに。',
    intervals: [1, 2, 4, 7, 12, 20, 32, 50, 90, 180, 365, 730, 1460],
  },
  {
    id: 'light',
    name: 'ゆるめ',
    description: '回数は少なめ。日々のメモを忘れた頃に見返したいときに。',
    intervals: [1, 7, 30, 90, 180, 365, 730, 1460, 2920],
  },
  {
    id: 'lifelong',
    name: '一生もの',
    description: '30 年先まで続く長い曲線。忘れた頃に、何度でも再会します。',
    intervals: [1, 3, 7, 21, 60, 180, 365, 730, 1460, 2920, 5840, 10950],
  },
  {
    id: 'none',
    name: 'あとで決める',
    description: '復習の予定を作らずに保存します。あとから「復習を始める」でいつでも設定できます。',
    intervals: [],
  },
  {
    id: 'custom',
    name: 'カスタム',
    description: '自分で間隔を決めます。年単位の間隔も設定できます。',
    intervals: [1, 3, 7, 14, 30, 60, 120, 365, 1095],
  },
];

export const DEFAULT_PRESET_ID = 'standard';

/** 間隔として許す最大日数（約 100 年） */
export const MAX_INTERVAL_DAYS = 36500;

/**
 * 復習日の分散。
 *
 * 同じ日に何件もメモを書くと、そのままでは未来の復習日まで丸ごと同じ日に重なる。
 * そこでメモごとに「シード」を持たせ、起点から離れるほど大きく前後へずらす。
 * ずらす量は間隔に比例するので、翌日の復習はほぼ動かず、数年先は数ヶ月単位で散る。
 */
export const SPREADS = [
  { id: 'none', label: '分散しない', ratio: 0, description: 'プリセットどおりの日付に置きます。' },
  { id: 'small', label: '控えめ', ratio: 0.06, description: '1年後で ±3週間ほど散らします。' },
  { id: 'normal', label: '標準', ratio: 0.12, description: '1年後で ±1ヶ月半ほど散らします。' },
  { id: 'large', label: '大きめ', ratio: 0.22, description: '1年後で ±2ヶ月半ほど散らします。' },
];

export const DEFAULT_SPREAD_ID = 'normal';
export const MAX_SEED = 9999;

export function getSpread(spreadId) {
  return SPREADS.find((s) => s.id === spreadId) || SPREADS[2];
}

/** 比率から一番近いプリセット ID を引く（保存値は比率で持つ） */
export function spreadIdOf(ratio) {
  const found = SPREADS.find((s) => Math.abs(s.ratio - Number(ratio)) < 0.001);
  return found ? found.id : DEFAULT_SPREAD_ID;
}

export function sanitizeSeed(seed) {
  const n = Math.round(Number(seed));
  if (!Number.isFinite(n)) return 0;
  return ((n % (MAX_SEED + 1)) + MAX_SEED + 1) % (MAX_SEED + 1);
}

export function randomSeed() {
  return Math.floor(Math.random() * (MAX_SEED + 1));
}

/** 文字列から安定したシードを作る（移行時に id から割り当てる用） */
export function seedFromString(text) {
  let h = 2166136261;
  for (let i = 0; i < String(text).length; i += 1) {
    h ^= String(text).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return sanitizeSeed(Math.abs(h));
}

/** シードとステップから -1〜1 の決定的な値を作る */
function jitterUnit(seed, step) {
  let x = (sanitizeSeed(seed) * 2654435761 + (step + 1) * 40503) >>> 0;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  return (x / 4294967295) * 2 - 1;
}

/**
 * 間隔にシード由来のゆらぎを与える。
 * - ずらす幅は「間隔 × ratio」なので、遠い先ほど大きく散る
 * - 1〜数日の間隔は四捨五入で 0 になり、実質動かない
 * - 並び順は必ず保つ（前の回より必ず 1 日以上あと）
 */
export function spreadIntervals(intervals, seed = 0, ratio = 0) {
  const list = sanitizeIntervals(intervals);
  if (!ratio) return list;
  const out = [];
  list.forEach((days, step) => {
    const offset = Math.round(days * ratio * jitterUnit(seed, step));
    let value = Math.max(1, days + offset);
    if (step > 0) value = Math.max(value, out[step - 1] + 1);
    out.push(Math.min(MAX_INTERVAL_DAYS, value));
  });
  return out;
}

/**
 * いま有効な「分散前」の間隔。
 * 途中で曲線を変えている場合は、最後の reschedule の値が基準になる。
 */
export function baseIntervalsOf(note) {
  for (let i = (note.events || []).length - 1; i >= 0; i -= 1) {
    const ev = note.events[i];
    if (ev.type === 'reschedule' && Array.isArray(ev.intervals)) return sanitizeIntervals(ev.intervals);
  }
  return sanitizeIntervals(note.origin?.intervals);
}

/** メモの実効間隔（プリセット + 分散） */
export function effectiveIntervals(origin) {
  return spreadIntervals(origin?.intervals, origin?.seed ?? 0, origin?.spread ?? 0);
}

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

/** 設定からプリセットの実効間隔を取り出す（custom は設定側の値を使う） */
export function resolveIntervals(presetId, settings = {}) {
  if (presetId === 'none') return [];
  if (presetId === 'custom') {
    return sanitizeIntervals(settings.customIntervals || getPreset('custom').intervals);
  }
  return [...getPreset(presetId).intervals];
}

/** 復習を設定していないメモか */
export function isInbox(note) {
  return !note.reviews.length && !note.events.some((e) => e.type === 'rate' || e.type === 'skip');
}

/** 正の整数・昇順・重複なしに整える */
export function sanitizeIntervals(list) {
  const cleaned = (Array.isArray(list) ? list : [])
    .map((n) => Math.round(Number(n)))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= MAX_INTERVAL_DAYS);
  const unique = [...new Set(cleaned)].sort((a, b) => a - b);
  return unique.length ? unique : [1, 3, 7];
}

export function clampEase(ease) {
  if (!Number.isFinite(ease)) return EASE_DEFAULT;
  return Math.min(EASE_MAX, Math.max(EASE_MIN, Math.round(ease * 100) / 100));
}

/**
 * 起点日と間隔から復習予定を生成する。
 * id は replay 内の生成順で決まる安定キー（g0, g1, …）。
 */
export function buildSchedule(anchorDate, intervals, makeKey) {
  return intervals.map((days, step) => ({
    id: makeKey(),
    step,
    due: addDays(anchorDate, days),
    status: 'pending',
    rating: null,
    completedAt: null,
    extra: false,
  }));
}

/* ------------------------------------------------------------------ */
/* イベント                                                            */
/* ------------------------------------------------------------------ */

export const EVENT_TYPES = ['rate', 'skip', 'postpone', 'restart', 'reschedule'];

/**
 * 出来事を作る。`day` はローカル日付（スケジュール計算の基準）、
 * `at` は記録時刻（表示・並び替え用）。
 */
export function createEvent(type, payload = {}, at = new Date()) {
  const iso = at instanceof Date ? at.toISOString() : String(at);
  const day = payload.day || localDayOf(iso);
  return { type, at: iso, day, ...payload };
}

export function localDayOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return todayKey();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * 起点とイベント列から、現在の復習予定を再生する。
 *
 * @param {{anchorDate:string, origin:{presetId:string, intervals:number[]}, events:Array}} note
 * @param {{adaptive?:boolean}} options
 * @returns {{reviews:Array, ease:number, intervals:number[], presetId:string, status:string}}
 */
export function replay(note, { adaptive = true } = {}) {
  let counter = 0;
  const makeKey = () => `g${counter++}`;

  let seed = sanitizeSeed(note.origin?.seed);
  let spread = Number(note.origin?.spread) || 0;
  // 間隔が空 = 「あとで決める」。復習予定を作らない
  let intervals = (note.origin?.intervals || []).length
    ? spreadIntervals(note.origin.intervals, seed, spread)
    : [];
  let presetId = note.origin?.presetId || DEFAULT_PRESET_ID;
  let ease = EASE_DEFAULT;
  let reviews = intervals.length ? buildSchedule(note.anchorDate, intervals, makeKey) : [];

  // 出来事は記録された順（因果の順）にそのまま再生する
  const events = (note.events || []).filter((e) => e && EVENT_TYPES.includes(e.type));

  const resolve = (ev) => {
    const byKey = reviews.find((r) => r.id === ev.reviewKey);
    if (byKey) return byKey;
    // 旧データ（キーを持たないイベント）は同じステップの未完了分に当てる
    return reviews.find((r) => r.status === 'pending' && r.step === ev.step) || null;
  };

  events.forEach((ev) => {
    switch (ev.type) {
      case 'rate': {
        const target = resolve(ev);
        if (!target || target.status !== 'pending') break;
        const ratingDef = RATINGS[ev.rating] || RATINGS.known;
        target.status = 'done';
        target.rating = ratingDef.id;
        target.completedAt = ev.at;
        if (!adaptive) break;

        ease = clampEase(ease + ratingDef.easeDelta);
        const factor = ease / EASE_DEFAULT;
        const step = Math.min(target.step, intervals.length - 1);

        if (ratingDef.behavior === 'restart') {
          reviews = reviews.filter((r) => r.status !== 'pending');
          buildSchedule(ev.day, intervals, makeKey).forEach((r) => reviews.push(r));
          break;
        }

        reviews.filter((r) => r.status === 'pending').forEach((r) => {
          const base = intervals[Math.min(r.step, intervals.length - 1)] - intervals[step];
          r.due = addDays(ev.day, Math.max(1, Math.round(base * factor)));
        });

        if (ratingDef.behavior === 'repeat') {
          const gap = Math.max(1, Math.round(intervals[step] * 0.5 * factor));
          reviews.push({
            id: makeKey(),
            step,
            due: addDays(ev.day, gap),
            status: 'pending',
            rating: null,
            completedAt: null,
            extra: true,
          });
        }
        break;
      }

      case 'skip': {
        const target = resolve(ev);
        if (!target || target.status !== 'pending') break;
        target.status = 'skipped';
        target.completedAt = ev.at;
        break;
      }

      case 'postpone': {
        const target = resolve(ev);
        if (!target || target.status !== 'pending' || !ev.due) break;
        target.due = ev.due;
        break;
      }

      case 'restart': {
        reviews = reviews.filter((r) => r.status !== 'pending');
        ease = EASE_DEFAULT;
        if (ev.intervals?.length) intervals = spreadIntervals(ev.intervals, seed, spread);
        if (ev.presetId) presetId = ev.presetId;
        buildSchedule(ev.day, intervals, makeKey).forEach((r) => reviews.push(r));
        break;
      }

      case 'reschedule': {
        if (ev.seed !== undefined) seed = sanitizeSeed(ev.seed);
        if (ev.spread !== undefined) spread = Number(ev.spread) || 0;
        intervals = (ev.intervals || []).length ? spreadIntervals(ev.intervals, seed, spread) : [];
        presetId = ev.presetId || presetId;
        const doneSteps = reviews.filter((r) => r.status !== 'pending').map((r) => r.step);
        const maxDone = doneSteps.length ? Math.max(...doneSteps) : -1;
        reviews = reviews.filter((r) => r.status !== 'pending');
        buildSchedule(note.anchorDate, intervals, makeKey)
          .filter((r) => r.step > maxDone)
          .forEach((r) => reviews.push(r));
        break;
      }

      default:
        break;
    }
  });

  reviews.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.step - b.step));
  const status = reviews.some((r) => r.status === 'pending')
    ? 'active'
    : (reviews.length ? 'graduated' : 'inbox');
  return { reviews, ease, intervals, presetId, status, seed, spread };
}

/**
 * replay の結果をメモへ書き戻す（reviews / schedule は導出値のキャッシュ）。
 * アーカイブ状態は再生で上書きしない。
 */
export function refreshNote(note, options = {}) {
  const result = replay(note, options);
  note.reviews = result.reviews;
  note.schedule = {
    presetId: result.presetId,
    intervals: result.intervals,   // 分散を反映した実際の間隔
    ease: result.ease,
    seed: result.seed,
    spread: result.spread,
    adaptive: options.adaptive !== false,
  };
  if (note.status !== 'archived') note.status = result.status;
  return note;
}

/* ------------------------------------------------------------------ */
/* 参照系                                                              */
/* ------------------------------------------------------------------ */

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

/** overdue 判定 */
export function isOverdue(review, base = todayKey()) {
  return review.status === 'pending' && diffDays(base, review.due) < 0;
}

/**
 * 忘却曲線（保持率）のイメージを表す折れ線。プレビュー描画専用。
 *
 * R = e^(-t / S) の指数的減衰を、復習のたびに保持力 S が伸びる形で描く。
 * 記憶を厳密に予測するものではなく、間隔の広がり方を見せるための図。
 */
export function retentionSeries(intervals, ease = EASE_DEFAULT, samples = 320) {
  const list = sanitizeIntervals(intervals);
  const horizon = list[list.length - 1] * 1.3;
  const stepSize = horizon / samples;
  const decayTarget = 0.7; // 次の復習までにおよそ半分まで落ちる
  const strengthFor = (idx) => {
    const from = idx === 0 ? 0 : list[idx - 1];
    const last = list[list.length - 1];
    const to = list[idx] ?? (last + (last - (list[list.length - 2] ?? 0)));
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
