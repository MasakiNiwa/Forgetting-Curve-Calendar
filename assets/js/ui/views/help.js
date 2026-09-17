/** ヘルプ画面（使い方・バージョン情報・リポジトリリンク） */
import { h, button } from '../dom.js';
import { icon } from '../icons.js';
import { curvePreview } from '../components.js';
import { openNoteEditor } from '../editor.js';
import { APP_NAME, APP_TAGLINE, APP_VERSION, RELEASE_DATE, REPO_URL, ISSUES_URL, SCHEMA_VERSION } from '../../core/config.js';
import { PRESETS, RATINGS } from '../../core/curve.js';

export function renderHelp(store) {
  const root = h('div', { class: 'page page--narrow' });

  root.appendChild(h('div', { class: 'page__header' },
    h('h1', { class: 'page__title' }, 'ヘルプ'),
    h('div', { class: 'page__subtitle' }, `${APP_NAME}の使い方`)));

  /* ---------------- はじめに ---------------- */
  root.appendChild(h('section', {
    class: 'card',
    style: { background: 'var(--fcc-primary-container)', color: 'var(--fcc-on-primary-container)' },
  },
  h('div', { class: 'card__title' },
    h('span', { html: icon('curve', { size: 20 }), style: { display: 'flex' } }),
    APP_TAGLINE),
  h('p', { style: { fontSize: '.88rem', margin: '4px 0 0' } },
    '人は覚えたことを翌日には半分以上忘れます。このアプリは「忘れる前提」で、'
    + 'その日書いたメモを忘却曲線に沿った日付へ自動的に配置します。'
    + 'カレンダーを開けば、その日に思い出し直すべきメモが積み上がっています。')));

  /* ---------------- 使い方 ---------------- */
  root.appendChild(h('section', { class: 'card' },
    h('div', { class: 'help-section' },
      h('h3', {}, h('span', { html: icon('play', { size: 18 }), style: { display: 'flex' } }), '使い方'),
      h('ol', {},
        h('li', {}, '右下の「＋」ボタンからメモを書きます。'),
        h('li', {}, '保存すると、1日後・3日後・7日後…と未来の日付に復習が自動で並びます。'),
        h('li', {}, 'カレンダーで日付を選ぶと、その日に思い出し直すメモの一覧が出ます。'),
        h('li', {}, 'メモを読む前に内容を思い出し、答え合わせをしてから'
          + '「覚えていた / あいまい / 忘れた」を記録します。'),
        h('li', {}, '記録に応じて、残りの復習日が自動で調整されます。'))),
    button('さっそくメモを書く', {
      className: 'btn btn--block',
      icon: icon('plus', { size: 18 }),
      onClick: () => openNoteEditor(store),
    })));

  /* ---------------- 忘却曲線 ---------------- */
  const preset = PRESETS[0];
  root.appendChild(h('section', { class: 'card' },
    h('div', { class: 'help-section' },
      h('h3', {}, h('span', { html: icon('curve', { size: 18 }), style: { display: 'flex' } }), '忘却曲線のしくみ'),
      h('p', {}, '記憶は時間とともに薄れますが、薄れかけたところで思い出すと保持期間が伸びます。'
        + '下のグラフは、復習のたびに記憶の減り方がゆるやかになる様子を表しています。'),
      curvePreview(preset.intervals),
      h('p', { style: { marginTop: '8px' } }, `標準プリセットでは ${preset.intervals.map((d) => `${d}日後`).join('、')} の計 ${preset.intervals.length} 回の復習が設定されます。`),
      h('p', {}, 'プリセットは設定画面で変更できます。メモごとに個別の曲線を設定することもできます。'),
      h('table', { class: 'help-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'プリセット'), h('th', {}, '回数'), h('th', {}, '内容'))),
        h('tbody', {}, ...PRESETS.filter((p) => p.id !== 'custom').map((p) => h('tr', {},
          h('td', {}, p.name),
          h('td', {}, `${p.intervals.length}回`),
          h('td', {}, `${p.intervals.join(' / ')} 日後`))))))));

  /* ---------------- 想起の記録 ---------------- */
  root.appendChild(h('section', { class: 'card' },
    h('div', { class: 'help-section' },
      h('h3', {}, h('span', { html: icon('target', { size: 18 }), style: { display: 'flex' } }), '3 つの記録ボタン'),
      h('table', { class: 'help-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'ボタン'), h('th', {}, '記録後の動き'))),
        h('tbody', {},
          h('tr', {}, h('td', {}, RATINGS.known.label), h('td', {}, '次の復習へ進みます。間隔は少し広がります。')),
          h('tr', {}, h('td', {}, RATINGS.vague.label), h('td', {}, '同じ段階の復習を短い間隔でもう一度挟みます。')),
          h('tr', {}, h('td', {}, RATINGS.forgot.label), h('td', {}, '今日を起点に、曲線を最初から組み直します。')))),
      h('p', { class: 'field__hint' }, '設定の「想起の結果で間隔を調整する」をオフにすると、間隔は固定されます。'))));

  /* ---------------- 追加メモ ---------------- */
  root.appendChild(h('section', { class: 'card' },
    h('div', { class: 'help-section' },
      h('h3', {}, h('span', { html: icon('branch', { size: 18 }), style: { display: 'flex' } }), '追加メモ'),
      h('p', {}, '復習中に気づいたこと、補足、関連知識は「追加メモ」として元のメモに紐付けられます。'),
      h('p', {}, '追加メモはそれ自身の忘却曲線を持つため、'
        + '書いた日を起点に新しい復習がカレンダーへ積み上がっていきます。'),
      h('p', { class: 'field__hint' }, 'メモの「⋮」メニュー、または詳細画面の「追加メモ」ボタンから作成できます。'))));

  /* ---------------- データ ---------------- */
  root.appendChild(h('section', { class: 'card' },
    h('div', { class: 'help-section' },
      h('h3', {}, h('span', { html: icon('data', { size: 18 }), style: { display: 'flex' } }), 'データの保存とバックアップ'),
      h('ul', {},
        h('li', {}, 'データはお使いの端末のブラウザ内だけに保存されます。サーバーへは送信されません。'),
        h('li', {}, 'ブラウザの履歴削除やシークレットモードではデータが消えることがあります。'),
        h('li', {}, '設定画面から JSON 形式の完全バックアップを保存・復元できます。'),
        h('li', {}, 'メモは Markdown / テキスト / CSV / JSON で書き出せます。')),
      h('p', { class: 'field__hint' }, '別の端末へ移すときは、バックアップを保存してから移行先で復元してください。'))));

  /* ---------------- よくある質問 ---------------- */
  root.appendChild(h('section', { class: 'card' },
    h('div', { class: 'help-section' },
      h('h3', {}, h('span', { html: icon('help', { size: 18 }), style: { display: 'flex' } }), 'よくある質問'),
      faq('復習をためてしまいました。', '設定の「期限切れを今日に繰り越す」が有効なら、'
        + 'やり残した復習は今日のタスクの先頭にまとめて表示されます。多すぎるときは「忘れた」を選んで組み直すか、'
        + 'メモの「⋮」→「復習を今日からやり直す」でリセットできます。'),
      faq('復習が全部終わったメモはどうなりますか？', '「定着」として扱われ、カレンダーからは外れます。'
        + '一覧の「定着」タブから確認でき、「もう一周する」でいつでも再開できます。'),
      faq('通知は来ますか？', 'v0.1 では通知機能はありません。今後のバージョンで、'
        + 'ホーム画面に追加できる PWA 化と合わせて対応を予定しています。'))));

  /* ---------------- バージョン情報 ---------------- */
  root.appendChild(h('section', { class: 'card' },
    h('div', { class: 'card__title' },
      h('span', { html: icon('info', { size: 18 }), style: { display: 'flex' } }), 'バージョン情報'),
    h('div', { class: 'version-row' },
      h('span', { class: 'version-row__key' }, 'アプリ名'),
      h('span', { class: 'version-row__value' }, APP_NAME)),
    h('div', { class: 'version-row' },
      h('span', { class: 'version-row__key' }, 'バージョン'),
      h('span', { class: 'version-row__value' }, `v${APP_VERSION}`)),
    h('div', { class: 'version-row' },
      h('span', { class: 'version-row__key' }, 'リリース日'),
      h('span', { class: 'version-row__value' }, RELEASE_DATE)),
    h('div', { class: 'version-row' },
      h('span', { class: 'version-row__key' }, 'データ形式'),
      h('span', { class: 'version-row__value' }, `schema v${SCHEMA_VERSION}`)),
    h('div', { class: 'divider' }),
    h('div', { class: 'note-card__actions', style: { marginTop: '0' } },
      h('a', {
        class: 'btn btn--tonal',
        href: REPO_URL,
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      h('span', { html: icon('external', { size: 18 }), style: { display: 'flex' } }),
      'GitHub リポジトリ'),
      h('a', {
        class: 'btn btn--text',
        href: ISSUES_URL,
        target: '_blank',
        rel: 'noopener noreferrer',
      }, '不具合・要望を送る')),
    h('div', { class: 'field__hint', style: { marginTop: '10px' } },
      'MIT License ・ 依存ライブラリなしの静的サイトとして GitHub Pages で公開しています。')));

  return root;
}

function faq(question, answer) {
  return h('details', { style: { marginBottom: '8px' } },
    h('summary', { style: { cursor: 'pointer', fontWeight: '600', fontSize: '.88rem', padding: '6px 0' } }, question),
    h('p', { style: { margin: '4px 0 8px' } }, answer));
}
