/**
 * memoryTool.js — the backend for Anthropic's client-side memory tool
 * (`memory_20250818`). Claude reads and writes files under a `/memories`
 * directory; this maps that to data/memory/<bot>/ on disk, sandboxed.
 *
 * Commands (from the SDK types): view {path, view_range?}, create {path,
 * file_text}, str_replace {path, old_str, new_str}, insert {path,
 * insert_line, insert_text}, delete {path}, rename {old_path, new_path}.
 * Results are plain text, like the reference implementation. Errors are
 * returned as text with `isError: true` so the loop can flag the result.
 */

import fs from 'node:fs';
import path from 'node:path';
import { MEMORY_DIR } from './tools/mind.js';

const ROOT_PREFIX = '/memories';
const MAX_FILE_BYTES = 64 * 1024;
const MAX_VIEW_CHARS = 12_000;

export const MEMORY_TOOL_DEFINITION = Object.freeze({ type: 'memory_20250818', name: 'memory' });

export class MemoryStore {
  constructor(username, { dir = null } = {}) {
    this.username = username;
    this.root = dir ?? path.join(MEMORY_DIR, username);
    fs.mkdirSync(this.root, { recursive: true });
  }

  /** Resolve a `/memories/...` path to disk, refusing anything outside the root. */
  resolve(p) {
    if (typeof p !== 'string' || !p.startsWith(ROOT_PREFIX)) {
      throw new Error(`path must start with ${ROOT_PREFIX}`);
    }
    const rel = p.slice(ROOT_PREFIX.length).replace(/^\/+/, '');
    const abs = path.resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new Error('path escapes the memory directory');
    return abs;
  }

  /** Files with sizes, for the login bootstrap. */
  list() {
    const out = [];
    const walk = (dir, prefix) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rel);
        else { try { out.push({ path: `${ROOT_PREFIX}/${rel}`, bytes: fs.statSync(path.join(dir, e.name)).size }); } catch {} }
      }
    };
    walk(this.root, '');
    return out;
  }

  run(input = {}) {
    try {
      switch (input.command) {
        case 'view': return this._view(input);
        case 'create': return this._create(input);
        case 'str_replace': return this._strReplace(input);
        case 'insert': return this._insert(input);
        case 'delete': return this._delete(input);
        case 'rename': return this._rename(input);
        default: return { text: `unknown command: ${input.command}`, isError: true };
      }
    } catch (e) {
      return { text: `error: ${e.message}`, isError: true };
    }
  }

  _view({ path: p, view_range }) {
    const abs = this.resolve(p ?? ROOT_PREFIX);
    if (!fs.existsSync(abs)) return { text: `${p} does not exist`, isError: true };
    if (fs.statSync(abs).isDirectory()) {
      const files = this.list().filter((f) => f.path.startsWith(p.replace(/\/+$/, '') + '/') || p === ROOT_PREFIX);
      if (!files.length) return { text: `${p} is empty` };
      return { text: `Files in ${p}:\n` + files.map((f) => `${f.path} (${f.bytes} bytes)`).join('\n') };
    }
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    let from = 1; let to = lines.length;
    if (Array.isArray(view_range) && view_range.length === 2) {
      from = Math.max(1, Number(view_range[0]) || 1);
      to = view_range[1] === -1 ? lines.length : Math.min(lines.length, Number(view_range[1]) || lines.length);
    }
    let text = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(4)}: ${l}`).join('\n');
    if (text.length > MAX_VIEW_CHARS) text = text.slice(0, MAX_VIEW_CHARS) + '\n…(truncated; use view_range)';
    return { text: `${p} (${lines.length} lines):\n${text}` };
  }

  _create({ path: p, file_text }) {
    const abs = this.resolve(p);
    const body = String(file_text ?? '');
    if (Buffer.byteLength(body) > MAX_FILE_BYTES) return { text: 'file too large (64 KB max)', isError: true };
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const existed = fs.existsSync(abs);
    fs.writeFileSync(abs, body);
    return { text: `${existed ? 'Overwrote' : 'Created'} ${p} (${body.split('\n').length} lines)` };
  }

  _strReplace({ path: p, old_str, new_str }) {
    const abs = this.resolve(p);
    if (!fs.existsSync(abs)) return { text: `${p} does not exist`, isError: true };
    const cur = fs.readFileSync(abs, 'utf8');
    const needle = String(old_str ?? '');
    if (!needle) return { text: 'old_str is empty', isError: true };
    const count = cur.split(needle).length - 1;
    if (count === 0) return { text: `old_str not found in ${p}`, isError: true };
    if (count > 1) return { text: `old_str matches ${count} places in ${p}; make it unique`, isError: true };
    const next = cur.replace(needle, String(new_str ?? ''));
    if (Buffer.byteLength(next) > MAX_FILE_BYTES) return { text: 'file too large (64 KB max)', isError: true };
    fs.writeFileSync(abs, next);
    return { text: `Edited ${p}` };
  }

  _insert({ path: p, insert_line, insert_text }) {
    const abs = this.resolve(p);
    if (!fs.existsSync(abs)) return { text: `${p} does not exist`, isError: true };
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    const at = Math.max(0, Math.min(lines.length, Number(insert_line) || 0));
    const ins = String(insert_text ?? '').replace(/\n$/, '').split('\n');
    lines.splice(at, 0, ...ins);
    const next = lines.join('\n');
    if (Buffer.byteLength(next) > MAX_FILE_BYTES) return { text: 'file too large (64 KB max)', isError: true };
    fs.writeFileSync(abs, next);
    return { text: `Inserted ${ins.length} line(s) at line ${at} of ${p}` };
  }

  _delete({ path: p }) {
    const abs = this.resolve(p);
    if (abs === this.root) return { text: 'refusing to delete the memory root', isError: true };
    if (!fs.existsSync(abs)) return { text: `${p} does not exist`, isError: true };
    fs.rmSync(abs, { recursive: true, force: true });
    return { text: `Deleted ${p}` };
  }

  _rename({ old_path, new_path }) {
    const from = this.resolve(old_path);
    const to = this.resolve(new_path);
    if (!fs.existsSync(from)) return { text: `${old_path} does not exist`, isError: true };
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return { text: `Renamed ${old_path} → ${new_path}` };
  }
}
