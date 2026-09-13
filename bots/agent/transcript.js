/**
 * transcript.js — the session on disk.
 *
 * One JSONL file per session at data/sessions/<bot>/<start-ts>.jsonl.
 * Every message appended to the model history is written as it happens,
 * plus one `turn` line per model call (usage, dollars, latency, stop
 * reason, tools called) and one `tool` line per tool execution. A failure
 * is something you read, not something you grep for.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const SESSIONS_DIR = path.join(PROJECT_ROOT, 'data', 'sessions');

export class Transcript {
  constructor(username, { dir = SESSIONS_DIR, startedAt = new Date() } = {}) {
    this.username = username;
    this.startedAt = startedAt;
    const botDir = path.join(dir, username);
    fs.mkdirSync(botDir, { recursive: true });
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
    this.filePath = path.join(botDir, `${stamp}.jsonl`);
    this._stream = fs.createWriteStream(this.filePath, { flags: 'a' });
    this.turns = 0;
    this.toolCalls = 0;
    this.usd = 0;
  }

  _write(obj) {
    try { this._stream.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n'); } catch {}
  }

  meta(fields) { this._write({ t: 'meta', ...fields }); }

  message(role, content) {
    this._write({ t: 'msg', role, content });
  }

  turn({ n, usage, usd, latencyMs, stopReason, tools, text }) {
    this.turns = n;
    this.usd = Math.round((this.usd + (usd ?? 0)) * 1e6) / 1e6;
    this._write({
      t: 'turn', n, stop: stopReason, usd, total_usd: this.usd, latency_ms: latencyMs,
      input: usage?.input_tokens, output: usage?.output_tokens,
      cache_read: usage?.cache_read_input_tokens, cache_create: usage?.cache_creation_input_tokens,
      tools, text: text ? String(text).slice(0, 400) : undefined,
    });
  }

  tool({ name, input, result, elapsedMs }) {
    this.toolCalls += 1;
    this._write({ t: 'tool', name, input, result, elapsed_ms: elapsedMs });
  }

  event(kind, fields = {}) { this._write({ t: 'event', kind, ...fields }); }

  summary() {
    return {
      file: this.filePath,
      turns: this.turns,
      tool_calls: this.toolCalls,
      usd: this.usd,
      minutes: Math.round((Date.now() - this.startedAt.getTime()) / 6000) / 10,
    };
  }

  close() {
    return new Promise((resolve) => { try { this._stream.end(resolve); } catch { resolve(); } });
  }
}
