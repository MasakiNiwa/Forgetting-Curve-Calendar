/**
 * エクスポート / バックアップ。
 * 形式を増やすときは FORMATS に定義を足すだけで UI 側は自動で追従する。
 */
import { APP_NAME, APP_VERSION } from './config.js';
import { formatLong, todayKey } from './date.js';
import { displayTitle } from './models.js';
import { RATINGS } from './curve.js';

export const FORMATS = [
  { id: 'markdown', label: 'Markdown', ext: 'md', mime: 'text/markdown' },
  { id: 'text', label: 'テキスト', ext: 'txt', mime: 'text/plain' },
  { id: 'csv', label: 'CSV', ext: 'csv', mime: 'text/csv' },
  { id: 'json', label: 'JSON', ext: 'json', mime: 'application/json' },
];

export function getFormat(id) {
  return FORMATS.find((f) => f.id === id) || FORMATS[0];
}

const ratingLabel = (r) => (r ? RATINGS[r]?.label ?? r : '');

function reviewSummary(note) {
  return note.reviews.map((r) => {
    const mark = r.status === 'done' ? (RATINGS[r.rating]?.short ?? '✓')
      : r.status === 'skipped' ? '—' : '·';
    return `${r.due} ${mark}`;
  }).join(' / ');
}

/* ------------------------------------------------------------------ */

export function toMarkdown(notes, { store } = {}) {
  const lines = [
    `# ${APP_NAME} エクスポート`,
    '',
    `- 出力日: ${formatLong(todayKey())}`,
    `- 件数: ${notes.length}`,
    '',
  ];

  notes.forEach((note) => {
    lines.push(`## ${displayTitle(note)}`);
    lines.push('');
    if (note.cue) {
      lines.push(`**手掛かり:** ${note.cue}`);
      lines.push('');
    }
    const meta = [`作成: ${note.anchorDate}`];
    if (note.tags.length) meta.push(`タグ: ${note.tags.map((t) => `#${t}`).join(' ')}`);
    if (note.parentId && store) {
      const parent = store.getNote(note.parentId);
      if (parent) meta.push(`追加メモ元: ${displayTitle(parent)}`);
    }
    meta.push(`状態: ${note.status === 'graduated' ? '定着' : note.status === 'archived' ? 'アーカイブ' : '復習中'}`);
    lines.push(`> ${meta.join(' ｜ ')}`);
    lines.push('');
    if (note.body) {
      lines.push(note.body);
      lines.push('');
    }
    lines.push(`<!-- 復習: ${reviewSummary(note)} -->`);
    lines.push('');
  });

  return lines.join('\n');
}

export function toText(notes) {
  const out = [`${APP_NAME} エクスポート  (${formatLong(todayKey())})`, '='.repeat(40), ''];
  notes.forEach((note) => {
    out.push(`■ ${displayTitle(note)}`);
    out.push(`  作成 ${note.anchorDate}${note.tags.length ? `  タグ ${note.tags.join(', ')}` : ''}`);
    if (note.cue) out.push(`  手掛かり: ${note.cue}`);
    if (note.body) {
      out.push('');
      note.body.split('\n').forEach((l) => out.push(`  ${l}`));
    }
    out.push('');
    out.push(`  復習: ${reviewSummary(note)}`);
    out.push('');
    out.push('-'.repeat(40));
    out.push('');
  });
  return out.join('\n');
}

export function toCsv(notes) {
  const header = [
    'id', 'parentId', 'title', 'cue', 'body', 'tags', 'anchorDate', 'createdAt', 'status',
    'preset', 'intervals', 'ease', 'reviewsDone', 'reviewsTotal', 'nextDue', 'lastRating',
  ];
  const rows = notes.map((note) => {
    const done = note.reviews.filter((r) => r.status !== 'pending');
    const next = note.reviews.find((r) => r.status === 'pending');
    const last = [...done].reverse().find((r) => r.rating);
    return [
      note.id,
      note.parentId || '',
      displayTitle(note),
      note.cue || '',
      note.body,
      note.tags.join(' '),
      note.anchorDate,
      note.createdAt,
      note.status,
      note.schedule.presetId,
      note.schedule.intervals.join(' '),
      note.schedule.ease,
      done.length,
      note.reviews.length,
      next ? next.due : '',
      ratingLabel(last?.rating),
    ];
  });
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toJson(notes) {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    kind: 'notes',
    notes,
  }, null, 2);
}

export function serializeNotes(notes, formatId, context = {}) {
  switch (formatId) {
    case 'text': return toText(notes);
    case 'csv': return toCsv(notes);
    case 'json': return toJson(notes);
    case 'markdown':
    default: return toMarkdown(notes, context);
  }
}

/** 完全バックアップ（設定・履歴を含む） */
export function serializeBackup(data) {
  return JSON.stringify({
    ...data,
    meta: { ...data.meta, exportedAt: new Date().toISOString(), appVersion: APP_VERSION },
  }, null, 2);
}

/* ------------------------------------------------------------------ */

export function buildFilename(base, ext) {
  const stamp = todayKey();
  return `${base}-${stamp}.${ext}`;
}

export function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fallthrough */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
