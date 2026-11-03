'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { tryAcquireLock } = require('./file-lock');
const { getProcessCommandLine, isRunning } = require('./process-utils');

function isValidDaemonState(state) {
  return Boolean(state)
    && Number.isInteger(state.pid)
    && state.pid > 0
    && typeof state.instanceToken === 'string'
    && state.instanceToken.length >= 16
    && typeof state.scriptPath === 'string'
    && state.scriptPath.length > 0;
}

function createDaemonStateManager(options) {
  const stateFile = options.stateFile;
  const lockFile = options.lockFile;
  const staleLockMs = options.staleLockMs || 30_000;
  // daemon 每 10 秒 touch 一次狀態檔；保留三個週期的容許量。
  const heartbeatTtlMs = options.heartbeatTtlMs || 30_000;

  const statePath = (dataDir) => path.join(dataDir, stateFile);
  const lockPath = (dataDir) => path.join(dataDir, lockFile);

  function readDaemonState(dataDir) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath(dataDir), 'utf8'));
      return isValidDaemonState(state) ? state : null;
    } catch {
      return null;
    }
  }

  function writeDaemonState(dataDir, state) {
    if (!isValidDaemonState(state)) throw new Error('無效的常駐程序狀態。');
    fs.mkdirSync(dataDir, { recursive: true });
    const targetPath = statePath(dataDir);
    const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, targetPath);
  }

  function removeDaemonState(dataDir, expectedState) {
    const state = readDaemonState(dataDir);
    if (!state) return false;
    if (expectedState && (state.pid !== expectedState.pid || state.instanceToken !== expectedState.instanceToken)) return false;
    fs.rmSync(statePath(dataDir), { force: true });
    return true;
  }

  const isSameOwner = (state, expectedState) => state.pid === expectedState.pid && state.instanceToken === expectedState.instanceToken;

  function touchDaemonState(dataDir, expectedState) {
    try {
      const state = readDaemonState(dataDir);
      if (!state || !isSameOwner(state, expectedState)) return false;
      const now = new Date();
      fs.utimesSync(statePath(dataDir), now, now);
      return true;
    } catch {
      return false;
    }
  }

  function hasFreshHeartbeat(dataDir, state) {
    try {
      const current = readDaemonState(dataDir);
      return Boolean(current)
        && isSameOwner(current, state)
        && Date.now() - fs.statSync(statePath(dataDir)).mtimeMs <= heartbeatTtlMs;
    } catch {
      return false;
    }
  }

  function isOwnedDaemon(state, dataDir) {
    if (!isValidDaemonState(state) || !isRunning(state.pid)) return false;
    // 狀態檔仍由 daemon 持續 touch 時可直接認定擁有者，省去查詢命令列（Windows 需啟動 PowerShell，約 400ms）。
    if (dataDir && hasFreshHeartbeat(dataDir, state)) return true;
    const commandLine = getProcessCommandLine(state.pid);
    if (!commandLine) return false;
    const normalizedCommand = commandLine.toLocaleLowerCase();
    const normalizedScript = path.resolve(state.scriptPath).toLocaleLowerCase();
    return normalizedCommand.includes(normalizedScript)
      && normalizedCommand.includes(`--instance-token=${state.instanceToken}`);
  }

  function stopOwnedDaemon(dataDir) {
    const state = readDaemonState(dataDir);
    if (!state) return false;
    const owned = isOwnedDaemon(state, dataDir);
    if (owned) {
      try {
        process.kill(state.pid, 'SIGTERM');
      } catch (error) {
        const errorCode = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
        if (errorCode !== 'ESRCH') throw error;
      }
    }
    removeDaemonState(dataDir, state);
    return owned;
  }

  function acquireStartLock(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    return tryAcquireLock(lockPath(dataDir), staleLockMs);
  }

  return { acquireStartLock, getProcessCommandLine, isOwnedDaemon, isRunning, isValidDaemonState, readDaemonState, removeDaemonState, statePath, stopOwnedDaemon, touchDaemonState, writeDaemonState, releaseStartLock: (dataDir) => fs.rmSync(lockPath(dataDir), { force: true }) };
}

module.exports = { createDaemonStateManager };
