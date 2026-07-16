'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const daemonState = require('../plugins/claude-discord-presence/scripts/daemon-state');

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
