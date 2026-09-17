/**
 * 表示領域の追従（ソフトキーボード対策）。
 *
 * スマホでキーボードが出ると、画面の下側がキーボードに隠れる。
 * このとき縮むのは「実際に見えている領域（visualViewport）」で、
 * 100dvh などのレイアウト高さは変わらないため、
 * 画面下に固定したバーがキーボードの裏に回ってしまう。
 *
 * そこで見えている領域の高さと位置を CSS 変数に流し込み、
 * 編集画面はその値を使って「キーボードのすぐ上」に収まるようにする。
 *
 *   --fcc-vv-height : いま見えている高さ
 *   --fcc-vv-top    : 見えている領域の上端（iOS でずれる分）
 *   --fcc-keyboard  : キーボードが覆っている高さ
 *   data-keyboard="open" : キーボードが出ているとき
 */
export function watchViewport() {
  const root = document.documentElement;
  const vv = window.visualViewport;

  const apply = ({ height, top, keyboard }) => {
    root.style.setProperty('--fcc-vv-height', `${Math.round(height)}px`);
    root.style.setProperty('--fcc-vv-top', `${Math.round(top)}px`);
    root.style.setProperty('--fcc-keyboard', `${Math.round(keyboard)}px`);
    if (keyboard > 80) root.dataset.keyboard = 'open';
    else delete root.dataset.keyboard;
  };

  const update = () => {
    if (!vv) {
      apply({ height: window.innerHeight, top: 0, keyboard: 0 });
      return;
    }
    // innerHeight（レイアウト）と visualViewport の差が、隠れている分
    const keyboard = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    apply({ height: vv.height, top: vv.offsetTop, keyboard });
  };

  if (vv) {
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
  }
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  update();
  return update;
}
