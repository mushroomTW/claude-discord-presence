'use strict';

const assert = require('node:assert/strict');
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
