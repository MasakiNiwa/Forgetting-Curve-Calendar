/** ハッシュベースの簡易ルーター */
const listeners = new Set();

export function currentRoute(routes, fallback) {
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return routes.some((r) => r.id === raw) ? raw : fallback;
}

export function navigate(routeId) {
  const next = `#/${routeId}`;
  if (window.location.hash === next) {
    listeners.forEach((fn) => fn(routeId));
    return;
  }
  window.location.hash = next;
}

export function onRouteChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function startRouter(handler) {
  const emit = () => handler();
  window.addEventListener('hashchange', emit);
  listeners.add(() => handler());
  emit();
}
