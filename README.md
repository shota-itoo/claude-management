# claude-management

ブラウザベースのClaude Codeターミナルマネージャー。
複数セッションをタブで管理し、ステータスを色で視覚的に表示する。
プロジェクト・タスク管理機能（ガントチャート・カンバンボード）も統合。

## 必要環境

- **Node.js** (v18以上推奨)
- **ビルドツール** (`node-pty`, `better-sqlite3` のネイティブモジュールコンパイルに必要)
- **Claude Code CLI** (`claude` コマンドがPATHに通っていること)

### ビルドツールのインストール

```bash
# Ubuntu/Debian
sudo apt install build-essential python3

# macOS
xcode-select --install

# Windows (PowerShell管理者)
npm install -g windows-build-tools
```

## セットアップ

```bash
npm install
npm start
```

ブラウザで http://localhost:3100 を開く。

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

## 技術構成

| 項目 | 内容 |
|---|---|
| サーバー | Express.js + Socket.IO |
| ターミナル | node-pty + xterm.js |
| データベース | SQLite (better-sqlite3 / ファイルベース) |
| 外部依存 | なし (完全ローカル完結) |
