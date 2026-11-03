import fs from 'node:fs';
import path from 'node:path';

export type Logger = (message: string) => void;

export function createRotatingLogger(logPath: string, maximumBytes = 1_000_000): Logger {
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
      console.error(`無法寫入 Discord Presence 日誌：${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
