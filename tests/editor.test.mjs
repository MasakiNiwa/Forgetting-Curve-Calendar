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

/* --------------------------------------------- v0.6.1: 選択範囲と履歴の区切り */

test('editor: 行末の改行まで選んでも、次の行は巻き込まない', () => {
  const { el, editor } = setup('AAA\nBBB');
  // 1 行目と改行だけを選ぶ（選択の終わりが 2 行目の先頭にある）
  el.setSelectionRange(0, 4);
  const range = editor.lineRange(0, 4);
  assert.deepEqual(range, { from: 0, to: 3 }, '1 行目だけが対象');

  editor.run('bullet');
  assert.equal(editor.text, '- AAA\nBBB', '2 行目には付かない');

  // 2 行にまたがる選択は、これまでどおり両方が対象
  const { el: el2, editor: ed2 } = setup('AAA\nBBB');
  el2.setSelectionRange(0, 5);
  ed2.run('bullet');
  assert.equal(ed2.text, '- AAA\n- BBB');
});

test('editor: 空行でボタンを押すと、行頭記号が入ってすぐ書ける', () => {
  const { el, editor } = setup('メモ\n');
  el.setSelectionRange(4, 4);
  editor.run('checkbox');
  assert.equal(editor.text, 'メモ\n- [ ] ');
  assert.equal(el.selectionStart, editor.text.length, 'カーソルは記号の後ろ');
});

test('editor: 箇条書きの改行は記号を継ぎ、空の項目で終わる', () => {
  const { el, editor } = setup('- 牛乳');
  el.setSelectionRange(4, 4);
  assert.equal(editor.run('newline'), true);
  assert.equal(editor.text, '- 牛乳\n- ');

  // 空の項目で改行したら、記号を外して終わる
  assert.equal(editor.run('newline'), true);
  assert.equal(editor.text, '- 牛乳\n');

  // 記号のない行では、普通の改行にまかせる
  const { el: el2, editor: ed2 } = setup('ただの行');
  el2.setSelectionRange(4, 4);
  assert.equal(ed2.run('newline'), false);

  // 行の途中でも、普通の改行にまかせる
  const { el: el3, editor: ed3 } = setup('- 牛乳とパン');
  el3.setSelectionRange(4, 4);
  assert.equal(ed3.run('newline'), false);
});

test('editor: チェック済みの行を改行すると、次は未チェックで始まる', () => {
  const { el, editor } = setup('- [x] 牛乳');
  el.setSelectionRange(editor.text.length, editor.text.length);
  editor.run('newline');
  assert.equal(editor.text, '- [x] 牛乳\n- [ ] ');
});

test('history: カーソルを動かす・貼り付ける・改行すると 1 手が区切られる', () => {
  const h = new EditHistory({ coalesceMs: 5000 });
  h.reset({ text: '', start: 0, end: 0 });
  h.push({ text: 'ab', start: 2, end: 2 }, { kind: 'input' });      // 貼り付け相当（2 文字）
  h.push({ text: 'abc', start: 3, end: 3 }, { kind: 'input' });
  h.push({ text: 'abcd', start: 4, end: 4 }, { kind: 'input' });
  assert.equal(h.undo().text, 'ab', '続けて打った分はまとまる');

  // カーソルを別の場所へ移してから打つと、別の 1 手になる
  const h2 = new EditHistory({ coalesceMs: 5000 });
  h2.reset({ text: 'あいう', start: 3, end: 3 });
  h2.push({ text: 'あいうえ', start: 4, end: 4 }, { kind: 'input' });
  h2.push({ text: 'xあいうえ', start: 1, end: 1 }, { kind: 'input' });  // 先頭へ移動して入力
  assert.equal(h2.undo().text, 'あいうえ', '移動前の入力は残る');

  // 改行を挟むと区切る
  const h3 = new EditHistory({ coalesceMs: 5000 });
  h3.reset({ text: 'a', start: 1, end: 1 });
  h3.push({ text: 'ab', start: 2, end: 2 }, { kind: 'input' });
  h3.push({ text: 'ab\n', start: 3, end: 3 }, { kind: 'input' });
  h3.push({ text: 'ab\nc', start: 4, end: 4 }, { kind: 'input' });
  assert.equal(h3.undo().text, 'ab\n', '改行の後は別の 1 手');
  assert.equal(h3.undo().text, 'ab');

  // 入力と削除が入れ替わったら区切る
  const h4 = new EditHistory({ coalesceMs: 5000 });
  h4.reset({ text: '', start: 0, end: 0 });
  h4.push({ text: 'a', start: 1, end: 1 }, { kind: 'input' });
  h4.push({ text: 'ab', start: 2, end: 2 }, { kind: 'input' });
  h4.push({ text: 'a', start: 1, end: 1 }, { kind: 'input' });
  assert.equal(h4.undo().text, 'ab', '消した分だけ戻る');
});

test('editor: 履歴を引き継いで開き直すと、元に戻すが続けられる', () => {
  const first = setup('はじめの本文');
  first.editor.replaceRange(0, 0, '追記：');
  assert.equal(first.editor.text, '追記：はじめの本文');
  const history = first.editor.history;

  // 一覧へ戻って、同じメモをまた開いた状況
  const el = fakeTextarea('追記：はじめの本文');
  const reopened = new TextEditor(el, {}, { history });
  assert.equal(reopened.history.canUndo, true, '履歴が残っている');
  reopened.applyHistory(reopened.history.undo());
  assert.equal(reopened.text, 'はじめの本文');
});

test('editor: Esc のあとの Tab はフォーカス移動に使う', () => {
  const { editor } = setup('本文');
  const key = (init) => ({ ...init, preventDefault() {} });
  assert.equal(editor.handleKey(key({ key: 'Escape' })), true);
  assert.equal(editor.tabMovesFocus, true);
  // 次の Tab は字下げせず、ブラウザにまかせる
  assert.equal(editor.handleKey(key({ key: 'Tab', shiftKey: false })), false);
  assert.equal(editor.text, '本文', '字下げされない');
  // そのあとの Tab は、これまでどおり字下げ
  assert.equal(editor.handleKey(key({ key: 'Tab', shiftKey: false })), true);
  assert.equal(editor.text, '  本文');
});

/* ------------------------------------------------- v0.7: 見出しと軽い集計 */

test('editor: 見出しの付け外しができる', () => {
  const { el, editor } = setup('第1章\n本文');
  el.setSelectionRange(0, 0);
  editor.run('heading');
  assert.equal(editor.text, '# 第1章\n本文');
  editor.run('heading');
  assert.equal(editor.text, '第1章\n本文', 'もう一度押すと外れる');

  // 空行なら、記号を置いてすぐ書ける
  const { el: el2, editor: ed2 } = setup('本文\n');
  el2.setSelectionRange(3, 3);
  ed2.run('heading');
  assert.equal(ed2.text, '本文\n# ');
  assert.equal(el2.selectionStart, ed2.text.length);
});

test('editor: 軽い集計は文字列を作り直さずに数える', () => {
  const { el, editor } = setup('いち\nに\nさん');
  el.setSelectionRange(0, 2);
  const quick = editor.quickStats();
  assert.equal(quick.chars, editor.text.length);
  assert.equal(quick.lines, 3);
  assert.equal(quick.selected, 2);

  const { editor: empty } = setup('');
  assert.deepEqual(empty.quickStats(), { chars: 0, lines: 0, selected: 0 });
});
