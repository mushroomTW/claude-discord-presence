'use strict';

const { createDaemonStateManager } = require('./shared/daemon-state');

module.exports = createDaemonStateManager({
  stateFile: 'claude-discord-presence.state.json',
  lockFile: 'claude-discord-presence.start.lock'
});
