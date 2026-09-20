/**
 * 外のページを開く。
 *
 * ふつうのブラウザで見ているときは `<a target="_blank">` のままでよい。
 * 困るのは**ホーム画面に追加したアプリ（PWA）**で、
 * Android ではアプリの中のブラウザ（Custom Tab）が上にかぶさって開く。
 * 読みながらアプリへ戻ったり、あとで読み返したりがしにくい。
 *
 * そこで Android のインストール版だけ、**端末のブラウザへ渡す**。
 * Android の `intent:` という決まりに沿った URL を開くと、
 * その URL を扱えるアプリ（ふだん使いのブラウザや、動画・音声のアプリ）へ渡される。
 *
 * 渡せなかったときのために、しばらく画面が動かなければ
 * これまでどおりの開き方に戻す（開かないまま終わらせない）。
 */

/** 受け渡しを試してから、戻ってこなかったか見るまでの時間 */
const HANDOFF_MS = 1200;

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

function isAndroid() {
  return /Android/i.test(navigator.userAgent || '');
}

/**
 * Android の受け渡し用の URL にする。
 *
 * `#` から後ろ（ページの中の位置）は、この書き方では持っていけないので、
 * そういう URL は渡さない（＝これまでどおりの開き方にする）。
 */
export function toIntentUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  if (parsed.hash) return null;
  const scheme = parsed.protocol.replace(':', '');
  const rest = url.slice(parsed.protocol.length + 2);
  return `intent://${rest}#Intent;scheme=${scheme};`
    + 'action=android.intent.action.VIEW;'
    + 'category=android.intent.category.BROWSABLE;end';
}

/** 新しいところで開く（いまの画面はそのまま残す） */
function openBlank(url) {
  const win = window.open(url, '_blank', 'noopener,noreferrer');
  if (win) return true;
  // ポップアップが止められたときは、その場のリンクとして押す
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return true;
}

/**
 * 外のページを開く。押されたその場（ユーザー操作の中）で呼ぶこと。
 * @param {string} url
 * @returns {boolean} 自分で開いたか（false なら呼び出し側の既定の動きに任せる）
 */
export function openExternal(url) {
  if (!url) return false;
  if (!(isAndroid() && isInstalledApp())) return false;

  const intent = toIntentUrl(url);
  if (!intent) return false;

  // 受け渡しは新しいところで行う。
  // 渡せなかったときに、いまの画面（書きかけのメモ）が飛ばされないようにするため
  const a = document.createElement('a');
  a.href = intent;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);

  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    window.removeEventListener('blur', done);
    document.removeEventListener('visibilitychange', onVisible);
  };
  function onVisible() {
    if (document.visibilityState === 'hidden') done();
  }
  window.addEventListener('blur', done);
  document.addEventListener('visibilitychange', onVisible);

  a.click();
  a.remove();

  // 画面が変わらないまま時間が過ぎたら、渡せなかったとみなして開き直す
  setTimeout(() => {
    if (settled) return;
    done();
    openBlank(url);
  }, HANDOFF_MS);

  return true;
}

/**
 * 画面のどこでも、外のページへのリンクは同じ開き方にする。
 * （とびらのカード・メモの本文・ヘルプの中のリンク…）
 */
export function watchExternalLinks(root = document) {
  root.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    // 自分で「新しいタブで開く」を選んだときは、そのまま任せる
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target?.closest?.('a[target="_blank"][href]');
    if (!link) return;
    if (!openExternal(link.href)) return;
    event.preventDefault();
  });
}
