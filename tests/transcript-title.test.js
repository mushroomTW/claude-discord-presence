'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createTranscriptTitleReader } = require('../plugins/claude-discord-presence/scripts/transcript-title');

test('讀取最後一筆 custom-title 並截斷至 128 字', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-title-test-'));
  const transcriptPath = path.join(dir, 'transcript.jsonl');
  try {
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ type: 'custom-title', customTitle: '第一個標題' }),
      'not-json-line',
      JSON.stringify({ type: 'message', text: 'noise' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'x'.repeat(200) })
    ].join('\n') + '\n', 'utf8');
    const reader = createTranscriptTitleReader();
    assert.equal(reader.findTitle(transcriptPath), 'x'.repeat(128));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('增量寫入時能跨 chunk 解析並處理未換行的最後一筆', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-title-test-'));
  const transcriptPath = path.join(dir, 'transcript.jsonl');
  try {
    const reader = createTranscriptTitleReader();
    fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'custom-title', customTitle: 'first' }) + '\n', 'utf8');
    assert.equal(reader.findTitle(transcriptPath), 'first');
    fs.appendFileSync(transcriptPath, JSON.stringify({ type: 'custom-title', customTitle: 'second' }), 'utf8');
    assert.equal(reader.findTitle(transcriptPath), 'second');
    fs.appendFileSync(transcriptPath, '\n' + JSON.stringify({ type: 'custom-title', customTitle: 'third' }) + '\n', 'utf8');
    assert.equal(reader.findTitle(transcriptPath), 'third');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('無檔案或無標題時回傳 null', () => {
  const reader = createTranscriptTitleReader();
  assert.equal(reader.findTitle(null), null);
  assert.equal(reader.findTitle(path.join(os.tmpdir(), 'presence-title-missing.jsonl')), null);
});
