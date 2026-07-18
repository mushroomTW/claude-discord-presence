'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const scriptsDir = path.resolve(__dirname, '../plugins/claude-discord-presence/scripts');

test('--status 可在隔離資料目錄讀取診斷資訊', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-presence-status-'));
  const diagnostic = { activeProject: 'example', activity: 'Working' };
  fs.writeFileSync(path.join(root, 'claude-discord-presence.diagnostic.json'), JSON.stringify(diagnostic), 'utf8');
  try {
    const result = childProcess.spawnSync(process.execPath, [path.join(scriptsDir, 'claude-discord-presence.js'), '--status'], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PRESENCE_DATA: root },
      timeout: 5_000,
      windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))), diagnostic);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stop 只移除指定 session，最後一個結束時清除 Broker 狀態', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-presence-stop-'));
  const dataDir = path.join(root, 'data');
  const brokerDir = path.join(root, 'broker');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(brokerDir);
  fs.writeFileSync(path.join(dataDir, 'active-sessions.json'), JSON.stringify([
    { id: 'one', cwd: path.join(root, 'one') },
    { id: 'two', cwd: path.join(root, 'two') }
  ]), 'utf8');
  const brokerPath = path.join(brokerDir, 'claude.json');
  fs.writeFileSync(brokerPath, '{}', 'utf8');
  const env = { ...process.env, CLAUDE_PRESENCE_DATA: dataDir, DISCORD_PRESENCE_BROKER_DATA: brokerDir };

  try {
    const first = childProcess.spawnSync(process.execPath, [path.join(scriptsDir, 'stop.js')], {
      input: JSON.stringify({ session_id: 'one' }), encoding: 'utf8', env, timeout: 5_000, windowsHide: true
    });
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'active-sessions.json'), 'utf8')).map((entry) => entry.id), ['two']);
    assert.equal(fs.existsSync(brokerPath), true);

    const second = childProcess.spawnSync(process.execPath, [path.join(scriptsDir, 'stop.js')], {
      input: JSON.stringify({ session_id: 'two' }), encoding: 'utf8', env, timeout: 5_000, windowsHide: true
    });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.existsSync(brokerPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
