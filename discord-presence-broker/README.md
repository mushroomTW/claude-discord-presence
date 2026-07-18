# Discord Presence Broker

## Prerequisites

The Broker runs through Node.js. Before starting it, install **Node.js LTS** (Node.js 20 or later is recommended) and verify the installation:

```text
node --version
```

If the `node` command is not found, install Node.js before running `node broker.js`.

This repository can run the shared Broker independently with `node broker.js`. The Broker is the only process that connects to Discord IPC; Claude and Codex only write local state to `%LOCALAPPDATA%\\mushroomTW\\discord-presence-broker`.

The Broker selects the most relevant active status every second, and an activity expires after 15 seconds without an update. Codex tool execution, editing, thinking, and reading activities take priority over generic waiting activity; ties are resolved in favor of the most recently updated activity.

The plugin bundles the same Broker (`scripts/broker.js`) and starts it automatically when no heartbeat (`broker.json`) is detected, so manual startup is usually unnecessary. The Broker uses a startup lock and `broker.state.json` to enforce a single instance, and writes events to `broker.log` in the state directory.
