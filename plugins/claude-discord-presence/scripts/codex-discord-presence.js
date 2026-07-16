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
const os = require('os');
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
function codexIsRunning() {
    if (process.platform === 'win32') {
        const result = childProcess.spawnSync('tasklist', ['/FI', 'IMAGENAME eq Codex.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
        return !result.error && result.status === 0 && result.stdout.toLowerCase().includes('codex.exe');
    }
    const result = childProcess.spawnSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });
    if (result.error || result.status !== 0)
        return false;
    return result.stdout.split(/\r?\n/).some((line) => {
        const [pid, ...command] = line.trim().split(/\s+/);
        const value = command.join(' ');
        return Number(pid) !== process.pid
            && !value.includes(path.basename(__filename))
            && /(^|[\\/\s])Codex(?:\.app[\\/]Contents[\\/]MacOS[\\/]Codex)?(?:\s|$)/i.test(value);
    });
}
function discordIpcPaths(index) {
    if (process.platform === 'win32')
        return [`\\\\?\\pipe\\discord-ipc-${index}`];
    const directories = process.platform === 'linux'
        ? [process.env.XDG_RUNTIME_DIR, '/tmp']
        : ['/tmp'];
    return directories.filter(Boolean).map((directory) => path.join(directory, `discord-ipc-${index}`));
}
function findActiveWorkspace() {
    try {
        const state = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', '.codex-global-state.json'), 'utf8'));
        const cwd = Array.isArray(state['active-workspace-roots']) ? state['active-workspace-roots'][0] : null;
        if (typeof cwd !== 'string' || !cwd)
            return null;
        const labels = state['electron-workspace-root-labels'];
        const name = labels && typeof labels[cwd] === 'string' && labels[cwd]
            ? labels[cwd]
            : path.basename(cwd);
        return { name, cwd };
    }
    catch {
        return null;
    }
}
function findTaskTitle(cwd) {
    if (typeof cwd !== 'string' || !cwd)
        return null;
    try {
        const titles = new Map(fs.readFileSync(path.join(os.homedir(), '.codex', 'session_index.jsonl'), 'utf8')
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter((item) => typeof item.id === 'string' && typeof item.thread_name === 'string')
            .map((item) => [item.id, item.thread_name]));
        const sessions = [];
        const collect = (directory) => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                const fullPath = path.join(directory, entry.name);
                if (entry.isDirectory())
                    collect(fullPath);
                else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                    sessions.push({ fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs });
                }
            }
        };
        collect(path.join(os.homedir(), '.codex', 'sessions'));
        for (const { fullPath } of sessions.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 60)) {
            const firstLine = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/, 1)[0];
            if (JSON.parse(firstLine)?.payload?.cwd !== cwd)
                continue;
            const sessionId = fullPath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1];
            const title = sessionId ? titles.get(sessionId) : null;
            if (title)
                return title;
        }
    }
    catch {
        // 無法讀取索引時，保留設定檔中的預設備註。
    }
    return null;
}
function findLatestProject() {
    const activeWorkspace = findActiveWorkspace();
    if (activeWorkspace)
        return activeWorkspace;
    try {
        const project = JSON.parse(fs.readFileSync(path.join(dataDir, 'active-project.json'), 'utf8'));
        if (typeof project.projectName === 'string' && project.projectName && typeof project.cwd === 'string' && project.cwd) {
            return { name: project.projectName, cwd: project.cwd };
        }
    }
    catch { }
    const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
    try {
        const files = [];
        const collect = (directory) => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                const fullPath = path.join(directory, entry.name);
                if (entry.isDirectory())
                    collect(fullPath);
                else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                    files.push({ fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs });
                }
            }
        };
        collect(sessionsDir);
        files.sort((a, b) => b.mtimeMs - a.mtimeMs);
        for (const { fullPath } of files.slice(0, 30)) {
            try {
                const firstLine = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/, 1)[0];
                const cwd = JSON.parse(firstLine)?.payload?.cwd;
                if (typeof cwd === 'string' && cwd)
                    return { name: path.basename(cwd), cwd };
            }
            catch {
                // 跳過尚未寫入完成或不符合預期格式的 session 檔。
            }
        }
    }
    catch {
        // 工作階段資料暫時無法讀取時，保留原本的自訂狀態。
    }
    return null;
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
let active = false;
let startedAt = null;
function tick() {
    const codexRunning = codexIsRunning();
    if (codexRunning && !active) {
        active = true;
        startedAt = Math.floor(Date.now() / 1000);
        log('偵測到 Codex，正在更新 Discord 活動。');
    }
    else if (!codexRunning && active) {
        active = false;
        startedAt = null;
        rpc.clearActivity();
        log('Codex 已關閉，已清除 Discord 活動。');
    }
    if (active) {
        const project = findLatestProject();
        const workspaceEnabled = config.showWorkspace ?? config.showProject !== false;
        const projectName = workspaceEnabled === false
            ? null
            : String(config.workspaceName || project?.name || '');
        const taskTitle = config.showTaskTitle === false
            ? null
            : String(config.taskTitle || findTaskTitle(project?.cwd) || '');
        const repositoryUrl = project?.cwd ? findGitHubRepository(project.cwd) : null;
        const buttons = config.showRepositoryButton === false || !repositoryUrl
            ? undefined
            : [{ label: String(config.repositoryButtonLabel || 'View Repository').slice(0, 32), url: repositoryUrl }];
        rpc.setActivity({
            details: projectName ? `${String(config.projectLabel || 'Workspace')}: ${projectName}` : String(config.details),
            state: taskTitle || String(config.taskTitleFallback || config.state),
            timestamps: { start: startedAt },
            instance: false,
            buttons
        });
    }
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
