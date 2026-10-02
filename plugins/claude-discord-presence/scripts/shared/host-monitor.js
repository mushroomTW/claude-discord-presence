'use strict';

// 追蹤宿主程序存活狀態：連續多次確認不存在才觸發 onMissing。
// query(callback) 以 true／false 回報是否存在，查詢失敗回報 null（狀態未知，不計入）。
function createHostMonitor({ query, missingLimit, startupGraceMs = 0, onMissing, now = Date.now }) {
  const startedAt = now();
  let inFlight = false;
  let missingChecks = 0;
  let knownRunning = null;

  function check() {
    if (inFlight) return;
    inFlight = true;
    query((running) => {
      inFlight = false;
      if (running === null) return;
      if (running) {
        knownRunning = true;
        missingChecks = 0;
        return;
      }
      // 開機或 Desktop 剛啟動時宿主可能尚未完成程序註冊，寬限期內不判定為關閉。
      if (now() - startedAt < startupGraceMs) return;
      knownRunning = false;
      missingChecks += 1;
      if (missingChecks >= missingLimit) onMissing();
    });
  }

  return { check, isKnownRunning: () => knownRunning === true };
}

module.exports = { createHostMonitor };
