import { EventEmitter } from 'node:events';

/**
 * Crash monitor + auto-restart. Subscribes to a Spawner's `exit` events:
 *   - exit code 0 or signal SIGTERM from scheduled kill → clean, no restart
 *   - anything else → crash. Scheduled restart with exponential backoff.
 *
 * Backoff schedule (per bot): 5s, 15s, 45s, 120s, 300s. After 5
 * consecutive crashes without ≥10 min of uptime between, the bot is
 * marked `unhealthy` and restart attempts pause until manually cleared
 * or the next scheduler evaluation (which is its own trigger).
 */

const BACKOFF_MS = [5_000, 15_000, 45_000, 120_000, 300_000];
const UPTIME_RESET_MS = 10 * 60_000;
// Exit reasons that trigger a longer per-reason backoff. When a bot
// force-exits with one of these, the underlying condition (server-side
// packet corruption that survives a fresh socket) is likely to recur
// immediately on reconnect — the orchestrator otherwise loops the bot
// through restart→corrupt→exit several times per minute. Multiplying
// the backoff lets server-side state drain between attempts.
// Observed in `data/logs/Archon_.log`: 5 consecutive
// `position_corrupt_unrecovered` exits in 12 minutes pre-fix.
const SLOW_RESTART_REASONS = new Set(['position_corrupt_unrecovered']);
const SLOW_RESTART_MULT = 3;

export class HealthMonitor extends EventEmitter {
  constructor({ spawner, profilesByName, log = null }) {
    super();
    if (!spawner) throw new Error('HealthMonitor requires spawner');
    if (!profilesByName) throw new Error('HealthMonitor requires profilesByName map');
    this.spawner = spawner;
    this.profiles = profilesByName;
    this.log = log;
    /** user -> { crashes: n, lastCrashAt, restartTimer, unhealthy, recent: [{ts, code, signal}] } */
    this.state = new Map();

    spawner.on('exit', (user, info) => this._onExit(user, info));
  }

  clearUnhealthy(user) {
    const s = this.state.get(user);
    if (!s) return;
    s.unhealthy = false;
    s.crashes = 0;
  }

  statusOf(user) {
    const s = this.state.get(user);
    if (!s) return { crashes: 0, unhealthy: false, recent: [] };
    return { crashes: s.crashes, unhealthy: !!s.unhealthy, recent: s.recent ?? [] };
  }

  _onExit(user, info) {
    const scheduled = info.killReason === 'scheduled'
      || info.killReason === 'session_end'
      || info.killReason === 'shutdown'
      || info.killReason === 'budget';
    const cleanExit = info.code === 0 && !info.signal;

    if (scheduled || cleanExit) {
      // Graceful shutdown. Reset crash counter if the bot lasted long
      // enough to count as "healthy for a while".
      const s = this._get(user);
      if (info.uptimeMs >= UPTIME_RESET_MS) {
        s.crashes = 0;
        s.unhealthy = false;
      }
      return;
    }

    // Crash.
    const s = this._get(user);
    const sinceLast = s.lastCrashAt ? Date.now() - s.lastCrashAt : Infinity;
    if (info.uptimeMs >= UPTIME_RESET_MS) s.crashes = 0; // earned a reset
    if (sinceLast > UPTIME_RESET_MS) s.crashes = 0;

    s.crashes += 1;
    s.lastCrashAt = Date.now();
    s.recent = [{ ts: Date.now(), code: info.code, signal: info.signal }, ...(s.recent ?? [])].slice(0, 10);

    this.emit('crash', user, { ...info, crashes: s.crashes });
    this.log?.warn?.('bot_crash', { user, crashes: s.crashes, code: info.code, signal: info.signal });

    if (s.crashes >= BACKOFF_MS.length) {
      s.unhealthy = true;
      this.emit('unhealthy', user);
      this.log?.error?.('bot_unhealthy', { user, crashes: s.crashes });
      return;
    }

    let delay = BACKOFF_MS[Math.min(s.crashes - 1, BACKOFF_MS.length - 1)];
    const lastReason = info.lastEvent?.event === 'bot_force_exit'
      ? info.lastEvent.reason ?? null
      : null;
    if (lastReason && SLOW_RESTART_REASONS.has(lastReason)) {
      delay *= SLOW_RESTART_MULT;
    }
    if (s.restartTimer) clearTimeout(s.restartTimer);
    s.restartTimer = setTimeout(() => this._restart(user), delay);
    if (s.restartTimer.unref) s.restartTimer.unref();
    this.emit('backoff', user, { delayMs: delay, crashes: s.crashes, reason: lastReason });
  }

  _restart(user) {
    const profile = this.profiles.get(user);
    if (!profile) return;
    if (this.spawner.isOnline(user)) return;
    this.log?.info?.('bot_restart', { user });
    this.spawner.spawn(profile);
  }

  _get(user) {
    let s = this.state.get(user);
    if (!s) { s = { crashes: 0, lastCrashAt: 0, restartTimer: null, unhealthy: false, recent: [] }; this.state.set(user, s); }
    return s;
  }
}
