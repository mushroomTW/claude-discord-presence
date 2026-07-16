# Claude Discord Presence

此 marketplace 提供 `claude-discord-presence` 外掛，在 Discord 顯示 Claude Desktop 的 Rich Presence。

## 安裝

將此 repository 推送至 GitHub 後，在 Claude Desktop 的 Claude Code 工作階段輸入：

```text
/plugin marketplace add <GitHub 使用者名稱>/discord-claude
/plugin install claude-discord-presence@claude-discord-presence
```

外掛啟用時，Claude 的 `SessionStart` hook 會啟動 Presence；`SessionEnd` hook 會停止它。程序 PID 和日誌儲存在 Claude 管理的 `CLAUDE_PLUGIN_DATA` 目錄，解除安裝最後一個 scope 時，該資料也由 Claude 清除。

## 開發測試

```text
claude --plugin-dir ./plugins/claude-discord-presence
```

再於 Claude Code 中執行 `/reload-plugins`，並用 `/hooks` 確認兩個 hooks 已載入。
