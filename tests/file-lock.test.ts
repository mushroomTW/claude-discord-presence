import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { tryAcquireLock } from '../plugins/claude-discord-presence/scripts/shared/file-lock.ts';

function age(filePath: string, milliseconds: number) {
  const time = new Date(Date.now() - milliseconds);
  fs.utimesSync(filePath, time, time);
}

test('鎖檔被持有時回傳 false，逾時的鎖可被回收', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-file-lock-'));
  const lockPath = path.join(dir, 'start.lock');
  try {
    assert.equal(tryAcquireLock(lockPath, 10_000), true);
    assert.equal(tryAcquireLock(lockPath, 10_000), false);
    age(lockPath, 60_000);
    assert.equal(tryAcquireLock(lockPath, 10_000), true);
    assert.deepEqual(fs.readdirSync(dir), ['start.lock']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('其他程序正在回收時不刪除鎖檔，殘留的回收鎖逾時後清除', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-file-lock-'));
  const lockPath = path.join(dir, 'start.lock');
  const reclaimPath = `${lockPath}.reclaim`;
  try {
    fs.writeFileSync(lockPath, '');
    age(lockPath, 60_000);
    fs.writeFileSync(reclaimPath, '');
    assert.equal(tryAcquireLock(lockPath, 10_000), false);
    assert.equal(fs.existsSync(lockPath), true);

    age(reclaimPath, 60_000);
    assert.equal(tryAcquireLock(lockPath, 10_000), false);
    assert.equal(fs.existsSync(reclaimPath), false);
    assert.equal(tryAcquireLock(lockPath, 10_000), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
