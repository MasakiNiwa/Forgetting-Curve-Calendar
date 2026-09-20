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
import { fold, foldText } from '../core/search.js';

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
  const {
    Editor, Extension, StarterKit, TaskList, TaskItem,
    Table, TableRow, TableCell, TableHeader, Placeholder,
    Plugin, PluginKey, Decoration, DecorationSet,
  } = lib;

  /**
   * 見つかったところに色を置く。
   *
   * 文字そのものには触らない（飾りを 1 枚かぶせるだけ）ので、
   * 探している最中に本文が書き換わることはない＝「元に戻す」にも残らない。
   */
  const findKey = new PluginKey('fccFind');
  const FindHighlight = Extension.create({
    name: 'fccFindHighlight',
    addProseMirrorPlugins() {
      return [new Plugin({
        key: findKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const next = tr.getMeta(findKey);
            if (next) return next;
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: { decorations: (state) => findKey.getState(state) },
      })];
    },
  });

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
  extensions.push(FindHighlight);
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
  /**
   * 行やマスの切れ目に挟む印。
   * 探す言葉には出てこない文字なので、これをまたいで当たることはない。
   */
  const GAP = '\u0000';

  function flatten() {
    let flat = '';
    const map = [];
    let lastParent = null;
    editor.state.doc.descendants((node, pos, parent) => {
      // 行を分けたところ（Shift+Enter）は、別の行として扱う
      if (node.type.name === 'hardBreak') {
        flat += GAP;
        map.push(pos);
        lastParent = parent;
        return;
      }
      if (!node.isText) return;
      // 段落・マス・項目が変わったら、そこは続いていない
      if (lastParent && parent !== lastParent) {
        flat += GAP;
        map.push(pos);
      }
      lastParent = parent;
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

    /**
     * 見つかったところを全部返す。
     *
     * ふだんは「そろえて」探す（大文字小文字・全角半角・カタカナひらがなを同じに扱う）。
     * メモを探すとき（core/search.js）と同じそろえ方なので、
     * 一覧で見つかったメモを開いて、同じ言葉で探し直しても取りこぼさない。
     */
    findMatches(query, { exact = false } = {}) {
      const needle = String(query ?? '');
      if (!needle) return [];
      const { flat, map } = flatten();
      const ranges = [];
      if (exact) {
        let at = flat.indexOf(needle);
        while (at !== -1) {
          ranges.push({ from: map[at], to: map[at + needle.length - 1] + 1 });
          at = flat.indexOf(needle, at + needle.length);
        }
        return ranges;
      }
      // そろえた形で探し、当たった場所を元の文字へ戻す
      const folded = fold(flat);
      const q = foldText(needle);
      if (!q) return [];
      let at = folded.text.indexOf(q);
      while (at !== -1) {
        const fromFlat = folded.map[at];
        const toFlat = folded.map[at + q.length];
        if (fromFlat === undefined || toFlat === undefined || toFlat <= fromFlat) break;
        ranges.push({ from: map[fromFlat], to: map[toFlat - 1] + 1 });
        at = folded.text.indexOf(q, at + q.length);
      }
      return ranges;
    },

    /** いまのカーソルのすぐ後ろにある当たりは何番目か */
    matchIndexAfterCaret(ranges) {
      const { to } = editor.state.selection;
      const found = ranges.findIndex((r) => r.from >= to - 1);
      return found === -1 ? 0 : found;
    },

    /** 当たったところに色を置く（本文は書き換えない） */
    highlight(ranges, current = -1) {
      const decos = ranges.map((r, i) => Decoration.inline(r.from, r.to, {
        class: i === current ? 'fcc-find fcc-find--on' : 'fcc-find',
      }));
      const set = decos.length ? DecorationSet.create(editor.state.doc, decos) : DecorationSet.empty;
      editor.view.dispatch(editor.state.tr.setMeta(findKey, set));
    },

    clearHighlight() {
      editor.view.dispatch(editor.state.tr.setMeta(findKey, DecorationSet.empty));
    },

    /**
     * その場所を画面に入れる（カーソルは動かさない）。
     * 探している最中は入力欄にカーソルを置いたままにしたいので、選び直さない。
     */
    revealRange(range) {
      if (!range) return;
      let coords;
      try { coords = editor.view.coordsAtPos(range.from); } catch { return; }
      let el = mount.parentElement;
      while (el && el !== document.body) {
        const style = window.getComputedStyle(el);
        if (/(auto|scroll)/.test(style.overflowY)) break;
        el = el.parentElement;
      }
      const margin = 80;
      if (!el || el === document.body) {
        if (coords.top < margin || coords.bottom > window.innerHeight - margin) {
          window.scrollBy(0, coords.top - window.innerHeight / 2);
        }
        return;
      }
      const rect = el.getBoundingClientRect();
      if (coords.top < rect.top + margin) el.scrollTop -= (rect.top + margin) - coords.top;
      else if (coords.bottom > rect.bottom - margin) el.scrollTop += coords.bottom - (rect.bottom - margin);
    },

    /**
     * そこへカーソルを移す（検索を閉じるときなど）。
     * 選んだままにせず、見つけた言葉の後ろに置く。
     * 選択のまま閉じると、次に打った 1 文字でその言葉が消えてしまうため。
     */
    placeCaret(range) {
      if (!range) return;
      handle.select(range.to, range.to);
    },

    /** その 1 か所を置き換える */
    replaceRange(range, replacement) {
      if (!range) return false;
      const tr = editor.state.tr;
      if (replacement) tr.insertText(replacement, range.from, range.to);
      else tr.delete(range.from, range.to);
      editor.view.dispatch(tr);
      return true;
    },

    /** すべて置き換える（1 回の「元に戻す」で戻せる） */
    replaceRanges(ranges, replacement) {
      if (!ranges?.length) return 0;
      const tr = editor.state.tr;
      // 後ろから直すと、前の位置がずれない
      [...ranges].reverse().forEach(({ from, to }) => {
        if (replacement) tr.insertText(replacement, from, to);
        else tr.delete(from, to);
      });
      editor.view.dispatch(tr);
      return ranges.length;
    },
  };

  return handle;
}
