'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sessionState = require('../plugins/claude-discord-presence/scripts/session-state');

test('排除家目錄與過期 session，選擇最後活躍的有效專案', () => {
  const now = Date.now();
  const active = { cwd: path.join(os.tmpdir(), 'presence-active-project'), lastActiveAt: now - 1 };
  const stale = { cwd: path.join(os.tmpdir(), 'presence-stale-project'), lastActiveAt: now - sessionState.DEFAULT_SESSION_TTL_MS - 1 };
  assert.equal(sessionState.isWorkspaceCwd(os.homedir()), false);
  assert.equal(sessionState.selectActiveSession([{ cwd: os.homedir(), lastActiveAt: now }, stale, active], now), active);
});

test('isWorkspaceCwd 排除 Claude 與 Codex 資料目錄並接受一般專案路徑', () => {
  assert.equal(sessionState.isWorkspaceCwd(path.join(os.homedir(), '.claude')), false);
  assert.equal(sessionState.isWorkspaceCwd(path.join(os.homedir(), '.codex', 'sessions')), false);
  assert.equal(sessionState.isWorkspaceCwd(path.join(os.homedir(), 'projects', 'demo')), true);
  assert.equal(sessionState.isWorkspaceCwd(''), false);
  assert.equal(sessionState.isWorkspaceCwd(null), false);
});

test('isFreshSession 要求有效工作目錄與未過期的 lastActiveAt', () => {
  const now = Date.now();
  const cwd = path.join(os.tmpdir(), 'presence-fresh-project');
  assert.equal(sessionState.isFreshSession({ cwd, lastActiveAt: now - 1 }, now), true);
  assert.equal(sessionState.isFreshSession({ cwd, lastActiveAt: now - sessionState.DEFAULT_SESSION_TTL_MS - 1 }, now), false);
  assert.equal(sessionState.isFreshSession({ cwd }, now), false);
  assert.equal(sessionState.isFreshSession({ cwd: os.homedir(), lastActiveAt: now }, now), false);
});

test('writeJsonAtomic 完整寫入、可覆寫且不留暫存檔', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-atomic-test-'));
  const target = path.join(dir, 'sessions.json');
  try {
    sessionState.writeJsonAtomic(target, [{ id: 'a' }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), [{ id: 'a' }]);
    sessionState.writeJsonAtomic(target, [{ id: 'b' }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), [{ id: 'b' }]);
    assert.deepEqual(fs.readdirSync(dir), ['sessions.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
