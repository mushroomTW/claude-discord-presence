'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyActivity } = require('../plugins/claude-discord-presence/scripts/activity-classifier');

test('依最後一筆有效紀錄分類，略過 attachment 等非活動紀錄', () => {
  const lines = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
    JSON.stringify({ type: 'attachment' }),
    JSON.stringify({ type: 'queue-operation' }),
    JSON.stringify({ type: 'custom-title', customTitle: 'x' })
  ].join('\n');
  assert.equal(classifyActivity(lines), 'Running tools');
});

test('各紀錄型別對應正確標籤', () => {
  assert.equal(classifyActivity(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit' }] } })), 'Editing');
  assert.equal(classifyActivity(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write' }] } })), 'Editing');
  assert.equal(classifyActivity(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } })), 'Reading results');
  assert.equal(classifyActivity(JSON.stringify({ type: 'user', message: { content: 'hello' } })), 'Thinking');
  assert.equal(classifyActivity(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '...' }] } })), 'Thinking');
  assert.equal(classifyActivity(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } })), 'Waiting');
  assert.equal(classifyActivity(JSON.stringify({ type: 'progress' })), 'Running tools');
});

test('thinking 與 text 同列一筆時視為回覆完成', () => {
  const record = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: 'done' }] }
  });
  assert.equal(classifyActivity(record), 'Waiting');
});

test('空內容或無法解析時回傳 Working', () => {
  assert.equal(classifyActivity(''), 'Working');
  assert.equal(classifyActivity('not-json\n{broken'), 'Working');
});
