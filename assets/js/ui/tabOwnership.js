/**
 * 「このタブで編集できるか」の見張り役。
 *
 * データは 1 つの保存先に丸ごと入っているので、同時に 2 つのタブが書くと
 * 相手の変更を消してしまう。そこで書けるタブを 1 つに決め、
 * あとから開いたタブは「見るだけ」にする。編集したくなったら譲り受ける。
 */
import { h, button } from './dom.js';
import { icon } from './icons.js';
import { toast } from './overlays.js';

export async function setupTabOwnership(store, lock) {
  let banner = null;

  // 譲るときは、書きかけを必ず保存してから手を離す
  lock.onRelease = async () => {
    await store.flush();
  };

  const apply = (owner, { quiet = false } = {}) => {
    store.setReadOnly(!owner);
    document.documentElement.dataset.viewer = owner ? '' : 'true';
    if (owner) {
      banner?.remove();
      banner = null;
      if (!quiet) toast('このタブで編集できます');
      return;
    }
    showBanner();
  };

  function showBanner() {
    if (banner) return;
    banner = h('div', { class: 'banner banner--warning banner--sticky', role: 'status' },
      h('span', { html: icon('info', { size: 18 }), style: { display: 'flex' } }),
      h('span', { style: { flex: '1' } },
        '別のタブで開いています。ここは見るだけです。'),
      button('このタブで編集', {
        className: 'btn btn--sm',
        onClick: async () => {
          await takeOver();
        },
      }));
    document.querySelector('.appbar')?.insertAdjacentElement('afterend', banner);
  }

  async function takeOver() {
    await lock.takeOver();
    // 譲り受けたら、保存されている内容で読み直す（こちらの古い状態で上書きしない）
    await store.reload();
    apply(true);
    store.emit({ type: 'view:refresh' });
  }

  // 印が残っていても、返事が無ければ引き継ぐ（閉じてすぐ開き直したとき用）
  await lock.start();
  apply(lock.owner, { quiet: true });

  // 編集画面からの「このタブで編集」（画面いっぱいのときは上のバーが隠れるため）
  store.subscribe((event) => {
    if (event?.type === 'tab:request-edit' && !lock.owner) takeOver();
  });

  // 別タブからの合図（持ち主の交代・譲ってほしいという依頼）
  window.addEventListener('storage', async (event) => {
    if (!event.key) return;
    const signal = lock.handleSignal(event.key);
    if (signal === 'release') {
      // 相手が「編集したい」と言っている。保存してから譲る
      await lock.release();
      apply(false);
      toast('別のタブへ編集を譲りました');
      return;
    }
    if (signal === 'lost') {
      apply(false);
      return;
    }
    if (signal === 'free' && !lock.owner) {
      // 持ち主のタブが閉じられた。開いているタブが引き継ぐ
      if (lock.claim()) {
        await store.reload();
        apply(true);
        store.emit({ type: 'view:refresh' });
      }
    }
  });

  // 表示に戻ったとき：持ち主が消えていれば引き継ぎ、見るだけのままなら最新を読む
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') {
      // 画面から離れるときは、書きかけを確実に残す
      if (lock.owner) store.flushSync();
      return;
    }
    if (lock.owner) {
      // 離れているあいだに別のタブが持ち主になっていないか確かめる
      const current = lock.currentOwner();
      if (current && current.id !== lock.id) {
        lock.setOwner(false, 'lost');
        apply(false);
        return;
      }
      lock.beat();
      return;
    }
    if (!lock.currentOwner() && await lock.claimWithProbe()) {
      await store.reload();
      apply(true);
      store.emit({ type: 'view:refresh' });
      return;
    }
    // 見るだけのタブは、別タブの最新を読み直して表示だけ合わせる
    await store.reload();
    store.emit({ type: 'view:refresh' });
  });

  // 閉じる直前：書きかけを保存し、持ち主の印を外す
  window.addEventListener('pagehide', () => {
    if (!lock.owner) return;
    // 閉じる直前は、待たずにその場で書く
    store.flushSync();
    lock.stop();
    const record = lock.read('fcc.owner.v1');
    if (record?.id === lock.id) lock.write('fcc.owner.v1', null);
  });

  return { lock, takeOver };
}
