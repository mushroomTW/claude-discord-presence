# Claude Discord Presence

This marketplace provides the `claude-discord-presence` plugin, which displays Claude Desktop activity through Discord Rich Presence.

## Installation

After pushing this repository to GitHub, run the following commands from a Claude Code session in Claude Desktop:

```text
/plugin marketplace add <GitHub username>/claude-discord-presence
/plugin install claude-discord-presence@claude-discord-presence
```

When enabled, the plugin starts Rich Presence from Claude's `SessionStart` hook and stops it from its `SessionEnd` hook. The process PID and logs are stored in Claude's managed `CLAUDE_PLUGIN_DATA` directory. Claude removes that data when the plugin is uninstalled from its final scope.

## Development

```text
claude --plugin-dir ./plugins/claude-discord-presence
```

Then run `/reload-plugins` in Claude Code and use `/hooks` to verify that both lifecycle hooks are loaded.
