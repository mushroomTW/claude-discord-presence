#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

function createDaemonStateManager(options) {
  const stateFile = options.stateFile;
  const lockFile = options.lockFile;
  const legacyPidFiles = options.legacyPidFiles || [];
  const staleLockMs = options.staleLockMs || 30_000;

  const statePath = (dataDir) => path.join(dataDir, stateFile);
  const lockPath = (dataDir) => path.join(dataDir, lockFile);

  function isValidDaemonState(state) {
    return Boolean(state)
      && Number.isInteger(state.pid)
      && state.pid > 0
      && typeof state.instanceToken === 'string'
      && state.instanceToken.length >= 16
      && typeof state.scriptPath === 'string'
      && state.scriptPath.length > 0;
  }

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

  function isRunning(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function getProcessCommandLine(pid) {
    try {
      const result = process.platform === 'win32'
        ? childProcess.spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`], { encoding: 'utf8', windowsHide: true })
        : childProcess.spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
      if (result.error || result.status !== 0) return null;
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  function isOwnedDaemon(state) {
    if (!isValidDaemonState(state) || !isRunning(state.pid)) return false;
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
    const owned = isOwnedDaemon(state);
    if (owned) {
      try {
        process.kill(state.pid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    removeDaemonState(dataDir, state);
    return owned;
  }

  function stopLegacyDaemon(dataDir, scriptPath) {
    let stopped = false;
    for (const legacyPidFile of legacyPidFiles) {
      const pidFile = path.join(dataDir, legacyPidFile);
      if (!fs.existsSync(pidFile)) continue;
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && isRunning(pid)) {
        const commandLine = getProcessCommandLine(pid);
        if (commandLine?.toLocaleLowerCase().includes(path.resolve(scriptPath).toLocaleLowerCase())) {
          process.kill(pid, 'SIGTERM');
          stopped = true;
        }
      }
      fs.rmSync(pidFile, { force: true });
    }
    return stopped;
  }

  function acquireStartLock(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    const targetPath = lockPath(dataDir);
    try {
      const descriptor = fs.openSync(targetPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8');
      fs.closeSync(descriptor);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(targetPath).mtimeMs > staleLockMs) {
          fs.rmSync(targetPath, { force: true });
          return acquireStartLock(dataDir);
        }
      } catch {
        return false;
      }
      return false;
    }
  }

  return { acquireStartLock, getProcessCommandLine, isOwnedDaemon, isRunning, isValidDaemonState, readDaemonState, removeDaemonState, statePath, stopLegacyDaemon, stopOwnedDaemon, writeDaemonState, releaseStartLock: (dataDir) => fs.rmSync(lockPath(dataDir), { force: true }) };
}

module.exports = { createDaemonStateManager };
