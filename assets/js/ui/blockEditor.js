/**
 * 見たままの編集（かたまり単位）。
 *
 * 本文は素の Markdown のまま持ちながら、画面では読む形で見せて、
 * 触ったところだけを書き換えられるようにする。
 *
 * - 文章・見出し・箇条書き・引用・コードは、そのかたまりの元の文字を出して直す
 *   （記法を覚えていなくても、書いてあるとおりに直せる）
 * - 表はマス目で直せる。行・列の足し引きもボタンでできる
 * - チェックは、押すだけで入る／外れる
 * - 「＋」で新しいかたまりを足す（文章・見出し・箇条書き・チェック・表・引用・コード・区切り線）
 *
 * 記法でしか書けないもの（入れ子の細かい調整など）は、
 * 上のツールバーから「ソース」に切り替えて直す。
 */
import { h, append, clear, iconButton } from './dom.js';
import { icon } from './icons.js';
import { openMenu } from './overlays.js';
import { blockView } from './markdownView.js';
import {
  BLOCK_TEMPLATES, blocksOf, insertBlock, lineCount, moveBlock, removeBlock, replaceLines,
  tableOf, tableToMarkdown, tableWithColumn, tableWithRow, tableWithoutColumn, tableWithoutRow,
  toggleCheck,
} from '../core/blocks.js';

const LABELS = {
  heading: '見出し',
  paragraph: '文章',
  list: '箇条書き',
  quote: '引用',
  code: 'コード',
  table: '表',
  rule: '区切り線',
};

function autoGrow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}

/**
 * @param {{getText:Function, setText:Function, onEditingChange?:Function}} options
 *   getText: いまの本文 / setText: 書き換えた本文を渡す
 */
export function createBlockEditor({ getText, setText, onEditingChange }) {
  const root = h('div', { class: 'be' });
  /** いま開いているかたまりの番号（閉じているときは null） */
  let editingIndex = null;
  let blocks = [];
  /**
   * 描き直している最中か。
   * 描き直しで入力欄が外れると blur が起き、そこからまた描き直しが呼ばれる。
   * 二重に走ると DOM の取り外しがぶつかるので、内側の呼び出しは見送る。
   */
  let rendering = false;

  const apply = (next, { keepEditing = false } = {}) => {
    setText(next);
    if (!keepEditing) editingIndex = null;
    render();
  };

  /* ---------------------------------------------------------- 表の編集 */

  function tableEditor(block, range) {
    const wrap = h('div', { class: 'be__table' });
    let table = tableOf(block);
    let focus = { row: -1, col: 0 };   // -1 は見出しの行

    const push = () => {
      const md = tableToMarkdown(table);
      setText(replaceLines(getText(), range.start, range.end, md));
      // 行や列が増えると長さが変わるので、次に書くときの範囲を合わせ直す
      range.end = range.start + lineCount(md);
    };

    const cell = (value, row, col) => h('input', {
      class: `be__cell ${row < 0 ? 'be__cell--head' : ''}`.trim(),
      value,
      'aria-label': row < 0 ? `見出し ${col + 1} 列目` : `${row + 1} 行 ${col + 1} 列`,
      onFocus: () => { focus = { row, col }; },
      onInput: (e) => {
        if (row < 0) table.head[col] = e.target.value;
        else table.rows[row][col] = e.target.value;
        push();
      },
    });

    const draw = () => {
      const grid = h('div', {
        class: 'be__grid',
        style: { gridTemplateColumns: `repeat(${table.head.length}, minmax(6.5em, 1fr))` },
      });
      table.head.forEach((v, col) => grid.appendChild(cell(v, -1, col)));
      table.rows.forEach((row, r) => row.forEach((v, col) => grid.appendChild(cell(v, r, col))));
      const tools = h('div', { class: 'be__tools be__tools--table' },
        toolButton('plus', '行を追加', () => { table = tableWithRow(table, focus.row < 0 ? table.rows.length : focus.row + 1); push(); draw(); }),
        toolButton('plus', '列を追加', () => { table = tableWithColumn(table, focus.col + 1); push(); draw(); }),
        toolButton('trash', '行を削除', () => {
          if (focus.row < 0) return;
          table = tableWithoutRow(table, focus.row);
          focus = { row: -1, col: focus.col };
          push(); draw();
        }),
        toolButton('trash', '列を削除', () => { table = tableWithoutColumn(table, focus.col); focus = { row: focus.row, col: 0 }; push(); draw(); }));
      append(clear(wrap), [tools, grid]);
    };
    draw();
    return wrap;
  }

  /** @param {{compact?:boolean}} options compact は絵だけ（場所を取らないように） */
  function toolButton(name, label, onClick, { compact = false } = {}) {
    return h('button', {
      type: 'button',
      class: `be__tool ${compact ? 'be__tool--icon' : ''}`.trim(),
      'aria-label': label,
      title: label,
      // 押したときにキーボードが閉じないようにする
      onMouseDown: (e) => e.preventDefault(),
      onClick: (e) => { e.stopPropagation(); onClick(); },
    },
    h('span', { class: 'be__tool-icon', html: icon(name, { size: 18 }) }),
    compact ? null : h('span', {}, label));
  }

  /* -------------------------------------------------- かたまりのしまい */

  /** いまの本文から、編集中のかたまりを引き直す（書いている途中で行がずれるため） */
  function liveBlock(range) {
    const list = blocksOf(getText());
    const index = list.findIndex((b) => b.start === range.start);
    return { list, index, block: index === -1 ? null : list[index] };
  }

  function blockTools(range) {
    const act = (fn) => {
      const { list, index, block } = liveBlock(range);
      if (!block) { editingIndex = null; render(); return; }
      fn({ list, index, block });
    };
    return h('div', { class: 'be__tools' },
      toolButton('check', '編集を終える', () => { editingIndex = null; render(); }),
      toolButton('chevronLeft', '上へ動かす', () => act(({ list, index }) => apply(moveBlock(getText(), list, index, -1))), { compact: true }),
      toolButton('chevronDown', '下へ動かす', () => act(({ list, index }) => apply(moveBlock(getText(), list, index, 1))), { compact: true }),
      toolButton('plus', '下に足す', () => act(({ block }) => addBlock(block)), { compact: true }),
      toolButton('trash', '削除', () => act(({ block }) => apply(removeBlock(getText(), block))), { compact: true }));
  }

  function editorFor(block) {
    const wrap = h('div', { class: 'be__edit' });
    // 書いているあいだに行数が変わるので、いまの範囲を持ち歩く
    const range = { start: block.start, end: block.end };
    wrap.appendChild(blockTools(range));
    if (block.type === 'table') {
      wrap.appendChild(tableEditor(block, range));
      return wrap;
    }
    const textarea = h('textarea', {
      class: 'be__source',
      spellcheck: 'false',
      'aria-label': `${LABELS[block.type] || 'かたまり'}の中身`,
      onInput: (e) => {
        setText(replaceLines(getText(), range.start, range.end, e.target.value));
        range.end = range.start + lineCount(e.target.value);
        autoGrow(e.target);
      },
      onKeyDown: (e) => {
        if (e.key === 'Escape') { e.preventDefault(); editingIndex = null; render(); }
      },
    });
    textarea.value = block.source;
    wrap.appendChild(textarea);
    setTimeout(() => {
      autoGrow(textarea);
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }, 0);
    return wrap;
  }

  /* ------------------------------------------------------ 見ている状態 */

  function displayFor(block, index) {
    const view = blockView(block);
    if (!view) return null;
    // チェックは、押すだけで入る／外れる（編集に入らない）
    if (block.type === 'list') {
      const boxes = [...view.querySelectorAll('.md__box')];
      let at = 0;
      const withLine = block.items.filter((i) => i.checked === true || i.checked === false);
      boxes.forEach((box) => {
        const item = withLine[at];
        at += 1;
        if (!item) return;
        const button = h('button', {
          type: 'button',
          class: 'md__box be__check',
          'aria-label': item.checked ? 'チェックを外す' : 'チェックを入れる',
          onClick: (e) => { e.stopPropagation(); apply(toggleCheck(getText(), item.line)); },
        }, item.checked ? '☑' : '☐');
        box.replaceWith(button);
      });
    }
    return h('div', {
      class: 'be__view',
      role: 'button',
      tabindex: '0',
      'aria-label': `${LABELS[block.type] || 'かたまり'}を編集`,
      onClick: () => { editingIndex = index; render(); },
      onKeyDown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); editingIndex = index; render(); }
      },
    }, view);
  }

  /* ------------------------------------------------------------ 足す */

  function addBlock(after) {
    openMenu({
      title: '何を足しますか？',
      items: BLOCK_TEMPLATES.map((t) => ({
        label: t.label,
        icon: icon(t.icon, { size: 20 }),
        onClick: () => {
          const text = getText();
          const next = insertBlock(text, after, t.source);
          setText(next);
          const list = blocksOf(next);
          // 足したかたまりを、そのまま開く
          const at = after
            ? list.findIndex((b) => b.start >= after.end && b.source.trim() === t.source.trim())
            : list.length - 1;
          editingIndex = at === -1 ? null : at;
          render();
        },
      })),
    });
  }

  /* ---------------------------------------------------------- 描き直し */

  function render() {
    if (rendering) return;
    rendering = true;
    try {
      draw();
    } finally {
      rendering = false;
    }
  }

  function draw() {
    blocks = blocksOf(getText());
    clear(root);
    // まだ何も書かれていないときは、そのまま書き始められるようにする
    if (!blocks.length) { renderEmptyEditor(); return; }
    blocks.forEach((block, index) => {
      const el = h('div', { class: `be__block ${index === editingIndex ? 'be__block--editing' : ''}`.trim() });
      el.appendChild(index === editingIndex ? editorFor(block) : displayFor(block, index));
      root.appendChild(el);
    });
    root.appendChild(h('button', {
      type: 'button',
      class: 'be__add',
      onClick: () => addBlock(null),
    }, h('span', { class: 'be__add-icon', html: icon('plus', { size: 18 }) }), '足す'));
    onEditingChange?.(editingIndex !== null);
  }

  /**
   * 何も無いところから書き始めるとき。
   * かたまりが 1 つも無い状態では、ふつうの入力欄として出す
   * （新しいメモを開いて、そのまま書き出せるように）。
   */
  function renderEmptyEditor() {
    const textarea = h('textarea', {
      class: 'be__source',
      'aria-label': '本文',
      placeholder: '書き始めてください。',
      onInput: (e) => {
        setText(e.target.value);
        autoGrow(e.target);
        // 空行で区切ったら、そこまでを見たままの形にする
        if (/\n\s*\n/.test(e.target.value)) render();
      },
      // 書き終えて離れたら、見たままの形にし直す
      onBlur: () => { if (getText().trim()) render(); },
    });
    root.appendChild(h('div', { class: 'be__block be__block--editing' },
      h('div', { class: 'be__edit' }, textarea)));
    onEditingChange?.(true);
  }

  return {
    element: root,
    render,
    /** いまどこかを開いているか（開いていると、外からの描き直しは控える） */
    isEditing: () => editingIndex !== null,
    closeEditing: () => { if (editingIndex !== null) { editingIndex = null; render(); } },
  };
}
