# assets/vendor

本文を書くための道具（[Tiptap](https://tiptap.dev/) / ProseMirror）を、
1 つのファイルにまとめて置いてあります。

このアプリはビルド工程を持たない静的サイトなので、
配布物（`tiptap.bundle.js`）をそのまま repository に入れています。
読み込むのは**編集画面を開いたときだけ**です（`assets/js/editor/docEditor.js` の動的 import）。

| ファイル | 中身 |
| --- | --- |
| `tiptap.bundle.js` | 配布するもの（ES Module・約 420KB） |
| `tiptap.entry.js` | まとめる前の入口。何を入れたかの記録 |

## 作り直すとき

```bash
mkdir /tmp/tiptapbuild && cd /tmp/tiptapbuild
npm init -y
npm i @tiptap/core@3.31.3 @tiptap/starter-kit@3.31.3 @tiptap/extension-list@3.31.3 \
      @tiptap/extension-table@3.31.3 @tiptap/extensions@3.31.3 \
      @tiptap/static-renderer@3.31.3 esbuild
cp <このフォルダ>/tiptap.entry.js entry.js
npx esbuild entry.js --bundle --format=esm --target=es2020 --minify \
      --legal-comments=none --outfile=tiptap.bundle.js
cp tiptap.bundle.js <このフォルダ>/
```

`Mark` と `mergeAttributes` を出しているのは、飾りを自分で定義するためです
（文字の色とマーカー: `assets/js/editor/textMarks.js`）。
色を値のまま本文へ書き込む拡張は入れていません（詳しくは docs/SPEC.md 9.18）。

版を上げたときは、`assets/js/core/doc.js` の
「置いてよいかたまり（BLOCK_TYPES）」「置いてよい飾り（MARK_TYPES）」が
新しい形と食い違っていないかを確かめてください。
保存された本文は、読み込むたびにこの一覧で選り分けています。

ライセンスは MIT（Tiptap / ProseMirror とも）。
