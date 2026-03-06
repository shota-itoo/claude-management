# claude-management

ブラウザベースのClaude Codeターミナルマネージャー。
複数セッションをタブで管理し、ステータスを色で視覚的に表示する。

## 起動

```bash
npm start
```

ブラウザで http://localhost:3000 を開く。

## ステータス色

| 色 | 状態 | 説明 |
|---|---|---|
| 黄 | working | ツール実行中 |
| 赤（点滅） | waiting | 確認待ち |
| 青 | done | 完了 |

## Hooks

セッション起動時に対象プロジェクトの `.claude/settings.local.json` へ自動注入される。
セッション終了時に自動クリーンアップ。グローバル設定は汚さない。

## ポート変更

```bash
PORT=3001 npm start
```
