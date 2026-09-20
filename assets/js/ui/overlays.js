/** トースト / ダイアログ / ボトムシートなどのオーバーレイ UI */
import { h, clear, append, iconButton } from './dom.js';
import { icon } from './icons.js';
import { consumePop, popEntry, pushEntry } from './backstack.js';

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

/**
 * 端末の「戻る」で、まずこの重なりを閉じる。
 *
 * 開くときに履歴を 1 つ積んでおき、戻るが押されたら（popstate）
 * 画面を移らずに上の 1 枚だけ閉じる。
 * 画面の中のボタンで閉じたときは、積んだ履歴も戻して帳尻を合わせる。
 */
function pushOverlay(nodes, onClose) {
  const entry = { nodes, onClose, inHistory: pushEntry() };
  openStack.push(entry);
  document.body.style.overflow = 'hidden';
  return () => closeOverlay(entry);
}

function closeOverlay(entry, { fromHistory = false } = {}) {
  const idx = openStack.indexOf(entry);
  if (idx === -1) return;
  openStack.splice(idx, 1);
  entry.nodes.forEach((n) => n.remove());
  if (!openStack.length) document.body.style.overflow = '';
  entry.onClose?.();
  // 「戻る」以外で閉じたときは、開くときに積んだ履歴を戻しておく
  if (entry.inHistory && !fromHistory) popEntry();
}

window.addEventListener('popstate', () => {
  if (consumePop()) return;
  const top = openStack[openStack.length - 1];
  if (top) closeOverlay(top, { fromHistory: true });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openStack.length) {
    e.preventDefault();
    closeOverlay(openStack[openStack.length - 1]);
  }
});

/** 重なりが開いているか（「戻る」の扱いを決めるために使う） */
export function hasOpenOverlay() {
  return openStack.length > 0;
}

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
 * 見た目どおりに動くようにする。
 *
 * 指の操作はブラウザのスクロールと取り合いになる。先にスクロールが始まると
 * こちらの操作は打ち切られ（pointercancel）、「たまに閉じない」ことになるので、
 * 指は touch イベントで受けて、最初のひと動きで
 * 「スクロール」か「閉じる操作」かを決め、決めたら最後までそのまま扱う。
 */
function enableSwipeToClose({ sheet, scrim, body, close }) {
  // これ以上下げたら閉じる。背の高いシートでも遠すぎないように上限を付ける
  const CLOSE_RATIO = 0.2;
  const CLOSE_MAX = 120;
  const FLICK_SPEED = 0.35;  // px/ms（最後のひと払いの速さで見る）
  const RECENT_MS = 160;     // 速さを見るのは直前のこれだけ
  const DECIDE_PX = 6;       // どちらの操作か決めるまでの遊び

  let startY = 0;
  let recent = [];           // 直前の動き（速さを測るため）
  let delta = 0;
  let dragging = false;      // 指・マウスが触れている
  let decided = null;        // 'drag' | 'scroll'
  let pointerId = null;

  const height = () => sheet.getBoundingClientRect().height || 1;
  const threshold = () => Math.min(height() * CLOSE_RATIO, CLOSE_MAX);

  /**
   * ここから始めてよいか。
   * 中身をスクロールしている途中は、まずスクロールを優先する。
   * ボタンの上からでも払えるようにして（シートの中身はボタンだらけなので）、
   * 払ったときだけ、そのあとの click を飲み込む。
   */
  const canStart = (target) => {
    if (target?.closest?.('.sheet__handle')) return true;
    if (body.scrollTop > 0) return false;
    // 文字を選んだり書いたりするところは、そちらを優先する
    return !target?.closest?.('input, textarea, select, [contenteditable]');
  };

  /** 払ったあとに続く click を 1 回だけ止める（ボタンを押したことにしない） */
  const swallowClick = (e) => { e.stopPropagation(); e.preventDefault(); };
  const suppressNextClick = () => {
    sheet.addEventListener('click', swallowClick, true);
    setTimeout(() => sheet.removeEventListener('click', swallowClick, true), 400);
  };

  const begin = (y) => {
    dragging = true;
    decided = null;
    delta = 0;
    startY = y;
    recent = [{ y: 0, at: Date.now() }];
  };

  const move = (dy) => {
    delta = Math.max(0, dy);
    sheet.style.transform = delta ? `translateY(${delta}px)` : '';
    scrim.style.opacity = String(Math.max(0, 1 - (delta / height()) * 1.2));
  };

  const reset = ({ animate = true } = {}) => {
    sheet.style.transition = animate ? 'transform var(--fcc-dur-medium) var(--fcc-ease-standard)' : '';
    sheet.style.transform = '';
    scrim.style.opacity = '';
    setTimeout(() => { sheet.style.transition = ''; }, 240);
  };

  /**
   * 最後のひと払いの速さ（px/ms）。
   * 指を止めてから離したときは「勢いなし」として、動いた距離だけで判断する。
   */
  const speedNow = () => {
    const last = recent[recent.length - 1];
    if (!last || Date.now() - last.at > RECENT_MS) return 0;
    const from = recent.find((p) => last.at - p.at <= RECENT_MS) || recent[0];
    const ms = last.at - from.at;
    return ms > 0 ? (last.y - from.y) / ms : 0;
  };

  const finish = () => {
    // しっかり引き下げたか、最後に勢いよく払ったら閉じる
    if (delta > threshold() || speedNow() > FLICK_SPEED) {
      sheet.style.transition = 'transform var(--fcc-dur-short) var(--fcc-ease-standard)';
      sheet.style.transform = `translateY(${height()}px)`;
      scrim.style.opacity = '0';
      setTimeout(() => close(), 140);
      return;
    }
    reset();
  };

  /** 動いた量から、閉じる操作かスクロールかを決める */
  const track = (dy) => {
    if (decided === 'scroll') return false;
    let moved = dy;
    if (!decided) {
      if (Math.abs(moved) < DECIDE_PX) return false;
      // 上へ動かし始めたらスクロール。下へ動かし始めたら閉じる操作
      decided = moved > 0 ? 'drag' : 'scroll';
      if (decided === 'scroll') return false;
      // 決めるまでの遊びのぶんを外して、指の動きと段差が出ないようにする
      startY += DECIDE_PX;
      moved -= DECIDE_PX;
    }
    move(moved);
    recent.push({ y: delta, at: Date.now() });
    if (recent.length > 8) recent.shift();
    return true;
  };

  const end = () => {
    if (!dragging) return;
    dragging = false;
    const wasDragging = decided === 'drag';
    decided = null;
    if (wasDragging) suppressNextClick();
    if (wasDragging && delta > 0) finish();
    else if (delta > 0) reset({ animate: false });
  };

  /* ---- マウス（指は touch イベントで扱うので、ここでは相手にしない） ---- */
  sheet.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    if (e.button !== undefined && e.button !== 0) return;
    if (!canStart(e.target)) return;
    pointerId = e.pointerId;
    begin(e.clientY);
  });

  sheet.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerType === 'touch' || e.pointerId !== pointerId) return;
    if (track(e.clientY - startY) && !sheet.hasPointerCapture(pointerId)) {
      sheet.setPointerCapture(pointerId);
    }
  });

  const pointerEnd = (e) => {
    if (e.pointerType === 'touch' || e.pointerId !== pointerId) return;
    if (pointerId !== null && sheet.hasPointerCapture(pointerId)) sheet.releasePointerCapture(pointerId);
    pointerId = null;
    end();
  };
  sheet.addEventListener('pointerup', pointerEnd);
  sheet.addEventListener('pointercancel', pointerEnd);

  /* ---- 指 ---- */
  sheet.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { end(); return; }
    if (!canStart(e.target)) return;
    begin(e.touches[0].clientY);
  }, { passive: true });

  sheet.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    if (e.touches.length !== 1) { end(); return; }
    const moved = track(e.touches[0].clientY - startY);
    // 閉じる操作だと決めたら、ブラウザのスクロールには渡さない
    if (moved && e.cancelable) e.preventDefault();
  }, { passive: false });

  sheet.addEventListener('touchend', end, { passive: true });
  sheet.addEventListener('touchcancel', end, { passive: true });
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

/**
 * その場で開く小さなメニュー（ポップオーバー）。
 *
 * 本文を書いている途中に使うので、シートのように画面を覆わない。
 * 押してもカーソルが本文から外れない（＝キーボードが閉じない）ようにしてある。
 *
 * 押したボタンに**ずっと付いて回る**。
 * スマホでは、変換の候補が出たりキーボードが開け閉めされるたびに
 * 下のバー（＝押したボタン）が上下する。開いたときの位置に置いたままだと、
 * メニューだけが取り残されてしまうので、ボタンの位置を見張って追いかける。
 *
 * @param {{anchor:HTMLElement, items:Array, title?:string, align?:'left'|'right'}} options
 */
export function openPopover({ anchor, items, title, align = 'left' }) {
  const scrim = h('div', { class: 'scrim scrim--clear' });
  const pop = h('div', { class: 'popover', role: 'menu', 'aria-label': title || '' });
  if (title) pop.appendChild(h('div', { class: 'popover__title' }, title));

  let close = () => {};
  items.filter(Boolean).forEach((item) => {
    if (item.divider) { pop.appendChild(h('hr', { class: 'divider' })); return; }
    pop.appendChild(h('button', {
      type: 'button',
      class: `popover__item${item.active ? ' popover__item--on' : ''}`,
      role: 'menuitem',
      // 押してもカーソルが本文から外れないようにする
      onMouseDown: (e) => e.preventDefault(),
      onClick: () => { close(); item.onClick?.(); },
    },
    item.icon ? h('span', { class: 'popover__icon', html: item.icon }) : null,
    h('span', { class: 'popover__label' }, item.label),
    item.hint ? h('span', { class: 'popover__hint' }, item.hint) : null));
  });

  const vv = window.visualViewport;

  // 押したボタンの真上に出す（見えている範囲からはみ出さないように寄せる）
  const place = () => {
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    // キーボードが出ていると、見えている範囲はこれだけになる。
    // 位置は fixed（＝レイアウトの左上が原点）で書くので、原点もそろえる
    const viewLeft = vv ? vv.offsetLeft : 0;
    const viewTop = vv ? vv.offsetTop : 0;
    const viewWidth = vv ? vv.width : window.innerWidth;
    const viewHeight = vv ? vv.height : window.innerHeight;

    // 高さは「押したボタンの上下で広い方」に収まる分だけにする。
    // キーボードが出ていて置き場所が狭いときは、中を送って読む形になる
    const room = Math.max(rect.top - viewTop, viewTop + viewHeight - rect.bottom) - margin * 2;
    pop.style.maxHeight = `${Math.max(180, Math.min(420, Math.round(room)))}px`;

    const box = pop.getBoundingClientRect();
    let left = align === 'right' ? rect.right - box.width : rect.left;
    left = Math.max(viewLeft + margin, Math.min(left, viewLeft + viewWidth - box.width - margin));
    const above = rect.top - box.height - 6;
    const top = above >= viewTop + margin
      ? above
      : Math.min(rect.bottom + 6, viewTop + viewHeight - box.height - margin);
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    pop.dataset.ready = 'true';
  };

  /**
   * ボタンの位置を毎フレーム見比べて、動いたときだけ置き直す。
   *
   * キーボードの開け閉めは「ひと息で終わる動き」ではなく、
   * 端末によっては数十フレームかけて動く。resize の知らせだけでは追い切れない。
   * 位置が変わらないフレームでは何も書かないので、動きが無いあいだは静か。
   */
  let frame = 0;
  let placedAt = '';
  const follow = () => {
    frame = requestAnimationFrame(follow);
    // 押したボタンが画面から消えたら、メニューも閉じる（迷子にしない）
    if (!anchor.isConnected) { close(); return; }
    const rect = anchor.getBoundingClientRect();
    const key = `${Math.round(rect.top)}:${Math.round(rect.left)}:${Math.round(rect.width)}`;
    if (key === placedAt) return;
    placedAt = key;
    place();
  };
  const stopFollowing = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };

  layer().append(scrim, pop);
  close = pushOverlay([scrim, pop], stopFollowing);
  scrim.addEventListener('mousedown', (e) => e.preventDefault());
  scrim.addEventListener('click', () => close());

  place();
  placedAt = (() => {
    const r = anchor.getBoundingClientRect();
    return `${Math.round(r.top)}:${Math.round(r.left)}:${Math.round(r.width)}`;
  })();
  frame = requestAnimationFrame(follow);
  return { close: () => close(), element: pop };
}

export { clear };
