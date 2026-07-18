#!/usr/bin/env node
'use strict';

// 唯一允許連線 Discord IPC 的本機仲裁器。
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const stateDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'mushroomTW', 'discord-presence-broker');
const sources = ['claude', 'codex'];
// daemon 意外結束時，最遲三秒內撤下殘留的活動。
const staleAfterMs = 3_000;
const heartbeatIntervalMs = 5_000;
const staleLockMs = 30_000;
const MAX_RPC_FRAME_BYTES = 1_000_000;
const MAX_LOG_BYTES = 1_000_000;
const statePath = path.join(stateDir, 'broker.state.json');
const heartbeatPath = path.join(stateDir, 'broker.json');
const lockPath = path.join(stateDir, 'broker.start.lock');
const logPath = path.join(stateDir, 'broker.log');

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size >= MAX_LOG_BYTES) {
      fs.rmSync(`${logPath}.1`, { force: true });
      fs.renameSync(logPath, `${logPath}.1`);
    }
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  } catch {
    // 日誌寫入失敗不影響仲裁器運作。
  }
}

function ipcPaths(index) {
  if (process.platform === 'win32') return [`\\\\?\\pipe\\discord-ipc-${index}`];
  return [process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, process.env.TMP, process.env.TEMP, '/tmp']
    .filter(Boolean).map((directory) => path.join(directory, `discord-ipc-${index}`));
}

function writeFrame(socket, opcode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(8);
  header.writeInt32LE(opcode, 0);
  header.writeInt32LE(body.length, 4);
  socket.cork();
  socket.write(header);
  socket.write(body);
  socket.uncork();
}

function loadStates(directory = stateDir) {
  return sources.map((source) => {
    try { return JSON.parse(fs.readFileSync(path.join(directory, `${source}.json`), 'utf8')); }
    catch { return null; }
  });
}

function selectActiveState(states, now = Date.now()) {
  return states
    .filter((state) => state && now - Number(state.updatedAt || 0) < staleAfterMs)
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0] || null;
}

class Rpc {
  constructor({ createConnection = net.createConnection.bind(net), setTimer = setTimeout } = {}) {
    this.socket = null; this.clientId = null; this.ready = false; this.buffer = Buffer.alloc(0); this.timer = null; this.attempt = 0;
    this.createConnection = createConnection;
    this.setTimer = setTimer;
  }
  connect(clientId) {
    if (this.timer) return;
    if (this.socket && this.clientId === clientId) return;
    this.socket?.destroy(); this.socket = null; this.ready = false; this.clientId = clientId;
    const tryPath = (index, pathIndex = 0) => {
      if (index > 9) return this.retry();
      const paths = ipcPaths(index);
      if (pathIndex >= paths.length) return tryPath(index + 1);
      const socket = this.createConnection(paths[pathIndex]); let connected = false;
      socket.once('connect', () => {
        connected = true;
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        socket.on('data', (data) => this.data(data));
        socket.on('close', () => this.reset(socket));
        socket.on('error', () => this.reset(socket));
        writeFrame(socket, 0, { v: 1, client_id: clientId });
        log(`已連線至 Discord IPC #${index}`);
      });
      socket.once('error', () => { if (!connected) tryPath(index, pathIndex + 1); });
    };
    tryPath(0);
  }
  reset(socket = null) {
    // 已被替換的舊 socket 可能稍後才送出 close/error；不可讓它清掉新連線。
    if (socket && this.socket !== socket) return;
    this.socket = null;
    this.ready = false;
    this.retry();
  }
  retry() { if (this.timer || !this.clientId) return; const delay = Math.min(30_000, 1_000 * (2 ** this.attempt++)); this.timer = this.setTimer(() => { this.timer = null; this.connect(this.clientId); }, delay); }
  data(data) {
    if (data.length > MAX_RPC_FRAME_BYTES + 8 || this.buffer.length > MAX_RPC_FRAME_BYTES + 8 - data.length) {
      log(`Discord IPC 接收緩衝超過上限：${data.length}`);
      this.buffer = Buffer.alloc(0);
      this.socket?.destroy();
      return;
    }
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 8) {
      const opcode = this.buffer.readInt32LE(0);
      const length = this.buffer.readInt32LE(4);
      if (length < 0 || length > MAX_RPC_FRAME_BYTES) {
        log(`收到無效的 Discord IPC 封包長度：${length}`);
        this.buffer = Buffer.alloc(0);
        this.socket?.destroy();
        return;
      }
      if (this.buffer.length < length + 8) return;
      let payload;
      try {
        payload = JSON.parse(this.buffer.subarray(8, 8 + length).toString('utf8'));
      } catch (error) {
        log(`無法解析 Discord IPC 封包：${error.message}`);
        this.buffer = Buffer.alloc(0);
        this.socket?.destroy();
        return;
      }
      this.buffer = this.buffer.subarray(8 + length);
      if (opcode === 2) {
        log(`Discord IPC 已關閉：${payload.data?.message || JSON.stringify(payload)}`);
        this.socket?.destroy();
        return;
      }
      if (payload.evt === 'READY') {
        this.ready = true;
        this.attempt = 0;
        log('Discord Rich Presence 已就緒');
        publish();
      } else if (payload.evt === 'ERROR') {
        log(`Discord RPC 錯誤：${payload.data?.message || JSON.stringify(payload)}`);
        // Discord 會在 IPC server 暫時滿載時回傳 ERROR 而非直接斷線；必須主動重連。
        this.socket?.destroy();
        this.reset();
      }
    }
  }
  set(activity) { if (this.ready && this.socket && !this.socket.destroyed) writeFrame(this.socket, 1, { cmd: 'SET_ACTIVITY', nonce: crypto.randomUUID(), args: { pid: process.pid, activity } }); }
}

const rpc = new Rpc(); let lastKey = null;
function publish() {
  const state = selectActiveState(loadStates());
  if (!state) { if (lastKey !== 'none') rpc.set(null); lastKey = 'none'; return; }
  const key = JSON.stringify([state.clientId, state.activity]);
  // 每次斷線或切換 Application 都必須在 READY 後重新發布，不能讓去重邏輯吞掉首次活動。
  if (!rpc.ready || rpc.clientId !== state.clientId) {
    lastKey = null;
    rpc.connect(state.clientId);
    return;
  }
  if (key === lastKey) return;
  rpc.set(state.activity);
  lastKey = key;
}

// 單例保護：同一時間只允許一個 broker 直接連線 Discord IPC。
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
      ? childProcess.spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`], { encoding: 'utf8', windowsHide: true })
      : childProcess.spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    if (result.error || result.status !== 0) return null;
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
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
  rpc.set(null);
  setTimeout(() => process.exit(0), 150);
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
  setInterval(publish, 1_000);
  publish();
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { Rpc, loadStates, selectActiveState, sources, staleAfterMs };
if (require.main === module) main();
