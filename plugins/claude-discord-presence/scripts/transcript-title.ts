import fs from 'node:fs';

interface TitleCache {
  mtimeMs: number;
  offset: number;
  path: string;
  pending: Buffer;
  skippingOversizedLine: boolean;
  title: string | null;
}

// 以增量方式讀取 Claude 對話紀錄，找出最後一筆 custom-title 作為顯示標題。
export function createTranscriptTitleReader({ maxInitialReadBytes = 512 * 1024, maxPendingBytes = 64 * 1024 } = {}) {
  let cache: TitleCache | null = null;

  function reset(transcriptPath: string, offset = 0): TitleCache {
    cache = {
      mtimeMs: 0,
      offset,
      path: transcriptPath,
      pending: Buffer.alloc(0),
      skippingOversizedLine: false,
      title: null
    };
    return cache;
  }

  function applyRecord(state: TitleCache, recordText: string) {
    // custom-title 紀錄必含此關鍵字；先以子字串過濾，避免對每一行紀錄做 JSON.parse。
    if (!recordText.includes('custom-title'))
      return;
    try {
      const record = JSON.parse(recordText);
      if (record.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.trim())
        state.title = record.customTitle.trim().slice(0, 128);
    } catch {
      // 忽略尚未完整寫入或無法辨識的紀錄。
    }
  }

  function consumeChunk(chunk: Buffer) {
    const state = cache ?? reset('');
    let completeBuffer = Buffer.concat([state.pending, chunk]);
    state.pending = Buffer.alloc(0);
    if (state.skippingOversizedLine) {
      const firstNewline = completeBuffer.indexOf(0x0A);
      if (firstNewline === -1)
        return;
      completeBuffer = completeBuffer.subarray(firstNewline + 1);
      state.skippingOversizedLine = false;
    }
    const lastNewline = completeBuffer.lastIndexOf(0x0A);
    const remainder = lastNewline === -1 ? completeBuffer : completeBuffer.subarray(lastNewline + 1);
    if (lastNewline !== -1) {
      for (const recordText of completeBuffer.subarray(0, lastNewline).toString('utf8').split(/\r?\n/))
        applyRecord(state, recordText);
    }
    // 對話紀錄的單行可能長達數 MB（大型工具輸出）；custom-title 紀錄極小，
    // 超過上限的未完成行不可能是標題，直接丟棄以免無限累積在記憶體。
    if (remainder.length > maxPendingBytes) {
      state.skippingOversizedLine = true;
      return;
    }
    state.pending = remainder;
    // 保留不完整的最後一筆紀錄；若其實已完整則立即解析，等待下一次增量讀取覆寫。
    if (state.pending.length > 0)
      applyRecord(state, state.pending.toString('utf8'));
  }

  function findTitle(transcriptPath: string | null | undefined): string | null {
    if (!transcriptPath || !fs.existsSync(transcriptPath))
      return null;
    try {
      const stat = fs.statSync(transcriptPath);
      let state = cache;
      if (!state
        || state.path !== transcriptPath
        || stat.size < state.offset
        || (stat.size === state.offset && stat.mtimeMs !== state.mtimeMs)) {
        state = reset(transcriptPath, Math.max(0, stat.size - maxInitialReadBytes));
      }
      if (stat.size > state.offset) {
        const bytesToRead = stat.size - state.offset;
        const chunk = Buffer.alloc(bytesToRead);
        const descriptor = fs.openSync(transcriptPath, 'r');
        try {
          fs.readSync(descriptor, chunk, 0, bytesToRead, state.offset);
        } finally {
          fs.closeSync(descriptor);
        }
        consumeChunk(chunk);
        state.offset = stat.size;
      }
      state.mtimeMs = stat.mtimeMs;
      return state.title;
    } catch {
      return null;
    }
  }

  return { consumeChunk, findTitle, reset, currentTitle: () => cache?.title ?? null };
}
