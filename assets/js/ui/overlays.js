/** トースト / ダイアログ / ボトムシートなどのオーバーレイ UI */
import { h, clear, append, iconButton } from './dom.js';
import { icon } from './icons.js';

const layerId = 'overlay-layer';

function layer() {
  let el = document.getElementById(layerId);
  if (!el) {
    el = h('div', { id: layerId });
    document.body.appendChild(el);
  }
  return el;
}

/* ------------------------------------------------------------ toast */

let activeToast = null;

export function toast(message, { actionLabel, onAction, duration = 3200 } = {}) {
  if (activeToast) activeToast.remove();
  const el = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'toast__text' }, message));

  if (actionLabel) {
    el.appendChild(h('button', {
      type: 'button',
      class: 'toast__action',
      onClick: () => { el.remove(); activeToast = null; onAction?.(); },
    }, actionLabel));
  }

  layer().appendChild(el);
  activeToast = el;
  const timer = setTimeout(() => {
    el.classList.add('toast--leaving');
    setTimeout(() => { el.remove(); if (activeToast === el) activeToast = null; }, 220);
  }, duration);
  el.addEventListener('remove', () => clearTimeout(timer));
  return el;
}

/* ------------------------------------------------------------ dialog */

const openStack = [];

function pushOverlay(nodes, onClose) {
  const entry = { nodes, onClose };
  openStack.push(entry);
  document.body.style.overflow = 'hidden';
  return () => closeOverlay(entry);
}

function closeOverlay(entry) {
  const idx = openStack.indexOf(entry);
  if (idx === -1) return;
  openStack.splice(idx, 1);
  entry.nodes.forEach((n) => n.remove());
  if (!openStack.length) document.body.style.overflow = '';
  entry.onClose?.();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openStack.length) {
    e.preventDefault();
    closeOverlay(openStack[openStack.length - 1]);
  }
});

/**
 * 汎用ダイアログ。
 * @param {{title:string, content:Node|Node[], actions?:Array, variant?:'full'|'alert',
 *          dismissible?:boolean, onClose?:Function, leading?:Node}} options
 * @returns {{close:Function, element:HTMLElement}}
 */
export function openDialog(options) {
  const {
    title, content, actions = [], variant = 'full',
    dismissible = true, onClose, leading,
  } = options;

  const scrim = h('div', { class: 'scrim' });
  const dialog = h('section', {
    class: `dialog ${variant === 'alert' ? 'dialog--alert' : ''}`,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title,
  });

  let close = () => {};

  if (variant === 'alert') {
    if (title) dialog.appendChild(h('h2', { class: 'dialog__title' }, title));
  } else {
    const bar = h('div', { class: 'dialog__bar' });
    bar.appendChild(leading || iconButton(icon('close'), {
      label: '閉じる',
      onClick: () => close(),
    }));
    bar.appendChild(h('h2', { class: 'dialog__title' }, title || ''));
    dialog.appendChild(bar);
  }

  const body = h('div', { class: variant === 'alert' ? 'dialog__body' : 'dialog__content' });
  append(body, [content]);
  dialog.appendChild(body);

  if (actions.length) {
    const row = h('div', { class: 'dialog__actions' });
    actions.forEach((a) => {
      row.appendChild(h('button', {
        type: 'button',
        class: a.className || 'btn btn--text',
        onClick: () => a.onClick?.(close),
      }, a.label));
    });
    dialog.appendChild(row);
  }

  layer().append(scrim, dialog);
  close = pushOverlay([scrim, dialog], onClose);
  if (dismissible) scrim.addEventListener('click', () => close());

  const focusable = dialog.querySelector('input, textarea, button, select, [tabindex]');
  setTimeout(() => focusable?.focus({ preventScroll: true }), 40);

  return { close: () => close(), element: dialog, body };
}

/** ボトムシート（PC では中央ダイアログ） */
export function openSheet({ title, content, onClose }) {
  const scrim = h('div', { class: 'scrim' });
  const sheet = h('section', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' });
  // つまみは「下へ払えば閉じられる」印。押しても閉じられるようにしておく
  const handle = h('button', {
    type: 'button',
    class: 'sheet__handle',
    'aria-label': '閉じる（下へ払っても閉じます）',
  });
  sheet.appendChild(handle);
  const body = h('div', { class: 'sheet__content' });
  append(body, [content]);
  sheet.appendChild(body);

  layer().append(scrim, sheet);
  const close = pushOverlay([scrim, sheet], onClose);
  scrim.addEventListener('click', () => close());
  handle.addEventListener('click', () => close());
  enableSwipeToClose({ sheet, scrim, body, close });
  return { close, element: sheet, body };
}

/**
 * 下へ払って閉じられるようにする。
 *
 * つまみが「動かせそう」に見えるのに動かないと気持ち悪いので、
 * 見た目どおりに動くようにする。中身をスクロールしている途中では始めない。
 */
function enableSwipeToClose({ sheet, scrim, body, close }) {
  let startY = 0;
  let startedAt = 0;
  let delta = 0;
  let dragging = false;
  let pointerId = null;

  const height = () => sheet.getBoundingClientRect().height || 1;

  const move = (dy) => {
    delta = Math.max(0, dy);
    sheet.style.transform = `translateY(${delta}px)`;
    scrim.style.opacity = String(Math.max(0, 1 - (delta / height()) * 1.2));
  };

  const reset = ({ animate = true } = {}) => {
    sheet.style.transition = animate ? 'transform var(--fcc-dur-medium) var(--fcc-ease-standard)' : '';
    sheet.style.transform = '';
    scrim.style.opacity = '';
    setTimeout(() => { sheet.style.transition = ''; }, 240);
  };

  const finish = () => {
    const elapsed = Date.now() - startedAt || 1;
    const speed = delta / elapsed;        // px/ms
    // しっかり引き下げたか、勢いよく払ったら閉じる
    if (delta > height() * 0.25 || speed > 0.6) {
      sheet.style.transition = 'transform var(--fcc-dur-short) var(--fcc-ease-standard)';
      sheet.style.transform = `translateY(${height()}px)`;
      scrim.style.opacity = '0';
      setTimeout(() => close(), 140);
      return;
    }
    reset();
  };

  sheet.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    // 中身を途中までスクロールしているときは、まずスクロールを優先する
    const fromHandle = e.target.closest('.sheet__handle');
    if (!fromHandle && body.scrollTop > 0) return;
    // 入力中の操作を邪魔しない
    if (!fromHandle && e.target.closest('input, textarea, select, button, a, [contenteditable]')) return;
    dragging = true;
    pointerId = e.pointerId;
    startY = e.clientY;
    startedAt = Date.now();
    delta = 0;
  });

  sheet.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const dy = e.clientY - startY;
    if (dy <= 0) { move(0); return; }
    // 下へ動かし始めたら、スクロールではなく「閉じる操作」として扱う
    if (dy > 6 && !sheet.hasPointerCapture(pointerId)) sheet.setPointerCapture(pointerId);
    move(dy);
    if (delta > 0) e.preventDefault();
  });

  const end = (e) => {
    if (!dragging || (e && e.pointerId !== pointerId)) return;
    dragging = false;
    if (pointerId !== null && sheet.hasPointerCapture(pointerId)) sheet.releasePointerCapture(pointerId);
    pointerId = null;
    if (delta > 0) finish();
    else reset({ animate: false });
  };

  sheet.addEventListener('pointerup', end);
  sheet.addEventListener('pointercancel', end);
}

/** 確認ダイアログ */
export function confirmDialog({
  title, message, confirmLabel = 'OK', cancelLabel = 'キャンセル', danger = false,
}) {
  return new Promise((resolve) => {
    let decided = false;
    const settle = (value, close) => { decided = true; resolve(value); close(); };
    openDialog({
      title,
      variant: 'alert',
      content: h('p', { style: { margin: '4px 0 0', color: 'var(--fcc-on-surface-variant)' } }, message),
      actions: [
        { label: cancelLabel, className: 'btn btn--text', onClick: (close) => settle(false, close) },
        {
          label: confirmLabel,
          className: `btn ${danger ? 'btn--danger' : ''}`,
          onClick: (close) => settle(true, close),
        },
      ],
      onClose: () => { if (!decided) resolve(false); },
    });
  });
}

/** 開いているダイアログ・シートをすべて閉じる（画面遷移の前に呼ぶ） */
export function closeAllOverlays() {
  [...openStack].reverse().forEach((entry) => closeOverlay(entry));
}

/** 選択肢メニュー（ボトムシート形式） */
export function openMenu({ title, items }) {
  const list = h('div', { class: 'menu' });
  let ref;
  items.forEach((item) => {
    if (item.divider) { list.appendChild(h('hr', { class: 'divider' })); return; }
    list.appendChild(h('button', {
      type: 'button',
      class: 'list-row',
      onClick: () => { ref.close(); item.onClick?.(); },
    },
    item.icon ? h('span', { class: 'list-row__icon', html: item.icon, style: { color: item.danger ? 'var(--fcc-error)' : 'inherit' } }) : null,
    h('span', { class: 'list-row__text' },
      h('span', { class: 'list-row__title', style: { color: item.danger ? 'var(--fcc-error)' : 'inherit' } }, item.label),
      item.description ? h('span', { class: 'list-row__desc' }, item.description) : null)));
  });

  ref = openSheet({
    title,
    content: [title ? h('h2', { class: 'daypanel__date', style: { margin: '4px 0 8px' } }, title) : null, list],
  });
  return ref;
}

export { clear };
