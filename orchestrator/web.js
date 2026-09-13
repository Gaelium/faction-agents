#!/usr/bin/env node
/**
 * web.js — the browser dashboard: a small local HTTP server over the same
 * FleetTracker the terminal view uses.
 *
 *   inside the orchestrator:   started automatically (--web [port], --no-web)
 *   standalone, read-only:     node orchestrator/web.js [--port 4545] [--only a,b | --all]
 *                              (tails data/sessions for bots started any other way;
 *                               by default those written to in the last 24 h)
 *
 * Binds to 127.0.0.1 only: it is a local tool with no authentication.
 *
 *   GET /               the page (orchestrator/web/index.html)
 *   GET /api/fleet      header, budget, one row per bot, chat, events, crashes, cost series
 *   GET /api/bot/<name> everything about one bot: focus, goals, journal, activity, thoughts, events, chat
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(__dirname, 'web', 'index.html');
const LIVE_MS = 90_000;
const CRASH_MAX = 8;
const CHAT_MAX = 30;

export class WebDashboard {
  constructor({ tracker, spawner = null, health = null, scheduler = null, getProfile = null, getBudget = null, orchestratorStart = Date.now(), log = null, extra = null }) {
    if (!tracker) throw new Error('WebDashboard requires tracker');
    this.tracker = tracker;
    this.spawner = spawner;
    this.health = health;
    this.scheduler = scheduler;
    this.getProfile = getProfile;
    this.getBudget = getBudget;
    this.orchestratorStart = orchestratorStart;
    this.log = log;
    this.extra = extra;          // () => object merged into /api/fleet (redis state, mode)
    this.chatFeed = [];
    this.crashFeed = [];
    this.redisOk = null;
    this.server = null;
    this.url = null;
    spawner?.on?.('exit', (user, info) => { if (info?.code !== 0 && !info?.killReason) this._crash({ user, code: info.code, signal: info.signal, retries: null }); });
    health?.on?.('crash', (user, info) => this._crash({ user, code: info.code, signal: info.signal, retries: info.crashes }));
  }

  setRedisOk(ok) { this.redisOk = !!ok; }

  recordChat({ sender, message, channel = 'global', ts = Date.now() }) {
    this.chatFeed.unshift({ ts, sender, message, channel });
    if (this.chatFeed.length > CHAT_MAX) this.chatFeed.length = CHAT_MAX;
  }

  _crash(c) {
    this.crashFeed = this.crashFeed.filter((x) => x.user !== c.user || Date.now() - x.ts > 500);
    this.crashFeed.unshift({ ts: Date.now(), ...c });
    if (this.crashFeed.length > CRASH_MAX) this.crashFeed.length = CRASH_MAX;
  }

  _roster() {
    const online = this.spawner?.onlineUsernames?.().sort() ?? [];
    const tracked = this.tracker.tracked().filter((u) => !online.includes(u)).sort();
    return [...online, ...tracked];
  }

  _row(user, now) {
    const rec = this.spawner?.getRecord?.(user) ?? null;
    const st = this.tracker.botState(user);
    const p = rec?.profile ?? this.getProfile?.(user) ?? null;
    const online = !!rec;
    const live = !!st?.lastTs && now - st.lastTs < LIVE_MS;
    const startedAt = rec?.startedAt ?? st?.session?.startedAt ?? null;
    const endTs = online || live ? now : (st?.lastTs ?? now);
    const upMs = startedAt ? Math.max(0, endTs - startedAt) : 0;
    const hours = Math.max(upMs / 3_600_000, 1 / 60);
    return {
      user, online, live, archetype: p?.archetype ?? st?.session?.archetype ?? null, tier: p?.skill_tier ?? null,
      faction: st?.faction ?? null, home: st?.home ?? null, money: st?.money ?? null,
      startedAt, upMs, model: st?.session?.model ?? null, effort: st?.session?.effort ?? null,
      usd: st?.usd ?? 0, pastUsd: st?.pastUsd ?? 0, usdPerH: st ? st.usd / hours : 0, turns: st?.turns ?? 0, turnsPerH: st ? st.turns / hours : 0,
      tools: st?.toolCalls ?? 0, toolsOk: st?.toolsOk ?? 0, toolsFailed: st?.toolsFailed ?? 0, interrupts: st?.interrupts ?? 0,
      deaths: st?.deaths ?? 0, scripts: st?.scripts ?? { run: 0, ok: 0, saved: 0, used: 0 }, contextEdits: st?.contextEdits ?? 0, sessions: st?.sessions ?? 0,
      lastTool: st?.lastTool ?? null, lastThought: st?.lastThought ?? null, lastTs: st?.lastTs ?? null,
      focus: st?.focus ?? null, focusAt: st?.focusAt ?? null,
      series: (st?.series ?? []).map(([ts, usd, turns]) => [ts, usd, turns]),
    };
  }

  fleet() {
    const now = Date.now();
    const names = this._roster();
    const rows = names.map((u) => this._row(u, now));
    const chat = [...this.chatFeed.map((m) => ({ ts: m.ts, from: m.sender, text: m.message, channel: m.channel, dir: 'relay' }))];
    for (const r of rows) for (const c of this.tracker.botState(r.user)?.recentChat ?? []) if (c.dir === 'out') chat.push({ ts: c.ts, from: c.from, text: c.text, channel: c.to === 'public' ? 'global' : 'private', dir: 'out' });
    const seen = new Set();
    const mergedChat = chat.sort((a, b) => b.ts - a.ts).filter((m) => { const k = `${m.from}|${m.text}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, CHAT_MAX);
    const events = [];
    for (const r of rows) for (const e of this.tracker.botState(r.user)?.recentEvents ?? []) events.push({ ...e, user: r.user });
    events.sort((a, b) => b.ts - a.ts);
    const totals = this.tracker.fleetTotals();
    const hours = Math.max((now - this.orchestratorStart) / 3_600_000, 1 / 60);
    return {
      at: now, orchestratorStart: this.orchestratorStart, mode: this.spawner ? 'orchestrator' : 'standalone',
      online: this.spawner?.onlineCount?.() ?? rows.filter((r) => r.live).length,
      target: this.scheduler ? [this.scheduler.min, this.scheduler.max] : null,
      redis: this.redisOk,
      totals: { ...totals, usdPerH: totals.usd / hours },
      budget: this.getBudget?.() ?? null,
      bots: rows, chat: mergedChat, events: events.slice(0, 40), crashes: this.crashFeed,
      series: this.tracker.series.map(([ts, usd]) => [ts, usd]),
      ...(this.extra?.() ?? {}),
    };
  }

  bot(user) {
    const st = this.tracker.botState(user);
    if (!st) return null;
    const row = this._row(user, Date.now());
    return {
      ...row,
      session: st.session ? { file: path.basename(st.session.file), startedAt: st.session.startedAt, model: st.session.model, effort: st.session.effort, spawn: st.session.spawn } : null,
      goals: this.tracker.goals(user, { planLines: 40, journalLines: 12 }),
      recentTools: st.recentTools, recentThoughts: st.recentThoughts, recentEvents: st.recentEvents, recentChat: st.recentChat,
      profile: row.archetype ? { archetype: row.archetype, tier: row.tier } : null,
    };
  }

  start({ port = 4545, host = '127.0.0.1' } = {}) {
    if (this.server) return Promise.resolve(this.url);
    let page = null;
    const loadPage = () => { try { page = fs.readFileSync(PAGE, 'utf8'); } catch (e) { page = `<!doctype html><title>dashboard</title><pre>page missing: ${e.message}</pre>`; } return page; };
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const send = (code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
      try {
        if (url.pathname === '/' || url.pathname === '/index.html') return send(200, process.env.FLEET_WEB_DEV ? loadPage() : (page ?? loadPage()), 'text/html; charset=utf-8');
        if (url.pathname === '/api/fleet') return send(200, JSON.stringify(this.fleet()));
        const m = /^\/api\/bot\/([A-Za-z0-9_]{1,32})$/.exec(url.pathname);
        if (m) { const b = this.bot(m[1]); return b ? send(200, JSON.stringify(b)) : send(404, JSON.stringify({ error: 'unknown bot' })); }
        return send(404, JSON.stringify({ error: 'not found' }));
      } catch (e) {
        this.log?.warn?.('web_request_failed', { path: url.pathname, msg: e.message });
        return send(500, JSON.stringify({ error: e.message }));
      }
    });
    return new Promise((resolve, reject) => {
      this.server.once('error', (e) => { this.log?.warn?.('web_listen_failed', { port, msg: e.message }); this.server = null; reject(e); });
      this.server.listen(port, host, () => {
        const actual = this.server.address().port;
        this.url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${actual}`;
        this.log?.info?.('web_dashboard_up', { url: this.url });
        this.server.unref?.();
        resolve(this.url);
      });
    });
  }

  close() { return new Promise((resolve) => { if (!this.server) return resolve(); this.server.close(() => resolve()); this.server = null; }); }
}

// ---------- standalone: read-only over data/sessions ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { FleetTracker } = await import('./tracker.js');
  const PROJECT_ROOT = path.resolve(__dirname, '..');
  const argv = process.argv.slice(2);
  const port = Number(argv[argv.indexOf('--port') + 1]) || Number(process.env.FLEET_WEB_PORT) || 4545;
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? String(argv[onlyIdx + 1] ?? '').split(',').filter(Boolean) : null;
  const all = argv.includes('--all');
  const sessionsDir = path.join(PROJECT_ROOT, 'data', 'sessions');
  const tracker = new FleetTracker({ sessionsDir, memoryDir: path.join(PROJECT_ROOT, 'data', 'memory') });
  // Default roster: bots with a transcript written in the last 24 h (--all for every directory).
  const names = only ?? (() => {
    try {
      return fs.readdirSync(sessionsDir).filter((d) => {
        const dir = path.join(sessionsDir, d);
        if (!fs.statSync(dir).isDirectory()) return false;
        if (all) return true;
        const newest = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().pop();
        return !!newest && Date.now() - fs.statSync(path.join(dir, newest)).mtimeMs < 24 * 3_600_000;
      });
    } catch { return []; }
  })();
  for (const n of names) tracker.track(n);
  tracker.tick(); tracker._sample(true);
  // Rates are measured from the earliest tracked session, not from this process's start.
  const starts = names.map((n) => tracker.botState(n)?.session?.startedAt).filter(Number.isFinite);
  const orchestratorStart = starts.length ? Math.min(...starts) : Date.now();
  const web = new WebDashboard({ tracker, orchestratorStart, extra: () => ({ note: 'standalone: reading transcripts only; active means written to in the last 90 s' }) });
  const url = await web.start({ port });
  console.log(`fleet web dashboard (read-only) at ${url} — tracking ${names.length} bot(s): ${names.join(', ') || '(none)'}`);
  setInterval(() => tracker.tick(), 2500);
  process.on('SIGINT', async () => { await web.close(); process.exit(0); });
}
