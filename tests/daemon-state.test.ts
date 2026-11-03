import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as daemonState from '../plugins/claude-discord-presence/scripts/daemon-state.ts';

function createTemporaryDirectory() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-discord-presence-test-'));
}

test('只接受包含 PID、token 與腳本路徑的有效常駐程序狀態', () => {
    assert.equal(daemonState.isValidDaemonState(null), false);
    assert.equal(daemonState.isValidDaemonState({ pid: 1 }), false);
    assert.equal(daemonState.isValidDaemonState({
        pid: 123,
        instanceToken: '1234567890abcdef',
        scriptPath: '/tmp/daemon.js'
    }), true);
});

test('狀態檔只有在擁有者相符時才會移除', () => {
    const dataDir = createTemporaryDirectory();
    const state = {
        pid: 123,
        instanceToken: '1234567890abcdef',
        scriptPath: '/tmp/daemon.js'
    };
    try {
        daemonState.writeDaemonState(dataDir, state);
        daemonState.writeDaemonState(dataDir, { ...state, pid: 124 });
        daemonState.writeDaemonState(dataDir, state);
        assert.deepEqual(daemonState.readDaemonState(dataDir), state);
        assert.equal(daemonState.removeDaemonState(dataDir, { ...state, pid: 456 }), false);
        assert.deepEqual(daemonState.readDaemonState(dataDir), state);
        assert.equal(daemonState.removeDaemonState(dataDir, state), true);
        assert.equal(daemonState.readDaemonState(dataDir), null);
    }
    finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('啟動鎖可避免同一資料目錄的並行啟動', () => {
    const dataDir = createTemporaryDirectory();
    try {
        assert.equal(daemonState.acquireStartLock(dataDir), true);
        assert.equal(daemonState.acquireStartLock(dataDir), false);
        daemonState.releaseStartLock(dataDir);
        assert.equal(daemonState.acquireStartLock(dataDir), true);
    }
    finally {
        daemonState.releaseStartLock(dataDir);
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('狀態檔心跳新鮮時直接認定擁有者，過期後退回命令列比對', () => {
    const dataDir = createTemporaryDirectory();
    // 使用執行中的測試程序 PID；腳本路徑刻意不符，命令列比對必然失敗。
    const state = {
        pid: process.pid,
        instanceToken: '1234567890abcdef',
        scriptPath: path.join(dataDir, 'not-the-daemon.js')
    };
    const statePath = path.join(dataDir, 'claude-discord-presence.state.json');
    const expire = () => fs.utimesSync(statePath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    try {
        daemonState.writeDaemonState(dataDir, state);
        assert.equal(daemonState.isOwnedDaemon(state, dataDir), true);
        expire();
        assert.equal(daemonState.isOwnedDaemon(state, dataDir), false);
        assert.equal(daemonState.touchDaemonState(dataDir, { ...state, instanceToken: 'fedcba0987654321' }), false);
        assert.equal(daemonState.isOwnedDaemon(state, dataDir), false);
        assert.equal(daemonState.touchDaemonState(dataDir, state), true);
        assert.equal(daemonState.isOwnedDaemon(state, dataDir), true);
    }
    finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});
