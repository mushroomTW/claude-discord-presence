#!/usr/bin/env node
// @ts-nocheck
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require('fs');
const path = require('path');
const { stopLegacyDaemon, stopOwnedDaemon } = require('./daemon-state');
const dataDir = process.env.CLAUDE_PLUGIN_DATA || __dirname;
const daemonScript = path.join(__dirname, 'claude-discord-presence.js');
const sessionsPath = path.join(dataDir, 'active-sessions.json');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
    let sessionId = null;
    try {
        const event = JSON.parse(input.trim().split(/\r?\n/).pop());
        sessionId = event?.session_id ?? event?.sessionId ?? event?.id ?? event?.transcript_path ?? event?.payload?.transcript_path ?? event?.cwd;
    }
    catch {}
    if (sessionId) {
        try {
            const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
            const remaining = Array.isArray(sessions) ? sessions.filter((entry) => entry?.id !== sessionId) : [];
            fs.writeFileSync(sessionsPath, JSON.stringify(remaining), 'utf8');
            if (remaining.length > 0) {
                console.log('Claude Discord Presence 保持執行，仍有其他活動工作階段。');
                return;
            }
        }
        catch {}
    }
    const stopped = stopOwnedDaemon(dataDir) || stopLegacyDaemon(dataDir, daemonScript);
    console.log(stopped ? 'Claude Discord Presence stopped.' : 'Claude Discord Presence is not running.');
});
process.stdin.resume();
