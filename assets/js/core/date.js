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

/* ------------------------------------------------------------------ */
/* 日付の足し算・引き算（Date を作らずに数える）                        */
/*                                                                      */
/* メモが増えると、予定を組み直すたびに何十万回も日付を足すことになる。 */
/* そのたびに Date を作ると、それだけで時間を食う。                     */
/* ここでは「暦の日付 ↔ 通し日数」を数え上げで変換する（結果は同じ）。   */
/* 時刻を持たない暦の計算なので、夏時間やタイムゾーンの影響も受けない。 */
/* ------------------------------------------------------------------ */

/** 'YYYY-MM-DD' -> 1970-01-01 からの通し日数 */
function keyToDays(key) {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  const d = Number(key.slice(8, 10));
  // 3 月始まりにすると、うるう日が年の最後に来て数えやすくなる
  const year = m <= 2 ? y - 1 : y;
  const era = Math.floor((year >= 0 ? year : year - 399) / 400);
  const yoe = year - era * 400;                                  // 0..399
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** 通し日数 -> 'YYYY-MM-DD' */
function daysToKey(z) {
  const days = z + 719468;
  const era = Math.floor((days >= 0 ? days : days - 146096) / 146097);
  const doe = days - era * 146097;                               // 0..146096
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524)
    - Math.floor(doe / 146096)) / 365);                          // 0..399
  const year = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);                    // 0..11（3 月始まり）
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const y = year + (m <= 2 ? 1 : 0);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function addDays(key, days) {
  return daysToKey(keyToDays(key) + Math.round(days));
}

/** b - a を日数で返す */
export function diffDays(a, b) {
  return keyToDays(b) - keyToDays(a);
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

/**
 * 日数を人が読める長さに直す。'3日' / '2週間' / '6ヶ月' / '5年'
 * 年単位まで伸びる忘却曲線を扱うため、遠い間隔ほど粗い単位で表す。
 */
export function formatDuration(days) {
  const d = Math.round(days);
  if (d < 7) return `${d}日`;
  if (d < 30) return `${Math.round(d / 7)}週間`;
  if (d < 365) return `${Math.round(d / 30)}ヶ月`;
  const years = d / 365;
  return years % 1 < 0.1 || years >= 10 ? `${Math.round(years)}年` : `${years.toFixed(1)}年`;
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
