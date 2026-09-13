/**
 * tracker.js — what each bot is doing and what it costs, read from the
 * files the agent already writes:
 *
 *   data/sessions/<bot>/<ts>.jsonl   every turn (cost), tool call, thought, event
 *   data/memory/<bot>/plans.md       standing goals the bot wrote for itself
 *   data/memory/<bot>/journal.md     one dated line per notable thing, per session
 *
 * No hooks into the bot process: the tracker tails the newest transcript
 * per bot, so it works the same for a bot the orchestrator spawned and one
 * started by hand, and it can show a bot's last session while it is
 * offline. Everything here is read-only.
 */

import fs from 'node:fs';
import path from 'node:path';

const RECENT_TOOLS = 40;
const RECENT_THOUGHTS = 12;
const RECENT_CHAT = 20;
const RECENT_EVENTS = 20;
const SERIES_MAX = 1440;           // cost samples per bot (at 30 s: 12 h)
const SAMPLE_MS = 30_000;
const READ_CAP = 4 * 1024 * 1024;
const TAIL_BYTES = 24 * 1024;

// Which input fields make a one-line summary of a tool call.
const SUMMARY_KEYS = {
  mine: ['block', 'count'], craft: ['item', 'count'], smelt: ['item', 'count'], smelt_start: ['item', 'count'],
  goto: ['named', 'player', 'x', 'z'], build: ['blueprint'], survey_site: ['blueprint'], place: ['block', 'x', 'y', 'z'],
  dig: ['x', 'y', 'z'], f: ['action', 'name'], sell: ['items'], pay: ['to', 'amount'], say: ['text'], focus: ['text'],
  command: ['cmd'], store: ['named', 'items'], withdraw: ['named', 'items'], farm: ['action'], use_skill: ['name'],
  save_skill: ['name'], skills: ['query', 'show'], wait: ['seconds'], teleport: ['to'], unstick: ['strategy'],
  attack: ['target'], flee: ['from'], scan: ['block'], memory: ['command', 'path'], note: ['text'],
  faction_notes: ['action'], think: ['question'], equip: ['item'], run_script: ['timeout_s'], light_area: [],
  eat: [], leave_spawn: [], look: [], inventory: [], board: [], recipes: ['item'], blueprints: ['id'], jobs: [],
  smelt_collect: [], collect_drops: [], wear_armor: [], logoff: ['reason'],
};

export function summarizeInput(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const keys = SUMMARY_KEYS[name] ?? Object.keys(i).slice(0, 2);
  const parts = [];
  for (const k of keys) {
    const v = i[k];
    if (v === undefined || v === null || v === '') continue;
    if (k === 'count' || k === 'amount' || k === 'seconds') { parts.push(`×${v}`); continue; }
    if (k === 'x' || k === 'y' || k === 'z') { parts.push(String(v)); continue; }
    if (typeof v === 'string') { parts.push(v.length > 48 ? `"${v.slice(0, 45)}…"` : (/\s/.test(v) ? `"${v}"` : v)); continue; }
    if (Array.isArray(v)) { parts.push(v.slice(0, 3).join(',') + (v.length > 3 ? '…' : '')); continue; }
    parts.push(JSON.stringify(v).slice(0, 30));
  }
  const coords = ['x', 'y', 'z'].filter((k) => keys.includes(k) && i[k] !== undefined).length;
  if (coords >= 2) {
    const c = ['x', 'y', 'z'].filter((k) => i[k] !== undefined).map((k) => i[k]).join(',');
    const rest = parts.filter((p) => !['x', 'y', 'z'].some((k) => String(i[k]) === p));
    return `${name} ${[...rest, c].join(' ')}`.trim();
  }
  return `${name} ${parts.join(' ')}`.trim();
}

/** "2026-09-05T19-21-02-051Z" → ms since epoch. */
export function sessionStartFromName(file) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(path.basename(file));
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isFinite(t) ? t : null;
}

function freshState(username) {
  return {
    username,
    session: null,          // { file, startedAt, model, effort, spawn, archetype }
    sessions: 0,
    usd: 0, pastUsd: 0, turns: 0, toolCalls: 0, toolsOk: 0, toolsFailed: 0, interrupts: 0, deaths: 0, contextEdits: 0,
    scripts: { run: 0, ok: 0, saved: 0, used: 0 },
    focus: null, focusAt: null, faction: null, home: null, money: null,
    lastTool: null, lastThought: null, lastTs: null, ended: null,
    recentTools: [], recentThoughts: [], recentChat: [], recentEvents: [],
    series: [],             // [[ts, usd this session, turns]] sampled every 30 s
    _offset: 0, _buf: '',
  };
}

export class FleetTracker {
  constructor({ sessionsDir, memoryDir, log = null, clock = Date.now } = {}) {
    if (!sessionsDir) throw new Error('FleetTracker requires sessionsDir');
    this.sessionsDir = sessionsDir;
    this.memoryDir = memoryDir ?? null;
    this.log = log;
    this.clock = clock;
    this.bots = new Map();       // username → state
    this._usdCache = new Map();  // file → { size, usd, startedAt, mtime }
    this._goalsCache = new Map();
    this.series = [];            // fleet: [[ts, usd of current sessions summed]]
    this._lastSample = 0;
  }

  track(username) { if (!this.bots.has(username)) this.bots.set(username, freshState(username)); return this.bots.get(username); }
  untrack(username) { this.bots.delete(username); }
  tracked() { return [...this.bots.keys()]; }
  botState(username) { return this.bots.get(username) ?? null; }

  latestSessionFile(username) {
    const dir = path.join(this.sessionsDir, username);
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return null; }
    if (!files.length) return null;
    files.sort();
    return path.join(dir, files[files.length - 1]);
  }

  /** Poll every tracked bot's newest transcript for new lines. */
  tick() {
    for (const [username, st] of this.bots) {
      try { this._tickOne(username, st); }
      catch (e) { this.log?.debug?.('tracker_tick_failed', { user: username, msg: e.message }); }
    }
    this._sample();
  }

  /** Cost over time, for the web dashboard's chart. */
  _sample(force = false) {
    const now = this.clock();
    if (!force && now - this._lastSample < SAMPLE_MS) return;
    this._lastSample = now;
    let sum = 0;
    for (const st of this.bots.values()) {
      if (!st.session) continue;
      const last = st.series[st.series.length - 1];
      if (!last || last[1] !== st.usd || last[2] !== st.turns) { st.series.push([now, st.usd, st.turns]); if (st.series.length > SERIES_MAX) st.series.splice(0, st.series.length - SERIES_MAX); }
      sum += st.usd;
    }
    const lastF = this.series[this.series.length - 1];
    if (!lastF || lastF[1] !== sum) { this.series.push([now, Math.round(sum * 1000) / 1000]); if (this.series.length > SERIES_MAX) this.series.splice(0, this.series.length - SERIES_MAX); }
  }

  _tickOne(username, st) {
    const file = this.latestSessionFile(username);
    if (!file) return;
    if (!st.session || st.session.file !== file) {
      // A new session: counters restart, cost rolls into pastUsd, and the
      // time-stamped feeds (tools, thoughts, events, chat) carry over so the
      // dashboard still shows the last session while the new one warms up.
      const carry = {
        pastUsd: st.pastUsd + st.usd, sessions: st.sessions + 1,
        focus: st.focus, focusAt: st.focusAt, faction: st.faction, home: st.home, money: st.money,
        recentTools: st.recentTools, recentThoughts: st.recentThoughts, recentEvents: st.recentEvents, recentChat: st.recentChat,
        lastTool: st.lastTool, lastThought: st.lastThought, series: st.series,
      };
      Object.assign(st, freshState(username), carry);
      st.session = { file, startedAt: sessionStartFromName(file) ?? this.clock(), model: null, effort: null, spawn: null, archetype: null };
    }
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { return; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size < st._offset) { st._offset = 0; st._buf = ''; }
      if (size === st._offset) return;
      const len = Math.min(size - st._offset, READ_CAP);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st._offset);
      st._offset += len;
      st._buf += buf.toString('utf8');
    } finally { fs.closeSync(fd); }
    let i;
    while ((i = st._buf.indexOf('\n')) >= 0) {
      const line = st._buf.slice(0, i);
      st._buf = st._buf.slice(i + 1);
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      this._apply(st, rec);
    }
  }

  _apply(st, rec) {
    const ts = rec.ts ? Date.parse(rec.ts) : this.clock();
    st.lastTs = ts;
    switch (rec.t) {
      case 'meta':
        Object.assign(st.session, { model: rec.model ?? null, effort: rec.effort ?? null, spawn: rec.spawn ?? null, archetype: rec.archetype ?? null });
        break;
      case 'turn':
        if (Number.isFinite(rec.total_usd)) st.usd = rec.total_usd;
        if (Number.isFinite(rec.n)) st.turns = rec.n;
        if (rec.text) { st.lastThought = { ts, text: String(rec.text).slice(0, 240) }; push(st.recentThoughts, st.lastThought, RECENT_THOUGHTS); }
        break;
      case 'tool': this._applyTool(st, rec, ts); break;
      case 'msg': if (rec.role === 'user') this._applyUserMsg(st, rec, ts); break;
      case 'event': if (rec.kind === 'context_edited') st.contextEdits += 1; break;
      default: break;
    }
  }

  _applyTool(st, rec, ts) {
    const r = rec.result ?? {};
    const status = r.status ?? 'unknown';
    const entry = { ts, name: rec.name, summary: summarizeInput(rec.name, rec.input), status, reason: r.reason ?? null, by: r.by ?? null, elapsed_ms: rec.elapsedMs ?? null };
    st.toolCalls += 1;
    if (status === 'ok') st.toolsOk += 1;
    else if (status === 'failed') st.toolsFailed += 1;
    else if (status === 'interrupted') { st.interrupts += 1; push(st.recentEvents, { ts, text: `interrupted ${rec.name}${r.by ? ' by ' + r.by : ''}${r.detail?.cause ? ` (${r.detail.cause})` : ''}` }, RECENT_EVENTS); }
    st.lastTool = entry;
    push(st.recentTools, entry, RECENT_TOOLS);
    const input = rec.input ?? {};
    if (rec.name === 'focus' && status === 'ok' && input.text) { st.focus = String(input.text); st.focusAt = ts; }
    if (rec.name === 'say' && status === 'ok') push(st.recentChat, { ts, dir: 'out', from: st.username, to: input.to ?? 'public', text: String(r.said ?? input.text ?? '') }, RECENT_CHAT);
    if (rec.name === 'f' && status === 'ok') {
      if (input.action === 'create' || input.action === 'join') st.faction = r.faction ?? input.name ?? st.faction;
      if (input.action === 'leave') st.faction = null;
      if (input.action === 'claim') push(st.recentEvents, { ts, text: `claimed chunk ${r.chunk ? `${r.chunk.chunk_x},${r.chunk.chunk_z}` : ''}` }, RECENT_EVENTS);
      if (input.action === 'create') push(st.recentEvents, { ts, text: `founded faction ${st.faction}` }, RECENT_EVENTS);
      if (input.action === 'join') push(st.recentEvents, { ts, text: `joined faction ${st.faction}` }, RECENT_EVENTS);
    }
    if (rec.name === 'build' && status === 'ok' && r.home_set && r.anchor) { st.home = r.anchor; push(st.recentEvents, { ts, text: `built ${r.blueprint} at ${r.anchor.x},${r.anchor.y},${r.anchor.z}` }, RECENT_EVENTS); }
    if (rec.name === 'board' && status === 'ok' && Number.isFinite(r.balance)) st.money = r.balance;
    if (rec.name === 'sell' && status === 'ok') {
      if (Number.isFinite(r.balance_after)) st.money = r.balance_after;
      if (Number.isFinite(r.earned) && r.earned > 0) push(st.recentEvents, { ts, text: `sold for $${r.earned}` }, RECENT_EVENTS);
    }
    if (rec.name === 'pay' && status === 'ok') push(st.recentEvents, { ts, text: `paid ${input.to} $${input.amount}` }, RECENT_EVENTS);
    if (rec.name === 'run_script') { st.scripts.run += 1; if (status === 'ok') st.scripts.ok += 1; }
    if (rec.name === 'use_skill') { st.scripts.used += 1; if (status === 'ok') st.scripts.ok += 1; }
    if (rec.name === 'save_skill' && status === 'ok') { st.scripts.saved += 1; push(st.recentEvents, { ts, text: `saved skill ${input.name}` }, RECENT_EVENTS); }
    if (rec.name === 'logoff') st.ended = { ts, reason: input.reason ?? 'logoff' };
  }

  _applyUserMsg(st, rec, ts) {
    const texts = (Array.isArray(rec.content) ? rec.content : []).filter((b) => b?.type === 'text').map((b) => String(b.text ?? ''));
    for (const text of texts) {
      if (/YOU DIED/.test(text)) { st.deaths += 1; const m = /YOU DIED[^\n]*/.exec(text); push(st.recentEvents, { ts, text: (m?.[0] ?? 'died').slice(0, 120) }, RECENT_EVENTS); }
      if (!st.focus) {
        const m = /Your focus card from last time[^:]*: ([^\n]+)/.exec(text);
        if (m) { st.focus = m[1].trim(); st.focusAt = null; }
      }
      // The login bootstrap restates faction and home from earlier sessions.
      let m;
      if ((m = /You are in the faction (\w+)/.exec(text))) st.faction = m[1];
      if ((m = /Your home \(([^)]*)\) is at (-?\d+),(-?\d+),(-?\d+)/.exec(text))) st.home = { x: Number(m[2]), y: Number(m[3]), z: Number(m[4]), blueprint: m[1] };
      const evBlock = /\[events\]\n([\s\S]*?)(?:\n\[|$)/.exec(text);
      if (evBlock) {
        for (const raw of evBlock[1].split('\n')) {
          const line = raw.replace(/^- /, '').trim();
          if (!line) continue;
          let m;
          if ((m = /^chat: <([^>]+)> (.*)$/.exec(line))) { push(st.recentChat, { ts, dir: 'in', from: m[1], text: m[2] }, RECENT_CHAT); continue; }
          if ((m = /^whisper from ([^:]+): (.*)$/.exec(line))) { push(st.recentChat, { ts, dir: 'in', from: m[1], to: st.username, text: m[2] }, RECENT_CHAT); continue; }
          if (/^(player |joined: |left: |\d+ other chat)/.test(line)) continue;   // noise
          if (/^(damage|faction|dusk|dawn|job |hungry|LOW HP)/.test(line)) push(st.recentEvents, { ts, text: line.slice(0, 120) }, RECENT_EVENTS);
        }
      }
    }
  }

  /** Dollars spent by every session (any bot) that started or was written within `sinceMs`. */
  usdSince(sinceTs) {
    let total = 0;
    let dirs = [];
    try { dirs = fs.readdirSync(this.sessionsDir); } catch { return 0; }
    for (const user of dirs) {
      const dir = path.join(this.sessionsDir, user);
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const file = path.join(dir, f);
        let stat;
        try { stat = fs.statSync(file); } catch { continue; }
        const startedAt = sessionStartFromName(f) ?? stat.mtimeMs;
        if (stat.mtimeMs < sinceTs && startedAt < sinceTs) continue;
        const cached = this._usdCache.get(file);
        if (cached && cached.size === stat.size) { total += cached.usd; continue; }
        const usd = readSessionUsd(file, stat.size);
        this._usdCache.set(file, { size: stat.size, usd });
        total += usd;
      }
    }
    return Math.round(total * 1000) / 1000;
  }

  /** Sum over the bots being tracked right now (current sessions only). */
  fleetTotals() {
    const t = { bots: 0, online: 0, usd: 0, usdAll: 0, turns: 0, toolCalls: 0, deaths: 0, scripts: 0 };
    for (const st of this.bots.values()) {
      t.bots += 1;
      t.usd += st.usd; t.usdAll += st.usd + st.pastUsd; t.turns += st.turns; t.toolCalls += st.toolCalls; t.deaths += st.deaths; t.scripts += st.scripts.run + st.scripts.used;
    }
    t.usd = Math.round(t.usd * 1000) / 1000; t.usdAll = Math.round(t.usdAll * 1000) / 1000;
    return t;
  }

  /** The bot's own written goals: plans.md (head) and journal.md (tail). Cached by mtime. */
  goals(username, { planLines = 14, journalLines = 6 } = {}) {
    if (!this.memoryDir) return { plans: [], journal: [] };
    const read = (name, fromEnd, n) => {
      const file = path.join(this.memoryDir, username, name);
      let stat;
      try { stat = fs.statSync(file); } catch { return []; }
      const key = `${file}:${n}:${fromEnd}`;
      const cached = this._goalsCache.get(key);
      if (cached && cached.mtime === stat.mtimeMs) return cached.lines;
      let lines = [];
      try {
        const all = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
        lines = fromEnd ? all.slice(-n) : all.slice(0, n);
      } catch { lines = []; }
      this._goalsCache.set(key, { mtime: stat.mtimeMs, lines });
      return lines;
    };
    return { plans: read('plans.md', false, planLines), journal: read('journal.md', true, journalLines) };
  }

  /** A JSON-safe snapshot for data/fleet_status.json. */
  snapshot() {
    const bots = {};
    for (const [u, st] of this.bots) {
      bots[u] = {
        session: st.session ? { file: path.basename(st.session.file), startedAt: st.session.startedAt, model: st.session.model, effort: st.session.effort } : null,
        usd: st.usd, pastUsd: st.pastUsd, turns: st.turns, toolCalls: st.toolCalls, toolsOk: st.toolsOk, toolsFailed: st.toolsFailed,
        interrupts: st.interrupts, deaths: st.deaths, scripts: st.scripts, focus: st.focus, faction: st.faction, home: st.home, money: st.money,
        lastTool: st.lastTool, lastThought: st.lastThought, lastTs: st.lastTs,
      };
    }
    return { at: new Date(this.clock()).toISOString(), totals: this.fleetTotals(), bots };
  }
}

function push(arr, item, max) { arr.push(item); if (arr.length > max) arr.splice(0, arr.length - max); }

/** total_usd of the last turn line in a transcript, reading only its tail. */
function readSessionUsd(file, size) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return 0; }
  try {
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    const lines = text.split('\n').reverse();
    for (const line of lines) {
      if (!line.includes('"t":"turn"')) continue;
      try { const rec = JSON.parse(line); if (Number.isFinite(rec.total_usd)) return rec.total_usd; } catch {}
    }
    // The tail may not hold a turn line at all (a short session): scan the whole file if small.
    if (size > len) return 0;
    return 0;
  } catch { return 0; }
  finally { try { fs.closeSync(fd); } catch {} }
}
