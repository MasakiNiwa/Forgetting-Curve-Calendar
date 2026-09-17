/** テーマ（ライト / ダーク / 端末設定）の適用 */
const media = window.matchMedia('(prefers-color-scheme: dark)');
let current = 'system';

function resolve(theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  return media.matches ? 'dark' : 'light';
}

export function applyTheme(theme) {
  current = theme || 'system';
  const resolved = resolve(current);
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = resolved === 'dark' ? '#131318' : '#fbf8ff';
}

media.addEventListener('change', () => {
  if (current === 'system') applyTheme('system');
});
