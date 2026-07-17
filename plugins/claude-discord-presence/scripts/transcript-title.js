'use strict';

const fs = require('fs');

// 以增量方式讀取 Claude 對話紀錄，找出最後一筆 custom-title 作為顯示標題。
function createTranscriptTitleReader({ maxInitialReadBytes = 512 * 1024 } = {}) {
  let cache = null;

  function reset(transcriptPath, offset = 0) {
    cache = {
      mtimeMs: 0,
      offset,
      path: transcriptPath,
      pending: Buffer.alloc(0),
      title: null
    };
  }

  function applyRecord(recordText) {
    try {
      const record = JSON.parse(recordText);
      if (record.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.trim())
        cache.title = record.customTitle.trim().slice(0, 128);
    } catch {
      // 忽略尚未完整寫入或無法辨識的紀錄。
    }
  }

  function consumeChunk(chunk) {
    const completeBuffer = Buffer.concat([cache.pending, chunk]);
    const lastNewline = completeBuffer.lastIndexOf(0x0A);
    if (lastNewline === -1) {
      cache.pending = completeBuffer;
    }
    const records = lastNewline === -1
      ? []
      : completeBuffer.subarray(0, lastNewline).toString('utf8').split(/\r?\n/);
    if (lastNewline !== -1)
      cache.pending = completeBuffer.subarray(lastNewline + 1);
    for (const recordText of records)
      applyRecord(recordText);
    // 保留不完整的最後一筆紀錄；若其實已完整則立即解析，等待下一次增量讀取覆寫。
    if (cache.pending.length > 0)
      applyRecord(cache.pending.toString('utf8'));
  }

  function findTitle(transcriptPath) {
    if (!transcriptPath || !fs.existsSync(transcriptPath))
      return null;
    try {
      const stat = fs.statSync(transcriptPath);
      if (!cache
        || cache.path !== transcriptPath
        || stat.size < cache.offset
        || (stat.size === cache.offset && stat.mtimeMs !== cache.mtimeMs)) {
        reset(transcriptPath, Math.max(0, stat.size - maxInitialReadBytes));
      }
      if (stat.size > cache.offset) {
        const bytesToRead = stat.size - cache.offset;
        const chunk = Buffer.alloc(bytesToRead);
        const descriptor = fs.openSync(transcriptPath, 'r');
        try {
          fs.readSync(descriptor, chunk, 0, bytesToRead, cache.offset);
        } finally {
          fs.closeSync(descriptor);
        }
        consumeChunk(chunk);
        cache.offset = stat.size;
      }
      cache.mtimeMs = stat.mtimeMs;
      return cache.title;
    } catch {
      return null;
    }
  }

  return { consumeChunk, findTitle, reset, currentTitle: () => cache?.title ?? null };
}

module.exports = { createTranscriptTitleReader };
