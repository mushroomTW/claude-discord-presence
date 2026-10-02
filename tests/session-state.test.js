'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
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

test('writeJsonAtomic 遇到暫時性 rename 錯誤會重試，最終失敗時清除暫存檔', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-atomic-retry-'));
  const target = path.join(dir, 'sessions.json');
  const busy = () => Object.assign(new Error('busy'), { code: 'EPERM' });
  try {
    let calls = 0;
    sessionState.writeJsonAtomic(target, [{ id: 'a' }], (from, to) => {
      calls += 1;
      if (calls < 3) throw busy();
      fs.renameSync(from, to);
    });
    assert.equal(calls, 3);
    assert.throws(() => sessionState.writeJsonAtomic(target, [{ id: 'b' }], () => { throw busy(); }), /busy/);
    assert.deepEqual(fs.readdirSync(dir), ['sessions.json']);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), [{ id: 'a' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updateSessions 完成後釋放鎖檔，並回收逾時的舊鎖', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-sessions-lock-'));
  const target = path.join(dir, 'sessions.json');
  const ids = () => JSON.parse(fs.readFileSync(target, 'utf8')).map((entry) => entry.id);
  try {
    sessionState.updateSessions(target, (sessions) => [...sessions, { id: 'a' }]);
    assert.deepEqual(sessionState.updateSessions(target, (sessions) => [...sessions, { id: 'b' }]).map((entry) => entry.id), ['a', 'b']);
    assert.deepEqual(fs.readdirSync(dir), ['sessions.json']);

    const lockPath = `${target}.lock`;
    fs.writeFileSync(lockPath, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    sessionState.updateSessions(target, (sessions) => sessions.slice(1));
    assert.deepEqual(ids(), ['b']);
    assert.deepEqual(fs.readdirSync(dir), ['sessions.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('多個程序同時更新 session 不會遺失紀錄', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-sessions-race-'));
  const target = path.join(dir, 'sessions.json');
  const modulePath = require.resolve('../plugins/claude-discord-presence/scripts/session-state');
  const script = 'require(process.env.MODULE).updateSessions(process.env.TARGET, (list) => [...list, { id: process.env.ID }]);';
  try {
    await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise((resolve, reject) => {
      const child = childProcess.spawn(process.execPath, ['-e', script], {
        env: { ...process.env, MODULE: modulePath, TARGET: target, ID: String(index) },
        stdio: 'inherit',
        windowsHide: true
      });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`子程序結束碼 ${code}`))));
    })));
    const ids = JSON.parse(fs.readFileSync(target, 'utf8')).map((entry) => entry.id).sort();
    assert.deepEqual(ids, ['0', '1', '2', '3', '4', '5', '6', '7']);
    assert.deepEqual(fs.readdirSync(dir), ['sessions.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('對話紀錄仍在寫入時，即使 lastActiveAt 已逾時也視為有效 session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-long-turn-'));
  const transcriptPath = path.join(dir, 'transcript.jsonl');
  const now = Date.now();
  const session = {
    cwd: path.join(os.tmpdir(), 'presence-long-turn-workspace'),
    lastActiveAt: now - sessionState.DEFAULT_SESSION_TTL_MS - 60_000,
    transcriptPath
  };
  try {
    assert.equal(sessionState.isFreshSession(session, now), false);
    fs.writeFileSync(transcriptPath, '{}\n');
    assert.equal(sessionState.isFreshSession(session, now), true);
    const old = new Date(now - sessionState.DEFAULT_SESSION_TTL_MS - 1_000);
    fs.utimesSync(transcriptPath, old, old);
    assert.equal(sessionState.isFreshSession(session, now), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
