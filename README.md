# 忘却曲線カレンダー / Forgetting Curve Calendar

**そのメモ、もちろん忘れます**

その日書いたメモを、忘却曲線に沿って自動でリマインドするカレンダー型メモ帳です。
スマホ・PC 両対応。インストール不要のブラウザアプリ（データは端末内に保存されます）。

👉 **[アプリを開く](https://masakiniwa.github.io/Forgetting-Curve-Calendar/)**

---

## できること

- 📝 **メモを書くと復習日が自動で並ぶ** — 1 日後、3 日後、7 日後… と忘却曲線に沿って未来の日付に配置
- 📅 **カレンダーで「思い出し直すタスク」が見える** — その日に積み上がった過去のメモを一覧で確認
- 🧠 **想起結果で賢く再スケジュール** — 「覚えていた / あいまい / 忘れた」に応じて残りの復習日を自動調整
- 🔗 **追加メモからも曲線が発生** — 過去メモに紐付けた追記が、それ自身の忘却曲線を持つ
- 📤 **テキスト出力** — Markdown / テキスト / CSV / JSON でエクスポート
- 💾 **完全バックアップと復元** — 全データを JSON で保存・復元
- ⚙️ **設定 / ヘルプ** — 曲線プリセット、テーマ、週の開始曜日ほか

## 使い方

1. 右下の **+** ボタンでメモを書く
2. カレンダーの未来日に復習タスクが自動配置される
3. その日になったら日付をタップして、思い出せたかを記録する
4. 記録に応じて、残りの復習日が自動で調整される

詳しくはアプリ内の **ヘルプ** ページを参照してください。

## 技術構成

- 依存ライブラリなしの **静的サイト**（ES Modules / CSS Custom Properties）
- Material Design 3 を参考にしたカラートークンとコンポーネント
- データは `localStorage`。ストレージ層を抽象化しており、将来の同期実装に差し替え可能

```
index.html
assets/
  css/    tokens.css / app.css
  js/
    core/  storage / models / curve / store / exporter  … ドメインロジック（UI 非依存）
    ui/    calendar / notes / settings / help / editor … 画面
docs/SPEC.md    仕様書
```

設計の詳細・ロードマップは [docs/SPEC.md](docs/SPEC.md) を参照してください。

## ローカルで動かす

```bash
git clone https://github.com/MasakiNiwa/Forgetting-Curve-Calendar.git
cd Forgetting-Curve-Calendar
python3 -m http.server 8000
# http://localhost:8000 を開く
```

ES Modules を使っているため、`file://` で直接開かずローカルサーバ経由で開いてください。

コアロジックのテスト:

```bash
npm test
```

## デプロイ

`main` ブランチへの push で GitHub Actions がそのまま GitHub Pages へ公開します
（ビルド工程はありません）。

## ライセンス

[MIT](LICENSE)
