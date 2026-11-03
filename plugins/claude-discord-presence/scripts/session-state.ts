import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// 本檔出貨於外掛的 scripts/（非 scripts/shared/），故依出貨位置引用。
import { errorCode, tryAcquireLock } from './shared/file-lock.ts';

export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

// session 清單來自 Hook 寫入的 JSON，欄位皆須於使用時再驗證。
export interface Session {
  id?: string;
  sessionId?: string | null;
  projectName?: string;
  cwd?: unknown;
  transcriptPath?: unknown;
  lastActiveAt?: unknown;
  [key: string]: unknown;
}

export function isWorkspaceCwd(cwd: unknown): cwd is string {
  if (typeof cwd !== 'string' || !cwd.trim()) return false;
  try {
    const resolved = path.resolve(cwd);
    const home = path.resolve(os.homedir());
    if (resolved === home) return false;
    const relative = path.relative(home, resolved);
    if (!relative.startsWith(`..${path.sep}`) && relative !== '..') {
      return Boolean(relative) && !/^(?:\.claude|\.codex)(?:[\\/]|$)/i.test(relative);
    }
    return true;
  } catch {
    return false;
  }
}

export function readSessions(sessionsPath: string): Session[] {
  try {
    const sessions: unknown = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    return Array.isArray(sessions) ? sessions : [];
  } catch {
    return [];
  }
}

// lastActiveAt 只在 SessionStart／UserPromptSubmit 時更新；長時間自主執行的回合仍會持續寫入對話紀錄，
// 故以對話紀錄的修改時間一併判斷是否仍在活動。
function lastActivityAt(session: Session): number {
  const lastActiveAt = Number(session.lastActiveAt);
  if (typeof session.transcriptPath !== 'string' || !session.transcriptPath) return lastActiveAt;
  try {
    return Math.max(lastActiveAt, fs.statSync(session.transcriptPath).mtimeMs);
  } catch {
    return lastActiveAt;
  }
}

export function isFreshSession(session: Session | null | undefined, now = Date.now(), ttlMs = DEFAULT_SESSION_TTL_MS): boolean {
  return Boolean(session && isWorkspaceCwd(session.cwd)
    && Number.isFinite(Number(session.lastActiveAt))
    && now - lastActivityAt(session) <= ttlMs);
}

export function pruneSessions(sessions: Session[], now = Date.now(), ttlMs = DEFAULT_SESSION_TTL_MS): Session[] {
  return sessions.filter((session) => isFreshSession(session, now, ttlMs));
}

export function selectActiveSession(sessions: Session[], now = Date.now(), ttlMs = DEFAULT_SESSION_TTL_MS): Session | null {
  return pruneSessions(sessions, now, ttlMs)
    .sort((left, right) => Number(right.lastActiveAt) - Number(left.lastActiveAt))[0] || null;
}

const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100];
const RETRYABLE_RENAME_ERRORS = new Set<unknown>(['EACCES', 'EBUSY', 'EPERM']);
const SESSIONS_LOCK_TIMEOUT_MS = 3_000;
const STALE_SESSIONS_LOCK_MS = 10_000;

function sleepSync(milliseconds: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function writeJsonAtomic(filePath: string, value: unknown, renameSync: (from: string, to: string) => void = fs.renameSync) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value), 'utf8');
  // Windows 上目標檔被其他程序（掃毒、索引或另一個 hook）短暫開啟時，rename 會以 EPERM 失敗。
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temporaryPath, filePath);
      return;
    } catch (error) {
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !RETRYABLE_RENAME_ERRORS.has(errorCode(error))) {
        fs.rmSync(temporaryPath, { force: true });
        throw error;
      }
      sleepSync(delay);
    }
  }
}

function acquireSessionsLock(lockPath: string) {
  const deadline = Date.now() + SESSIONS_LOCK_TIMEOUT_MS;
  while (!tryAcquireLock(lockPath, STALE_SESSIONS_LOCK_MS)) {
    if (Date.now() > deadline) throw new Error('等待 session 狀態鎖逾時。');
    sleepSync(25);
  }
}

// 多個 hook 可能同時讀改寫 session 清單；以鎖檔序列化，避免彼此覆蓋更新。
export function updateSessions(sessionsPath: string, update: (sessions: Session[]) => Session[]): Session[] {
  const lockPath = `${sessionsPath}.lock`;
  acquireSessionsLock(lockPath);
  try {
    const sessions = update(readSessions(sessionsPath));
    writeJsonAtomic(sessionsPath, sessions);
    return sessions;
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}
