/**
 * 文字の色とマーカー（編集面に足す飾り）。
 *
 * Tiptap の用意している色の拡張は、`style="color: #ff0000"` のように
 * 値をそのまま本文へ書き込む。この形だと
 *   - 暗い配色のときに読めない色が残る
 *   - 外から貼り付けた本文に、好きな CSS が入り込む
 * の 2 つが困るので、**名前だけ**を持つ飾りを自分で用意している。
 *
 * 名前と色の対応は CSS（`.rt-ink--red` など）が持つ。
 * 明るい配色・暗い配色で、それぞれ読める色に置き換わる。
 *
 * 外のサイトから貼り付けた文字（`color:` や `<mark>`、背景色）は、
 * いちばん近い名前に寄せてから受け取る（core/inks.js）。
 */
import { isInk, isMarker, nearestInk, nearestMarker } from '../core/inks.js';

/** その要素が持っている「文字の色」を、名前にして返す */
function readInk(el) {
  if (!el || typeof el.getAttribute !== 'function') return null;
  const named = el.getAttribute('data-ink');
  if (isInk(named)) return named;
  return nearestInk(el.style?.color) || nearestInk(el.getAttribute('color'));
}

/** その要素が持っている「マーカーの色」を、名前にして返す */
function readMarker(el) {
  if (!el || typeof el.getAttribute !== 'function') return null;
  const named = el.getAttribute('data-marker');
  if (isMarker(named)) return named;
  const style = el.style || {};
  const found = nearestMarker(style.backgroundColor) || nearestMarker(style.background);
  if (found) return found;
  // <mark> は色の指定が無くても「マーカー」なので、既定の黄にする
  return el.tagName === 'MARK' ? 'yellow' : null;
}

/**
 * 文字の色とマーカーの飾りを作る。
 * @param {object} lib vendor/tiptap.bundle.js
 */
export function createTextMarks({ Mark, mergeAttributes }) {
  const TextColor = Mark.create({
    name: 'textColor',

    addAttributes() {
      return {
        color: {
          default: null,
          parseHTML: (el) => readInk(el),
          renderHTML: (attrs) => (isInk(attrs.color)
            ? { 'data-ink': attrs.color, class: `rt-ink rt-ink--${attrs.color}` }
            : {}),
        },
      };
    },

    parseHTML() {
      return [
        { tag: 'span[data-ink]', getAttrs: (el) => (readInk(el) ? {} : false) },
        { tag: 'span[style]', getAttrs: (el) => (readInk(el) ? {} : false) },
        { tag: 'font', getAttrs: (el) => (readInk(el) ? {} : false) },
      ];
    },

    renderHTML({ HTMLAttributes }) {
      return ['span', mergeAttributes(HTMLAttributes), 0];
    },

    addCommands() {
      return {
        setInk: (color) => ({ commands }) => (
          isInk(color) ? commands.setMark(this.name, { color }) : false
        ),
        unsetInk: () => ({ commands }) => commands.unsetMark(this.name),
      };
    },
  });

  const Marker = Mark.create({
    name: 'marker',

    addAttributes() {
      return {
        color: {
          default: 'yellow',
          parseHTML: (el) => readMarker(el),
          renderHTML: (attrs) => {
            const color = isMarker(attrs.color) ? attrs.color : 'yellow';
            return { 'data-marker': color, class: `rt-marker rt-marker--${color}` };
          },
        },
      };
    },

    parseHTML() {
      return [
        { tag: 'mark' },
        { tag: 'span[data-marker]', getAttrs: (el) => (readMarker(el) ? {} : false) },
        { tag: 'span[style]', getAttrs: (el) => (readMarker(el) ? {} : false) },
      ];
    },

    renderHTML({ HTMLAttributes }) {
      return ['mark', mergeAttributes(HTMLAttributes), 0];
    },

    addCommands() {
      return {
        setMarker: (color) => ({ commands }) => (
          isMarker(color) ? commands.setMark(this.name, { color }) : false
        ),
        unsetMarker: () => ({ commands }) => commands.unsetMark(this.name),
      };
    },
  });

  return [TextColor, Marker];
}
