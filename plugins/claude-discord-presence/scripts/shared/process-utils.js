'use strict';

const childProcess = require('node:child_process');

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getProcessCommandLine(pid) {
  try {
    const result = process.platform === 'win32'
      ? childProcess.spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`], { encoding: 'utf8', windowsHide: true }) // NOSONAR javascript:S4036 - 本機診斷查詢，參數為數字 PID，非 PATH 注入向量
      : childProcess.spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }); // NOSONAR javascript:S4036 - 本機診斷查詢，參數為數字 PID，非 PATH 注入向量
    if (result.error || result.status !== 0) return null;
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

module.exports = { getProcessCommandLine, isRunning };
