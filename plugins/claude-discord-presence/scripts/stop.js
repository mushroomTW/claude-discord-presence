#!/usr/bin/env node
// @ts-nocheck
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require('fs');
const childProcess = require('child_process');
const path = require('path');
const dataDir = process.env.CLAUDE_PLUGIN_DATA || __dirname;
const pidPath = path.join(dataDir, 'claude-discord-presence.pid');
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
const pids = new Set(findPluginDaemonPids());
if (fs.existsSync(pidPath))
    pids.add(Number(fs.readFileSync(pidPath, 'utf8').trim()));
for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0)
        continue;
    try {
        process.kill(pid, 'SIGTERM');
    }
    catch (error) {
        if (error.code !== 'ESRCH')
            throw error;
    }
}
fs.rmSync(pidPath, { force: true });
console.log(pids.size ? 'Claude Discord Presence stopped.' : 'Claude Discord Presence is not running.');
