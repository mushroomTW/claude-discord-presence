interface HostMonitorOptions {
  query: (callback: (running: boolean | null) => void) => void;
  missingLimit: number;
  startupGraceMs?: number;
  onMissing: () => void;
  now?: () => number;
}

// 追蹤宿主程序存活狀態：連續多次確認不存在才觸發 onMissing。
// query(callback) 以 true／false 回報是否存在，查詢失敗回報 null（狀態未知，不計入）。
export function createHostMonitor({ query, missingLimit, startupGraceMs = 0, onMissing, now = Date.now }: HostMonitorOptions) {
  const startedAt = now();
  let inFlight = false;
  let missingChecks = 0;
  let knownRunning: boolean | null = null;

  function check() {
    if (inFlight) return;
    inFlight = true;
    try {
      query(onResult);
    } catch {
      // 查詢同步拋錯（例如無法建立子程序）視為狀態未知，下次仍可再查。
      inFlight = false;
    }
  }

  function onResult(running: boolean | null) {
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
  }

  return { check, isKnownRunning: () => knownRunning === true };
}
