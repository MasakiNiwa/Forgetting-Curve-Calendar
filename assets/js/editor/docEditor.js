/**
 * 本文を書くための編集面。
 *
 * 中身は Tiptap（ProseMirror）。先人の作った道具に任せることで、
 * 日本語の変換（IME）・元に戻す・表の中の移動といった「自分で書くと必ず穴が空く」
 * ところを、まとめて任せられる。
 *
 * ここの役目は次の 3 つだけ:
 *   - 道具をあとから読み込む（読むだけの画面には持ち込まない）
 *   - アプリの言葉（太字・チェック・表…）を、道具の命令に置き換える
 *   - 検索・見出し・文字数のために、位置と文字を取り出す
 *
 * 本文の正本は文書データ（JSON）。素の文字は探すとき・数えるときに作る。
 */
import { docToText, normalizeDoc, textToDoc } from '../core/doc.js';

/** 道具の読み込みは 1 回だけ（2 つ目の編集画面でも待たない） */
let libraryPromise = null;

function loadLibrary() {
  if (!libraryPromise) {
    libraryPromise = import('../../vendor/tiptap.bundle.js').catch((error) => {
      // 次に開いたときは、もう一度試せるようにする
      libraryPromise = null;
      throw error;
    });
  }
  return libraryPromise;
}

/** 開いてよいリンクだけを通す */
export function safeLinkHref(href) {
  const url = String(href || '').trim();
  if (!url) return null;
  if (/^(https?:|mailto:)/i.test(url)) return url;
  // 「example.com」のように書かれたものは、http を足して開けるようにする
  if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(url)) return `https://${url}`;
  return null;
}

/**
 * 編集面を作る。
 * @param {HTMLElement} mount 置き場所
 * @param {object} options
 * @returns {Promise<object>} 使い方は下の handle を参照
 */
export async function createDocEditor(mount, {
  doc = null,
  text = '',
  editable = true,
  placeholder = '',
  onChange = () => {},
  onSelectionChange = () => {},
} = {}) {
  const lib = await loadLibrary();
  const { Editor, StarterKit, TaskList, TaskItem, Table, TableRow, TableCell, TableHeader, Placeholder } = lib;

  const extensions = [
    StarterKit.configure({
      // リンクは押しても飛ばない（書いている途中に画面が変わらないように）
      link: {
        openOnClick: false,
        autolink: true,
        protocols: ['http', 'https', 'mailto'],
        HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
      },
    }),
    // 済みに取り消し線を引くかどうかは、リストごとに選べるようにする
    TaskList.extend({
      addAttributes() {
        return {
          strike: {
            default: true,
            parseHTML: (el) => el.getAttribute('data-strike') !== 'false',
            renderHTML: (attrs) => ({ 'data-strike': attrs.strike === false ? 'false' : 'true' }),
          },
        };
      },
    }),
    TaskItem.configure({
      // チェックは入れ子にもできる（大きなやることの下に小さなやること）
      nested: true,
      // 読み上げの言葉も日本語にしておく
      a11y: {
        checkboxLabel: (node, checked) => (
          `${node.textContent || '空のチェック'}（${checked ? '済み' : '未'}）`
        ),
      },
    }),
    Table.configure({ resizable: false, allowTableNodeSelection: true }),
    TableRow,
    TableHeader,
    TableCell,
  ];
  if (placeholder) extensions.push(Placeholder.configure({ placeholder }));

  const content = normalizeDoc(doc) || textToDoc(text);

  const editor = new Editor({
    element: mount,
    extensions,
    content,
    editable,
    // 見た目は Markdown 表示と同じ流儀（.rt）に寄せる
    editorProps: {
      attributes: {
        class: 'rt',
        'aria-label': '本文',
        spellcheck: 'false',
      },
    },
    onUpdate: () => onChange(),
    onSelectionUpdate: () => onSelectionChange(),
  });

  /* --------------------------------------------------- 位置と文字 */

  /**
   * 文書の中の文字を 1 本に並べ、何文字目がどの位置かを覚えておく。
   * 検索と置換で「見つけた場所」を文書の位置に戻すために使う。
   */
  function flatten() {
    let flat = '';
    const map = [];
    editor.state.doc.descendants((node, pos) => {
      if (!node.isText) return;
      const value = node.text || '';
      for (let i = 0; i < value.length; i += 1) map.push(pos + i);
      flat += value;
    });
    return { flat, map };
  }

  const chain = () => editor.chain().focus();

  const handle = {
    element: mount,
    editor,

    /* ------------------------------------------- 出し入れ */

    getDoc() { return editor.getJSON(); },
    getText() { return docToText(editor.getJSON()); },
    setDoc(next) {
      editor.commands.setContent(normalizeDoc(next) || textToDoc(''), { emitUpdate: false });
    },
    isEmpty() { return editor.isEmpty; },

    focus({ end = false } = {}) {
      if (!editor.isEditable) return;
      editor.commands.focus(end ? 'end' : null);
    },
    // 書けるかどうかを切り替える。ここで「変わった」と言うと、
    // 見るだけのタブが保存をしにいってしまうので、知らせない
    setEditable(value) { editor.setEditable(value !== false, false); },
    destroy() { editor.destroy(); },

    /* ------------------------------------------- いまの状態 */

    state() {
      const heading = [1, 2, 3, 4, 5, 6].find((level) => editor.isActive('heading', { level })) || 0;
      return {
        bold: editor.isActive('bold'),
        italic: editor.isActive('italic'),
        strike: editor.isActive('strike'),
        code: editor.isActive('code'),
        link: editor.isActive('link'),
        heading,
        bullet: editor.isActive('bulletList'),
        ordered: editor.isActive('orderedList'),
        task: editor.isActive('taskList'),
        quote: editor.isActive('blockquote'),
        codeBlock: editor.isActive('codeBlock'),
        inTable: editor.isActive('table'),
        taskStrike: editor.getAttributes('taskList')?.strike !== false,
        canIndent: editor.can().sinkListItem('taskItem') || editor.can().sinkListItem('listItem'),
        canOutdent: editor.can().liftListItem('taskItem') || editor.can().liftListItem('listItem'),
        canUndo: editor.can().undo(),
        canRedo: editor.can().redo(),
      };
    },

    /** ステータスバーの数字（素の文字から数える＝保存されるものと同じ） */
    stats() {
      const text = handle.getText();
      const { from, to } = editor.state.selection;
      const selected = from === to ? 0 : editor.state.doc.textBetween(from, to, '\n', '\n').length;
      return {
        chars: text.length,
        lines: text ? text.split('\n').length : 0,
        selected,
      };
    },

    /* ------------------------------------------- 命令 */

    commands: {
      undo: () => chain().undo().run(),
      redo: () => chain().redo().run(),
      bold: () => chain().toggleBold().run(),
      italic: () => chain().toggleItalic().run(),
      strike: () => chain().toggleStrike().run(),
      code: () => chain().toggleCode().run(),
      heading: (level = 2) => chain().toggleHeading({ level }).run(),
      bullet: () => chain().toggleBulletList().run(),
      ordered: () => chain().toggleOrderedList().run(),
      task: () => chain().toggleTaskList().run(),
      quote: () => chain().toggleBlockquote().run(),
      codeBlock: () => chain().toggleCodeBlock().run(),
      rule: () => chain().setHorizontalRule().run(),
      table: () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
      /** ふつうの文章に戻す（見出し・引用・リストをほどく） */
      plain: () => chain().clearNodes().run(),
      /** 同じ項目・同じ段落の中で行を分ける */
      lineBreak: () => chain().setHardBreak().run(),
      /** リストの字下げ（チェックでも箇条書きでも効くように両方試す） */
      indent: () => (editor.can().sinkListItem('taskItem')
        ? chain().sinkListItem('taskItem').run()
        : chain().sinkListItem('listItem').run()),
      outdent: () => (editor.can().liftListItem('taskItem')
        ? chain().liftListItem('taskItem').run()
        : chain().liftListItem('listItem').run()),
      /** 済みのチェックに取り消し線を引くか（いま居るリストの決めごと） */
      taskStrike: (value) => chain().updateAttributes('taskList', { strike: value !== false }).run(),
      addRow: () => chain().addRowAfter().run(),
      addColumn: () => chain().addColumnAfter().run(),
      removeRow: () => chain().deleteRow().run(),
      removeColumn: () => chain().deleteColumn().run(),
      removeTable: () => chain().deleteTable().run(),
      unlink: () => chain().unsetLink().run(),
      /** 選んだ文字をリンクにする（選んでいなければ URL を文字として置く） */
      link: (href) => {
        const url = safeLinkHref(href);
        if (!url) return false;
        const { empty } = editor.state.selection;
        if (empty) {
          return chain().insertContent({
            type: 'text',
            text: url,
            marks: [{ type: 'link', attrs: { href: url } }],
          }).run();
        }
        return chain().setLink({ href: url }).run();
      },
      /** 日時を書き入れる（メモの区切りに使う） */
      timestamp: (value) => chain().insertContent(value).run(),
    },

    /* ------------------------------------------- 見出し */

    headings() {
      const out = [];
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'heading') return;
        out.push({ level: node.attrs?.level || 1, text: node.textContent, pos });
      });
      return out;
    },
    goTo(pos) {
      handle.select(pos + 1);
    },

    /* ------------------------------------------- カーソル */

    selection() {
      const { from, to } = editor.state.selection;
      return { from, to };
    },
    /** カーソルを置く（保存されていた位置が今の文書より先でも落ちないように丸める） */
    select(from, to = from) {
      const max = editor.state.doc.content.size;
      const start = Math.max(0, Math.min(Number(from) || 0, max));
      const end = Math.max(start, Math.min(Number(to) || start, max));
      try {
        editor.chain().focus().setTextSelection({ from: start, to: end }).scrollIntoView().run();
      } catch { /* 位置が使えなければ、そのままにする */ }
    },
    scrollCaret() {
      try { editor.commands.scrollIntoView(); } catch { /* noop */ }
    },

    /* ------------------------------------------- 検索と置換 */

    /** カーソルの先から次を探す（見つからなければ先頭から） */
    findNext(query) {
      if (!query) return null;
      const { flat, map } = flatten();
      const { to } = editor.state.selection;
      // いまのカーソルより後ろにある文字から探す
      let start = map.findIndex((pos) => pos >= to);
      if (start < 0) start = flat.length;
      let at = flat.indexOf(query, start);
      if (at === -1) at = flat.indexOf(query, 0);
      if (at === -1) return null;
      const range = { from: map[at], to: map[at + query.length - 1] + 1 };
      editor.chain().focus().setTextSelection(range).scrollIntoView().run();
      return range;
    },

    /** 選んでいるところが検索語と同じなら置き換える */
    replaceCurrent(query, replacement) {
      if (!query) return false;
      const { from, to } = editor.state.selection;
      if (from === to) return false;
      if (editor.state.doc.textBetween(from, to, '', '') !== query) return false;
      editor.chain().focus().insertContentAt({ from, to }, replacement || '').run();
      return true;
    },

    /** すべて置き換える（1 回の「元に戻す」で戻せる） */
    replaceAll(query, replacement) {
      if (!query) return 0;
      const { flat, map } = flatten();
      const ranges = [];
      let at = flat.indexOf(query);
      while (at !== -1) {
        ranges.push({ from: map[at], to: map[at + query.length - 1] + 1 });
        at = flat.indexOf(query, at + query.length);
      }
      if (!ranges.length) return 0;
      const tr = editor.state.tr;
      // 後ろから直すと、前の位置がずれない
      ranges.reverse().forEach(({ from, to }) => {
        if (replacement) tr.insertText(replacement, from, to);
        else tr.delete(from, to);
      });
      editor.view.dispatch(tr);
      return ranges.length;
    },
  };

  return handle;
}
