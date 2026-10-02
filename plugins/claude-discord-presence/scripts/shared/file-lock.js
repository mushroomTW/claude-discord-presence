'use strict';

const fs = require('node:fs');

function errorCode(error) {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function isStale(filePath, staleMs) {
  try {
    return Date.now() - fs.statSync(filePath).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

// 以 O_EXCL 建立鎖檔；成功回傳 true，已被持有回傳 false。
// 鎖檔逾時視為持有者已當機，但回收必須互斥：只有取得回收鎖者能在重新確認仍逾時後刪除舊鎖，
// 否則兩個等待者都判定逾時時，後者會刪掉前者剛建立的新鎖，讓兩者同時進入臨界區。
function tryAcquireLock(lockPath, staleMs) {
  try {
    const descriptor = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8');
    fs.closeSync(descriptor);
    return true;
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  if (!isStale(lockPath, staleMs)) return false;
  const reclaimPath = `${lockPath}.reclaim`;
  try {
    fs.closeSync(fs.openSync(reclaimPath, 'wx', 0o600));
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    // 回收者只會在極短的回收區間內當機才殘留回收鎖；逾時後清除，下一輪再回收。
    if (isStale(reclaimPath, staleMs)) fs.rmSync(reclaimPath, { force: true });
    return false;
  }
  try {
    if (isStale(lockPath, staleMs)) fs.rmSync(lockPath, { force: true });
  } finally {
    fs.rmSync(reclaimPath, { force: true });
  }
  return tryAcquireLock(lockPath, staleMs);
}

module.exports = { errorCode, tryAcquireLock };
