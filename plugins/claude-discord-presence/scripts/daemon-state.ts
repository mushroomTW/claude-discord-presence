import { createDaemonStateManager } from './shared/daemon-state.ts';

export const {
  acquireStartLock,
  getProcessCommandLine,
  isOwnedDaemon,
  isRunning,
  isValidDaemonState,
  readDaemonState,
  releaseStartLock,
  removeDaemonState,
  statePath,
  stopOwnedDaemon,
  touchDaemonState,
  writeDaemonState
} = createDaemonStateManager({
  stateFile: 'claude-discord-presence.state.json',
  lockFile: 'claude-discord-presence.start.lock'
});
