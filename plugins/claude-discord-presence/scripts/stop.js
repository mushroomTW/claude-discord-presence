#!/usr/bin/env node
// @ts-nocheck
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const path = require('path');
const { stopLegacyDaemon, stopOwnedDaemon } = require('./daemon-state');
const dataDir = process.env.CLAUDE_PLUGIN_DATA || __dirname;
const daemonScript = path.join(__dirname, 'claude-discord-presence.js');
const stopped = stopOwnedDaemon(dataDir) || stopLegacyDaemon(dataDir, daemonScript);
console.log(stopped ? 'Claude Discord Presence stopped.' : 'Claude Discord Presence is not running.');
