#!/usr/bin/env node
// @ts-nocheck
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require('fs');
const path = require('path');
const dataDir = process.env.CLAUDE_PLUGIN_DATA || __dirname;
const pidPath = path.join(dataDir, 'claude-discord-presence.pid');
if (!fs.existsSync(pidPath)) {
    console.log('Claude Discord Presence is not running.');
    process.exit(0);
}
const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
try {
    process.kill(pid, 'SIGTERM');
}
catch (error) {
    if (error.code !== 'ESRCH')
        throw error;
}
fs.rmSync(pidPath, { force: true });
console.log('Claude Discord Presence stopped.');
