'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildPresence, truncate } = require('../plugins/claude-discord-presence/scripts/shared/presence-builder');

test('truncate safely handles nullish and long values', () => {
  assert.equal(truncate(null, 10), '');
  assert.equal(truncate('abcdef', 3), 'abc');
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
