/**
 * 学びのとびら（リンク集）。
 *
 * このアプリは「書くことがある人」には強いが、
 * 「何か書こうとして開いたけれど、書くことが無い」日には手が止まる。
 * そこでアプリの側に**学びの入口**を置く。
 *
 *   学びたいことのリンクを並べておく
 *     → 別のタブで開いて読む・見る・聴く
 *       → 戻ってきて、学んだことをメモする（＝忘却曲線に乗る）
 *
 * リンクは必ず**別のところ**で開く（このアプリは開いたまま残す）。
 * 書きかけのメモを抱えたまま画面を奪われないように、`<a target="_blank">`
 * をそのまま使い、アプリ側で画面を切り替えることはしない。
 * ホーム画面に追加したアプリ（Android）からは、端末のブラウザへ渡す
 * （`ui/openExternal.js`。アプリの中のブラウザにかぶさられないように）。
 */
import { h, append, button, iconButton, clear } from './dom.js';
import { icon } from './icons.js';
import { openSheet, openDialog, openMenu, confirmDialog, toast } from './overlays.js';
import { openNoteEditor } from './editor.js';
import { INK_COLORS } from '../core/inks.js';
import { MAX_BOOKMARKS, bookmarkHost, bookmarkInitial, safeBookmarkUrl } from '../core/models.js';
import { formatRelative } from '../core/date.js';
import { localDayOf } from '../core/curve.js';

/** アイコンに使う絵文字の見本（選ぶだけで決まるように） */
const EMOJI_CHOICES = ['📗', '📰', '🎧', '🎬', '🧪', '💡', '🌏', '🧠', '🛠️', '🗣️', '🎨', '🔢'];

/** アプリバーの入口（左どなりがデイリーミッション） */
export function portalButton(store) {
  const element = h('button', {
    type: 'button',
    class: 'appbar__portal',
    onClick: () => openPortal(store),
  }, h('span', { class: 'appbar__portal-icon', html: icon('portal') }));

  function update() {
    const { count } = store.bookmarkStats();
    const label = count
      ? `学びのとびら（リンク ${count} 件）`
      : '学びのとびら（学びたいことのリンクを置く）';
    element.setAttribute('aria-label', label);
    element.title = label;
    element.dataset.empty = count ? '' : 'true';
  }

  update();
  return { element, update };
}

/* ------------------------------------------------------------------ */
/* とびら（シート）                                                     */
/* ------------------------------------------------------------------ */

export function openPortal(store) {
  let unsubscribe = () => {};
  const sheet = openSheet({
    title: '学びのとびら',
    content: render(store),
    onClose: () => unsubscribe(),
  });
  // 追加・並べ替え・削除のあと、開いたまま作り直す
  unsubscribe = store.subscribe((event) => {
    if (!String(event?.type || '').startsWith('bookmark:')) return;
    clear(sheet.body).appendChild(render(store));
  });
  return sheet;
}

function render(store) {
  const list = store.bookmarks;
  const stats = store.bookmarkStats();
  // 「今日はこれ」は、数が増えて選びにくくなってから出す
  // （2 件までは、下のカードを見れば分かる）
  const suggestion = list.length >= 3 ? store.suggestedBookmark() : null;

  return h('div', { class: 'portal' },
    h('div', { class: 'portal__head' },
      h('span', { class: 'portal__mark', html: icon('portal', { size: 26 }) }),
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('h2', { class: 'portal__title' }, '学びのとびら'),
        h('p', { class: 'portal__lead' }, list.length
          ? '今日は、どれを学ぶ？ 読んだら戻って書き残そう。'
          : '学びたいことのリンクを置いておくと、書くことに困らなくなる。'))),

    list.length ? h('div', { class: 'portal__stats' },
      statChip('link', `リンク ${stats.count}`),
      statChip('external', `ひらいた ${stats.opens} 回`),
      statChip('notes', `ここから ${stats.notes} 件のメモ`)) : null,

    // 読んで戻ってきた直後は、書き残すところまでを一続きにする
    recentCard(store, list),

    suggestion ? suggestionCard(store, suggestion) : null,

    list.length
      ? h('div', { class: 'portal__grid' }, ...list.map((b) => bookmarkCard(store, b)))
      : emptyState(),

    h('div', { class: 'portal__foot' },
      button('リンクを追加', {
        className: 'btn btn--tonal btn--block',
        icon: icon('plus', { size: 18 }),
        onClick: () => openBookmarkDialog(store),
        disabled: list.length >= MAX_BOOKMARKS ? true : undefined,
      }),
      list.length >= MAX_BOOKMARKS
        ? h('p', { class: 'field__hint' }, `リンクは ${MAX_BOOKMARKS} 件までです。`)
        : null));
}

function statChip(name, label) {
  return h('span', { class: 'portal__stat' },
    h('span', { class: 'portal__stat-icon', html: icon(name, { size: 15 }) }), label);
}

function emptyState() {
  return h('div', { class: 'portal__empty' },
    h('p', { class: 'portal__empty-title' }, 'まだリンクがありません'),
    h('p', {}, '「学びたいけれど、まだ手を付けていないこと」を入れておくのがおすすめです。'),
    h('ul', { class: 'portal__ideas' },
      h('li', {}, 'よく読む解説サイトや、積んである記事'),
      h('li', {}, '学習サービス・講座の続きのページ'),
      h('li', {}, '聴きたい番組、見たい動画の一覧'),
      h('li', {}, '興味はあるけれど詳しくない分野の入口')));
}

/** さっき開いたリンク（読んで戻ってきた人を、書くところまで連れていく） */
function recentCard(store, list) {
  const limit = Date.now() - 60 * 60 * 1000;
  const recent = list
    .filter((b) => b.openedAt && Date.parse(b.openedAt) >= limit)
    .sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)))[0];
  if (!recent) return null;

  return h('div', { class: 'portal__recent' },
    h('span', { class: 'portal__recent-icon', html: icon('edit', { size: 18 }) }),
    h('div', { style: { flex: '1', minWidth: '0' } },
      h('div', { class: 'portal__recent-label' }, 'さっき開きました'),
      h('div', { class: 'portal__recent-title' }, recent.title)),
    button('メモする', {
      className: 'btn btn--sm',
      onClick: () => writeFrom(store, recent),
    }));
}

/** 「今日はこれ」— いちばん長く開いていないリンク */
function suggestionCard(store, bookmark) {
  const host = bookmarkHost(bookmark.url);
  return h('div', { class: 'portal__pick', 'data-color': bookmark.color },
    h('div', { class: 'portal__pick-label' },
      h('span', { html: icon('sparkle', { size: 16 }) }),
      bookmark.openedAt ? 'しばらく開いていません' : 'まだ開いていません'),
    h('div', { class: 'portal__pick-title' }, bookmarkInitial(bookmark), ' ', bookmark.title),
    bookmark.note ? h('p', { class: 'portal__pick-note' }, bookmark.note) : null,
    h('p', { class: 'portal__pick-meta' },
      host,
      bookmark.openedAt ? `・前回 ${formatRelative(localDayOf(bookmark.openedAt))}` : ''),
    h('div', { class: 'portal__pick-actions' },
      openLink(store, bookmark, { label: 'ひらく', className: 'btn btn--sm' }),
      button('メモする', {
        className: 'btn btn--text btn--sm',
        icon: icon('edit', { size: 18 }),
        onClick: () => writeFrom(store, bookmark),
      })));
}

/** リンク 1 件のカード */
function bookmarkCard(store, bookmark) {
  return h('div', { class: 'pcard', 'data-color': bookmark.color },
    openLink(store, bookmark, { className: 'pcard__open', card: true }),
    h('div', { class: 'pcard__foot' },
      h('span', { class: 'pcard__stats' },
        bookmark.opens ? `${bookmark.opens}回ひらいた` : 'まだ開いていない',
        bookmark.notes ? `・メモ${bookmark.notes}` : ''),
      iconButton(icon('edit', { size: 18 }), {
        label: `「${bookmark.title}」からメモを書く`,
        className: 'icon-btn icon-btn--sm',
        onClick: () => writeFrom(store, bookmark),
      }),
      iconButton(icon('more', { size: 18 }), {
        label: `「${bookmark.title}」の操作`,
        className: 'icon-btn icon-btn--sm',
        onClick: () => openBookmarkMenu(store, bookmark),
      })));
}

/**
 * リンクを開くところ。
 *
 * 押したときに数を数えるだけで、開くのはブラウザに任せる
 * （`target="_blank"` のまま。長押しからの「新しいタブで開く」も生きる）。
 */
function openLink(store, bookmark, { label, className = 'btn', card = false } = {}) {
  const onOpen = () => {
    store.markBookmarkOpened(bookmark.id);
    // 戻ってきたときに書き残せるよう、ひと声かけておく
    toast('読んだら、戻って書き残そう', {
      actionLabel: 'メモする',
      onAction: () => writeFrom(store, bookmark),
    });
  };

  const attrs = {
    class: className,
    href: bookmark.url,
    target: '_blank',
    rel: 'noopener noreferrer',
    onClick: onOpen,
    // 中クリックや長押しからの「新しいタブで開く」でも数える
    onAuxClick: (e) => { if (e.button === 1) onOpen(); },
  };

  if (!card) {
    return h('a', attrs,
      h('span', { class: 'btn__icon', html: icon('external', { size: 18 }) }),
      label || 'ひらく');
  }

  const host = bookmarkHost(bookmark.url);
  return h('a', attrs,
    h('span', { class: 'pcard__icon' }, bookmarkInitial(bookmark)),
    h('span', { class: 'pcard__text' },
      h('span', { class: 'pcard__title' }, bookmark.title),
      h('span', { class: 'pcard__host' }, host),
      bookmark.note ? h('span', { class: 'pcard__note' }, bookmark.note) : null));
}

/** このリンクから新しいメモを書き始める */
function writeFrom(store, bookmark) {
  openNoteEditor(store, { link: bookmark.id });
}

function openBookmarkMenu(store, bookmark) {
  const list = store.bookmarks;
  const at = list.findIndex((b) => b.id === bookmark.id);
  openMenu({
    title: bookmark.title,
    items: [
      {
        label: 'メモを書く',
        icon: icon('edit', { size: 20 }),
        description: 'このリンクを頭に置いた新しいメモ',
        onClick: () => writeFrom(store, bookmark),
      },
      { label: '編集する', icon: icon('settings', { size: 20 }), onClick: () => openBookmarkDialog(store, bookmark) },
      { divider: true },
      at > 0 ? {
        label: '上へ',
        icon: icon('upload', { size: 20 }),
        onClick: () => store.moveBookmark(bookmark.id, -1),
      } : null,
      at < list.length - 1 ? {
        label: '下へ',
        icon: icon('download', { size: 20 }),
        onClick: () => store.moveBookmark(bookmark.id, 1),
      } : null,
      { divider: true },
      {
        label: 'このリンクを消す',
        icon: icon('trash', { size: 20 }),
        danger: true,
        onClick: async () => {
          const ok = await confirmDialog({
            title: 'リンクを消しますか？',
            message: `「${bookmark.title}」をとびらから外します。メモは消えません。`,
            confirmLabel: '消す',
            danger: true,
          });
          if (!ok) return;
          const removed = store.removeBookmark(bookmark.id);
          if (!removed) return;
          toast('消しました', {
            actionLabel: '元に戻す',
            onAction: () => store.restoreBookmark(removed.bookmark, removed.index),
          });
        },
      },
    ].filter(Boolean),
  });
}

/* ------------------------------------------------------------------ */
/* 追加・編集                                                          */
/* ------------------------------------------------------------------ */

export function openBookmarkDialog(store, bookmark = null) {
  const draft = {
    url: bookmark?.url || '',
    title: bookmark?.title || '',
    note: bookmark?.note || '',
    emoji: bookmark?.emoji || '',
    color: bookmark?.color || 'blue',
  };

  const urlInput = h('input', {
    class: 'input',
    type: 'url',
    inputmode: 'url',
    placeholder: 'https://example.com/…',
    value: draft.url,
    onInput: (e) => { draft.url = e.target.value; },
  });
  const titleInput = h('input', {
    class: 'input',
    type: 'text',
    placeholder: '（空ならサイト名になります）',
    value: draft.title,
    onInput: (e) => { draft.title = e.target.value; },
  });
  const noteInput = h('input', {
    class: 'input',
    type: 'text',
    placeholder: '例: 週に 1 本ずつ読む',
    value: draft.note,
    onInput: (e) => { draft.note = e.target.value; },
  });
  const emojiInput = h('input', {
    class: 'input input--emoji',
    type: 'text',
    maxlength: '2',
    value: draft.emoji,
    'aria-label': 'アイコンの絵文字',
    onInput: (e) => { draft.emoji = e.target.value; },
  });

  const emojiRow = h('div', { class: 'portal__emoji' },
    ...EMOJI_CHOICES.map((char) => h('button', {
      type: 'button',
      class: 'portal__emoji-btn',
      onClick: () => { draft.emoji = char; emojiInput.value = char; },
    }, char)));

  const colorRow = h('div', { class: 'portal__colors' },
    ...INK_COLORS.map(({ id, label }) => {
      const btn = h('button', {
        type: 'button',
        class: 'portal__color',
        'data-color': id,
        'aria-label': label,
        title: label,
        'aria-pressed': draft.color === id ? 'true' : 'false',
        onClick: () => {
          draft.color = id;
          [...colorRow.children].forEach((el) => {
            el.setAttribute('aria-pressed', el.dataset.color === id ? 'true' : 'false');
          });
        },
      });
      return btn;
    }));

  const dialog = openDialog({
    title: bookmark ? 'リンクを編集' : 'リンクを追加',
    content: h('div', { class: 'portal__form' },
      field('リンク先', urlInput, 'ひらくと、いつも別のタブで開きます。'),
      field('名前', titleInput),
      field('ひとこと', noteInput, '「なぜ学びたいのか」を書いておくと、見たときに思い出せます。'),
      field('アイコン', h('div', { class: 'portal__emoji-wrap' }, emojiInput, emojiRow)),
      field('色', colorRow)),
    actions: [
      { label: 'キャンセル', className: 'btn btn--text', onClick: (close) => close() },
      {
        label: bookmark ? '保存' : '追加',
        className: 'btn',
        onClick: (close) => {
          const url = safeBookmarkUrl(draft.url);
          if (!url) {
            toast('リンク先を確かめてください（http:// か https://）');
            urlInput.focus();
            return;
          }
          const patch = { ...draft, url };
          const saved = bookmark
            ? store.updateBookmark(bookmark.id, patch)
            : store.addBookmark(patch);
          if (!saved) {
            toast(store.bookmarks.length >= MAX_BOOKMARKS
              ? `リンクは ${MAX_BOOKMARKS} 件までです`
              : '保存できませんでした');
            return;
          }
          toast(bookmark ? '直しました' : 'とびらに置きました');
          close();
        },
      },
    ],
  });
  setTimeout(() => urlInput.focus(), 50);
  return dialog;
}

function field(label, control, hint) {
  return h('label', { class: 'field' },
    h('span', { class: 'field__label' }, label),
    control,
    hint ? h('span', { class: 'field__hint' }, hint) : null);
}
