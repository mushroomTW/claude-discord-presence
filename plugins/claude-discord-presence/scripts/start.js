#!/usr/bin/env node
// @ts-nocheck
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const scriptDir = __dirname;
const dataDir = process.env.CLAUDE_PLUGIN_DATA || scriptDir;
const pidPath = path.join(dataDir, 'claude-discord-presence.pid');
function isRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function isPluginDaemon(pid) {
    try {
        const result = process.platform === 'win32'
            ? childProcess.spawnSync('powershell', [
                '-NoProfile',
                '-Command',
                `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`
            ], { encoding: 'utf8', windowsHide: true })
            : childProcess.spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
        return result.status === 0 && /claude-discord-presence/i.test(result.stdout);
    }
    catch {
        return false;
    }
}
function stopDaemon(directory) {
    const stalePidPath = path.join(directory, 'claude-discord-presence.pid');
    if (!fs.existsSync(stalePidPath))
        return;
    const pid = Number(fs.readFileSync(stalePidPath, 'utf8').trim());
    if (Number.isInteger(pid) && isRunning(pid) && isPluginDaemon(pid)) {
        try {
            process.kill(pid, 'SIGTERM');
        }
        catch (error) {
            if (error.code !== 'ESRCH')
                throw error;
        }
    }
    fs.rmSync(stalePidPath, { force: true });
}
function findPluginDaemonPids() {
    const result = process.platform === 'win32'
        ? childProcess.spawnSync('powershell', [
            '-NoProfile',
            '-Command',
            "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'claude-discord-presence\\.js' } | ForEach-Object { $_.ProcessId }"
        ], { encoding: 'utf8', windowsHide: true })
        : childProcess.spawnSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });
    if (result.error || result.status !== 0)
        return [];
    return result.stdout.split(/\r?\n/)
        .map((line) => process.platform === 'win32' ? Number(line.trim()) : Number(line.trim().split(/\s+/, 1)[0]))
        .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}
function stopProcess(pid) {
    if (!isRunning(pid) || !isPluginDaemon(pid))
        return;
    try {
        process.kill(pid, 'SIGTERM');
    }
    catch (error) {
        if (error.code !== 'ESRCH')
            throw error;
    }
}
function stopStaleDaemons() {
    const pluginDataRoot = path.dirname(dataDir);
    if (!fs.existsSync(pluginDataRoot))
        return;
    for (const entry of fs.readdirSync(pluginDataRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('claude-discord-presence-'))
            stopDaemon(path.join(pluginDataRoot, entry.name));
    }
    for (const pid of findPluginDaemonPids())
        stopProcess(pid);
}
fs.mkdirSync(dataDir, { recursive: true });
const config = JSON.parse(fs.readFileSync(path.join(scriptDir, 'config.json'), 'utf8'));
if (!/^\d{17,20}$/.test(String(config.clientId || ''))) {
    throw new Error('外掛內建的 Discord Application ID 無效，請重新安裝外掛。');
}
stopStaleDaemons();
const child = childProcess.spawn(process.execPath, [path.join(scriptDir, 'claude-discord-presence.js')], {
    cwd: scriptDir,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    windowsHide: true
});
child.unref();
console.log('Claude Discord Presence started.');
