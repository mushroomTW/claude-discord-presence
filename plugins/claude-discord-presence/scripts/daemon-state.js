#!/usr/bin/env node
'use strict';

const { createDaemonStateManager } = require('./shared/daemon-state');

module.exports = createDaemonStateManager({
  stateFile: 'claude-discord-presence.state.json',
  legacyPidFiles: ['claude-discord-presence.pid'],
  lockFile: 'claude-discord-presence.start.lock'
});
