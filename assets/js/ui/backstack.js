/**
 * 端末の「戻る」の扱い。
 *
 * ホーム画面に追加して使うと、アプリらしく見える一方で「戻る」は
 * ブラウザのままなので、次の 2 つが気になる:
 *   - 重なり（シートやダイアログ）が開いたまま、画面だけ戻ってしまう
 *   - 最初の画面で戻ると、アプリごと閉じてしまう
 *
 * ここでは履歴まわりの段取りをまとめて持つ:
 *   - 重なりのぶんの履歴を積む／戻す（実際の開け閉めは overlays.js）
 *   - 戻し終わるのを待ってから画面を移る（router.js の navigate が使う）
 *   - 起動時に履歴をもう 1 つ積んでおき、いちばん下まで戻ってきたら積み直す
 *     （＝最初の画面で戻ってもアプリが閉じない。画面の移動は普通に戻れる）
 */
/* ------------------------------------------------------------------ */
/* 重なり（シート・ダイアログ）のぶんの履歴                            */
/* ------------------------------------------------------------------ */

/** 自分で戻したぶん（popstate を読み飛ばす数） */
let pendingPops = 0;
/**
 * これから戻す予定のぶん。
 *
 * 重なりを閉じてすぐ別の重なりを開く（メニューから設定シートへ、など）ときに、
 * 「戻す」と「積む」が行き違うと、履歴が 1 つずれて画面まで戻ってしまう。
 * 戻すのをほんの少し遅らせ、そのあいだに次の重なりが開いたら、
 * 積むかわりに「戻す予定」を取り消して、同じ履歴を使い回す。
 */
let pendingBacks = 0;
/** 戻し終わるのを待っている処理（画面の移動など） */
const waiters = [];

function settle() {
  if (pendingPops > 0 || pendingBacks > 0) return;
  waiters.splice(0).forEach((fn) => { try { fn(); } catch { /* 待ち手の失敗は他に波及させない */ } });
}

/** 重なりを開くときに、履歴を 1 つ積む */
export function pushEntry() {
  // 直前に閉じた重なりのぶんが、まだ戻されていない。それをそのまま使う
  if (pendingBacks > 0) { pendingBacks -= 1; return true; }
  try {
    window.history.pushState({ fcc: 'overlay' }, '');
    return true;
  } catch {
    return false;   // 履歴が使えない環境でも、重なり自体は使えるようにする
  }
}

/** 画面のボタンで閉じたときに、積んだぶんを戻す（すぐには戻さない） */
export function popEntry() {
  pendingBacks += 1;
  setTimeout(flushBacks, 0);
}

function flushBacks() {
  while (pendingBacks > 0) {
    pendingBacks -= 1;
    pendingPops += 1;
    window.history.back();
    // 万一 popstate が来なくても、待っている処理を止めない
    setTimeout(() => { if (pendingPops > 0) { pendingPops -= 1; settle(); } }, 400);
  }
  // 次の重なりに使い回されて、戻すものが無くなったときも待ち手を動かす
  settle();
}

/** popstate が「自分で戻したぶん」なら true（重なりを閉じる処理は不要） */
export function consumePop() {
  if (pendingPops <= 0) return false;
  pendingPops -= 1;
  settle();
  return true;
}

/**
 * 戻し終わってから動かす。
 * 重なりを閉じた直後に画面を移ると、あとから来る「戻る」に画面が引き戻される。
 */
export function whenSettled(fn) {
  if (pendingPops <= 0 && pendingBacks <= 0) { fn(); return; }
  waiters.push(fn);
}

export function guardExit() {
  if (typeof window === 'undefined' || !window.history?.pushState) return () => {};
  try {
    window.history.replaceState({ fcc: 'root' }, '');
    window.history.pushState({ fcc: 'page' }, '');
  } catch {
    // 履歴が使えない環境では、何もしない（戻るの挙動はブラウザ任せ）
    return () => {};
  }

  const onPop = (e) => {
    if (e.state?.fcc !== 'root') return;
    // いちばん下まで戻ってきた。出口をふさぎ直して、画面はそのままにする
    try { window.history.pushState({ fcc: 'page' }, ''); } catch { /* 進めないなら諦める */ }
  };
  window.addEventListener('popstate', onPop);
  return () => window.removeEventListener('popstate', onPop);
}
