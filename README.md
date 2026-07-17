# Claude Discord Presence

## 前置需求

使用此外掛前，請先安裝 **Node.js LTS**（建議 20 以上），因為 Hook 與 Discord Presence daemon 都透過 `node` 執行。安裝完成後，在終端機確認：

```text
node --version
```

若找不到 `node` 指令，請先安裝 Node.js 並重新開啟 Claude Desktop。

<p align="center">
  <img src="plugins/claude-discord-presence/assets/claude-discord-mascot-icon-transparent.png" alt="Claude Discord Presence mascot" width="220">
</p>

Show a local Discord Rich Presence while Claude Desktop is running. The plugin does not upload prompts, project contents, or chat messages to the plugin author. It can optionally show the active project and a repository button. Conversation-title display is enabled by default; the plugin reads the local Claude transcript to find custom-title records and sends only the selected title to Discord.

[Privacy Policy](PRIVACY.md) · [Terms of Service](TERMS.md) · [MIT License](LICENSE)

## Install

Run these commands from a Claude Code session in Claude Desktop:

```text
/plugin marketplace add mushroomTW/claude-discord-presence
/plugin install claude-discord-presence@claude-discord-presence
```

The first command adds the marketplace and the second installs the plugin. Reload plugins if Claude Code asks you to do so, then open or resume a Claude session. After updating the plugin, start a new Claude session so the current version replaces any older Presence daemon.

## Setup

The plugin includes the Discord Application created by mushroomTW. Users do not need to create a Discord Application or provide an Application ID.

## Controls

- Start: `node ./scripts/start.js`
- Stop: `node ./scripts/stop.js`
- Status: `node ./scripts/claude-discord-presence.js --status`

The plugin uses Node.js and Discord IPC only. It supports Windows, macOS, and Linux.

## Development checks

Run the built-in tests with:

```text
node --test tests/daemon-state.test.js tests/session-state.test.js
```

Rich Presence starts from Claude's `SessionStart` hook and stops from its `SessionEnd` hook. The plugin does not create an operating-system startup entry, so it can be installed, disabled, and removed through Claude without leaving a startup task behind.

所有 Claude 安裝來源會共用同一個本機 daemon 與工作階段資料。更新後首次啟動會回收舊版依安裝來源建立的 daemon。只有近期、且不位於使用者家目錄或 Claude 資料目錄內的工作階段才會顯示 Workspace；否則保留泛用 Presence，不會暴露 Windows 使用者名稱。

## Configuration

Edit `scripts/config.json` inside the installed plugin directory, then restart the Rich Presence service.

Content updates are event-driven by default (`pollIntervalMs: 0`). Set `pollIntervalMs` to a positive millisecond value only when a filesystem watcher is unreliable and a fallback poll is needed.

`useBroker` defaults to `false`, so Claude works independently through Discord IPC. Set it to `true` only after starting the shared local Broker with the same Windows privilege level as Discord.

This repository includes a complete Broker at `discord-presence-broker/broker.js`; run `node discord-presence-broker/broker.js` once before starting the plugin.

### Project display

```json
{
  "details": "Using Claude",
  "state": "Vibe coding",
  "showProject": true,
  "showConversationTitle": true,
  "projectLabel": "Workspace"
}
```

- Set `showProject` to `true` to display the active project name.
- Change `projectLabel` to customize the project-name prefix.
- Set `showConversationTitle` to `false` if you do not want the plugin to read the local transcript for a custom conversation title. The title is shown as the Rich Presence state.
- Change `state` to customize the fallback text used when conversation-title display is disabled or no title is available.

### Repository button

```json
{
  "showRepositoryButton": true,
  "repositoryButtonLabel": "View Repository"
}
```

The button uses the current project's Git `origin` remote when it points to GitHub. Set `showRepositoryButton` to `false` to hide it. Projects without a GitHub `origin` remote do not show a button, and private repositories still require GitHub permission.

## Notes

Run Discord and Claude Desktop with the same privileges. On Linux and macOS, use the Discord desktop app and ensure the current user can access the Discord IPC socket.
