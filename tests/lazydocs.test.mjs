/**
 * 本文（文書データ）を、保存・復元・同期のどこでも取り落とさないためのテスト。
 *   npm test
 *
 * 本文は「開いたときに読む」（v0.15）。手元に無いことがある、という前提が
 * 消す・戻す・統合する・書き出す、の各所に効いてくる。
 * ここは、その境目だけを集めて見ている。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { docToText } from '../assets/js/core/doc.js';
import { MemoryAdapter } from '../assets/js/core/storage.js';
import { Store } from '../assets/js/core/store.js';

const para = (text, marks) => ({
  type: 'paragraph',
  content: [{ type: 'text', text, ...(marks ? { marks } : {}) }],
});
const doc = (...content) => ({ type: 'doc', content });
const bold = [{ type: 'bold' }];

/** そのメモを「少し前に書いたもの」にする（時刻の競り合いを避ける） */
function ageNote(note, seconds = 60) {
  const at = new Date(Date.now() - seconds * 1000).toISOString();
  note.updatedAt = at;
  note.contentUpdatedAt = at;
  return note;
}

/** 保存先はそのままに、読み込み直したところから始める */
async function reopen(adapter) {
  const store = new Store(adapter);
  await store.load();
  return store;
}

test('lazyDocs: 未読の本文を消して取り消しても、書式ごと戻る', async () => {
  const adapter = new MemoryAdapter();
  const first = new Store(adapter);
  await first.load();
  const note = first.addNote({ doc: doc(para('KEEP', bold)), body: 'KEEP' });
  const child = first.addNote({ doc: doc(para('CHILD')), body: 'CHILD', parentId: note.id });
  await first.flush();

  // 開き直した直後は、本文をまだ読んでいない
  const store = await reopen(adapter);
  assert.equal(store.getNote(note.id).doc, undefined);

  const removed = await store.deleteNote(note.id);
  await store.flush();
  assert.equal(removed.length, 2, '追加メモも一緒に消える');

  store.restoreNotes(removed);
  await store.flush();

  const again = await reopen(adapter);
  const back = await again.ensureDoc(again.getNote(note.id));
  assert.equal(docToText(back), 'KEEP');
  assert.deepEqual(back.content[0].content[0].marks, bold, '太字も戻る');
  assert.equal(docToText(await again.ensureDoc(again.getNote(child.id))), 'CHILD');
});

test('lazyDocs: 本文が読めないときは、消さずに知らせる', async () => {
  const adapter = new MemoryAdapter();
  const first = new Store(adapter);
  await first.load();
  const note = first.addNote({ doc: doc(para('KEEP')), body: 'KEEP' });
  await first.flush();

  const store = await reopen(adapter);
  adapter.loadDocs = async () => { throw new Error('読めません'); };
  const messages = [];
  store.subscribe((event) => { if (event?.type === 'error') messages.push(event.message); });

  const removed = await store.deleteNote(note.id);
  assert.deepEqual(removed, [], '消さない');
  assert.equal(store.notes.length, 1, 'メモは残る');
  assert.match(messages[0] || '', /読めなかった/);
});

test('lazyDocs: 読めなかった本文を「持っていない」と覚えない', async () => {
  const adapter = new MemoryAdapter();
  const first = new Store(adapter);
  await first.load();
  const note = first.addNote({ doc: doc(para('KEEP')), body: 'KEEP' });
  await first.flush();

  const store = await reopen(adapter);
  const real = adapter.loadDocs.bind(adapter);
  adapter.loadDocs = async () => { throw new Error('読めません'); };

  assert.equal(await store.ensureDoc(store.getNote(note.id)), null, '呼び出し側には「無い」と返る');
  assert.equal(store.getNote(note.id).doc, undefined, 'まだ読んでいない扱いのまま');
  assert.equal(await store.ensureAllDocs(), false, 'そろっていない');
  assert.equal(store.docUnavailable(store.getNote(note.id)), true);

  // 原因が直れば、読み直せる
  adapter.loadDocs = real;
  assert.equal(await store.ensureAllDocs(), true);
  assert.equal(docToText(store.getNote(note.id).doc), 'KEEP');
});

test('lazyDocs: 書き出しは、本文がそろってからにする', async () => {
  const adapter = new MemoryAdapter();
  const first = new Store(adapter);
  await first.load();
  first.addNote({ doc: doc(para('KEEP')), body: 'KEEP' });
  await first.flush();

  const store = await reopen(adapter);
  adapter.loadDocs = async () => { throw new Error('読めません'); };
  assert.equal(await store.ensureAllDocs(), false, '読めないときは false（控えを作らせない）');
});

test('lazyDocs: 別タブの新しい本文を取り込むと、素の文字と正本が食い違わない', async () => {
  const adapter = new MemoryAdapter();
  const first = new Store(adapter);
  await first.load();
  const note = first.addNote({ doc: doc(para('KEEP', bold)), body: 'KEEP' });
  await first.flush();

  // A は古い本文を読んで持っている
  const a = await reopen(adapter);
  await a.ensureDoc(a.getNote(note.id));
  assert.equal(docToText(a.getNote(note.id).doc), 'KEEP');
  // 「どちらが新しいか」は時刻で決まる。同じミリ秒に並ぶと決められないので、
  // A の側を少しだけ古くしておく（速い機械でも同じ結果になるように）
  ageNote(a.getNote(note.id));

  // B が書き換えて保存する
  const b = await reopen(adapter);
  b.updateNote(note.id, { doc: doc(para('NEW')), body: 'NEW' });
  await b.flush();

  // A が取り込む
  await a.reconcile();
  const merged = a.getNote(note.id);
  assert.equal(merged.body, 'NEW');
  assert.notEqual(docToText(merged.doc ?? doc(para(''))), 'KEEP', '古い本文を残さない');
  const fresh = await a.ensureDoc(merged);
  assert.equal(docToText(fresh), 'NEW', '保存されている新しい本文を読み直す');
});

test('lazyDocs: 食い違った本文は、見た目ごと退避する', async () => {
  const adapter = new MemoryAdapter();
  const first = new Store(adapter);
  await first.load();
  const note = first.addNote({ doc: doc(para('KEEP')), body: 'KEEP' });
  await first.flush();

  const a = await reopen(adapter);
  await a.ensureDoc(a.getNote(note.id));
  // A も B も、別々に書き換える（B の方をあとに書いたことにする）
  a.updateNote(note.id, { doc: doc(para('MINE', bold)), body: 'MINE' });
  ageNote(a.getNote(note.id));

  const b = await reopen(adapter);
  b.updateNote(note.id, { doc: doc(para('THEIRS')), body: 'THEIRS' });
  await b.flush();

  await a.reconcile();
  const merged = a.getNote(note.id);
  assert.ok(merged.conflicts.length >= 1, '退避されている');
  const saved = merged.conflicts[0];
  assert.ok(saved.body === 'MINE' || saved.body === 'THEIRS');
  assert.ok(saved.doc, '見た目（文書データ）も一緒に残す');
});
