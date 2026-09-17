/**
 * 書きかけメモの保管。
 *
 * エディタを閉じても入力が消えないよう、入力のたびに下書きを保存する。
 * 本体データ（メモ）とは別のキーに置き、保存に失敗しても本体に影響しない。
 * 下書きが消えるのは「保存した」「破棄した」ときだけ。
 */
import { DRAFT_KEY_PREFIX } from './config.js';

/** 下書きの識別子。編集なら noteId、新規なら文脈ごとに 1 つ。 */
export function draftKey({ noteId, parentId, anchorDate } = {}) {
  if (noteId) return `${DRAFT_KEY_PREFIX}note.${noteId}`;
  if (parentId) return `${DRAFT_KEY_PREFIX}child.${parentId}`;
  return `${DRAFT_KEY_PREFIX}new.${anchorDate || 'today'}`;
}

export function saveDraft(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify({ savedAt: new Date().toISOString(), value }));
    return true;
  } catch {
    return false;
  }
}

export function loadDraft(key) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function clearDraft(key) {
  try {
    window.localStorage.removeItem(key);
  } catch { /* 保存できない環境では何もしない */ }
}

/** 残っている下書きの一覧（古いものの掃除と「書きかけを続ける」用） */
export function listDrafts() {
  const out = [];
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(DRAFT_KEY_PREFIX)) continue;
      const draft = loadDraft(key);
      if (draft) out.push({ key, ...draft });
    }
  } catch { /* noop */ }
  return out.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}

/** 中身が空なら下書きとして持たない */
export function isEmptyDraft(value) {
  if (!value) return true;
  return !['body', 'title', 'cue', 'tags'].some((k) => String(value[k] || '').trim());
}
