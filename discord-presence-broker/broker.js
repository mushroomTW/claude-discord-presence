#!/usr/bin/env node
'use strict';

// 唯一允許連線 Discord IPC 的本機仲裁器。
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const stateDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'mushroomTW', 'discord-presence-broker');
const sources = ['claude', 'codex'];
const staleAfterMs = 15_000;
fs.mkdirSync(stateDir, { recursive: true });

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
  socket.write(header);
  socket.write(body);
}

class Rpc {
  constructor() { this.socket = null; this.clientId = null; this.ready = false; this.buffer = Buffer.alloc(0); this.timer = null; this.attempt = 0; }
  connect(clientId) {
    if (this.socket && this.clientId === clientId) return;
    this.socket?.destroy(); this.socket = null; this.ready = false; this.clientId = clientId;
    const tryPath = (index, pathIndex = 0) => {
      if (index > 9) return this.retry();
      const paths = ipcPaths(index);
      if (pathIndex >= paths.length) return tryPath(index + 1);
      const socket = net.createConnection(paths[pathIndex]); let connected = false;
      socket.once('connect', () => { connected = true; this.socket = socket; this.buffer = Buffer.alloc(0); socket.on('data', (data) => this.data(data)); socket.on('close', () => this.reset()); socket.on('error', () => this.reset()); writeFrame(socket, 0, { v: 1, client_id: clientId }); });
      socket.once('error', () => { if (!connected) tryPath(index, pathIndex + 1); });
    };
    tryPath(0);
  }
  reset() { this.socket = null; this.ready = false; this.retry(); }
  retry() { if (this.timer || !this.clientId) return; const delay = Math.min(30_000, 1_000 * (2 ** this.attempt++)); this.timer = setTimeout(() => { this.timer = null; this.connect(this.clientId); }, delay); }
  data(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 8) { const length = this.buffer.readInt32LE(4); if (length < 0 || this.buffer.length < length + 8) return; const payload = JSON.parse(this.buffer.subarray(8, 8 + length).toString('utf8')); this.buffer = this.buffer.subarray(8 + length); if (payload.evt === 'READY') { this.ready = true; this.attempt = 0; publish(); } }
  }
  set(activity) { if (this.ready && this.socket && !this.socket.destroyed) writeFrame(this.socket, 1, { cmd: 'SET_ACTIVITY', nonce: crypto.randomUUID(), args: { pid: process.pid, activity } }); }
}

const rpc = new Rpc(); let lastKey = null;
function loadStates() {
  return sources.map((source) => { try { return JSON.parse(fs.readFileSync(path.join(stateDir, `${source}.json`), 'utf8')); } catch { return null; } })
    .filter((state) => state && Date.now() - Number(state.updatedAt || 0) < staleAfterMs)
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}
function publish() {
  const state = loadStates()[0];
  if (!state) { if (lastKey !== 'none') rpc.set(null); lastKey = 'none'; return; }
  const key = JSON.stringify([state.clientId, state.activity]);
  if (!rpc.ready || rpc.clientId !== state.clientId) {
    lastKey = null;
    rpc.connect(state.clientId);
    return;
  }
  if (key === lastKey) return;
  rpc.set(state.activity);
  lastKey = key;
}
fs.watch(stateDir, publish);
setInterval(publish, 1_000);
publish();
