#!/usr/bin/env node
'use strict';

// 僅使用 Node.js 內建模組，透過 Discord 的本機 IPC 傳送 Rich Presence。
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isFreshSession, isWorkspaceCwd, readSessions, selectActiveSession } = require('./session-state');
const { createTranscriptTitleReader } = require('./transcript-title');
const {
    isOwnedDaemon,
    readDaemonState,
    removeDaemonState,
    writeDaemonState
} = require('./daemon-state');
const { createRotatingLogger } = require('./shared/logger');
const { DiscordRpc: SharedDiscordRpc } = require('./shared/discord-rpc');
const { buildPresence, truncate } = require('./shared/presence-builder');

const MAX_LOG_BYTES = 1_000_000;
const MAX_TRANSCRIPT_INITIAL_READ_BYTES = 512 * 1024;
const scriptDir = __dirname;
const scriptPath = path.resolve(__filename);
const dataDir = process.env.CLAUDE_PRESENCE_DATA || path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'mushroomTW',
    'claude-discord-presence'
);
const configPath = path.join(scriptDir, 'config.json');
const brokerStateDir = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'mushroomTW',
    'discord-presence-broker'
);
const brokerHeartbeatPath = path.join(brokerStateDir, 'broker.json');
const brokerScriptPath = path.join(scriptDir, 'broker.js');
const BROKER_STALE_MS = 15_000;
// Claude 若被強制關閉（當機、工作管理員結束）不會觸發 SessionEnd hook。
// Windows 會額外監看 Claude Desktop 宿主，並以 session 訊號閒置時間作為跨平台保底。
const DAEMON_IDLE_SHUTDOWN_MS = 2 * 60 * 60 * 1000;
const HOST_CHECK_INTERVAL_MS = 10_000;
const HOST_MISSING_LIMIT = 3;
const WINDOWS_HOST_IMAGE_NAMES = ['Claude.exe', 'ClaudeDesktop.exe'];
const daemonStartedAt = Date.now();
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
        pollIntervalMs: 0,
        showConversationTitle: true,
        showElapsedTime: true,
        useBroker: true
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

const rpc = new SharedDiscordRpc(config.clientId, { log });
const startedAt = Math.floor(Date.now() / 1000);
let activeProjectWatcher = null;
let transcriptWatcher = null;
let watchedTranscriptPath = null;
let configWatcher = null;
let scheduledTick = null;
let optionalPollTimer = null;
let brokerHeartbeatTimer = null;
let hostProcessTimer = null;
let consecutiveMissingHostChecks = 0;
let hostProcessKnownRunning = null;
let configMtimeMs = 0;
let lastBrokerActivity = null;
let lastDiagnosticSnapshot = null;
let lastUseBroker = null;
let brokerSpawnedAt = 0;

function isBrokerAlive() {
    try {
        const heartbeat = JSON.parse(fs.readFileSync(brokerHeartbeatPath, 'utf8'));
        return Date.now() - Number(heartbeat.updatedAt || 0) < BROKER_STALE_MS;
    }
    catch {
        return false;
    }
}

function ensureBroker() {
    if (config.useBroker === false || isBrokerAlive())
        return;
    if (Date.now() - brokerSpawnedAt < BROKER_STALE_MS)
        return;
    brokerSpawnedAt = Date.now();
    try {
        childProcess.spawn(process.execPath, [brokerScriptPath], {
            cwd: scriptDir,
            detached: true,
            stdio: 'ignore',
            windowsHide: true
        }).unref();
        log('已啟動共享 Discord Presence Broker。');
    }
    catch (error) {
        log(`無法啟動共享 Broker：${error.message}`);
    }
}

function publishBrokerState(activity) {
    lastBrokerActivity = activity;
    fs.mkdirSync(brokerStateDir, { recursive: true });
    fs.writeFileSync(path.join(brokerStateDir, 'claude.json'), JSON.stringify({
        source: 'claude',
        clientId: config.clientId,
        priority: 1,
        updatedAt: Date.now(),
        activity
    }), 'utf8');
}

function clearPublishedActivity() {
    if (config.useBroker !== false) {
        lastBrokerActivity = null;
        try { fs.rmSync(path.join(brokerStateDir, 'claude.json'), { force: true }); }
        catch {}
    }
    else {
        rpc.clearActivity();
    }
}

function refreshConfig() {
    try {
        const mtimeMs = fs.statSync(configPath).mtimeMs;
        if (mtimeMs === configMtimeMs)
            return;
        config = readConfig();
        configMtimeMs = mtimeMs;
        scheduleOptionalPoll();
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

function optionalPollIntervalMs() {
    const value = Number(config.pollIntervalMs);
    return Number.isFinite(value) && value > 0 ? Math.max(500, value) : 0;
}

function scheduleOptionalPoll() {
    if (optionalPollTimer) {
        clearTimeout(optionalPollTimer);
        optionalPollTimer = null;
    }
    const intervalMs = optionalPollIntervalMs();
    if (!intervalMs)
        return;
    optionalPollTimer = setTimeout(() => {
        optionalPollTimer = null;
        tick();
        scheduleOptionalPoll();
    }, intervalMs);
}

function startBrokerHeartbeat() {
    if (brokerHeartbeatTimer)
        return;
    // Broker 以狀態檔 mtime 判定 TTL；只 touch 檔案可避免每秒重寫相同 JSON。
    brokerHeartbeatTimer = setInterval(() => {
        if (config.useBroker !== false && lastBrokerActivity) {
            const statePath = path.join(brokerStateDir, 'claude.json');
            try {
                const now = new Date();
                fs.utimesSync(statePath, now, now);
            }
            catch {
                publishBrokerState(lastBrokerActivity);
            }
            ensureBroker();
        }
    }, 1_000);
}

function isWindowsHostRunning() {
    for (const imageName of WINDOWS_HOST_IMAGE_NAMES) {
        const result = childProcess.spawnSync('tasklist', ['/NH', '/FO', 'CSV', '/FI', `IMAGENAME eq ${imageName}`], {
            encoding: 'utf8',
            timeout: 500,
            windowsHide: true
        });
        if (result.error || result.status !== 0)
            return null;
        if (result.stdout.toLocaleLowerCase().includes(`"${imageName.toLocaleLowerCase()}"`))
            return true;
    }
    return false;
}

function checkHostProcess() {
    const running = isWindowsHostRunning();
    if (running === null)
        return;
    if (running) {
        hostProcessKnownRunning = true;
        consecutiveMissingHostChecks = 0;
        return;
    }
    hostProcessKnownRunning = false;
    consecutiveMissingHostChecks += 1;
    if (consecutiveMissingHostChecks >= HOST_MISSING_LIMIT) {
        log('連續 3 秒找不到 Claude Desktop 宿主程序，daemon 自動關閉。');
        shutdown();
    }
}

function startHostMonitor() {
    if (process.platform !== 'win32' || hostProcessTimer)
        return;
    checkHostProcess();
    hostProcessTimer = setInterval(checkHostProcess, HOST_CHECK_INTERVAL_MS);
}

function lastSessionSignalAt() {
    let latest = daemonStartedAt;
    const candidates = [
        path.join(dataDir, 'active-sessions.json'),
        path.join(dataDir, 'active-project.json')
    ];
    for (const candidate of candidates) {
        try {
            const mtimeMs = fs.statSync(candidate).mtimeMs;
            if (mtimeMs > latest)
                latest = mtimeMs;
        }
        catch { }
    }
    return latest;
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
    if (!configWatcher) {
        try {
            configWatcher = fs.watch(scriptDir, (_eventType, filename) => {
                if (filename === 'config.json')
                    scheduleTick();
            });
        }
        catch {}
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
        const project = selectActiveSession(readSessions(path.join(dataDir, 'active-sessions.json')));
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
            // 回退檔也必須通過新鮮度檢查，避免永久顯示過期的 Workspace。
            if (!isFreshSession(project))
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

const transcriptTitleReader = createTranscriptTitleReader({ maxInitialReadBytes: MAX_TRANSCRIPT_INITIAL_READ_BYTES });

function writeDiagnostic(snapshot) {
    try {
        const serialized = JSON.stringify(snapshot);
        if (serialized === lastDiagnosticSnapshot)
            return;
        lastDiagnosticSnapshot = serialized;
        fs.writeFileSync(diagnosticPath, JSON.stringify({ updatedAt: new Date().toISOString(), ...snapshot }, null, 2), 'utf8');
    }
    catch (error) {
        log(`無法寫入活動診斷快照：${error.message}`);
    }
}

function tick() {
    try {
        if (hostProcessKnownRunning !== true && Date.now() - lastSessionSignalAt() > DAEMON_IDLE_SHUTDOWN_MS) {
            log(`超過 ${Math.round(DAEMON_IDLE_SHUTDOWN_MS / 60_000)} 分鐘沒有收到任何 Claude session 訊號，判定 Claude 已關閉，daemon 自動關閉。`);
            shutdown();
            return;
        }
        refreshConfig();
        const useBroker = config.useBroker !== false;
        if (lastUseBroker === true && !useBroker) {
            // 從 Broker 模式切回直連時，立即撤下 Broker 端的舊狀態。
            lastBrokerActivity = null;
            try { fs.rmSync(path.join(brokerStateDir, 'claude.json'), { force: true }); }
            catch {}
        }
        lastUseBroker = useBroker;
        if (!useBroker) {
            if (!rpc.ready)
                rpc.connect();
        }
        else {
            if (rpc.socket || rpc.reconnectTimer)
                rpc.disconnect();
            ensureBroker();
        }
        const project = readActiveProject();
        refreshWatchers(project);
        const projectName = config.showProject === false ? '' : String(project?.name || '');
        const conversationTitle = config.showConversationTitle === true
            ? transcriptTitleReader.findTitle(project?.transcriptPath)
            : null;
        const repositoryUrl = project?.cwd ? findGitHubRepository(project.cwd) : null;
        const activity = buildPresence({
            details: projectName
                ? `${truncate(config.projectLabel || 'Workspace', 64)}: ${truncate(projectName, 60)}`
                : truncate(config.details, 128),
            state: conversationTitle ? `Task: ${conversationTitle}` : truncate(config.state, 128),
            startedAt,
            showElapsedTime: config.showElapsedTime !== false,
            repositoryUrl: config.showRepositoryButton === false ? null : repositoryUrl,
            repositoryButtonLabel: config.repositoryButtonLabel
        });
        if (config.useBroker !== false)
            publishBrokerState(activity);
        else
            rpc.setActivity(activity);
        writeDiagnostic({
            activeProject: projectName || null,
            sessionId: project?.sessionId || null,
            title: conversationTitle || null,
            titleSource: conversationTitle ? 'custom-title' : 'fallback',
            transcriptWatched: Boolean(transcriptWatcher),
            updateMode: 'file-watch with optional fallback poll'
        });
    }
    catch (error) {
        log(`更新 Discord Rich Presence 時發生錯誤：${error.message}`);
    }
}

function shutdown() {
    activeProjectWatcher?.close();
    transcriptWatcher?.close();
    configWatcher?.close();
    if (scheduledTick)
        clearTimeout(scheduledTick);
    if (optionalPollTimer)
        clearTimeout(optionalPollTimer);
    if (brokerHeartbeatTimer)
        clearInterval(brokerHeartbeatTimer);
    if (hostProcessTimer)
        clearInterval(hostProcessTimer);
    clearPublishedActivity();
    removeDaemonState(dataDir, daemonState);
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
if (config.useBroker === false)
    rpc.connect();
else
    ensureBroker();
startHostMonitor();
tick();
scheduleOptionalPoll();
startBrokerHeartbeat();
