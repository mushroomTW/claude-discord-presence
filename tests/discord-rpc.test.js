'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { DiscordRpc, discordIpcPaths, encodeFrame } = require('../plugins/claude-discord-presence/scripts/shared/discord-rpc');

function createFakeSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.frames = [];
  socket.write = (frame) => { socket.frames.push(Buffer.from(frame)); };
  socket.destroy = () => { socket.destroyed = true; };
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
