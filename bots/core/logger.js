import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Structured JSONL logger. One line per event.
 *
 * Writes to data/logs/<username>.log and mirrors INFO/WARN/ERROR to stdout.
 * Caller flushes by calling close().
 */
export function createLogger(username, { logDir } = {}) {
  const dir = logDir ?? path.join(PROJECT_ROOT, 'data', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${username}.log`);
  const stream = fs.createWriteStream(filePath, { flags: 'a' });

  const write = (level, event, fields) => {
    const line = {
      ts: new Date().toISOString(),
      level,
      bot: username,
      event,
      ...fields,
    };
    const serialized = JSON.stringify(line);
    stream.write(serialized + '\n');
    if (level !== 'debug') {
      const tag = `[${username}] ${event}`;
      if (level === 'error') console.error(tag, fields ?? '');
      else if (level === 'warn') console.warn(tag, fields ?? '');
      else console.log(tag, fields ?? '');
    }
  };

  return {
    filePath,
    info:  (event, fields) => write('info',  event, fields),
    warn:  (event, fields) => write('warn',  event, fields),
    error: (event, fields) => write('error', event, fields),
    debug: (event, fields) => write('debug', event, fields),
    close: () => new Promise((resolve) => stream.end(resolve)),
  };
}
