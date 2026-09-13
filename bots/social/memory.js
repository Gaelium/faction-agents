import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Per-bot SQLite-backed memory (data/bots/<username>.db).
 *
 * Tables:
 *   events — server events this bot observed (with computed importance)
 *   kv     — JSON values by key: faction state, home, notes (the agent's
 *            persistent state lives here)
 *
 * Migration note (2026-09-12): the old stack's `relationships`,
 * `reflections` and `intentions` tables are no longer created or read.
 * Databases written before that date still carry them; they are ignored
 * and can be dropped with `sqlite3 data/bots/<name>.db 'DROP TABLE ...'`
 * or by deleting the file (the bot then starts with empty memory).
 *
 * All writes are synchronous (better-sqlite3) and take ~µs. Bot code is
 * free to call recordEvent() directly inside an event-bus handler.
 */
export class Memory {
  constructor(username, { dbDir } = {}) {
    this.username = username;
    const dir = dbDir ?? path.join(PROJECT_ROOT, 'data', 'bots');
    fs.mkdirSync(dir, { recursive: true });
    this.dbPath = path.join(dir, `${username}.db`);
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        ts INTEGER,
        type TEXT,
        actors TEXT,
        data TEXT,
        importance REAL
      );
      CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS events_type ON events(type);
      CREATE INDEX IF NOT EXISTS events_importance ON events(importance);

      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at INTEGER
      );

    `);

    this._insertEvent = this.db.prepare(
      `INSERT INTO events (ts, type, actors, data, importance)
       VALUES (?, ?, ?, ?, ?)`
    );
  }

  /**
   * Record an event. `actors` is an array of usernames involved (the bot
   * itself may or may not be one). `data` is any JSON-serializable payload.
   */
  recordEvent(type, actors, data = {}, importance = null) {
    const imp = importance ?? computeImportance(type, data);
    const ts = data?.ts ?? Date.now();
    this._insertEvent.run(
      ts,
      type,
      JSON.stringify(actors ?? []),
      JSON.stringify(data ?? {}),
      imp
    );
    return { ts, type, importance: imp };
  }

  /** Events from the last N minutes, ordered most-recent first. */
  recentEvents(minutes = 10, { limit = 200 } = {}) {
    const cutoff = Date.now() - minutes * 60_000;
    const rows = this.db.prepare(
      `SELECT * FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT ?`
    ).all(cutoff, limit);
    return rows.map(rowToEvent);
  }

  /**
   * Events whose actors array contains `target`. Used to build medium-
   * term context about a specific player.
   */
  eventsInvolving(target, limit = 100) {
    // JSON array membership via LIKE is fine for our data volumes (bot
    // horizons are minutes of play). json_each is cleaner but requires
    // the json1 extension; LIKE avoids that.
    const needle = `%"${target.replace(/"/g, '\\"')}"%`;
    const rows = this.db.prepare(
      `SELECT * FROM events
       WHERE actors LIKE ?
       ORDER BY ts DESC
       LIMIT ?`
    ).all(needle, limit);
    return rows.map(rowToEvent);
  }

  /**
   * Generic JSON-valued KV store. factions.js persists faction state here;
   * the agent keeps its home, notes and other durable state here too.
   */
  kvGet(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return fallback; }
  }

  kvSet(key, value) {
    this.db.prepare(
      `INSERT INTO kv (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, JSON.stringify(value ?? null), Date.now());
  }

  /** Diagnostic: total row counts. */
  counts() {
    return {
      events: this.db.prepare('SELECT COUNT(*) AS n FROM events').get().n,
      kv: this.db.prepare('SELECT COUNT(*) AS n FROM kv').get().n,
    };
  }

  close() {
    this.db.close();
  }
}

/**
 * Importance scoring. Deaths/kills and faction upheavals score high so
 * they rise to the top when building an LLM context window. Ambient
 * events stay low. Tunable per-type via the caller passing importance
 * explicitly to recordEvent().
 */
export function computeImportance(type, data = {}) {
  switch (type) {
    case 'player_death':        return 0.9;
    case 'player_damage':       return scaleDamage(data.damage);
    case 'faction_event':       return data.type === 'disband' ? 0.9 : 0.7;
    case 'kit_used':            return 0.3;
    case 'economy_transaction': return 0.4;
    case 'mcmmo_levelup':       return 0.3;
    case 'chat_message':        return 0.2;
    case 'zone_enter':          return 0.1;
    default:                    return 0.1;
  }
}

function scaleDamage(dmg) {
  // 0 dmg → 0.3, 10+ dmg → 0.8. Linear clamp.
  if (dmg == null) return 0.3;
  const clamped = Math.max(0, Math.min(10, Number(dmg)));
  return 0.3 + (clamped / 10) * 0.5;
}

function rowToEvent(r) {
  return {
    id: r.id,
    ts: r.ts,
    type: r.type,
    actors: safeParse(r.actors, []),
    data: safeParse(r.data, {}),
    importance: r.importance,
  };
}

function safeParse(s, fallback) {
  try { return JSON.parse(s ?? ''); } catch { return fallback; }
}
