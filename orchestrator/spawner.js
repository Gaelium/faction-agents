import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
// Every bot process runs the agent loop.
const BOT_RUN_JS = path.join(PROJECT_ROOT, 'bots', 'agent', 'main.js');

/**
 * Spawns bots as isolated Node child processes.
 *
 * Events:
 *   spawn    (username, pid)
 *   exit     (username, { code, signal, uptimeMs, sessionElapsedMs })
 *   stdout   (username, line)   // JSONL parsed opportunistically
 *   event    (username, parsed) // parsed JSON log record if line was JSON
 *
 * Per bot, enforces `session_minutes` from the profile: when the window
 * is up, the bot gets SIGTERM and will respawn on a future scheduler tick.
 * This drives the "logs on, plays a while, logs off" feel.
 */
/**
 * Evenly spaced headings out of spawn (degrees, 0 = north) for a roster,
 * by username order, so a fleet spawning on one block fans out instead of
 * crowding one side. Passed to each bot as AGENT_EXIT_BEARING.
 */
export function evenBearings(usernames) {
  const names = [...new Set(usernames)].sort();
  const step = names.length ? 360 / names.length : 360;
  return new Map(names.map((n, i) => [n, Math.round(i * step)]));
}

export class Spawner extends EventEmitter {
  constructor({ env = process.env, log = null, envFor = null } = {}) {
    super();
    this.env = env;
    this.log = log;
    this.envFor = envFor;   // (profile) => extra environment for that bot's process
    /** username -> { proc, profile, startedAt, sessionMs, sessionTimer, stdoutBuf, stderrBuf } */
    this.active = new Map();
  }

  isOnline(username) { return this.active.has(username); }
  onlineUsernames() { return [...this.active.keys()]; }
  onlineCount() { return this.active.size; }
  getRecord(username) { return this.active.get(username) ?? null; }

  spawn(profile) {
    if (this.active.has(profile.username)) return this.active.get(profile.username);

    const [minM, maxM] = profile.schedule?.session_minutes ?? [30, 120];
    const sessionMs = (minM + Math.random() * (maxM - minM)) * 60_000;

    const proc = spawn(process.execPath, [BOT_RUN_JS, profile.username], {
      cwd: PROJECT_ROOT,
      env: { ...this.env, ...(this.envFor?.(profile) ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const rec = {
      proc,
      profile,
      startedAt: Date.now(),
      sessionMs,
      sessionTimer: null,
      stdoutBuf: '',
      stderrBuf: '',
      lastEvent: null,   // last parsed JSON event from stdout (for dashboard)
    };
    this.active.set(profile.username, rec);

    proc.stdout.on('data', (chunk) => this._onStdout(profile.username, rec, chunk));
    proc.stderr.on('data', (chunk) => this._onStderr(profile.username, rec, chunk));
    proc.on('exit', (code, signal) => this._onExit(profile.username, rec, code, signal));
    proc.on('error', (err) => this.log?.warn?.('spawn_error', { user: profile.username, msg: err.message }));

    // Session timeout — SIGTERM when the window elapses.
    rec.sessionTimer = setTimeout(() => this.kill(profile.username, 'session_end'), sessionMs);
    if (rec.sessionTimer.unref) rec.sessionTimer.unref();

    this.emit('spawn', profile.username, proc.pid);
    this.log?.info?.('bot_spawned', {
      user: profile.username, pid: proc.pid, session_min: minM, session_max: maxM,
    });
    return rec;
  }

  kill(username, reason = 'scheduled') {
    const rec = this.active.get(username);
    if (!rec) return false;
    if (rec.sessionTimer) clearTimeout(rec.sessionTimer);
    try { rec.proc.kill('SIGTERM'); } catch {}
    // Force SIGKILL if it doesn't exit cleanly within 10s.
    const forceTimer = setTimeout(() => {
      try { rec.proc.kill('SIGKILL'); } catch {}
    }, 10_000);
    if (forceTimer.unref) forceTimer.unref();
    rec._killReason = reason;
    return true;
  }

  killAll(reason = 'shutdown') {
    for (const user of this.active.keys()) this.kill(user, reason);
  }

  _onStdout(user, rec, chunk) {
    rec.stdoutBuf += chunk.toString();
    let i;
    while ((i = rec.stdoutBuf.indexOf('\n')) >= 0) {
      const line = rec.stdoutBuf.slice(0, i);
      rec.stdoutBuf = rec.stdoutBuf.slice(i + 1);
      if (!line.trim()) continue;
      this.emit('stdout', user, line);
      // Our logger mirrors structured lines to stdout; some are just
      // "[user] event { fields }". We try to identify JSON-ish bot-log
      // events by looking for a trailing `{...}` object to parse.
      const jsonMatch = /\{.*\}\s*$/.exec(line);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          rec.lastEvent = { ...parsed, raw: line, ts: Date.now() };
          this.emit('event', user, parsed, line);
        } catch { /* not JSON */ }
      }
    }
  }

  _onStderr(user, rec, chunk) {
    rec.stderrBuf += chunk.toString();
    let i;
    while ((i = rec.stderrBuf.indexOf('\n')) >= 0) {
      const line = rec.stderrBuf.slice(0, i);
      rec.stderrBuf = rec.stderrBuf.slice(i + 1);
      if (line.trim()) this.emit('stderr', user, line);
    }
  }

  _onExit(user, rec, code, signal) {
    if (rec.sessionTimer) clearTimeout(rec.sessionTimer);
    this.active.delete(user);
    const uptimeMs = Date.now() - rec.startedAt;
    this.emit('exit', user, {
      code, signal,
      uptimeMs,
      sessionElapsedMs: Math.min(uptimeMs, rec.sessionMs),
      killReason: rec._killReason ?? null,
      // Last JSONL event the bot logged before exit. The HealthMonitor
      // uses this to apply per-reason restart backoff — e.g. a
      // `bot_force_exit reason: position_corrupt_unrecovered` exit
      // means the same packet-corruption condition will likely recur
      // immediately on reconnect, so a longer backoff is warranted.
      lastEvent: rec.lastEvent ?? null,
    });
    this.log?.info?.('bot_exited', { user, code, signal, uptime_s: Math.round(uptimeMs / 1000) });
  }
}
