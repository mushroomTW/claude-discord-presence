'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const daemonPath = path.resolve(__dirname, '../plugins/claude-discord-presence/scripts/claude-discord-presence.js');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(200);
  }
  return predicate();
}

// 在隔離的資料目錄與家目錄啟動真正的 daemon。持續更新偽造的 Broker 心跳，
// 讓 daemon 不會拉起真正的 Broker 去連線開發者的 Discord。
function startSandboxDaemon({ sessions = () => [], setup = () => {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-daemon-runtime-'));
  const local = path.join(root, 'local');
  const home = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  const brokerDir = path.join(local, 'discord-presence-broker');
  for (const directory of [home, dataDir, brokerDir]) fs.mkdirSync(directory, { recursive: true });
  const beat = () => fs.writeFileSync(path.join(brokerDir, 'broker.json'), JSON.stringify({ pid: 1, updatedAt: Date.now() }));
  beat();
  const beatTimer = setInterval(beat, 2_000);
  setup({ root, home, brokerDir });
  fs.writeFileSync(path.join(dataDir, 'active-sessions.json'), JSON.stringify(sessions(root)));
  const child = childProcess.spawn(process.execPath, [daemonPath, '--instance-token=daemon-runtime-test-token'], {
    env: { ...process.env, LOCALAPPDATA: local, HOME: home, USERPROFILE: home, CLAUDE_PRESENCE_DATA: dataDir },
    stdio: 'ignore',
    windowsHide: true
  });
  return {
    root,
    dataDir,
    child,
    readDiagnostic() {
      try {
        return JSON.parse(fs.readFileSync(path.join(dataDir, 'claude-discord-presence.diagnostic.json'), 'utf8'));
      } catch {
        return null;
      }
    },
    async stop() {
      clearInterval(beatTimer);
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill();
        await exited;
      }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
}

test('對話紀錄晚於 session 建立時，定期重新計算仍會接上並更新活動', async () => {
  const sandbox = startSandboxDaemon({
    sessions: (root) => [{
      id: 'session-1',
      sessionId: 'session-1',
      projectName: 'workspace',
      cwd: path.join(root, 'workspace'),
      transcriptPath: path.join(root, 'transcript.jsonl'),
      lastActiveAt: Date.now()
    }]
  });
  try {
    const initial = await waitFor(() => sandbox.readDiagnostic(), 5_000);
    assert.equal(initial?.activeProject, 'workspace');
    assert.equal(initial.activity, 'Waiting');
    // 對話紀錄位於任何檔案監看範圍之外，只能靠定期 tick 發現。
    fs.writeFileSync(path.join(sandbox.root, 'transcript.jsonl'), `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit' }] } })}\n`);
    const updated = await waitFor(() => sandbox.readDiagnostic()?.activity === 'Editing', 15_000);
    assert.ok(updated, '定期 tick 未在時限內讀到新建立的對話紀錄');
  } finally {
    await sandbox.stop();
  }
});

test('tick 發生例外時 daemon 記錄錯誤並繼續執行', async () => {
  const sandbox = startSandboxDaemon({
    // 讓 Broker 狀態檔路徑成為目錄，使發布狀態時寫檔失敗。
    setup: ({ brokerDir }) => fs.mkdirSync(path.join(brokerDir, 'claude.json'))
  });
  const logPath = path.join(sandbox.dataDir, 'claude-discord-presence.log');
  try {
    const logged = await waitFor(() => fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes('更新 Discord Rich Presence 時發生錯誤'), 5_000);
    assert.ok(logged, '未記錄 tick 例外');
    await sleep(500);
    assert.equal(sandbox.child.exitCode, null, 'daemon 不應因 tick 例外而結束');
  } finally {
    await sandbox.stop();
  }
});
