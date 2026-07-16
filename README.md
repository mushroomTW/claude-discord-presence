# Claude Discord Presence

<p align="center">
  <img src="plugins/claude-discord-presence/assets/claude-discord-mascot-icon-transparent.png" alt="Claude Discord Presence mascot" width="220">
</p>

Show a local Discord Rich Presence while Claude Desktop is running. The plugin does not read or upload prompts, project contents, or chat messages. It can optionally show the active project and a repository button.

[Privacy Policy](PRIVACY.md) · [Terms of Service](TERMS.md) · [MIT License](LICENSE)

## Install

Run these commands from a Claude Code session in Claude Desktop:

```text
/plugin marketplace add mushroomTW/claude-discord-presence
/plugin install claude-discord-presence@claude-discord-presence
```

The first command adds the marketplace and the second installs the plugin. Reload plugins if Claude Code asks you to do so, then open or resume a Claude session.

## Setup

The plugin includes the Discord Application created by mushroomTW. Users do not need to create a Discord Application or provide an Application ID.

## Controls

- Start: `node ./scripts/start.js`
- Stop: `node ./scripts/stop.js`
- Status: `node ./scripts/codex-discord-presence.js --status`

The plugin uses Node.js and Discord IPC only. It supports Windows, macOS, and Linux.

Rich Presence starts from Claude's `SessionStart` hook and stops from its `SessionEnd` hook. The plugin does not create an operating-system startup entry, so it can be installed, disabled, and removed through Claude without leaving a startup task behind.

## Configuration

Edit `scripts/config.json` inside the installed plugin directory, then restart the Rich Presence service.

### Project display

```json
{
  "details": "Using Claude",
  "state": "Vibe coding",
  "showProject": true,
  "projectLabel": "Workspace"
}
```

- Set `showProject` to `true` to display the active project name.
- Change `projectLabel` to customize the project-name prefix.
- Change `details` and `state` to customize the fallback Rich Presence text.

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
