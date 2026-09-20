/**
 * アプリ全体で共有する定数。
 * リリース時に更新するのは APP_VERSION / RELEASE_DATE のみで済むようにしている。
 */
export const APP_NAME = '忘却曲線カレンダー';
export const APP_TAGLINE = 'そのメモ、もちろん忘れます';
export const APP_VERSION = '1.0.1';
export const RELEASE_DATE = '2026-09-20';

export const REPO_URL = 'https://github.com/MasakiNiwa/Forgetting-Curve-Calendar';
export const ISSUES_URL = `${REPO_URL}/issues`;

/** localStorage のキー。schema のメジャー変更時のみ変える。 */
export const STORAGE_KEY = 'fcc.data.v1';
/** 書きかけメモの保存先（本体データとは分けて持つ） */
export const DRAFT_KEY_PREFIX = 'fcc.draft.';
/** データスキーマ番号。migrations.js のチェーンと対応する。 */
export const SCHEMA_VERSION = 7;
