'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

function isWorkspaceCwd(cwd) {
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

function readSessions(sessionsPath) {
  try {
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    return Array.isArray(sessions) ? sessions : [];
  } catch {
    return [];
  }
}

function isFreshSession(session, now = Date.now(), ttlMs = DEFAULT_SESSION_TTL_MS) {
  return Boolean(session && isWorkspaceCwd(session.cwd)
    && Number.isFinite(Number(session.lastActiveAt))
    && now - Number(session.lastActiveAt) <= ttlMs);
}

function pruneSessions(sessions, now = Date.now(), ttlMs = DEFAULT_SESSION_TTL_MS) {
  return sessions.filter((session) => isFreshSession(session, now, ttlMs));
}

function selectActiveSession(sessions, now = Date.now(), ttlMs = DEFAULT_SESSION_TTL_MS) {
  return pruneSessions(sessions, now, ttlMs)
    .sort((left, right) => Number(right.lastActiveAt) - Number(left.lastActiveAt))[0] || null;
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value), 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

module.exports = { DEFAULT_SESSION_TTL_MS, isFreshSession, isWorkspaceCwd, readSessions, pruneSessions, selectActiveSession, writeJsonAtomic };
