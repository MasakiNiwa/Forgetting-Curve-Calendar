/**
 * エディタ中核のテスト。
 * DOM は使わず、textarea と同じ振る舞いをする小さな代役で検証する。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { EditHistory } from '../assets/js/editor/history.js';
import { TextEditor } from '../assets/js/editor/textEditor.js';

/** textarea の代役（value / selection / イベントだけ） */
function fakeTextarea(initial = '') {
  const listeners = new Map();
  return {
    value: initial,
    selectionStart: initial.length,
    selectionEnd: initial.length,
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    focus() {},
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatch(type, event = {}) {
      (listeners.get(type) || []).forEach((fn) => fn(event));
    },
  };
}

const setup = (text = '', selection) => {
  const el = fakeTextarea(text);
  if (selection) el.setSelectionRange(selection[0], selection[1]);
  return { el, editor: new TextEditor(el) };
};

/* ------------------------------------------------------------- history */

test('history: 連続した入力は 1 手にまとまり、種類が変わると区切られる', () => {
  const h = new EditHistory({ coalesceMs: 1000 });
  h.reset({ text: '', start: 0, end: 0 });
  h.push({ text: 'a', start: 1, end: 1 }, { kind: 'input' });
  h.push({ text: 'ab', start: 2, end: 2 }, { kind: 'input' });
  h.push({ text: 'ab!', start: 3, end: 3 }, { kind: 'command' });

  assert.equal(h.undo().text, 'ab', 'コマンドの分だけ戻る');
  assert.equal(h.undo().text, '', '入力はまとめて戻る');
  assert.equal(h.canUndo, false);
  assert.equal(h.redo().text, 'ab');
});

test('history: 上限を超えても最新の履歴は残る', () => {
  const h = new EditHistory({ limit: 3, coalesceMs: 0 });
  h.reset({ text: '0', start: 0, end: 0 });
  for (let i = 1; i <= 10; i += 1) h.push({ text: String(i), start: 0, end: 0 }, { kind: 'command' });
  assert.equal(h.past.length, 3);
  assert.equal(h.undo().text, '9');
});

/* ------------------------------------------------------------- 編集 */

test('editor: 範囲置換は 1 手で元に戻せる', () => {
  const { editor } = setup('牛乳とパン');
  editor.replaceRange(0, 2, '豆乳');
  assert.equal(editor.text, '豆乳とパン');
  editor.applyHistory(editor.history.undo());
  assert.equal(editor.text, '牛乳とパン');
  editor.applyHistory(editor.history.redo());
  assert.equal(editor.text, '豆乳とパン');
});

test('editor: 一括置換も 1 回の取り消しで戻る', () => {
  const { editor } = setup('a\na\na');
  editor.setText('b\nb\nb', { kind: 'replaceAll' });
  assert.equal(editor.text, 'b\nb\nb');
  editor.applyHistory(editor.history.undo());
  assert.equal(editor.text, 'a\na\na', '3 か所まとめて戻る');
});

test('editor: 箇条書きとチェックを付け替えできる', () => {
  const { el, editor } = setup('牛乳\nパン');
  el.setSelectionRange(0, el.value.length);

  editor.run('bullet');
  assert.equal(editor.text, '- 牛乳\n- パン');

  el.setSelectionRange(0, editor.text.length);
  editor.run('checkbox');
  assert.equal(editor.text, '- [ ] 牛乳\n- [ ] パン', '箇条書きからチェックへ');

  el.setSelectionRange(0, editor.text.length);
  editor.run('toggleCheck');
  assert.equal(editor.text, '- [x] 牛乳\n- [x] パン');

  el.setSelectionRange(0, editor.text.length);
  editor.run('checkbox');
  assert.equal(editor.text, '牛乳\nパン', 'もう一度押すと外れる');
});

test('editor: 字下げと解除は選択範囲を保つ', () => {
  const { el, editor } = setup('一行目\n二行目');
  el.setSelectionRange(0, editor.text.length);
  editor.run('indent');
  assert.equal(editor.text, '  一行目\n  二行目');
  assert.equal(editor.selection.start, 0);
  assert.equal(editor.selection.end, editor.text.length, '選択範囲が残る');

  editor.run('outdent');
  assert.equal(editor.text, '一行目\n二行目');
});

test('editor: 行の複製と削除', () => {
  const { el, editor } = setup('A\nB\nC');
  el.setSelectionRange(2, 2); // B の行
  editor.run('duplicateLine');
  assert.equal(editor.text, 'A\nB\nB\nC');
  editor.run('deleteLine');
  assert.equal(editor.text, 'A\nB\nC');
});

test('editor: 日本語入力の変換中は履歴を刻まない', () => {
  const { el, editor } = setup('');
  el.dispatch('compositionstart');
  el.value = 'にほんご';
  el.setSelectionRange(4, 4);
  el.dispatch('input');
  assert.equal(editor.history.canUndo, false, '変換中は履歴に積まない');

  el.value = '日本語';
  el.setSelectionRange(3, 3);
  el.dispatch('compositionend');
  assert.equal(editor.history.canUndo, true, '確定で 1 手');
  editor.applyHistory(editor.history.undo());
  assert.equal(editor.text, '');
});

test('editor: 文字数と行・桁を数えられる', () => {
  const { el, editor } = setup('あいう\nえお');
  el.setSelectionRange(5, 5);
  assert.deepEqual(editor.caretPosition(), { line: 2, column: 2 });
  const stats = editor.stats();
  assert.equal(stats.chars, 6);
  assert.equal(stats.lines, 2);
});

test('editor: コマンドは後から足せる（拡張しても中核を書き換えない）', () => {
  const { editor } = setup('abc');
  editor.registerCommand('shout', {
    label: '大文字に',
    run: (ed) => ed.setText(ed.text.toUpperCase()),
  });
  assert.equal(editor.run('shout'), true);
  assert.equal(editor.text, 'ABC');
  assert.equal(editor.run('unknown'), false, '無いコマンドは何もしない');
});
