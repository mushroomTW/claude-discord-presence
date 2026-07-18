'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');
const pluginRoot = path.join(repositoryRoot, 'plugins', 'claude-discord-presence');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8'));
}

test('Claude 發布 metadata、版本與必要檔案完整', () => {
  const marketplace = readJson('.claude-plugin/marketplace.json');
  const manifest = readJson('plugins/claude-discord-presence/.claude-plugin/plugin.json');
  const config = readJson('plugins/claude-discord-presence/scripts/config.json');
  const listing = marketplace.plugins[0];

  assert.equal(marketplace.name, manifest.name);
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(listing.name, manifest.name);
  assert.equal(listing.source, './plugins/claude-discord-presence');
  assert.equal(listing.version, manifest.version);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.match(config.clientId, /^\d{17,20}$/);
  assert.equal(config.useBroker, true);

  for (const relativePath of ['hooks/hooks.json', 'assets/claude-discord-mascot-icon-transparent.png']) {
    assert.ok(fs.existsSync(path.join(pluginRoot, relativePath)), `缺少必要檔案：${relativePath}`);
  }
});

test('Claude hooks 僅引用存在的 Node.js 腳本', () => {
  const hooks = readJson('plugins/claude-discord-presence/hooks/hooks.json').hooks;
  const commands = Object.values(hooks).flatMap((groups) => groups.flatMap((group) => group.hooks));
  assert.ok(commands.length > 0);
  for (const hook of commands) {
    assert.equal(hook.type, 'command');
    assert.equal(hook.command, 'node');
    assert.ok(Number(hook.timeout) > 0 && Number(hook.timeout) <= 10);
    const script = hook.args?.[0]?.replace('${CLAUDE_PLUGIN_ROOT}/', '');
    assert.match(script || '', /^scripts\/.+\.js$/);
    assert.ok(fs.existsSync(path.join(pluginRoot, script)), `Hook 腳本不存在：${script}`);
  }
});

test('Git 發布內容不追蹤套件管理器或開發用 Broker 副本', () => {
  for (const name of ['package.json', 'package-lock.json', 'node_modules', 'discord-presence-broker']) {
    const tracked = childProcess.execFileSync('git', [
      'ls-files', '--', `plugins/claude-discord-presence/${name}`
    ], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true }).trim();
    assert.equal(tracked, '', `不應出貨：${name}`);
  }
});
