'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const brokerRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-broker-runtime-'));
process.env.LOCALAPPDATA = brokerRuntimeRoot;
const shippedBroker = require('../plugins/claude-discord-presence/scripts/broker.js');
const broker = shippedBroker;

test.after(() => fs.rmSync(brokerRuntimeRoot, { recursive: true, force: true }));

test('過期狀態與空值都不會被選取', () => {
  const now = Date.now();
  assert.equal(broker.selectActiveState([null, undefined], now), null);
  assert.equal(broker.selectActiveState([{ priority: 9, updatedAt: now - broker.staleAfterMs - 1 }], now), null);
});

test('測試實際隨外掛出貨的 Broker', () => {
  assert.equal(shippedBroker.staleAfterMs, 3_000);
});

test('舊 socket 的延遲事件不會重設目前連線', () => {
  const rpc = new shippedBroker.Rpc();
  const oldSocket = {};
  const currentSocket = {};
  rpc.socket = currentSocket;
  rpc.ready = true;

  rpc.reset(oldSocket);

  assert.equal(rpc.socket, currentSocket);
  assert.equal(rpc.ready, true);
  assert.equal(rpc.timer, null);
});

test('切換 clientId 後，舊 socket 的 close 不影響新連線', () => {
  const sockets = [];
  const createConnection = () => {
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.cork = () => {};
    socket.write = () => {};
    socket.uncork = () => {};
    socket.destroy = () => { socket.destroyed = true; };
    sockets.push(socket);
    return socket;
  };
  const rpc = new shippedBroker.Rpc({ createConnection });

  rpc.connect('11111111111111111');
  sockets[0].emit('connect');
  rpc.connect('22222222222222222');
  sockets[1].emit('connect');
  sockets[0].emit('close');

  assert.equal(rpc.socket, sockets[1]);
  assert.equal(rpc.clientId, '22222222222222222');
});

test('Discord IPC 可接收分段 frame', () => {
  const rpc = new shippedBroker.Rpc();
  rpc.socket = { destroyed: false, destroy() {} };
  const payload = Buffer.from(JSON.stringify({ evt: 'IGNORED' }), 'utf8');
  const frame = Buffer.alloc(8 + payload.length);
  frame.writeInt32LE(1, 0);
  frame.writeInt32LE(payload.length, 4);
  payload.copy(frame, 8);

  rpc.data(frame.subarray(0, 5));
  assert.equal(rpc.buffer.length, 5);
  rpc.data(frame.subarray(5));
  assert.equal(rpc.buffer.length, 0);
  assert.equal(rpc.ready, false);
});

test('優先序高者勝出，同分取最後更新者', () => {
  const now = Date.now();
  const low = { source: 'claude', priority: 1, updatedAt: now - 100 };
  const highOld = { source: 'codex', priority: 5, updatedAt: now - 2_000 };
  const highNew = { source: 'codex', priority: 5, updatedAt: now - 500 };
  assert.equal(broker.selectActiveState([low, highOld, highNew], now), highNew);
});

test('loadStates 容忍缺檔與壞 JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-broker-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'claude.json'), JSON.stringify({ source: 'claude', priority: 1, updatedAt: 123 }), 'utf8');
    fs.writeFileSync(path.join(dir, 'codex.json'), '{broken', 'utf8');
    const [claudeState, codexState] = broker.loadStates(dir);
    assert.equal(claudeState.source, 'claude');
    assert.equal(codexState, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
