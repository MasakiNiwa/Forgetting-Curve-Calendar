/**
 * 外のページの開き方。
 *
 * ## ホーム画面に追加したアプリ（PWA）で起きること
 *
 * Android では、インストールしたアプリから外のページを開くと、
 * **アプリの中のブラウザ**（Custom Tab）が上にかぶさって開く。
 * これは Chrome 側の決まりで、ページの書き方では変えられない。
 *
 *   - `<a target="_blank">` でも `window.open()` でも同じ
 *   - v1.1.1 で `intent:` を使った受け渡しを試したが、実機では変わらなかった
 *     （`intent:` の行き先もふだん使いのブラウザ＝Chrome になり、
 *     Chrome は自分宛ての受け渡しを、いまのアプリの中で開き直すため）
 *
 * できるのは「別の渡し方を選べるようにしておく」ところまで。
 *
 *   - 共有メニューへ渡す（`navigator.share`）。ほかのアプリで開ける
 *   - リンクをコピーして、自分でブラウザに貼る
 *   - 開いたページのメニュー（⋮）から「ブラウザで開く」を選ぶ（Chrome 側の機能）
 *
 * ふつうのブラウザで見ているときは、これまでどおり新しいタブで開く
 * （`<a target="_blank">` のまま。ここでは何もしない）。
 */

/** ホーム画面に追加したアプリとして開いているか */
export function isInstalledApp() {
  try {
    return ['standalone', 'fullscreen', 'minimal-ui']
      .some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches)
      // iOS の Safari は display-mode を返さないことがある
      || window.navigator.standalone === true;
  } catch {
    return false;
  }
}

export function isAndroid() {
  return /Android/i.test(navigator.userAgent || '');
}

/**
 * アプリの中のブラウザで開くことになる場面か。
 * （案内を出すかどうかの判断にだけ使う）
 */
export function opensInAppBrowser() {
  return isInstalledApp() && isAndroid();
}

/** 共有メニューを出せるか */
export function canShareLink() {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

/**
 * リンクを共有メニューへ渡す（ほかのアプリで開くための逃げ道）。
 * @returns {Promise<'shared'|'cancelled'|'unavailable'>}
 */
export async function shareLink(url, title = '') {
  if (!canShareLink()) return 'unavailable';
  try {
    await navigator.share(title ? { title, url } : { url });
    return 'shared';
  } catch (error) {
    // 自分でやめたときは、何も言わない
    if (error?.name === 'AbortError') return 'cancelled';
    return 'unavailable';
  }
}

/**
 * 新しいところで開く（いまの画面はそのまま残す）。
 *
 * `window.open()` は使わない。理由が 2 つある。
 *
 *   1. `noopener` を付けた `window.open()` は、**うまく開けても null を返す**。
 *      戻り値で成否を判断できないので、「失敗したときの保険」を足すと
 *      毎回二重に開いてしまう（v1.1.2 で実際にそうなっていた）
 *   2. ブラウザから見ると `window.open()` は「ポップアップ」で、
 *      止められることがある。リンクを押したのと同じ形にすれば止められない
 *
 * そこで、その場でリンクを 1 つ作って押す（＝ふつうのリンクを押したのと同じ）。
 * 押した本人の操作の中から呼ぶこと。
 */
export function openInNewTab(url) {
  if (!url) return;
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
