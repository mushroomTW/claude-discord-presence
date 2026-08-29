#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createRotatingLogger(logPath, maximumBytes = 1_000_000) {
  return (message) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(line);
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      if (fs.existsSync(logPath) && fs.statSync(logPath).size >= maximumBytes) {
        fs.rmSync(`${logPath}.1`, { force: true });
        fs.renameSync(logPath, `${logPath}.1`);
      }
      fs.appendFileSync(logPath, `${line}\n`, 'utf8');
    } catch (error) {
      console.error(`無法寫入 Discord Presence 日誌：${error.message}`);
    }
  };
}

module.exports = { createRotatingLogger };
