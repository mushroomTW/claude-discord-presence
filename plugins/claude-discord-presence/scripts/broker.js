#!/usr/bin/env node
'use strict';

// 唯一允許連線 Discord IPC 的本機仲裁器。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DiscordRpc } = require('./shared/discord-rpc');
const { getProcessCommandLine, isRunning } = require('./shared/process-utils');
const { createRotatingLogger } = require('./shared/logger');

const stateDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'discord-presence-broker');
const sources = ['claude', 'codex'];
// daemon 意外結束時，最遲三秒內撤下殘留的活動。
const staleAfterMs = 3_000;
const heartbeatIntervalMs = 5_000;
const staleLockMs = 30_000;
// Claude 與 Codex 都關閉後，Broker 沒有存在的必要；等有新 session 時再由外掛重新拉起。
const idleExitMs = 10 * 60_000;
const MAX_RPC_FRAME_BYTES = 1_000_000;
const MAX_LOG_BYTES = 1_000_000;
const statePath = path.join(stateDir, 'broker.state.json');
const heartbeatPath = path.join(stateDir, 'broker.json');
const lockPath = path.join(stateDir, 'broker.start.lock');
const logPath = path.join(stateDir, 'broker.log');

const log = createRotatingLogger(logPath, MAX_LOG_BYTES);

function loadStates(directory = stateDir) {
  return sources.map((source) => {
    try {
      const stateFile = path.join(directory, `${source}.json`);
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      // Producer 僅更新 mtime 作為心跳，避免每秒重寫完全相同的 JSON。
      return { ...state, updatedAt: Math.max(Number(state.updatedAt || 0), fs.statSync(stateFile).mtimeMs) };
    }
    catch { return null; }
  });
}

function selectActiveState(states, now = Date.now()) {
  return states
    .filter((state) => state && now - Number(state.updatedAt || 0) < staleAfterMs)
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0] || null;
}

// 每次斷線或切換 Application 都必須在 READY 後重新發布，故把 publish 掛在 onReady。
const rpc = new DiscordRpc(null, { log, maxFrameBytes: MAX_RPC_FRAME_BYTES, onReady: () => publish() });
let activityCleared = false;
let lastActiveStateAt = Date.now();

function publish() {
  const state = selectActiveState(loadStates());
  if (!state) {
    if (!activityCleared) rpc.clearActivity();
    activityCleared = true;
    return;
  }
  activityCleared = false;
  lastActiveStateAt = Date.now();
  if (!rpc.ready || rpc.clientId !== state.clientId) {
    rpc.connect(state.clientId);
    return;
  }
  rpc.setActivity(state.activity);
}

function readBrokerState() {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return Number.isInteger(state.pid) && state.pid > 0 ? state : null;
  } catch {
    return null;
  }
}

function isOwnedBroker(state) {
  return Boolean(state)
    && state.pid !== process.pid
    && isRunning(state.pid)
    && /broker\.js/i.test(getProcessCommandLine(state.pid) || '');
}

function acquireStartLock() {
  try {
    const descriptor = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    fs.closeSync(descriptor);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > staleLockMs) {
        fs.rmSync(lockPath, { force: true });
        return acquireStartLock();
      }
    } catch {
      return false;
    }
    return false;
  }
}

function writeHeartbeat() {
  try {
    fs.writeFileSync(heartbeatPath, JSON.stringify({ pid: process.pid, updatedAt: Date.now() }), 'utf8');
  } catch (error) {
    log(`無法寫入 Broker 心跳：${error.message}`);
  }
}

function shutdown() {
  try { fs.rmSync(heartbeatPath, { force: true }); } catch {}
  try {
    if (readBrokerState()?.pid === process.pid) fs.rmSync(statePath, { force: true });
  } catch {}
  rpc.clearActivity();
  setTimeout(() => process.exit(0), 150);
}

function tick() {
  publish();
  if (Date.now() - lastActiveStateAt > idleExitMs) {
    log(`超過 ${Math.round(idleExitMs / 60_000)} 分鐘沒有任何有效 producer 狀態，Broker 自動關閉。`);
    shutdown();
  }
}

function main() {
  fs.mkdirSync(stateDir, { recursive: true });
  if (!acquireStartLock()) {
    console.log('Discord Presence Broker 正在啟動中，略過重複啟動。');
    return;
  }
  try {
    if (isOwnedBroker(readBrokerState())) {
      console.log('Discord Presence Broker 已在執行。');
      return;
    }
    fs.writeFileSync(statePath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
  log('Discord Presence Broker 已啟動。');
  writeHeartbeat();
  setInterval(writeHeartbeat, heartbeatIntervalMs);
  try {
    fs.watch(stateDir, (_eventType, filename) => {
      if (filename && sources.includes(path.basename(filename, '.json'))) publish();
    });
  }
  catch { /* 每秒輪詢已是保底。 */ }
  setInterval(tick, 1_000);
  publish();
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { idleExitMs, loadStates, selectActiveState, sources, staleAfterMs };
if (require.main === module) main();
