'use strict';

const assert = require('node:assert/strict');
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
  assert.equal(shippedBroker.idleExitMs, 10 * 60_000);
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
    assert.ok(claudeState.updatedAt > 123);
    assert.equal(codexState, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('同分時維持目前顯示者，避免在兩個 Application 間反覆切換', () => {
  const now = Date.now();
  const claude = { source: 'claude', clientId: '11111111111111111', priority: 1, updatedAt: now - 800 };
  const codex = { source: 'codex', clientId: '22222222222222222', priority: 1, updatedAt: now - 100 };
  assert.equal(broker.selectActiveState([claude, codex], now, 'claude'), claude);
  assert.equal(broker.selectActiveState([claude, codex], now, null), codex);
  // 優先序較高者仍會取代目前顯示者。
  const busyCodex = { ...codex, priority: 5 };
  assert.equal(broker.selectActiveState([claude, busyCodex], now, 'claude'), busyCodex);
  // 目前顯示者過期時改選其他有效狀態。
  const staleClaude = { ...claude, updatedAt: now - broker.staleAfterMs - 1 };
  assert.equal(broker.selectActiveState([staleClaude, codex], now, 'claude'), codex);
});
