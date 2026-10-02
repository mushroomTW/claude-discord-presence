'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

function discordIpcPaths(index, platform = process.platform, environment = process.env) {
  if (platform === 'win32') return [String.raw`\\?\pipe\discord-ipc-${index}`]; // NOSONAR javascript:S7780 - String.raw 避免反斜線轉義
  // macOS 的 Discord socket 位於 $TMPDIR 之下，不在 /tmp；Linux 則優先使用 XDG_RUNTIME_DIR。
  const directories = [environment.XDG_RUNTIME_DIR, environment.TMPDIR, environment.TMP, environment.TEMP, '/tmp']; // NOSONAR javascript:S5443 - Discord IPC 標準 socket 位置（唯讀連線探測，非建立可寫檔案）
  return [...new Set(directories.filter(Boolean))].map((directory) => path.posix.join(directory, `discord-ipc-${index}`));
}

function isTrustedIpcPath(ipcPath, platform = process.platform, getuid = process.getuid, statSync = fs.statSync) {
  // 測試替身與 Windows named pipe 沒有可用的 Unix socket 擁有者資訊。
  if (platform === 'win32' || !path.isAbsolute(ipcPath)) return true;
  if (typeof getuid !== 'function') return false;
  try {
    const stat = statSync(ipcPath);
    return stat.isSocket() && stat.uid === getuid();
  } catch {
    return false;
  }
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
    this.isTrustedIpcPath = dependencies.isTrustedIpcPath || isTrustedIpcPath;
    this.setTimer = dependencies.setTimer || setTimeout;
    this.clearTimer = dependencies.clearTimer || clearTimeout;
    this.randomUUID = dependencies.randomUUID || crypto.randomUUID;
    this.pid = dependencies.pid || process.pid;
    this.log = dependencies.log || (() => {});
    // READY 後的回呼：Broker 用它在斷線或切換 Application 後重新發布活動。
    this.onReady = dependencies.onReady || (() => {});
    this.maxFrameBytes = dependencies.maxFrameBytes || DEFAULT_MAX_FRAME_BYTES;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.ready = false;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.lastActivityFingerprint = null;
    // 正在探測 IPC 端點的連線嘗試；探測期間 socket 尚未建立，需另行防止重入。
    this.pendingConnection = null;
  }

  connect(clientId = this.clientId) {
    if (clientId && clientId !== this.clientId) {
      // 切換 Application：先清掉舊連線與待執行的重連計時器，再以新 clientId 重新握手。
      this.disconnect();
      this.clientId = clientId;
    }
    // 重連計時器待執行期間不重複嘗試，讓指數退避真正生效。
    if (this.socket || this.reconnectTimer || this.pendingConnection || !this.clientId) return;
    const attempt = {};
    this.pendingConnection = attempt;
    const tryPipe = (index) => {
      if (this.pendingConnection !== attempt) return;
      if (index > 9) {
        this.pendingConnection = null;
        this.scheduleReconnect();
        return;
      }
      const paths = this.getIpcPaths(index);
      const tryPath = (pathIndex) => {
        if (this.pendingConnection !== attempt) return;
        if (pathIndex >= paths.length) {
          tryPipe(index + 1);
          return;
        }
        const ipcPath = paths[pathIndex];
        if (!this.isTrustedIpcPath(ipcPath)) {
          tryPath(pathIndex + 1);
          return;
        }
        const socket = this.createConnection(ipcPath);
        let settled = false;
        socket.once('connect', () => {
          settled = true;
          // 探測期間已 disconnect 或切換 Application：放棄這條過時的連線。
          if (this.pendingConnection !== attempt) {
            socket.destroy();
            return;
          }
          // 連線完成後再次檢查，避免候選 socket 在連線過程被替換。
          if (!this.isTrustedIpcPath(ipcPath)) {
            socket.destroy();
            tryPath(pathIndex + 1);
            return;
          }
          this.pendingConnection = null;
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
        this.log(`Discord IPC 封包無法解析：${error instanceof Error ? error.message : String(error)}`);
        this.socket?.destroy();
        return;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        this.log('Discord IPC 封包 payload 必須為物件');
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
        this.onReady();
      } else if (payload.evt === 'ERROR') {
        this.log(`Discord RPC 錯誤：${payload.data?.message || JSON.stringify(payload)}`);
        // Discord 會在 IPC server 暫時滿載時回傳 ERROR 而非直接斷線；必須主動重連。
        const socket = this.socket;
        socket?.destroy();
        this.reset(socket);
        return;
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
    this.pendingConnection = null;
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

module.exports = { DEFAULT_MAX_FRAME_BYTES, DiscordRpc, discordIpcPaths, encodeFrame, isTrustedIpcPath };
