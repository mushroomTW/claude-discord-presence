#!/usr/bin/env node
// @ts-nocheck
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
// 僅使用 Node.js 內建模組，透過 Discord 的本機 IPC 傳送 Rich Presence。
const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const scriptDir = __dirname;
const dataDir = process.env.CLAUDE_PLUGIN_DATA || scriptDir;
fs.mkdirSync(dataDir, { recursive: true });
const configPath = path.join(scriptDir, 'config.json');
const pidPath = path.join(dataDir, 'claude-discord-presence.pid');
const logPath = path.join(dataDir, 'claude-discord-presence.log');
function readConfig() {
    const defaults = { clientId: '', details: 'Using Claude', state: 'Vibe coding', pollIntervalMs: 8000 };
    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return { ...defaults, ...parsed };
    }
    catch (error) {
        throw new Error(`無法讀取 config.json：${error.message}`);
    }
}
function log(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(line);
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
}
function discordIpcPaths(index) {
    if (process.platform === 'win32')
        return [`\\\\?\\pipe\\discord-ipc-${index}`];
    const directories = process.platform === 'linux'
        ? [process.env.XDG_RUNTIME_DIR, '/tmp']
        : ['/tmp'];
    return directories.filter(Boolean).map((directory) => path.join(directory, `discord-ipc-${index}`));
}
function findGitHubRepository(cwd) {
    const result = childProcess.spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8',
        windowsHide: true
    });
    if (result.error || result.status !== 0)
        return null;
    const remote = result.stdout.trim();
    const url = remote
        .replace(/^git@github\.com:/i, 'https://github.com/')
        .replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/')
        .replace(/\.git$/i, '');
    return /^https:\/\/github\.com\//i.test(url) ? url : null;
}
function writeFrame(socket, opcode, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.alloc(8);
    header.writeInt32LE(opcode, 0);
    header.writeInt32LE(body.length, 4);
    socket.write(Buffer.concat([header, body]));
}
class DiscordRpc {
    constructor(clientId) {
        this.clientId = clientId;
        this.socket = null;
        this.buffer = Buffer.alloc(0);
        this.ready = false;
        this.reconnectTimer = null;
    }
    connect() {
        if (this.socket || !this.clientId)
            return;
        const tryPipe = (index) => {
            if (index > 9) {
                this.scheduleReconnect();
                return;
            }
            const paths = discordIpcPaths(index);
            const tryPath = (pathIndex) => {
                if (pathIndex >= paths.length) {
                    tryPipe(index + 1);
                    return;
                }
                const socket = net.createConnection(paths[pathIndex]);
                let settled = false;
                socket.once('connect', () => {
                    settled = true;
                    this.socket = socket;
                    this.buffer = Buffer.alloc(0);
                    socket.on('data', (data) => this.onData(data));
                    socket.on('close', () => this.reset());
                    socket.on('error', () => this.reset());
                    writeFrame(socket, 0, { v: 1, client_id: this.clientId });
                    log(`已連線至 Discord IPC #${index}`);
                });
                socket.once('error', () => {
                    if (!settled)
                        tryPath(pathIndex + 1);
                });
            };
            tryPath(0);
        };
        tryPipe(0);
    }
    reset() {
        this.socket = null;
        this.ready = false;
        this.scheduleReconnect();
    }
    scheduleReconnect() {
        if (this.reconnectTimer)
            return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, 5000);
    }
    onData(data) {
        this.buffer = Buffer.concat([this.buffer, data]);
        while (this.buffer.length >= 8) {
            const opcode = this.buffer.readInt32LE(0);
            const length = this.buffer.readInt32LE(4);
            if (this.buffer.length < 8 + length)
                return;
            const payload = JSON.parse(this.buffer.subarray(8, 8 + length).toString('utf8'));
            this.buffer = this.buffer.subarray(8 + length);
            if (opcode === 2) {
                log(`Discord IPC 已關閉：${payload.data?.message || JSON.stringify(payload)}`);
                this.socket?.destroy();
                return;
            }
            if (payload.evt === 'READY') {
                this.ready = true;
                log('Discord Rich Presence 已就緒');
            }
            else if (payload.evt === 'ERROR') {
                log(`Discord RPC 錯誤：${payload.data?.message || JSON.stringify(payload)}`);
            }
        }
    }
    setActivity(activity) {
        if (!this.ready || !this.socket || this.socket.destroyed)
            return;
        writeFrame(this.socket, 1, {
            cmd: 'SET_ACTIVITY',
            nonce: crypto.randomUUID(),
            args: { pid: process.pid, activity }
        });
    }
    clearActivity() {
        this.setActivity(null);
    }
}
function status() {
    const running = fs.existsSync(pidPath) && (() => {
        const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
        try {
            process.kill(pid, 0);
            return true;
        }
        catch {
            return false;
        }
    })();
    console.log(running ? '常駐程式正在執行。' : '常駐程式未執行。');
}
if (process.argv.includes('--status')) {
    status();
    process.exit(0);
}
const config = readConfig();
if (!/^\d{17,20}$/.test(config.clientId)) {
    console.error('外掛內建的 Discord Application ID 無效，請重新安裝外掛。');
    process.exit(1);
}
fs.writeFileSync(pidPath, String(process.pid), 'utf8');
const rpc = new DiscordRpc(config.clientId);
const startedAt = Math.floor(Date.now() / 1000);
function readActiveProject() {
    try {
        const project = JSON.parse(fs.readFileSync(path.join(dataDir, 'active-project.json'), 'utf8'));
        if (typeof project.cwd !== 'string' || !project.cwd)
            return null;
        return {
            cwd: project.cwd,
            name: typeof project.projectName === 'string' && project.projectName
                ? project.projectName
                : path.basename(project.cwd),
            transcriptPath: typeof project.transcriptPath === 'string' ? project.transcriptPath : null
        };
    }
    catch {
        return null;
    }
}
function findConversationTitle(transcriptPath) {
    if (!transcriptPath || !fs.existsSync(transcriptPath))
        return null;
    try {
        const lines = fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/).filter(Boolean).reverse();
        for (const line of lines) {
            try {
                const record = JSON.parse(line);
                if (record.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.trim())
                    return record.customTitle.trim().slice(0, 128);
            }
            catch {
                // Ignore a partially-written transcript line and continue scanning older records.
            }
        }
    }
    catch {
        // Keep the configured fallback when the session transcript is unavailable.
    }
    return null;
}
function tick() {
    const project = readActiveProject();
    const projectName = config.showProject === false ? '' : String(project?.name || '');
    const conversationTitle = findConversationTitle(project?.transcriptPath);
    const repositoryUrl = project?.cwd ? findGitHubRepository(project.cwd) : null;
    const buttons = config.showRepositoryButton === false || !repositoryUrl
        ? undefined
        : [{ label: String(config.repositoryButtonLabel || 'View Repository').slice(0, 32), url: repositoryUrl }];
    rpc.setActivity({
        details: projectName ? `${String(config.projectLabel || 'Workspace')}: ${projectName}` : String(config.details),
        state: conversationTitle || String(config.state),
        timestamps: { start: startedAt },
        instance: false,
        buttons
    });
}
function shutdown() {
    rpc.clearActivity();
    fs.rmSync(pidPath, { force: true });
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
rpc.connect();
tick();
setInterval(tick, Math.max(2000, Number(config.pollIntervalMs) || 8000));
