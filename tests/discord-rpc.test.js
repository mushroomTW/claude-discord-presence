'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { DiscordRpc, discordIpcPaths, encodeFrame, isTrustedIpcPath } = require('../plugins/claude-discord-presence/scripts/shared/discord-rpc');

function createFakeSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.frames = [];
  socket.write = (frame) => { socket.frames.push(Buffer.from(frame)); };
  socket.destroy = () => { socket.destroyed = true; };
  socket.setTimeout = (timeout, callback) => {
    socket.timeout = timeout;
    if (callback) socket.onTimeout = callback;
  };
  return socket;
}

function decodeFrame(frame) {
  return {
    opcode: frame.readInt32LE(0),
    payload: JSON.parse(frame.subarray(8).toString('utf8'))
  };
}

test('discordIpcPaths 產生各平台預期路徑', () => {
  assert.deepEqual(discordIpcPaths(2, 'win32', {}), ['\\\\?\\pipe\\discord-ipc-2']);
  assert.deepEqual(discordIpcPaths(2, 'linux', { XDG_RUNTIME_DIR: '/run/user/1' }), [
    '/run/user/1/discord-ipc-2',
    '/tmp/discord-ipc-2'
  ]);
  // macOS 的 Discord socket 在 $TMPDIR 之下；重複目錄只保留一次。
  assert.deepEqual(discordIpcPaths(0, 'darwin', { TMPDIR: '/var/folders/x/T', TMP: '/var/folders/x/T' }), [
    '/var/folders/x/T/discord-ipc-0',
    '/tmp/discord-ipc-0'
  ]);
});

test('Unix IPC 只接受目前使用者擁有的 socket', () => {
  const socket = { isSocket: () => true, uid: 1000 };
  assert.equal(isTrustedIpcPath('/tmp/discord-ipc-0', 'linux', () => 1000, () => socket), true);
  assert.equal(isTrustedIpcPath('/tmp/discord-ipc-0', 'linux', () => 1001, () => socket), false);
  assert.equal(isTrustedIpcPath('/tmp/discord-ipc-0', 'linux', () => 1000, () => ({ isSocket: () => false, uid: 1000 })), false);
});

test('連線前後都會驗證 Unix IPC 候選端點', () => {
  const socket = createFakeSocket();
  const delays = [];
  let checks = 0;
  const rpc = new DiscordRpc('12345678901234567', {
    createConnection: () => socket,
    getIpcPaths: (index) => index === 0 ? ['/tmp/discord-ipc-0'] : [],
    isTrustedIpcPath: () => ++checks === 1,
    setTimer: (_callback, delay) => { delays.push(delay); return {}; }
  });

  rpc.connect();
  socket.emit('connect');

  assert.equal(socket.destroyed, true);
  assert.equal(rpc.ready, false);
  assert.deepEqual(delays, [1_000]);
});

test('連線後送出 handshake，READY 後發布並去除重複活動', () => {
  const socket = createFakeSocket();
  const rpc = new DiscordRpc('12345678901234567', {
    createConnection: () => socket,
    getIpcPaths: () => ['fake-ipc'],
    randomUUID: () => 'nonce-1',
    pid: 42
  });

  rpc.connect();
  socket.emit('connect');
  assert.deepEqual(decodeFrame(socket.frames[0]), {
    opcode: 0,
    payload: { v: 1, client_id: '12345678901234567' }
  });

  const ready = encodeFrame(1, { evt: 'READY' });
  socket.emit('data', ready.subarray(0, 5));
  assert.equal(rpc.ready, false);
  socket.emit('data', ready.subarray(5));
  assert.equal(rpc.ready, true);

  rpc.setActivity({ details: 'Working' });
  rpc.setActivity({ details: 'Working' });
  assert.equal(socket.frames.length, 2);
  assert.deepEqual(decodeFrame(socket.frames[1]), {
    opcode: 1,
    payload: {
      cmd: 'SET_ACTIVITY',
      nonce: 'nonce-1',
      args: { pid: 42, activity: { details: 'Working' } }
    }
  });
});

test('無效 frame 會關閉 socket，且舊 socket 事件不會清掉新連線', () => {
  const first = createFakeSocket();
  const second = createFakeSocket();
  const sockets = [first, second];
  const rpc = new DiscordRpc('12345678901234567', {
    createConnection: () => sockets.shift(),
    getIpcPaths: () => ['fake-ipc'],
    setTimer: () => ({})
  });

  rpc.connect();
  first.emit('connect');
  rpc.socket = null;
  rpc.connect();
  second.emit('connect');
  first.emit('close');
  assert.equal(rpc.socket, second);

  const invalid = Buffer.alloc(8);
  invalid.writeInt32LE(1, 0);
  invalid.writeInt32LE(2 * 1024 * 1024, 4);
  second.emit('data', invalid);
  assert.equal(second.destroyed, true);
});

test('重連採指數退避且 disconnect 會清除計時器', () => {
  const delays = [];
  const cleared = [];
  const rpc = new DiscordRpc('12345678901234567', {
    setTimer: (_callback, delay) => {
      delays.push(delay);
      return `timer-${delay}`;
    },
    clearTimer: (timer) => cleared.push(timer)
  });

  rpc.scheduleReconnect();
  rpc.scheduleReconnect();
  assert.deepEqual(delays, [1_000]);
  rpc.disconnect();
  assert.deepEqual(cleared, ['timer-1000']);
});

test('所有 IPC 路徑失敗後會排程重連', () => {
  const sockets = [];
  const delays = [];
  const rpc = new DiscordRpc('12345678901234567', {
    createConnection: () => {
      const socket = createFakeSocket();
      sockets.push(socket);
      return socket;
    },
    getIpcPaths: (index) => index === 0 ? ['first', 'second'] : [],
    setTimer: (_callback, delay) => { delays.push(delay); return {}; }
  });

  rpc.connect();
  sockets[0].emit('error', new Error('first failed'));
  sockets[1].emit('error', new Error('second failed'));
  assert.deepEqual(delays, [1_000]);
});

test('關閉封包、壞 JSON 與過大輸入都會中止連線', () => {
  for (const data of [
    encodeFrame(2, { data: { message: 'closed' } }),
    encodeFrame(1, null),
    encodeFrame(1, []),
    Buffer.from([1, 0, 0, 0, 1, 0, 0, 0, 0xff]),
    Buffer.alloc(1024 * 1024 + 9)
  ]) {
    const socket = createFakeSocket();
    const rpc = new DiscordRpc('12345678901234567');
    rpc.socket = socket;
    rpc.onData(data);
    assert.equal(socket.destroyed, true);
  }
});

test('clearActivity 送出 null，disconnect 移除 listeners 並關閉 socket', () => {
  const socket = createFakeSocket();
  const rpc = new DiscordRpc('12345678901234567', {
    randomUUID: () => 'clear-nonce',
    pid: 7
  });
  rpc.socket = socket;
  rpc.ready = true;
  socket.on('close', () => {});
  socket.on('error', () => {});

  rpc.clearActivity();
  assert.equal(decodeFrame(socket.frames[0]).payload.args.activity, null);
  rpc.disconnect();
  assert.equal(socket.destroyed, true);
  assert.equal(rpc.ready, false);
  assert.equal(socket.listenerCount('close'), 0);
  assert.equal(socket.listenerCount('error'), 1);
});

test('READY 後呼叫 onReady，ERROR 封包會關閉 socket 並排程重連', () => {
  const socket = createFakeSocket();
  const delays = [];
  let readyCount = 0;
  const rpc = new DiscordRpc('12345678901234567', {
    createConnection: () => socket,
    getIpcPaths: () => ['fake-ipc'],
    setTimer: (_callback, delay) => { delays.push(delay); return {}; },
    onReady: () => { readyCount += 1; }
  });

  rpc.connect();
  socket.emit('connect');
  socket.emit('data', encodeFrame(1, { evt: 'READY' }));
  assert.equal(readyCount, 1);
  assert.equal(rpc.ready, true);

  socket.emit('data', encodeFrame(1, { evt: 'ERROR', data: { message: 'busy' } }));
  assert.equal(socket.destroyed, true);
  assert.equal(rpc.socket, null);
  assert.equal(rpc.ready, false);
  assert.deepEqual(delays, [1_000]);
});

test('切換 clientId 會清掉舊連線與重連計時器，舊 socket 的 close 不影響新連線', () => {
  const sockets = [];
  const cleared = [];
  const rpc = new DiscordRpc('11111111111111111', {
    createConnection: () => {
      const socket = createFakeSocket();
      sockets.push(socket);
      return socket;
    },
    getIpcPaths: () => ['fake-ipc'],
    setTimer: (_callback, delay) => `timer-${delay}`,
    clearTimer: (timer) => cleared.push(timer)
  });

  rpc.connect();
  sockets[0].emit('connect');
  rpc.scheduleReconnect();
  rpc.connect('22222222222222222');
  assert.deepEqual(cleared, ['timer-1000']);
  assert.equal(sockets[0].destroyed, true);
  sockets[1].emit('connect');
  sockets[0].emit('close');

  assert.equal(rpc.socket, sockets[1]);
  assert.equal(rpc.clientId, '22222222222222222');
  assert.deepEqual(decodeFrame(sockets[1].frames[0]).payload, { v: 1, client_id: '22222222222222222' });
});

test('重連計時器待執行時，connect 不會重複嘗試連線', () => {
  let attempts = 0;
  const rpc = new DiscordRpc('12345678901234567', {
    createConnection: () => { attempts += 1; return createFakeSocket(); },
    getIpcPaths: () => ['fake-ipc'],
    setTimer: () => ({})
  });

  rpc.scheduleReconnect();
  rpc.connect();
  assert.equal(attempts, 0);
});

test('探測端點期間重複呼叫 connect 不會開啟第二條連線', () => {
  const sockets = [];
  const rpc = new DiscordRpc('12345678901234567', {
    createConnection: () => { const socket = createFakeSocket(); sockets.push(socket); return socket; },
    getIpcPaths: () => ['fake-ipc'],
    setTimer: () => ({})
  });

  rpc.connect();
  rpc.connect();
  assert.equal(sockets.length, 1);
  sockets[0].emit('connect');
  assert.equal(rpc.socket, sockets[0]);
});

test('探測期間 disconnect 後，過時的連線完成會被丟棄', () => {
  const sockets = [];
  const rpc = new DiscordRpc('12345678901234567', {
    createConnection: () => { const socket = createFakeSocket(); sockets.push(socket); return socket; },
    getIpcPaths: () => ['fake-ipc'],
    setTimer: () => ({})
  });

  rpc.connect();
  rpc.disconnect();
  sockets[0].emit('connect');
  assert.equal(sockets[0].destroyed, true);
  assert.equal(sockets[0].frames.length, 0);
  assert.equal(rpc.socket, null);
});

test('端點連線逾時會改試下一個端點，全部逾時後排程重連', () => {
  const sockets = [];
  const delays = [];
  const rpc = new DiscordRpc('12345678901234567', {
    createConnection: () => { const socket = createFakeSocket(); sockets.push(socket); return socket; },
    getIpcPaths: (index) => index === 0 ? ['first', 'second'] : [],
    setTimer: (_callback, delay) => { delays.push(delay); return {}; },
    connectTimeoutMs: 1_234
  });

  rpc.connect();
  assert.equal(sockets[0].timeout, 1_234);
  sockets[0].onTimeout();
  assert.equal(sockets[0].destroyed, true);
  assert.equal(sockets.length, 2);
  sockets[1].onTimeout();
  assert.deepEqual(delays, [1_000]);
  assert.equal(rpc.pendingConnection, null);
  // 逾時後才抵達的 error 不會再推進探測。
  sockets[1].emit('error', new Error('late'));
  assert.equal(sockets.length, 2);
});

test('連線成功後關閉連線逾時，避免閒置的 IPC 連線被中斷', () => {
  const socket = createFakeSocket();
  const rpc = new DiscordRpc('12345678901234567', {
    createConnection: () => socket,
    getIpcPaths: () => ['fake-ipc'],
    setTimer: () => ({})
  });

  rpc.connect();
  socket.emit('connect');
  assert.equal(socket.timeout, 0);
  assert.equal(rpc.socket, socket);
});
