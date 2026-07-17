#!/usr/bin/env node
// @ts-nocheck
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    acquireStartLock,
    isOwnedDaemon,
    readDaemonState,
    releaseStartLock,
    stopLegacyDaemon,
    stopOwnedDaemon,
    writeDaemonState
} = require('./daemon-state');
const scriptDir = __dirname;
const dataDir = process.env.CLAUDE_PRESENCE_DATA || path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'mushroomTW',
    'claude-discord-presence'
);

function retireLegacyPluginDaemons() {
    const pluginDataRoot = path.join(os.homedir(), '.claude', 'plugins', 'data');
    try {
        for (const entry of fs.readdirSync(pluginDataRoot, { withFileTypes: true })) {
            if (!entry.isDirectory() || !/^claude-discord-presence-/i.test(entry.name))
                continue;
            const legacyDataDir = path.join(pluginDataRoot, entry.name);
            stopOwnedDaemon(legacyDataDir);
            stopLegacyDaemon(legacyDataDir, path.join(scriptDir, 'claude-discord-presence.js'));
        }
    }
    catch {
        // 未安裝舊版或外掛資料目錄暫時無法讀取時，直接使用新的共享狀態。
    }
}
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
    retireLegacyPluginDaemons();
    if (isOwnedDaemon(readDaemonState(dataDir))) {
        console.log('Claude Discord Presence is already running.');
        process.exit(0);
    }
    stopOwnedDaemon(dataDir);
    stopLegacyDaemon(dataDir, daemonScript);
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
    child.once('error', (error) => console.error(`無法啟動 Claude Discord Presence：${error.message}`));
    child.unref();
    console.log('Claude Discord Presence started.');
}
finally {
    releaseStartLock(dataDir);
}
