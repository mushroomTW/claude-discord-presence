#!/usr/bin/env node
// @ts-nocheck
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pruneSessions, readSessions, isWorkspaceCwd } = require('./session-state');
const scriptDir = __dirname;
const dataDir = process.env.CLAUDE_PRESENCE_DATA || path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'mushroomTW',
    'claude-discord-presence'
);
const sessionsPath = path.join(dataDir, 'active-sessions.json');
fs.mkdirSync(dataDir, { recursive: true });
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
    try {
        const events = input.trim().split(/\r?\n/).reverse();
        const session = events
            .map((line) => {
            try {
                return JSON.parse(line);
            }
            catch {
                return null;
            }
        })
            .find((event) => event && typeof (event.cwd ?? event.payload?.cwd ?? event.context?.cwd) === 'string');
        const cwd = session?.cwd ?? session?.payload?.cwd ?? session?.context?.cwd;
        const sessionId = session?.session_id ?? session?.sessionId ?? session?.id;
        const transcriptPath = session?.transcript_path ?? session?.payload?.transcript_path ?? session?.context?.transcript_path;
        if (isWorkspaceCwd(cwd)) {
            const activeSession = {
                id: typeof sessionId === 'string' && sessionId ? sessionId : transcriptPath || cwd,
                projectName: path.basename(cwd),
                cwd,
                transcriptPath: typeof transcriptPath === 'string' ? transcriptPath : null,
                lastActiveAt: Date.now()
            };
            const sessions = pruneSessions(readSessions(sessionsPath))
                .filter((entry) => entry?.id !== activeSession.id).slice(-19);
            sessions.push(activeSession);
            fs.writeFileSync(sessionsPath, JSON.stringify(sessions), 'utf8');
            fs.writeFileSync(path.join(dataDir, 'active-project.json'), JSON.stringify(activeSession), 'utf8');
        }
    }
    catch {
        // A session can start without a working directory; the daemon uses its configured fallback text.
    }
    if (!process.argv.includes('--update')) {
        childProcess.spawn(process.execPath, [path.join(scriptDir, 'start.js')], {
            cwd: scriptDir,
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, CLAUDE_PRESENCE_DATA: dataDir },
            windowsHide: true
        }).unref();
    }
});
process.stdin.resume();
