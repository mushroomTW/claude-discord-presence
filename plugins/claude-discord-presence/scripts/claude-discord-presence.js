#!/usr/bin/env node
'use strict';

// 僅使用 Node.js 內建模組，透過 Discord 的本機 IPC 傳送 Rich Presence。
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSessions, selectActiveSession } = require('./session-state');
const { createTranscriptTitleReader } = require('./transcript-title');
const {
    isOwnedDaemon,
    readDaemonState,
    removeDaemonState,
    writeDaemonState
} = require('./daemon-state');
const { createHostMonitor } = require('./shared/host-monitor');
const { createRotatingLogger } = require('./shared/logger');
const { DiscordRpc: SharedDiscordRpc } = require('./shared/discord-rpc');
const { buildPresence, truncate, truncateToWidth, displayWidth } = require('./shared/presence-builder');
const { classifyActivity } = require('./activity-classifier');

const MAX_LOG_BYTES = 1_000_000;
const MAX_TRANSCRIPT_INITIAL_READ_BYTES = 512 * 1024;
const ACTIVITY_TAIL_READ_BYTES = [64 * 1024, 512 * 1024];
const scriptDir = __dirname;
const scriptPath = path.resolve(__filename);
const dataDir = process.env.CLAUDE_PRESENCE_DATA || path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'claude-discord-presence'
);
const configPath = path.join(scriptDir, 'config.json');
const brokerStateDir = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
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
// 開機後 Claude Desktop 可能尚未完成程序註冊；先保留 daemon，避免一次性的 SessionStart hook 被競速吃掉。
const HOST_STARTUP_GRACE_MS = 60_000;
// 對話紀錄可能在 hook 觸發後才建立，且 session 時效需隨時間失效；定期重新計算作為檔案監看的保底。
const PERIODIC_TICK_MS = 10_000;
const WINDOWS_HOST_IMAGE_NAMES = ['Claude.exe', 'ClaudeDesktop.exe'];
const WINDOWS_HOST_IMAGE_FILTER = 'Claude*';
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
        state: 'Coding session',
        showConversationTitle: true,
        showActivity: true,
        showElapsedTime: true,
        useBroker: true,
        compactPrefix: true,
        compactProjectLabel: '📁 ',
        compactTaskLabel: '📌 ',
        projectLabel: 'Workspace',
        taskLabel: 'Task',
        showAssets: true,
        largeImage: 'https://cdn.discordapp.com/app-icons/1527170380404621453/3d87e1372d5ad27c20746a3d134116fa.png',
        largeImageText: 'Claude Desktop · Coding session',
        projectNameMaxWidth: 40,
        taskTitleMaxWidth: 40
    };
    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return { ...defaults, ...parsed };
    }
    catch (error) {
        throw new Error(`無法讀取 config.json：${error instanceof Error ? error.message : String(error)}`);
    }
}

const log = createRotatingLogger(logPath, MAX_LOG_BYTES);

let repositoryCache = { cwd: null, url: null };

function findGitHubRepository(cwd) {
    if (repositoryCache.cwd === cwd)
        return repositoryCache.url;
    const result = childProcess.spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { // NOSONAR javascript:S4036 - 本機工作區查詢遠端 URL，cwd 為已驗證的 Workspace 路徑，非 PATH 注入邊界
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
let brokerHeartbeatTimer = null;
let hostProcessTimer = null;
let periodicTickTimer = null;
let configMtimeMs = 0;
let lastBrokerActivity = null;
let lastBrokerActivityLabel = null;
let lastBrokerPayload = null;
let lastDiagnosticSnapshot = null;
let activityCache = { transcriptPath: null, mtimeMs: 0, size: 0, value: 'Waiting' };
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
        log(`無法啟動共享 Broker：${error instanceof Error ? error.message : String(error)}`);
    }
}

function publishBrokerState(activity, activityLabel, force = false) {
    lastBrokerActivity = activity;
    lastBrokerActivityLabel = activityLabel;
    // 與 Codex 外掛使用相同的優先權對映，活躍度較高的一方取得共享的 Discord 動態。
    const priority = ({ 'Running tools': 5, Editing: 4, Thinking: 3, 'Reading results': 2, Waiting: 1 })[activityLabel] || 1;
    // 內容未變時不重寫：心跳會 touch mtime 維持有效，重寫只會多觸發 Broker 的檔案監看。
    const payload = JSON.stringify({ clientId: config.clientId, priority, activity });
    if (!force && payload === lastBrokerPayload)
        return;
    fs.mkdirSync(brokerStateDir, { recursive: true });
    fs.writeFileSync(path.join(brokerStateDir, 'claude.json'), JSON.stringify({
        source: 'claude',
        clientId: config.clientId,
        priority,
        updatedAt: Date.now(),
        activity
    }), 'utf8');
    lastBrokerPayload = payload;
}

function clearPublishedActivity() {
    if (config.useBroker !== false) {
        lastBrokerActivity = null;
        lastBrokerActivityLabel = null;
        lastBrokerPayload = null;
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
        log('已重新載入 Discord Presence 設定。');
    }
    catch (error) {
        log(`無法重新載入設定，保留上一份有效設定：${error instanceof Error ? error.message : String(error)}`);
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
                publishBrokerState(lastBrokerActivity, lastBrokerActivityLabel, true);
            }
            ensureBroker();
        }
    }, 1_000);
}

// tasklist 查詢可能耗時 50–300ms；以非同步執行避免阻塞事件迴圈，
// 讓 timer 與 fs.watch 回呼不受宿主檢查影響。
function queryWindowsHostRunning(callback) {
    // 多個 /FI 是 AND 關係，無法一次列舉兩個映像名；以萬用字元篩選再比對完整名稱，
    // 避免每 10 秒把全系統程序清單轉成大字串做全文檢索。
    childProcess.execFile('tasklist', ['/NH', '/FO', 'CSV', '/FI', `IMAGENAME eq ${WINDOWS_HOST_IMAGE_FILTER}`], { // NOSONAR javascript:S4036 - 本機宿主存活檢查，執行固定系統指令 tasklist，參數為固定映像名稱
        timeout: 2_000,
        windowsHide: true
    }, (error, stdout) => {
        if (error)
            return callback(null);
        const text = String(stdout).toLocaleLowerCase();
        callback(WINDOWS_HOST_IMAGE_NAMES.some((imageName) => text.includes(`"${imageName.toLocaleLowerCase()}"`)));
    });
}

const hostMonitor = createHostMonitor({
    query: queryWindowsHostRunning,
    missingLimit: HOST_MISSING_LIMIT,
    startupGraceMs: HOST_STARTUP_GRACE_MS,
    onMissing: () => {
        log('連續 3 次檢查找不到 Claude Desktop 宿主程序，daemon 自動關閉。');
        shutdown();
    }
});

function startHostMonitor() {
    if (process.platform !== 'win32' || hostProcessTimer)
        return;
    hostMonitor.check();
    hostProcessTimer = setInterval(hostMonitor.check, HOST_CHECK_INTERVAL_MS);
}

function lastSessionSignalAt() {
    try {
        return Math.max(daemonStartedAt, fs.statSync(path.join(dataDir, 'active-sessions.json')).mtimeMs);
    } catch {
        return daemonStartedAt;
    }
}

function refreshWatchers(project) {
    if (!activeProjectWatcher) {
        try {
            activeProjectWatcher = fs.watch(dataDir, (_eventType, filename) => {
                if (!filename || filename === 'active-sessions.json')
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
    const project = selectActiveSession(readSessions(path.join(dataDir, 'active-sessions.json')));
    if (!project || typeof project.cwd !== 'string' || !project.cwd)
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

const transcriptTitleReader = createTranscriptTitleReader({ maxInitialReadBytes: MAX_TRANSCRIPT_INITIAL_READ_BYTES });

function findActivity(transcriptPath) {
    if (!transcriptPath || !fs.existsSync(transcriptPath))
        return 'Waiting';
    try {
        const stat = fs.statSync(transcriptPath);
        if (activityCache.transcriptPath === transcriptPath
            && activityCache.mtimeMs === stat.mtimeMs
            && activityCache.size === stat.size)
            return activityCache.value;
        // 尾端一筆巨型 tool_result（大型 diff、搜尋結果）可能超過 64KB，
        // 使整段緩衝都是半行而解析不到任何紀錄；此時才擴大讀取範圍，避免每次都付出大讀取成本。
        let value = 'Working';
        for (const limit of ACTIVITY_TAIL_READ_BYTES) {
            const bytes = Math.min(stat.size, limit);
            const buffer = Buffer.alloc(bytes);
            const descriptor = fs.openSync(transcriptPath, 'r');
            try {
                fs.readSync(descriptor, buffer, 0, bytes, stat.size - bytes);
            } finally {
                fs.closeSync(descriptor);
            }
            value = classifyActivity(buffer.toString('utf8'));
            if (value !== 'Working' || bytes >= stat.size)
                break;
        }
        activityCache = { transcriptPath, mtimeMs: stat.mtimeMs, size: stat.size, value };
        return value;
    } catch {
        return 'Working';
    }
}

function writeDiagnostic(snapshot) {
    try {
        const serialized = JSON.stringify(snapshot);
        if (serialized === lastDiagnosticSnapshot)
            return;
        lastDiagnosticSnapshot = serialized;
        fs.writeFileSync(diagnosticPath, JSON.stringify({ updatedAt: new Date().toISOString(), ...snapshot }, null, 2), 'utf8');
    }
    catch (error) {
        log(`無法寫入活動診斷快照：${error instanceof Error ? error.message : String(error)}`);
    }
}

function shouldShutdownForIdle() {
    return !hostMonitor.isKnownRunning() && Date.now() - lastSessionSignalAt() > DAEMON_IDLE_SHUTDOWN_MS;
}

function syncBrokerConnection(useBroker) {
    if (lastUseBroker === true && !useBroker) {
        lastBrokerActivity = null;
        lastBrokerActivityLabel = null;
        lastBrokerPayload = null;
        try { fs.rmSync(path.join(brokerStateDir, 'claude.json'), { force: true }); }
        catch {}
    }
    lastUseBroker = useBroker;
    if (!useBroker) {
        if (!rpc.ready) rpc.connect();
    } else {
        if (rpc.socket || rpc.reconnectTimer) rpc.disconnect();
        ensureBroker();
    }
}

function formatPrefix(label, fallback) {
    const text = String(label || fallback).trimEnd();
    return text.endsWith(':') ? `${text} ` : `${text}: `;
}

function buildPresenceState(project, conversationTitle, activityLabel, repositoryUrl) {
    const projectName = config.showProject === false ? '' : String(project?.name || '');
    const activitySuffix = activityLabel ? ` · ${activityLabel}` : '';
    const isCompact = config.compactPrefix !== false;
    const projectPrefix = isCompact
        ? (config.compactProjectLabel ?? '📁 ')
        : formatPrefix(config.projectLabel, 'Workspace');
    const taskPrefix = isCompact
        ? (config.compactTaskLabel ?? '📌 ')
        : formatPrefix(config.taskLabel, 'Task');

    let state;
    if (conversationTitle) {
        const titleBudget = Math.max(0, (config.taskTitleMaxWidth ?? 40) - displayWidth(taskPrefix) - displayWidth(activitySuffix));
        state = `${taskPrefix}${truncateToWidth(conversationTitle, titleBudget)}${activitySuffix}`;
    }
    else {
        state = `${truncate(config.state, 128)}${activitySuffix}`;
    }
    const assets = config.showAssets !== false ? {
        largeImage: config.largeImage,
        largeText: config.largeImageText,
        smallImage: config.smallImage || undefined,
        smallText: config.smallImage ? (config.smallImageText || (activityLabel ? `Status: ${activityLabel}` : undefined)) : undefined
    } : undefined;

    const activity = buildPresence({
        details: projectName
            ? `${truncate(projectPrefix, 64)}${truncateToWidth(projectName, config.projectNameMaxWidth)}`
            : truncate(config.details, 110),
        state,
        startedAt,
        showElapsedTime: config.showElapsedTime !== false,
        repositoryUrl: config.showRepositoryButton === false ? null : repositoryUrl,
        repositoryButtonLabel: config.repositoryButtonLabel,
        assets
    });
    return { activity, projectName };
}

function tick() {
    try {
        if (shouldShutdownForIdle()) {
            log(`超過 ${Math.round(DAEMON_IDLE_SHUTDOWN_MS / 60_000)} 分鐘沒有收到任何 Claude session 訊號，判定 Claude 已關閉，daemon 自動關閉。`);
            shutdown();
            return;
        }
        refreshConfig();
        const useBroker = config.useBroker !== false;
        syncBrokerConnection(useBroker);
        const project = readActiveProject();
        refreshWatchers(project);
        const conversationTitle = config.showConversationTitle === true
            ? transcriptTitleReader.findTitle(project?.transcriptPath)
            : null;
        const repositoryUrl = project?.cwd ? findGitHubRepository(project.cwd) : null;
        const activityLabel = config.showActivity === false ? null : findActivity(project?.transcriptPath);
        const { activity, projectName } = buildPresenceState(project, conversationTitle, activityLabel, repositoryUrl);
        if (config.useBroker !== false)
            publishBrokerState(activity, activityLabel);
        else
            rpc.setActivity(activity);
        writeDiagnostic({
            activeProject: projectName || null,
            sessionId: project?.sessionId || null,
            title: conversationTitle || null,
            activity: activityLabel,
            titleSource: conversationTitle ? 'custom-title' : 'fallback',
            transcriptWatched: Boolean(transcriptWatcher),
            updateMode: 'file-watch'
        });
    }
    catch (error) {
        log(`更新 Discord Rich Presence 時發生錯誤：${error instanceof Error ? error.message : String(error)}`);
    }
}

function shutdown() {
    activeProjectWatcher?.close();
    transcriptWatcher?.close();
    configWatcher?.close();
    if (scheduledTick)
        clearTimeout(scheduledTick);
    if (brokerHeartbeatTimer)
        clearInterval(brokerHeartbeatTimer);
    if (hostProcessTimer)
        clearInterval(hostProcessTimer);
    if (periodicTickTimer)
        clearInterval(periodicTickTimer);
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
startBrokerHeartbeat();
periodicTickTimer = setInterval(scheduleTick, PERIODIC_TICK_MS);
