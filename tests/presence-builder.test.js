'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildPresence, truncate, displayWidth, truncateToWidth } = require('../plugins/claude-discord-presence/scripts/shared/presence-builder');

test('truncate safely handles nullish and long values', () => {
  assert.equal(truncate(null, 10), '');
  assert.equal(truncate('abcdef', 3), 'abc');
});

test('displayWidth counts CJK characters as double-width', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('ab中文'), 6);
});

test('displayWidth treats emoji as double-width and joins modifiers into one glyph', () => {
  assert.equal(displayWidth('\u{1F680}-cool-app'), 11); // 🚀 = 2
  assert.equal(displayWidth('\u{1F468}\u200D\u{1F4BB}'), 2); // 👨‍💻 ZWJ 序列視為單一字形
  assert.equal(displayWidth('\u{1F44D}\u{1F3FD}'), 2); // 👍🏽 膚色修飾符不加寬
  assert.equal(displayWidth('\u2600\uFE0F'), 2); // ☀️ 帶 Emoji 呈現選擇子
  assert.equal(displayWidth('✓★'), 2); // ✓★ 純文字符號維持單寬
});

test('truncateToWidth keeps the activity suffix visible for emoji-heavy names', () => {
  const truncated = truncateToWidth('\u{1F680}\u{1F525}\u{1F389}\u{1F4A1}-project', 8);
  assert.ok(displayWidth(truncated) <= 8);
  assert.equal(truncated, '\u{1F680}\u{1F525}\u{1F389}…');
});

test('truncateToWidth leaves short values untouched', () => {
  assert.equal(truncateToWidth('Vibe coding', 40), 'Vibe coding');
  assert.equal(truncateToWidth(null, 10), '');
});

test('truncateToWidth truncates by display width and appends an ellipsis', () => {
  const truncated = truncateToWidth('Discord的VibeCoding工具動態', 20);
  assert.ok(displayWidth(truncated) <= 20);
  assert.ok(truncated.endsWith('…'));
});

test('truncateToWidth returns empty string when the budget is too small for an ellipsis', () => {
  assert.equal(truncateToWidth('abcdef', 0), '');
});

test('buildPresence enforces Discord limits and optional fields', () => {
  const activity = buildPresence({
    details: 'd'.repeat(140),
    state: 's'.repeat(140),
    startedAt: 123,
    repositoryUrl: 'https://github.com/example/repo',
    repositoryButtonLabel: 'b'.repeat(40)
  });
  assert.equal(activity.details.length, 128);
  assert.equal(activity.state.length, 128);
  assert.deepEqual(activity.timestamps, { start: 123 });
  assert.equal(activity.buttons[0].label.length, 32);
  assert.equal(activity.instance, false);
});

test('buildPresence omits elapsed time and unavailable repository button', () => {
  const activity = buildPresence({ details: 'Using Claude', state: 'Waiting', showElapsedTime: false });
  assert.equal(activity.timestamps, undefined);
  assert.equal(activity.buttons, undefined);
});
