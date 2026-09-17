/**
 * 日付ユーティリティ。
 * アプリ内の日付はすべてローカルタイムの 'YYYY-MM-DD' 文字列（dateKey）で扱う。
 * タイムゾーンずれを避けるため Date オブジェクトは境界でのみ使う。
 */

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** Date -> 'YYYY-MM-DD' */
export function toKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 'YYYY-MM-DD' -> Date（ローカル 0 時） */
export function fromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function todayKey() {
  return toKey(new Date());
}

export function addDays(key, days) {
  const d = fromKey(key);
  d.setDate(d.getDate() + days);
  return toKey(d);
}

/** b - a を日数で返す */
export function diffDays(a, b) {
  const MS = 86400000;
  return Math.round((fromKey(b).getTime() - fromKey(a).getTime()) / MS);
}

export function isValidKey(key) {
  return typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key) && !Number.isNaN(fromKey(key).getTime());
}

export function weekdayIndex(key) {
  return fromKey(key).getDay();
}

export function weekdayJa(key) {
  return WEEKDAY_JA[weekdayIndex(key)];
}

/** 表示用: '9月17日(水)' */
export function formatMedium(key) {
  const d = fromKey(key);
  return `${d.getMonth() + 1}月${d.getDate()}日(${WEEKDAY_JA[d.getDay()]})`;
}

/** 表示用: 今年なら '9月17日(水)'、年をまたぐなら '2027年1月6日(水)' */
export function formatSmart(key) {
  const d = fromKey(key);
  const thisYear = new Date().getFullYear();
  return d.getFullYear() === thisYear ? formatMedium(key) : formatLong(key);
}

/** 表示用: '2026年9月17日(水)' */
export function formatLong(key) {
  const d = fromKey(key);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${WEEKDAY_JA[d.getDay()]})`;
}

export function formatMonth(year, month /* 0-based */) {
  return `${year}年${month + 1}月`;
}

/** 'あと3日' / '3日前' / '今日' のような相対表現 */
export function formatRelative(key, base = todayKey()) {
  const d = diffDays(base, key);
  if (d === 0) return '今日';
  if (d === 1) return '明日';
  if (d === 2) return 'あさって';
  if (d === -1) return '昨日';
  if (d > 0) return `${d}日後`;
  return `${-d}日前`;
}

export function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${formatLong(toKey(d))} ${hh}:${mm}`;
}

/**
 * 月カレンダー用のセル配列（前後の月を含む 6 週 = 42 セル）を返す。
 * @param {number} year
 * @param {number} month 0-based
 * @param {number} weekStart 0=日曜, 1=月曜
 */
export function monthMatrix(year, month, weekStart = 0) {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() - weekStart + 7) % 7;
  const start = new Date(year, month, 1 - offset);
  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({ key: toKey(d), day: d.getDate(), weekday: d.getDay(), inMonth: d.getMonth() === month });
  }
  return cells;
}

export function weekdayLabels(weekStart = 0) {
  return Array.from({ length: 7 }, (_, i) => {
    const idx = (i + weekStart) % 7;
    return { label: WEEKDAY_JA[idx], index: idx };
  });
}
