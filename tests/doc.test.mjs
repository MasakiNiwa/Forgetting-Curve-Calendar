/**
 * 本文の中身（文書データ）のテスト。
 *   npm test
 *
 * ここで見るのは「書いたものが、書いたとおりに残るか」。
 * 記号の読み違い（2 * 3 が斜体になる、C:\temp が消える）は、
 * v0.11 までの Markdown 保存で実際に起きていた問題なので、必ず残す。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  docHeadings, docToMarkdown, docToText, isEmptyDoc, markdownToDoc, normalizeDoc, textToDoc,
} from '../assets/js/core/doc.js';
import { DEFAULT_SETTINGS, createNote, displayTitle, normalizeNote, toStoredNote } from '../assets/js/core/models.js';
import { migrate } from '../assets/js/core/migrations.js';
import { SCHEMA_VERSION } from '../assets/js/core/config.js';
import { MemoryAdapter } from '../assets/js/core/storage.js';
import { Store } from '../assets/js/core/store.js';

const settings = { ...DEFAULT_SETTINGS };

const para = (text) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : undefined });
const doc = (...content) => ({ type: 'doc', content });

/* ------------------------------------------------------------------ */
/* ただの文字                                                          */
/* ------------------------------------------------------------------ */

test('doc: ただの文字は、記号もそのまま残る', () => {
  const source = '2 * 3 = 6\nC:\\temp\\new\n__important__';
  const d = textToDoc(source);
  assert.equal(docToText(d), source);
});

test('doc: 空行は空の段落として残る', () => {
  const d = textToDoc('ひとつめ\n\n\nふたつめ');
  assert.equal(d.content.length, 4);
  assert.equal(d.content[1].content, undefined);
  // 文字にするときだけ、続きすぎた空行をまとめる
  assert.equal(docToText(d), 'ひとつめ\n\nふたつめ');
});

test('doc: 何も書いていない文書は空とみなす', () => {
  assert.equal(isEmptyDoc(textToDoc('')), true);
  assert.equal(isEmptyDoc(textToDoc('  \n  ')), true);
  assert.equal(isEmptyDoc(textToDoc('あ')), false);
  assert.equal(isEmptyDoc(null), true);
});

/* ------------------------------------------------------------------ */
/* 整える                                                              */
/* ------------------------------------------------------------------ */

test('doc: 知らないかたまりは中身だけ拾う', () => {
  const d = normalizeDoc(doc({ type: 'iframe', content: [{ type: 'text', text: '中身' }] }));
  assert.equal(d.content[0].type, 'paragraph');
  assert.equal(docToText(d), '中身');
});

test('doc: 開けないリンクは飾りごと落とす', () => {
  const d = normalizeDoc(doc({
    type: 'paragraph',
    content: [{
      type: 'text',
      text: '押さない',
      marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
    }],
  }));
  assert.equal(d.content[0].content[0].marks, undefined);
  assert.equal(docToText(d), '押さない');
});

test('doc: 知らない飾りは落とし、リンクには安全な属性を付ける', () => {
  const d = normalizeDoc(doc({
    type: 'paragraph',
    content: [{
      type: 'text',
      text: 'こちら',
      marks: [{ type: 'blink' }, { type: 'link', attrs: { href: 'https://example.com' } }],
    }],
  }));
  const marks = d.content[0].content[0].marks;
  assert.equal(marks.length, 1);
  assert.equal(marks[0].attrs.rel, 'noopener noreferrer');
});

test('doc: 文書でないものは受け取らない', () => {
  assert.equal(normalizeDoc(null), null);
  assert.equal(normalizeDoc({ type: 'paragraph' }), null);
  assert.equal(normalizeDoc('doc'), null);
});

test('doc: 空の文書には段落を 1 つ置く', () => {
  assert.deepEqual(normalizeDoc({ type: 'doc', content: [] }), doc({ type: 'paragraph' }));
});

test('doc: チェックの取り消し線は、リストごとの決めごととして残る', () => {
  const list = (attrs) => doc({
    type: 'taskList',
    ...(attrs ? { attrs } : {}),
    content: [{ type: 'taskItem', attrs: { checked: true }, content: [para('済んだこと')] }],
  });
  // 何も言われていなければ、これまでどおり取り消し線を引く
  assert.equal(normalizeDoc(list()).content[0].attrs.strike, true);
  // 引かないと決めたら、そのまま残す
  assert.equal(normalizeDoc(list({ strike: false })).content[0].attrs.strike, false);
  // 見た目の決めごとなので、Markdown へ書き出すときは関係ない
  assert.match(docToMarkdown(list({ strike: false })), /- \[x\] 済んだこと/);
});

test('doc: これまでの Markdown から読み直したチェックは、取り消し線あり', () => {
  const d = markdownToDoc('- [ ] やること');
  assert.equal(d.content[0].type, 'taskList');
  assert.equal(normalizeDoc(d).content[0].attrs.strike, true);
});

test('doc: 項目の中の改行は、行を分けたまま残る', () => {
  const d = doc({
    type: 'bulletList',
    content: [{
      type: 'listItem',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: '買い物' },
          { type: 'hardBreak' },
          { type: 'text', text: '（牛乳とパン）' },
        ],
      }],
    }],
  });
  assert.equal(docToText(d), '買い物\n（牛乳とパン）');
  // 読み直しても、項目は 1 つのまま
  const back = markdownToDoc(docToMarkdown(d));
  assert.equal(back.content[0].content.length, 1);
});

/* ------------------------------------------------------------------ */
/* 文字にする・Markdown にする                                          */
/* ------------------------------------------------------------------ */

test('doc: 表は、マスをタブ・行を改行で区切って文字にする', () => {
  const table = {
    type: 'table',
    content: [
      { type: 'tableRow', content: [
        { type: 'tableHeader', content: [para('名前')] },
        { type: 'tableHeader', content: [para('点')] },
      ] },
      { type: 'tableRow', content: [
        { type: 'tableCell', content: [para('田中')] },
        { type: 'tableCell', content: [para('80')] },
      ] },
    ],
  };
  assert.equal(docToText(doc(table)), '名前\t点\n田中\t80');
});

test('doc: 書き出した Markdown は、マスの中の「|」を守る', () => {
  const table = {
    type: 'table',
    content: [
      { type: 'tableRow', content: [{ type: 'tableHeader', content: [para('記号')] }] },
      { type: 'tableRow', content: [{ type: 'tableCell', content: [para('a|b')] }] },
    ],
  };
  const md = docToMarkdown(doc(table));
  assert.match(md, /a\\\|b/);
  // 書き戻しても、マスは 1 つのまま
  const back = markdownToDoc(md);
  assert.equal(docToText(back), '記号\na|b');
});

test('doc: チェックとコードを Markdown に書き出す', () => {
  const d = doc(
    { type: 'taskList', content: [
      { type: 'taskItem', attrs: { checked: true }, content: [para('買い物')] },
      { type: 'taskItem', attrs: { checked: false }, content: [para('掃除')] },
    ] },
    { type: 'codeBlock', content: [{ type: 'text', text: 'const a = 1;' }] },
  );
  const md = docToMarkdown(d);
  assert.match(md, /- \[x\] 買い物/);
  assert.match(md, /- \[ \] 掃除/);
  assert.match(md, /```\nconst a = 1;\n```/);
});

/* ------------------------------------------------------------------ */
/* これまでのメモを読み直す                                            */
/* ------------------------------------------------------------------ */

test('doc: これまでの Markdown を読み直しても、かたまりの並びは変わらない', () => {
  const md = [
    '# 見出し',
    '',
    'ふつうの段落',
    '',
    '- [ ] やること',
    '- [x] 終わったこと',
    '',
    '> 引用',
    '',
    '| 名前 | 点 |',
    '| --- | --- |',
    '| 田中 | 80 |',
    '',
    '---',
  ].join('\n');
  const d = markdownToDoc(md);
  const types = d.content.map((n) => n.type);
  assert.deepEqual(types, [
    'heading', 'paragraph', 'taskList', 'blockquote', 'table', 'horizontalRule',
  ]);
  assert.equal(d.content[2].content[1].attrs.checked, true);
});

test('doc: 読み直しても「2 * 3」は斜体にならない', () => {
  const d = markdownToDoc('2 * 3 = 6');
  assert.equal(docToText(d), '2 * 3 = 6');
  assert.equal(d.content[0].content.length, 1);
});

test('doc: 段落どうしの空行は残り、かたまりの区切りは増やさない', () => {
  // 書いた空行はそのまま（段落 → 空の段落 → 段落）
  assert.deepEqual(markdownToDoc('前\n\n後').content.map((n) => n.type),
    ['paragraph', 'paragraph', 'paragraph']);
  // 見出しのあとの空行は Markdown の決まりなので、行を増やさない
  assert.deepEqual(markdownToDoc('# 見出し\n\n本文').content.map((n) => n.type),
    ['heading', 'paragraph']);
  // 2 つ以上続いた空行は、そのぶん残す
  assert.deepEqual(markdownToDoc('# 見出し\n\n\n本文').content.map((n) => n.type),
    ['heading', 'paragraph', 'paragraph']);
});

test('doc: 見出しは、メモの中の移動に使える形で拾える', () => {
  const d = markdownToDoc('# 大きな見出し\n\n本文\n\n### 小さな見出し');
  assert.deepEqual(docHeadings(d).map((x) => [x.level, x.text]), [
    [1, '大きな見出し'],
    [3, '小さな見出し'],
  ]);
});

/* ------------------------------------------------------------------ */
/* メモとして持つ                                                      */
/* ------------------------------------------------------------------ */

test('models: 文書データを渡すと、素の文字はそこから作る', () => {
  const note = createNote({ doc: doc(para('見たまま書いた本文')) }, settings);
  assert.equal(note.body, '見たまま書いた本文');
  assert.equal(note.doc.content[0].type, 'paragraph');
});

test('models: 文書データを持つメモだけ、保存する形にも入れる', () => {
  const withDoc = createNote({ doc: doc(para('あたらしい')) }, settings);
  const legacy = createNote({ body: '# むかしのメモ' }, settings);
  assert.ok(toStoredNote(withDoc).doc);
  assert.equal('doc' in toStoredNote(legacy), false);
  // 古いメモは、書いてあった文字のまま残る
  assert.equal(legacy.body, '# むかしのメモ');
  assert.equal(legacy.doc, null);
});

test('models: 壊れた文書データは受け取らない', () => {
  const note = normalizeNote({ id: 'n1', body: 'ほんぶん', doc: { type: 'paragraph' } }, settings);
  assert.equal(note.doc, null);
});

test('models: タイトルは、文書データのメモなら記号を外さない', () => {
  const withDoc = createNote({ doc: doc(para('2 * 3 の答え')) }, settings);
  assert.equal(displayTitle(withDoc), '2 * 3 の答え');
});

test('store: 本文の書き換えは、文書データと素の文字の両方を残す', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  const note = store.addNote({ doc: doc(para('さいしょ')), body: 'さいしょ' });
  const next = doc(para('あとから'), para('つづき'));
  store.updateNote(note.id, { doc: next, body: 'あとから\nつづき' });
  const saved = store.getNote(note.id);
  assert.equal(saved.body, 'あとから\nつづき');
  assert.equal(docToText(saved.doc), 'あとから\nつづき');
});

test('store: 中身が同じ文書データでは、更新したことにしない', async () => {
  const store = new Store(new MemoryAdapter());
  await store.load();
  const note = store.addNote({ doc: doc(para('そのまま')) });
  const before = store.getNote(note.id).contentUpdatedAt;
  store.updateNote(note.id, { doc: doc(para('そのまま')), body: 'そのまま' });
  assert.equal(store.getNote(note.id).contentUpdatedAt, before);
});

test('migrations: v5 のデータは、本文に触れずに v6 になる', () => {
  const data = migrate({
    schemaVersion: 5,
    notes: [{ id: 'n1', body: '# むかしのメモ', events: [] }],
  });
  assert.equal(data.schemaVersion, SCHEMA_VERSION);
  assert.equal(data.notes[0].body, '# むかしのメモ');
  assert.equal(data.notes[0].doc, undefined);
});
