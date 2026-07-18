'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

function discordIpcPaths(index, platform = process.platform, environment = process.env) {
  if (platform === 'win32') return [`\\\\?\\pipe\\discord-ipc-${index}`];
  const directories = platform === 'linux'
    ? [environment.XDG_RUNTIME_DIR, '/tmp']
    : ['/tmp'];
  return directories.filter(Boolean).map((directory) => path.posix.join(directory, `discord-ipc-${index}`));
}

function encodeFrame(opcode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const frame = Buffer.allocUnsafe(8 + body.length);
  frame.writeInt32LE(opcode, 0);
  frame.writeInt32LE(body.length, 4);
  body.copy(frame, 8);
  return frame;
}

class DiscordRpc {
  constructor(clientId, dependencies = {}) {
    this.clientId = clientId;
    this.createConnection = dependencies.createConnection || net.createConnection.bind(net);
    this.getIpcPaths = dependencies.getIpcPaths || discordIpcPaths;
    this.setTimer = dependencies.setTimer || setTimeout;
    this.clearTimer = dependencies.clearTimer || clearTimeout;
    this.randomUUID = dependencies.randomUUID || crypto.randomUUID;
    this.pid = dependencies.pid || process.pid;
    this.log = dependencies.log || (() => {});
    this.maxFrameBytes = dependencies.maxFrameBytes || DEFAULT_MAX_FRAME_BYTES;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.ready = false;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.lastActivityFingerprint = null;
  }

  connect() {
    if (this.socket || !this.clientId) return;
    const tryPipe = (index) => {
      if (index > 9) {
        this.scheduleReconnect();
        return;
      }
      const paths = this.getIpcPaths(index);
      const tryPath = (pathIndex) => {
        if (pathIndex >= paths.length) {
          tryPipe(index + 1);
          return;
        }
        const socket = this.createConnection(paths[pathIndex]);
        let settled = false;
        socket.once('connect', () => {
          settled = true;
          this.socket = socket;
          this.buffer = Buffer.alloc(0);
          socket.on('data', (data) => this.onData(data));
          socket.on('close', () => this.reset(socket));
          socket.on('error', () => this.reset(socket));
          socket.write(encodeFrame(0, { v: 1, client_id: this.clientId }));
          this.log(`已連線至 Discord IPC #${index}`);
        });
        socket.once('error', () => {
          if (!settled) tryPath(pathIndex + 1);
        });
      };
      tryPath(0);
    };
    tryPipe(0);
  }

  reset(socket = null) {
    if (socket && this.socket !== socket) return;
    this.socket = null;
    this.ready = false;
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * (2 ** this.reconnectAttempt));
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  onData(data) {
    if (data.length > this.maxFrameBytes + 8 || this.buffer.length > this.maxFrameBytes + 8 - data.length) {
      this.log(`Discord IPC 接收緩衝超過上限：${data.length}`);
      this.buffer = Buffer.alloc(0);
      this.socket?.destroy();
      return;
    }
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 8) {
      const opcode = this.buffer.readInt32LE(0);
      const length = this.buffer.readInt32LE(4);
      if (length < 0 || length > this.maxFrameBytes) {
        this.log(`Discord IPC 封包長度無效：${length}`);
        this.socket?.destroy();
        return;
      }
      if (this.buffer.length < 8 + length) return;
      let payload;
      try {
        payload = JSON.parse(this.buffer.subarray(8, 8 + length).toString('utf8'));
      } catch (error) {
        this.log(`Discord IPC 封包無法解析：${error.message}`);
        this.socket?.destroy();
        return;
      }
      this.buffer = this.buffer.subarray(8 + length);
      if (opcode === 2) {
        this.log(`Discord IPC 已關閉：${payload.data?.message || JSON.stringify(payload)}`);
        this.socket?.destroy();
        return;
      }
      if (payload.evt === 'READY') {
        this.ready = true;
        this.lastActivityFingerprint = null;
        this.reconnectAttempt = 0;
        this.log('Discord Rich Presence 已就緒');
      } else if (payload.evt === 'ERROR') {
        this.log(`Discord RPC 錯誤：${payload.data?.message || JSON.stringify(payload)}`);
      }
    }
  }

  setActivity(activity) {
    if (!this.ready || !this.socket || this.socket.destroyed) return;
    const fingerprint = JSON.stringify(activity);
    if (this.lastActivityFingerprint === fingerprint) return;
    this.lastActivityFingerprint = fingerprint;
    this.socket.write(encodeFrame(1, {
      cmd: 'SET_ACTIVITY',
      nonce: this.randomUUID(),
      args: { pid: this.pid, activity }
    }));
  }

  clearActivity() {
    this.lastActivityFingerprint = null;
    this.setActivity(null);
  }

  disconnect() {
    if (this.reconnectTimer) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.lastActivityFingerprint = null;
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    if (socket) {
      socket.removeAllListeners('close');
      socket.removeAllListeners('error');
      socket.on('error', () => {});
      socket.destroy();
    }
  }
}

module.exports = { DEFAULT_MAX_FRAME_BYTES, DiscordRpc, discordIpcPaths, encodeFrame };
