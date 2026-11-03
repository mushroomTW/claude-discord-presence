import fs from 'node:fs';
import path from 'node:path';
import { errorCode, tryAcquireLock } from './file-lock.ts';
import { getProcessCommandLine, isRunning } from './process-utils.ts';

export interface DaemonState {
  pid: number;
  instanceToken: string;
  scriptPath: string;
}

interface DaemonStateManagerOptions {
  stateFile: string;
  lockFile: string;
  staleLockMs?: number;
  heartbeatTtlMs?: number;
}

function isValidDaemonState(state: unknown): state is DaemonState {
  if (typeof state !== 'object' || state === null) return false;
  const candidate = state as Partial<DaemonState>;
  return Number.isInteger(candidate.pid)
    && Number(candidate.pid) > 0
    && typeof candidate.instanceToken === 'string'
    && candidate.instanceToken.length >= 16
    && typeof candidate.scriptPath === 'string'
    && candidate.scriptPath.length > 0;
}

export function createDaemonStateManager(options: DaemonStateManagerOptions) {
  const stateFile = options.stateFile;
  const lockFile = options.lockFile;
  const staleLockMs = options.staleLockMs || 30_000;
  // daemon 每 10 秒 touch 一次狀態檔；保留三個週期的容許量。
  const heartbeatTtlMs = options.heartbeatTtlMs || 30_000;

  const statePath = (dataDir: string) => path.join(dataDir, stateFile);
  const lockPath = (dataDir: string) => path.join(dataDir, lockFile);

  function readDaemonState(dataDir: string): DaemonState | null {
    try {
      const state: unknown = JSON.parse(fs.readFileSync(statePath(dataDir), 'utf8'));
      return isValidDaemonState(state) ? state : null;
    } catch {
      return null;
    }
  }

  function writeDaemonState(dataDir: string, state: DaemonState) {
    if (!isValidDaemonState(state)) throw new Error('無效的常駐程序狀態。');
    fs.mkdirSync(dataDir, { recursive: true });
    const targetPath = statePath(dataDir);
    const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, targetPath);
  }

  function removeDaemonState(dataDir: string, expectedState?: DaemonState) {
    const state = readDaemonState(dataDir);
    if (!state) return false;
    if (expectedState && (state.pid !== expectedState.pid || state.instanceToken !== expectedState.instanceToken)) return false;
    fs.rmSync(statePath(dataDir), { force: true });
    return true;
  }

  const isSameOwner = (state: DaemonState, expectedState: DaemonState) => state.pid === expectedState.pid && state.instanceToken === expectedState.instanceToken;

  function touchDaemonState(dataDir: string, expectedState: DaemonState) {
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

  function hasFreshHeartbeat(dataDir: string, state: DaemonState) {
    try {
      const current = readDaemonState(dataDir);
      return current !== null
        && isSameOwner(current, state)
        && Date.now() - fs.statSync(statePath(dataDir)).mtimeMs <= heartbeatTtlMs;
    } catch {
      return false;
    }
  }

  function isOwnedDaemon(state: DaemonState | null, dataDir?: string) {
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

  function stopOwnedDaemon(dataDir: string) {
    const state = readDaemonState(dataDir);
    if (!state) return false;
    const owned = isOwnedDaemon(state, dataDir);
    if (owned) {
      try {
        process.kill(state.pid, 'SIGTERM');
      } catch (error) {
        if (errorCode(error) !== 'ESRCH') throw error;
      }
    }
    removeDaemonState(dataDir, state);
    return owned;
  }

  function acquireStartLock(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    return tryAcquireLock(lockPath(dataDir), staleLockMs);
  }

  return { acquireStartLock, getProcessCommandLine, isOwnedDaemon, isRunning, isValidDaemonState, readDaemonState, removeDaemonState, statePath, stopOwnedDaemon, touchDaemonState, writeDaemonState, releaseStartLock: (dataDir: string) => fs.rmSync(lockPath(dataDir), { force: true }) };
}
