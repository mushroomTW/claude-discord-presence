#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    acquireStartLock,
    isOwnedDaemon,
    readDaemonState,
    releaseStartLock,
    stopOwnedDaemon,
    writeDaemonState
} = require('./daemon-state');
const scriptDir = __dirname;
const dataDir = process.env.CLAUDE_PRESENCE_DATA || path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'claude-discord-presence'
);

fs.mkdirSync(dataDir, { recursive: true });
const config = JSON.parse(fs.readFileSync(path.join(scriptDir, 'config.json'), 'utf8'));
if (!/^\d{17,20}$/.test(String(config.clientId || ''))) {
    throw new Error('外掛內建的 Discord Application ID 無效，請重新安裝外掛。');
}
if (!acquireStartLock(dataDir)) {
    console.log('Claude Discord Presence is already starting.');
    process.exit(0);
}
try {
    const daemonScript = path.join(scriptDir, 'claude-discord-presence.js');
    if (isOwnedDaemon(readDaemonState(dataDir))) {
        console.log('Claude Discord Presence is already running.');
        process.exit(0);
    }
    stopOwnedDaemon(dataDir);
    const instanceToken = crypto.randomUUID();
    const child = childProcess.spawn(process.execPath, [daemonScript, `--instance-token=${instanceToken}`], {
        cwd: scriptDir,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, CLAUDE_PRESENCE_DATA: dataDir },
        windowsHide: true
    });
    if (!Number.isInteger(child.pid))
        throw new Error('無法取得常駐程序的 PID。');
    try {
        writeDaemonState(dataDir, {
            pid: child.pid,
            instanceToken,
            scriptPath: path.resolve(daemonScript)
        });
    }
    catch (error) {
        child.kill();
        throw error;
    }
    child.once('error', (error) => console.error(`無法啟動 Claude Discord Presence：${error instanceof Error ? error.message : String(error)}`));
    child.unref();
    console.log('Claude Discord Presence started.');
}
finally {
    releaseStartLock(dataDir);
}
