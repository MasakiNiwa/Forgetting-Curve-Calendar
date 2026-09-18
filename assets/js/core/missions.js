/**
 * デイリーミッション（毎日ここへ戻ってくる理由）。
 *
 * 設計の原則:
 *   - 水増しさせない。要求はその日の予定の範囲に収め、上限を必ず設ける
 *   - 失敗しても罰がない。連続記録は「おまもり」で途切れにくくする
 *   - 3 つの枠（想起／記録／おまけ）に分け、その日にできるものだけを出す
 *   - 毎日同じ並びにならないよう、日付から決まる乱数で選ぶ（同じ日なら何度開いても同じ）
 *
 * このモジュールは純粋関数だけで構成する（DOM も保存も触らない）。
 */
import { addDays, diffDays } from './date.js';

/** 1 日に出すミッションの数（できるものが少ない日は、その数だけ出す） */
export const MISSION_COUNT = 4;
/** 全部そろえたときの追加ポイント */
export const COMPLETE_BONUS = 20;
/** おまもり（連続を 1 日ぶん守る）の上限 */
export const MAX_SHIELDS = 3;
/** おまもりがもらえる連続日数の区切り */
export const SHIELD_EVERY = 7;

/* ------------------------------------------------------------------ */
/* 日付から決まる乱数                                                   */
/* ------------------------------------------------------------------ */

function hash32(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rngFrom(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* ミッションの定義                                                     */
/* ------------------------------------------------------------------ */

/**
 * slot: recall（思い出す）/ write（書く）/ extra（おまけ）
 * available(ctx): 今日その人に出して意味があるか
 * target(ctx): 必要な数（初回に決めて、その日は動かさない）
 * progress(ctx): 今どこまで進んだか
 */
const DEFS = [
  {
    id: 'recall-some',
    slot: 'recall',
    icon: 'target',
    points: 20,
    available: (c) => c.plannedToday >= 2,
    target: (c) => Math.max(1, Math.min(5, Math.ceil(c.plannedToday / 2))),
    progress: (c) => c.ratedToday,
    title: (t) => `今日の復習を ${t} 件 思い出す`,
    desc: '思い出せなくても大丈夫。開いた時点で半分できています。',
  },
  {
    id: 'recall-all',
    slot: 'recall',
    icon: 'check',
    points: 25,
    available: (c) => c.plannedToday >= 1 && c.plannedToday <= 12,
    target: (c) => c.plannedToday,
    progress: (c) => c.ratedToday,
    title: (t) => `今日の復習 ${t} 件をやりきる`,
    desc: '今日のぶんを空にすると、明日が軽くなります。',
  },
  {
    id: 'recall-many',
    slot: 'recall',
    icon: 'flame',
    points: 30,
    // 数をこなす手応えのあるお題。今日の予定が十分にある日だけ出す
    available: (c) => c.plannedToday >= 10,
    target: (c) => Math.min(20, Math.max(10, Math.floor(c.plannedToday * 0.8))),
    progress: (c) => c.ratedToday,
    title: (t) => `今日の復習を ${t} 件 まとめて片づける`,
    desc: '調子のいい日に。まとめてやると、明日がぐっと軽くなります。',
  },
  {
    id: 'recall-known',
    slot: 'recall',
    icon: 'check',
    points: 25,
    available: (c) => c.plannedToday >= 5,
    target: () => 5,
    progress: (c) => c.knownToday,
    title: (t) => `「覚えていた」を ${t} 回 出す`,
    desc: '思い出せた回数を数えます。あいまいでも、忘れていても減りません。',
    unit: '回',
  },
  {
    id: 'reunion',
    slot: 'recall',
    icon: 'sparkle',
    points: 25,
    available: (c) => c.oldDueToday >= 1,
    target: () => 1,
    progress: (c) => c.oldRecallToday,
    title: () => '1ヶ月より前のメモに再会する',
    desc: '遠くから戻ってきたメモほど、思い出す価値があります。',
  },
  {
    id: 'write-one',
    slot: 'write',
    icon: 'edit',
    points: 15,
    available: () => true,
    target: () => 1,
    progress: (c) => c.createdToday,
    title: () => 'メモを 1 つ書く',
    desc: '短くて構いません。忘れてよくなるのが、ここに書く意味です。',
  },
  {
    id: 'write-chars',
    slot: 'write',
    icon: 'text',
    points: 20,
    available: (c) => c.totalNotes >= 3,
    target: () => 200,
    progress: (c) => c.charsToday,
    title: (t) => `今日 ${t} 文字 書く`,
    desc: '1 つのメモでも、何本かに分けても構いません。',
    unit: '文字',
  },
  {
    id: 'write-many',
    slot: 'write',
    icon: 'notes',
    points: 30,
    available: (c) => c.totalNotes >= 8,
    target: () => 3,
    progress: (c) => c.createdToday,
    title: (t) => `メモを ${t} つ書く`,
    desc: '思いついたことを、3 回に分けて置いていく日。',
  },
  {
    id: 'write-long',
    slot: 'write',
    icon: 'text',
    points: 30,
    available: (c) => c.totalNotes >= 10,
    target: () => 500,
    progress: (c) => c.charsToday,
    title: (t) => `今日 ${t} 文字 書く`,
    desc: 'まとめて考えたい日に。分けて書いても合計されます。',
    unit: '文字',
  },
  {
    id: 'revisit-edit',
    slot: 'grow',
    icon: 'note',
    points: 20,
    available: (c) => c.olderNotes >= 1,
    target: () => 1,
    progress: (c) => c.editedToday,
    title: () => '前に書いたメモに書き足す',
    desc: '読み返して増えた一行が、いちばん濃い記憶になります。',
  },
  {
    id: 'touch-notes',
    slot: 'grow',
    icon: 'layers',
    points: 25,
    available: (c) => c.totalNotes >= 6,
    target: () => 3,
    progress: (c) => c.touchedToday,
    title: (t) => `${t} つのメモに触れる`,
    desc: '書く・読み返す・思い出す。どれでも 1 件と数えます。',
  },
  {
    id: 'branch',
    slot: 'grow',
    icon: 'branch',
    points: 25,
    available: (c) => c.olderNotes >= 1,
    target: () => 1,
    progress: (c) => c.childCreatedToday,
    title: () => '追加メモ（気づき）を 1 つ生やす',
    desc: '追加メモにも、そこから新しい忘却曲線がつきます。',
  },
  {
    id: 'branch-two',
    slot: 'grow',
    icon: 'branch',
    points: 30,
    available: (c) => c.olderNotes >= 5,
    target: () => 2,
    progress: (c) => c.childCreatedToday,
    title: (t) => `追加メモを ${t} つ生やす`,
    desc: '読み返して出てきた気づきを、その場で足していく日。',
  },
  {
    id: 'inbox-start',
    slot: 'grow',
    icon: 'play',
    points: 20,
    available: (c) => c.inboxCount >= 1,
    target: () => 1,
    progress: (c) => c.restartedToday,
    title: () => '「あとで決める」のメモに復習を組む',
    desc: '寝かせていたメモを、忘却曲線に乗せてあげましょう。',
  },
  {
    id: 'peek-future',
    slot: 'extra',
    icon: 'calendar',
    points: 10,
    available: () => true,
    target: () => 1,
    progress: (c) => (c.flags.peeked ? 1 : 0),
    title: () => 'カレンダーで先の月をのぞく',
    desc: 'いつか自分に届く予定を見ておくと、今日の一行が変わります。',
  },
  {
    id: 'open-old',
    slot: 'extra',
    icon: 'search',
    points: 10,
    available: (c) => c.olderNotes >= 1,
    target: () => 1,
    progress: (c) => (c.flags.opened ? 1 : 0),
    title: () => '昔のメモを 1 つ開いてみる',
    desc: '予定になくても、ふと読み返す日があっていい。',
  },
  {
    id: 'backup',
    slot: 'extra',
    icon: 'download',
    points: 20,
    available: (c) => c.backupStale,
    target: () => 1,
    progress: (c) => (c.backupToday ? 1 : 0),
    title: () => 'バックアップを保存する',
    desc: 'メモはこの端末の中だけにあります。ときどき外へ。',
  },
];

const BY_ID = new Map(DEFS.map((d) => [d.id, d]));

export function getMissionDef(id) {
  return BY_ID.get(id) || null;
}

/** その日に出せるものだけを枠ごとに集める */
function candidates(slot, ctx, taken) {
  return DEFS.filter((d) => d.slot === slot && !taken.has(d.id) && d.available(ctx));
}

/**
 * その日のミッションを決める。
 * 同じ日・同じ状況なら何度呼んでも同じ組み合わせになる。
 */
export function pickMissions(dayKey, ctx) {
  const rand = rngFrom(hash32(`fcc-mission:${dayKey}`));
  const taken = new Set();
  const picked = [];

  ['recall', 'write', 'grow', 'extra'].forEach((slot) => {
    const pool = candidates(slot, ctx, taken);
    if (!pool.length) return;
    const def = pool[Math.floor(rand() * pool.length) % pool.length];
    taken.add(def.id);
    picked.push(def);
  });

  // 枠が埋まらない日（復習がまだ無い最初の数日など）は、残りから補う
  while (picked.length < MISSION_COUNT) {
    const rest = DEFS.filter((d) => !taken.has(d.id) && d.available(ctx));
    if (!rest.length) break;
    const def = rest[Math.floor(rand() * rest.length) % rest.length];
    taken.add(def.id);
    picked.push(def);
  }
  return picked;
}

/** 1 つのミッションの今の状態 */
export function evaluateMission(def, ctx, lockedTarget) {
  const target = Number.isFinite(lockedTarget) && lockedTarget > 0 ? lockedTarget : def.target(ctx);
  const progress = Math.max(0, def.progress(ctx));
  return {
    id: def.id,
    slot: def.slot,
    icon: def.icon,
    points: def.points,
    unit: def.unit || '件',
    title: def.title(target),
    desc: def.desc,
    target,
    progress: Math.min(progress, target),
    done: progress >= target,
  };
}

/* ------------------------------------------------------------------ */
/* レベルと称号                                                         */
/* ------------------------------------------------------------------ */

/** レベル n に必要な累計ポイント（25n(n+1)：はじめは軽く、だんだん重く） */
export function pointsForLevel(level) {
  return 25 * level * (level + 1);
}

export const RANKS = [
  { level: 0, name: '記録のはじまり' },
  { level: 1, name: '忘却の見習い' },
  { level: 3, name: '想起の旅人' },
  { level: 5, name: '記憶の庭師' },
  { level: 8, name: '曲線の読み手' },
  { level: 12, name: '記憶の建築家' },
  { level: 16, name: '忘却と友だち' },
  { level: 20, name: '長期記憶の達人' },
];

export function rankOf(level) {
  let rank = RANKS[0];
  RANKS.forEach((r) => { if (level >= r.level) rank = r; });
  return rank;
}

/** 累計ポイントから、レベル・称号・次のレベルまでの残りを出す */
export function levelInfo(points = 0) {
  const total = Math.max(0, Math.round(points));
  let level = 0;
  while (total >= pointsForLevel(level + 1) && level < 99) level += 1;
  const floor = pointsForLevel(level);
  const ceiling = pointsForLevel(level + 1);
  return {
    points: total,
    level,
    rank: rankOf(level).name,
    into: total - floor,
    span: ceiling - floor,
    toNext: ceiling - total,
    ratio: Math.min(1, (total - floor) / (ceiling - floor)),
  };
}

/* ------------------------------------------------------------------ */
/* 連続達成（おまもり付き）                                             */
/* ------------------------------------------------------------------ */

export function createStreak() {
  return { current: 0, best: 0, lastDay: null, shields: 0 };
}

/**
 * その日ぶんの達成を連続記録に反映する（純粋関数）。
 *
 * 空いた日は「おまもり」で埋められる。おまもりは 7 日続けるたびに 1 つ増える。
 * 罰を作らないための仕組みで、使ったことは本人に見せる。
 */
export function advanceStreak(streak, dayKey) {
  const base = { ...createStreak(), ...(streak || {}) };
  if (base.lastDay === dayKey) return { streak: base, changed: false, usedShields: 0, awardedShield: false };

  const gap = base.lastDay ? diffDays(base.lastDay, dayKey) : null;
  let usedShields = 0;
  let current;

  if (gap === 1 || base.lastDay === null) {
    current = base.current + 1;
  } else if (gap > 1) {
    const missed = gap - 1;
    if (missed <= base.shields) {
      usedShields = missed;
      current = base.current + 1;
    } else {
      current = 1;
    }
  } else {
    // 未来の記録が残っている（時計のずれなど）。数え直す。
    current = 1;
  }

  let shields = base.shields - usedShields;
  const awardedShield = current > 0 && current % SHIELD_EVERY === 0 && shields < MAX_SHIELDS;
  if (awardedShield) shields += 1;

  return {
    streak: {
      current,
      best: Math.max(base.best, current),
      lastDay: dayKey,
      shields: Math.max(0, Math.min(MAX_SHIELDS, shields)),
    },
    changed: true,
    usedShields,
    awardedShield,
  };
}

/** 連続が今日/昨日で途切れていないか（表示用） */
export function streakAlive(streak, today) {
  if (!streak?.lastDay) return false;
  const gap = diffDays(streak.lastDay, today);
  if (gap <= 1) return true;
  return gap - 1 <= (streak.shields || 0);
}

/** 記録を残す日数の上限（古い日は捨てる） */
export const KEEP_DAYS = 120;

export function pruneDays(days, today) {
  const limit = addDays(today, -KEEP_DAYS);
  const out = {};
  Object.entries(days || {}).forEach(([key, value]) => {
    if (key >= limit) out[key] = value;
  });
  return out;
}
