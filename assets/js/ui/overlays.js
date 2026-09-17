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
  sheet.appendChild(h('div', { class: 'sheet__handle' }));
  const body = h('div', { class: 'sheet__content' });
  append(body, [content]);
  sheet.appendChild(body);

  layer().append(scrim, sheet);
  const close = pushOverlay([scrim, sheet], onClose);
  scrim.addEventListener('click', () => close());
  return { close, element: sheet, body };
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
