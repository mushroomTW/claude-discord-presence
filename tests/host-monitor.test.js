'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHostMonitor } = require('../plugins/claude-discord-presence/scripts/shared/host-monitor');

function createQuery() {
  const pending = [];
  return { pending, query: (callback) => pending.push(callback) };
}

test('每次查詢完成後都能再次檢查，連續缺席達上限才觸發 onMissing', () => {
  const { pending, query } = createQuery();
  let missing = 0;
  const monitor = createHostMonitor({ query, missingLimit: 3, onMissing: () => { missing += 1; } });
  for (let index = 0; index < 3; index += 1) {
    monitor.check();
    assert.equal(pending.length, index + 1, '前一次查詢完成後必須能發出下一次查詢');
    pending[index](false);
  }
  assert.equal(missing, 1);
});

test('查詢進行中不重複查詢，查詢失敗不計入缺席', () => {
  const { pending, query } = createQuery();
  let missing = 0;
  const monitor = createHostMonitor({ query, missingLimit: 1, onMissing: () => { missing += 1; } });
  monitor.check();
  monitor.check();
  assert.equal(pending.length, 1);
  pending[0](null);
  assert.equal(missing, 0);
  monitor.check();
  pending[1](true);
  assert.equal(monitor.isKnownRunning(), true);
  monitor.check();
  pending[2](false);
  assert.equal(monitor.isKnownRunning(), false);
  assert.equal(missing, 1);
});

test('啟動寬限期內找不到宿主不判定為關閉', () => {
  const { pending, query } = createQuery();
  let clock = 0;
  let missing = 0;
  const monitor = createHostMonitor({ query, missingLimit: 1, startupGraceMs: 60_000, onMissing: () => { missing += 1; }, now: () => clock });
  monitor.check();
  pending[0](false);
  assert.equal(missing, 0);
  clock = 60_000;
  monitor.check();
  pending[1](false);
  assert.equal(missing, 1);
});
