#!/usr/bin/env node
'use strict';

// 僅使用 Node.js 內建模組，透過 Discord 的本機 IPC 傳送 Rich Presence。
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const {
    isOwnedDaemon,
    readDaemonState,
    removeDaemonState,
    writeDaemonState
} = require('./daemon-state');
const { createRotatingLogger } = require('./shared/logger');

const MAX_LOG_BYTES = 1_000_000;
const MAX_RPC_FRAME_BYTES = 1_000_000;
const MAX_TRANSCRIPT_INITIAL_READ_BYTES = 512 * 1024;
const scriptDir = __dirname;
const scriptPath = path.resolve(__filename);
const dataDir = process.env.CLAUDE_PLUGIN_DATA || scriptDir;
const configPath = path.join(scriptDir, 'config.json');
const logPath = path.join(dataDir, 'claude-discord-presence.log');
const diagnosticPath = path.join(dataDir, 'claude-discord-presence.diagnostic.json');
const instanceToken = process.argv
    .find((argument) => argument.startsWith('--instance-token='))
    ?.slice('--instance-token='.length);

function readConfig() {
    const defaults = {
        clientId: '',
        details: 'Using Claude',
        state: 'Vibe coding',
        pollIntervalMs: 2000,
        showConversationTitle: true,
        showElapsedTime: true
    };
    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return { ...defaults, ...parsed };
    }
    catch (error) {
        throw new Error(`無法讀取 config.json：${error.message}`);
    }
}

const log = createRotatingLogger(logPath, MAX_LOG_BYTES);

function discordIpcPaths(index) {
    if (process.platform === 'win32')
        return [`\\\\?\\pipe\\discord-ipc-${index}`];
    const directories = process.platform === 'linux'
        ? [process.env.XDG_RUNTIME_DIR, '/tmp']
        : ['/tmp'];
    return directories.filter(Boolean).map((directory) => path.join(directory, `discord-ipc-${index}`));
}

let repositoryCache = { cwd: null, url: null };

function findGitHubRepository(cwd) {
    if (repositoryCache.cwd === cwd)
        return repositoryCache.url;
    const result = childProcess.spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8',
        windowsHide: true
    });
    if (result.error || result.status !== 0) {
        repositoryCache = { cwd, url: null };
        return null;
    }
    const remote = result.stdout.trim();
    const url = remote
        .replace(/^git@github\.com:/i, 'https://github.com/')
        .replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/')
        .replace(/\.git$/i, '');
    repositoryCache = { cwd, url: /^https:\/\/github\.com\//i.test(url) ? url : null };
    return repositoryCache.url;
}

function writeFrame(socket, opcode, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.alloc(8);
    header.writeInt32LE(opcode, 0);
    header.writeInt32LE(body.length, 4);
    socket.cork();
    socket.write(header);
    socket.write(body);
    socket.uncork();
}

function truncate(value, maximumLength) {
    return String(value).slice(0, maximumLength);
}

class DiscordRpc {
    constructor(clientId) {
        this.clientId = clientId;
        this.socket = null;
        this.buffer = Buffer.alloc(0);
        this.ready = false;
        this.reconnectTimer = null;
        this.reconnectAttempt = 0;
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
        const delay = Math.min(30000, 1000 * (2 ** this.reconnectAttempt));
        this.reconnectAttempt += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    onData(data) {
        if (data.length > MAX_RPC_FRAME_BYTES + 8 || this.buffer.length > MAX_RPC_FRAME_BYTES + 8 - data.length) {
            log(`Discord IPC 接收緩衝超過上限：${data.length}`);
            this.buffer = Buffer.alloc(0);
            this.socket?.destroy();
            return;
        }
        this.buffer = Buffer.concat([this.buffer, data]);
        while (this.buffer.length >= 8) {
            const opcode = this.buffer.readInt32LE(0);
            const length = this.buffer.readInt32LE(4);
            if (length < 0 || length > MAX_RPC_FRAME_BYTES) {
                log(`收到無效的 Discord IPC 封包長度：${length}`);
                this.buffer = Buffer.alloc(0);
                this.socket?.destroy();
                return;
            }
            if (this.buffer.length < 8 + length)
                return;
            let payload;
            try {
                payload = JSON.parse(this.buffer.subarray(8, 8 + length).toString('utf8'));
            }
            catch (error) {
                log(`無法解析 Discord IPC 封包：${error.message}`);
                this.buffer = Buffer.alloc(0);
                this.socket?.destroy();
                return;
            }
            this.buffer = this.buffer.subarray(8 + length);
            if (opcode === 2) {
                log(`Discord IPC 已關閉：${payload.data?.message || JSON.stringify(payload)}`);
                this.socket?.destroy();
                return;
            }
            if (payload.evt === 'READY') {
                this.ready = true;
                this.lastActivityFingerprint = null;
                this.reconnectAttempt = 0;
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
        const fingerprint = JSON.stringify(activity);
        if (this.lastActivityFingerprint === fingerprint)
            return;
        this.lastActivityFingerprint = fingerprint;
        writeFrame(this.socket, 1, {
            cmd: 'SET_ACTIVITY',
            nonce: crypto.randomUUID(),
            args: { pid: process.pid, activity }
        });
    }

    clearActivity() {
        this.lastActivityFingerprint = null;
        this.setActivity(null);
    }
}

function status() {
    const state = readDaemonState(dataDir);
    const running = Boolean(state && isOwnedDaemon(state));
    console.log(running ? '常駐程式正在執行。' : '常駐程式未執行。');
    try {
        console.log(JSON.stringify(JSON.parse(fs.readFileSync(diagnosticPath, 'utf8')), null, 2));
    }
    catch {
        console.log('尚未取得活動診斷快照。');
    }
}

if (process.argv.includes('--status')) {
    status();
    process.exit(0);
}

if (!instanceToken || instanceToken.length < 16) {
    console.error('請使用 start.js 啟動 Discord Presence。');
    process.exit(1);
}

let config = readConfig();
if (!/^\d{17,20}$/.test(config.clientId)) {
    console.error('外掛內建的 Discord Application ID 無效，請重新安裝外掛。');
    process.exit(1);
}

fs.mkdirSync(dataDir, { recursive: true });
const daemonState = { pid: process.pid, instanceToken, scriptPath };
writeDaemonState(dataDir, daemonState);

const rpc = new DiscordRpc(config.clientId);
const startedAt = Math.floor(Date.now() / 1000);
let activeProjectWatcher = null;
let transcriptWatcher = null;
let watchedTranscriptPath = null;
let scheduledTick = null;
let configMtimeMs = 0;

function refreshConfig() {
    try {
        const mtimeMs = fs.statSync(configPath).mtimeMs;
        if (mtimeMs === configMtimeMs)
            return;
        config = readConfig();
        configMtimeMs = mtimeMs;
        log('已重新載入 Discord Presence 設定。');
    }
    catch (error) {
        log(`無法重新載入設定，保留上一份有效設定：${error.message}`);
    }
}

function scheduleTick() {
    if (scheduledTick)
        return;
    scheduledTick = setTimeout(() => {
        scheduledTick = null;
        tick();
    }, 100);
}

function refreshWatchers(project) {
    if (!activeProjectWatcher) {
        try {
            activeProjectWatcher = fs.watch(dataDir, (_eventType, filename) => {
                if (!filename || filename === 'active-project.json' || filename === 'active-sessions.json')
                    scheduleTick();
            });
        }
        catch {
            // 輪詢會在不支援檔案監看的環境中繼續作為保底。
        }
    }
    if (project?.transcriptPath === watchedTranscriptPath)
        return;
    transcriptWatcher?.close();
    transcriptWatcher = null;
    watchedTranscriptPath = project?.transcriptPath || null;
    if (!watchedTranscriptPath)
        return;
    try {
        transcriptWatcher = fs.watch(watchedTranscriptPath, scheduleTick);
    }
    catch {
        // 對話檔可能尚未建立；下一次輪詢會重新嘗試監看。
        watchedTranscriptPath = null;
    }
}

function readActiveProject() {
    try {
        const sessions = JSON.parse(fs.readFileSync(path.join(dataDir, 'active-sessions.json'), 'utf8'));
        const project = Array.isArray(sessions)
            ? sessions.filter((entry) => entry && typeof entry.cwd === 'string' && entry.cwd)
                .sort((left, right) => {
                    const getActivityAt = (entry) => {
                        try { return entry.transcriptPath ? fs.statSync(entry.transcriptPath).mtimeMs : Number(entry.lastActiveAt || 0); }
                        catch { return Number(entry.lastActiveAt || 0); }
                    };
                    return getActivityAt(right) - getActivityAt(left);
                })[0]
            : null;
        if (!project)
            throw new Error('沒有可用的活動工作階段');
        if (typeof project.cwd !== 'string' || !project.cwd)
            return null;
        return {
            sessionId: typeof project.id === 'string' ? project.id : null,
            cwd: project.cwd,
            name: typeof project.projectName === 'string' && project.projectName
                ? project.projectName
                : path.basename(project.cwd),
            transcriptPath: typeof project.transcriptPath === 'string' ? project.transcriptPath : null
        };
    }
    catch {
        try {
            const project = JSON.parse(fs.readFileSync(path.join(dataDir, 'active-project.json'), 'utf8'));
            if (typeof project.cwd !== 'string' || !project.cwd)
                return null;
            return {
                sessionId: typeof project.id === 'string' ? project.id : null,
                cwd: project.cwd,
                name: typeof project.projectName === 'string' && project.projectName ? project.projectName : path.basename(project.cwd),
                transcriptPath: typeof project.transcriptPath === 'string' ? project.transcriptPath : null
            };
        }
        catch {
            return null;
        }
    }
}

let transcriptCache = null;

function resetTranscriptCache(transcriptPath, offset = 0) {
    transcriptCache = {
        mtimeMs: 0,
        offset,
        path: transcriptPath,
        pending: Buffer.alloc(0),
        title: null
    };
}

function consumeTranscriptChunk(chunk) {
    const completeBuffer = Buffer.concat([transcriptCache.pending, chunk]);
    const lastNewline = completeBuffer.lastIndexOf(0x0A);
    if (lastNewline === -1) {
        transcriptCache.pending = completeBuffer;
    }
    const records = lastNewline === -1
        ? []
        : completeBuffer.subarray(0, lastNewline).toString('utf8').split(/\r?\n/);
    if (lastNewline !== -1)
        transcriptCache.pending = completeBuffer.subarray(lastNewline + 1);
    for (const recordText of records) {
        try {
            const record = JSON.parse(recordText);
            if (record.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.trim())
                transcriptCache.title = record.customTitle.trim().slice(0, 128);
        }
        catch {
            // 忽略尚未完整寫入或無法辨識的紀錄。
        }
    }
    if (transcriptCache.pending.length > 0) {
        try {
            const record = JSON.parse(transcriptCache.pending.toString('utf8'));
            if (record.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.trim())
                transcriptCache.title = record.customTitle.trim().slice(0, 128);
        }
        catch {
            // 保留不完整的最後一筆紀錄，等待下一次增量讀取後再解析。
        }
    }
}

function findConversationTitle(transcriptPath) {
    if (!transcriptPath || !fs.existsSync(transcriptPath))
        return null;
    try {
        const stat = fs.statSync(transcriptPath);
        if (!transcriptCache
            || transcriptCache.path !== transcriptPath
            || stat.size < transcriptCache.offset
            || (stat.size === transcriptCache.offset && stat.mtimeMs !== transcriptCache.mtimeMs)) {
            resetTranscriptCache(transcriptPath, Math.max(0, stat.size - MAX_TRANSCRIPT_INITIAL_READ_BYTES));
        }
        if (stat.size > transcriptCache.offset) {
            const bytesToRead = stat.size - transcriptCache.offset;
            const chunk = Buffer.alloc(bytesToRead);
            const descriptor = fs.openSync(transcriptPath, 'r');
            try {
                fs.readSync(descriptor, chunk, 0, bytesToRead, transcriptCache.offset);
            }
            finally {
                fs.closeSync(descriptor);
            }
            consumeTranscriptChunk(chunk);
            transcriptCache.offset = stat.size;
        }
        transcriptCache.mtimeMs = stat.mtimeMs;
        return transcriptCache.title;
    }
    catch {
        return null;
    }
}

function writeDiagnostic(snapshot) {
    try {
        fs.writeFileSync(diagnosticPath, JSON.stringify({ updatedAt: new Date().toISOString(), ...snapshot }, null, 2), 'utf8');
    }
    catch (error) {
        log(`無法寫入活動診斷快照：${error.message}`);
    }
}

function tick() {
    try {
        refreshConfig();
        const project = readActiveProject();
        refreshWatchers(project);
        const projectName = config.showProject === false ? '' : String(project?.name || '');
        const conversationTitle = config.showConversationTitle === true
            ? findConversationTitle(project?.transcriptPath)
            : null;
        const repositoryUrl = project?.cwd ? findGitHubRepository(project.cwd) : null;
        const buttons = config.showRepositoryButton === false || !repositoryUrl
            ? undefined
            : [{ label: truncate(config.repositoryButtonLabel || 'View Repository', 32), url: repositoryUrl }];
        const activity = {
            details: projectName
                ? `${truncate(config.projectLabel || 'Workspace', 64)}: ${truncate(projectName, 60)}`
                : truncate(config.details, 128),
            state: conversationTitle || truncate(config.state, 128),
            ...(config.showElapsedTime === false ? {} : { timestamps: { start: startedAt } }),
            instance: false,
            buttons
        };
        rpc.setActivity(activity);
        writeDiagnostic({
            activeProject: projectName || null,
            sessionId: project?.sessionId || null,
            title: conversationTitle || null,
            titleSource: conversationTitle ? 'custom-title' : 'fallback',
            transcriptWatched: Boolean(transcriptWatcher),
            updateMode: 'file-watch with 2-second fallback poll'
        });
    }
    catch (error) {
        log(`更新 Discord Rich Presence 時發生錯誤：${error.message}`);
    }
}

function shutdown() {
    activeProjectWatcher?.close();
    transcriptWatcher?.close();
    rpc.clearActivity();
    removeDaemonState(dataDir, daemonState);
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
rpc.connect();
tick();
setInterval(tick, Math.max(2000, Number(config.pollIntervalMs) || 2000));
