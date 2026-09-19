/**
 * ハッシュベースの簡易ルーター。
 * `#/notes` のような固定ルートに加えて、`#/note/<id>?from=notes` のような
 * パラメータ付きのルートも扱う。
 */
import { whenSettled } from './backstack.js';

const listeners = new Set();

/** 現在のハッシュを {segments, params} に分解する */
export function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  return {
    segments: path.split('/').filter(Boolean),
    params: new URLSearchParams(query || ''),
  };
}

export function currentRoute(routes, fallback) {
  const { segments } = parseHash();
  const head = segments[0] || '';
  return routes.some((r) => r.id === head) ? head : fallback;
}

/** `#/note/abc?from=notes` の形を組み立てる */
export function buildPath(segments, params = {}) {
  const path = [].concat(segments).filter(Boolean).join('/');
  const query = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ).toString();
  return `#/${path}${query ? `?${query}` : ''}`;
}

export function navigate(target, params) {
  const next = typeof target === 'string' && target.startsWith('#')
    ? target
    : buildPath(target, params);
  if (window.location.hash === next) {
    listeners.forEach((fn) => fn());
    return;
  }
  // 重なりを閉じた直後なら、履歴が落ち着いてから移る
  whenSettled(() => { window.location.hash = next; });
}

/** 履歴を増やさずに URL だけ差し替える（新規メモに id が付いたときなど） */
export function replacePath(target, params) {
  const next = typeof target === 'string' && target.startsWith('#')
    ? target
    : buildPath(target, params);
  // 「戻る」の扱いに使っている印（state）は消さずに、URL だけ差し替える
  window.history.replaceState(window.history.state, '', next);
}

export function onRouteChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function startRouter(handler) {
  window.addEventListener('hashchange', () => handler());
  listeners.add(() => handler());
  handler();
}
