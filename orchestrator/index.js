#!/usr/bin/env node
/**
 * Orchestrator entry point.
 *
 *   node orchestrator/index.js               # run the full show (6-12 of every profile, by schedule)
 *   node orchestrator/index.js --only Rook_Vantis,oatmeal_ollie,TestBot44 --budget 15
 *                                            # a fixed roster kept online, $15 per rolling 24 h
 *   node orchestrator/index.js --dry         # plan + dashboard but never spawn
 *   node orchestrator/index.js --once        # evaluate once, print the plan, exit
 *   node orchestrator/index.js --no-dashboard
 *
 * Options (see args.js): --only, --respect-schedule, --target n[,m], --budget usd,
 * --budget-action pause|kill, --session min,max, --no-status-json.
 * Env: FLEET_MAX_USD_PER_DAY, FLEET_BUDGET_ACTION, plus everything the bots read
 * (AGENT_MODEL, AGENT_MAX_USD, …) which is inherited by each bot process.
 *
 * Wires:
 *   Scheduler → Spawner → HealthMonitor → Dashboard
 *   FleetTracker tails data/sessions/<bot>/*.jsonl for cost, tools, focus, events
 *   optional Redis subscriber → chat feed in Dashboard
 *   data/fleet_status.json rewritten every tick
 *
 * Reads profiles from bots/profiles/. Ticks every TICK_MS.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { listProfileNames, loadProfile } from '../bots/core/profileLoader.js';
import { Scheduler }     from './scheduler.js';
import { Spawner }       from './spawner.js';
import { HealthMonitor } from './health.js';
import { Dashboard }     from './dashboard.js';
import { FleetTracker }  from './tracker.js';
import { WebDashboard }  from './web.js';
import { parseArgs, applyRoster } from './args.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ORCH_LOG = path.join(PROJECT_ROOT, 'data', 'logs', 'orchestrator.log');
const SESSIONS_DIR = path.join(PROJECT_ROOT, 'data', 'sessions');
const MEMORY_DIR = path.join(PROJECT_ROOT, 'data', 'memory');
const STATUS_JSON = path.join(PROJECT_ROOT, 'data', 'fleet_status.json');

const TICK_MS = 15_000;
const TRACK_MS = 2_500;
const DAY_MS = 24 * 3_600_000;

// ---------- minimal logger for the orchestrator itself ----------
function makeLogger() {
  fs.mkdirSync(path.dirname(ORCH_LOG), { recursive: true });
  const stream = fs.createWriteStream(ORCH_LOG, { flags: 'a' });
  const write = (level, event, fields) => {
    const line = { ts: new Date().toISOString(), level, event, ...(fields ?? {}) };
    stream.write(JSON.stringify(line) + '\n');
  };
  return {
    debug: (e, f) => write('debug', e, f),
    info:  (e, f) => write('info',  e, f),
    warn:  (e, f) => write('warn',  e, f),
    error: (e, f) => write('error', e, f),
  };
}

// ---------- args ----------
const opts = parseArgs(process.argv.slice(2), process.env);
const DRY = opts.dry;
const ONCE = opts.once;
const NO_DASHBOARD = opts.noDashboard;

// ---------- load profiles ----------
const log = makeLogger();
const names = listProfileNames();
if (names.length === 0) {
  console.error('no profiles found under bots/profiles/');
  process.exit(1);
}
const loaded = [];
for (const n of names) {
  try { loaded.push(loadProfile(n)); }
  catch (e) { log.warn('profile_load_failed', { name: n, msg: e.message }); }
}
const { profiles, target: TARGET } = applyRoster(loaded, opts);
if (opts.only?.length && profiles.length !== opts.only.length) {
  const missing = opts.only.filter((n) => !profiles.some((p) => p.username.toLowerCase() === n.toLowerCase()));
  if (missing.length) { console.error(`unknown profiles in --only: ${missing.join(', ')}`); process.exit(1); }
}
if (!profiles.length) { console.error('no profiles selected'); process.exit(1); }
const byName = new Map(profiles.map((p) => [p.username, p]));
log.info('profiles_loaded', { count: profiles.length, roster: opts.only ?? null, target: TARGET, budget: opts.budget ?? null, session: opts.session ?? null });

// ---------- wire ----------
const scheduler = new Scheduler({ profiles, target: TARGET, log });
const spawner   = new Spawner({ env: process.env, log });
const health    = new HealthMonitor({ spawner, profilesByName: byName, log });
const tracker   = new FleetTracker({ sessionsDir: SESSIONS_DIR, memoryDir: MEMORY_DIR, log });
for (const p of profiles) tracker.track(p.username);   // offline bots still show their last session
const orchestratorStart = Date.now();
const budget = { perDay: opts.budget, action: opts.budgetAction, spent24h: 0, projectedPerDay: null, paused: false, pausedAt: null };
function refreshBudget() {
  const now = Date.now();
  budget.spent24h = tracker.usdSince(now - DAY_MS);
  const hours = (now - orchestratorStart) / 3_600_000;
  const session = tracker.fleetTotals().usd;
  budget.projectedPerDay = hours >= 0.1 ? (session / hours) * 24 : null;
  const over = !!budget.perDay && budget.spent24h >= budget.perDay;
  if (over && !budget.paused) {
    budget.paused = true; budget.pausedAt = now;
    log.warn('budget_ceiling', { spent_24h: budget.spent24h, per_day: budget.perDay, action: budget.action });
    if (budget.action === 'kill' && !DRY) spawner.killAll('budget');
  } else if (!over && budget.paused) {
    budget.paused = false; budget.pausedAt = null;
    log.info('budget_resumed', { spent_24h: budget.spent24h, per_day: budget.perDay });
  }
  return budget;
}
// The browser dashboard: same data, plus the cost chart and a zoomable bot
// page. Started before the terminal view so its URL can sit in the header.
const web = opts.web && !ONCE ? new WebDashboard({
  spawner, health, scheduler, tracker,
  getProfile: (u) => byName.get(u) ?? null,
  getBudget: () => budget,
  orchestratorStart, log,
}) : null;
let webUrl = null;
if (web) {
  try { webUrl = await web.start({ port: opts.web }); }
  catch (e) { log.warn('web_dashboard_failed', { port: opts.web, msg: e.message }); }
}
const dashboard = NO_DASHBOARD ? null : new Dashboard({
  spawner, health, scheduler, tracker,
  getProfile: (u) => byName.get(u) ?? null,
  getBudget: () => budget,
  orchestratorStart, webUrl,
});
dashboard?.on('quit', () => shutdown('quit'));
const botModel = process.env.AGENT_MODEL ?? process.env.LLM_MODEL ?? 'claude-opus-5';
const botModelSource = process.env.AGENT_MODEL ? 'AGENT_MODEL' : (process.env.LLM_MODEL ? 'LLM_MODEL, the older name; set AGENT_MODEL to change it' : 'default');
log.info('fleet_model', { model: botModel, source: botModelSource });
if (NO_DASHBOARD) console.log(`bots run on ${botModel} (${botModelSource})`);
if (NO_DASHBOARD && webUrl) console.log(`fleet web dashboard at ${webUrl}`);

function writeStatus() {
  if (!opts.statusJson) return;
  try {
    const snap = tracker.snapshot();
    snap.online = spawner.onlineUsernames();
    snap.target = TARGET;
    snap.budget = { ...budget };
    snap.orchestratorStart = orchestratorStart;
    fs.writeFileSync(STATUS_JSON, JSON.stringify(snap, null, 2));
  } catch (e) { log.debug('status_json_failed', { msg: e.message }); }
}

// ---------- optional Redis subscriber (chat feed) ----------
let redisClient = null;
if ((!NO_DASHBOARD || web) && !DRY) {
  tryConnectRedis().catch((e) => log.warn('redis_sub_failed', { msg: e.message }));
}

// ioredis resolves from the root package.json; loaded lazily so a dry run or
// a dashboard-less run never opens a socket.
async function tryConnectRedis() {
  const { default: Redis } = await import('ioredis');
  redisClient = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    lazyConnect: true,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(30_000, 1000 * times),
  });
  const setRedis = (ok) => { dashboard?.setRedisOk(ok); web?.setRedisOk(ok); };
  redisClient.on('ready', () => setRedis(true));
  redisClient.on('end',   () => setRedis(false));
  redisClient.on('error', () => setRedis(false));
  redisClient.on('message', (channel, msg) => {
    if (channel !== 'mc:events') return;
    let parsed;
    try { parsed = JSON.parse(msg); } catch { return; }
    if (parsed?.event === 'chat_message' && parsed.sender) {
      const line = { sender: parsed.sender, message: parsed.message ?? '', channel: parsed.channel ?? 'global', ts: parsed.ts ?? Date.now() };
      dashboard?.recordChat(line);
      web?.recordChat(line);
    }
  });
  await redisClient.connect();
  await redisClient.subscribe('mc:events');
  log.info('redis_subscribed', { channel: 'mc:events' });
}

// Declared early so tick()'s deferred setTimeout callbacks can see it.
let shuttingDown = false;

// ---------- tick ----------
// Stagger spawns so Minecraft's connection-throttle (and our own SQLite /
// LLM startup cost) doesn't get a 6-at-once burst. Paper's default
// connection-throttle is 4s, so 2s per spawn is the safe ceiling — we go
// a bit lower so a whole refill finishes in reasonable time.
const SPAWN_STAGGER_MS = 1500;

function tick() {
  tracker.tick();
  refreshBudget();
  const onlineSet = new Set(spawner.onlineUsernames());
  const plan = scheduler.evaluate({ onlineSet });
  log.info('tick', {
    online: onlineSet.size,
    toSpawn: plan.toSpawn.map((p) => p.username),
    toKill: plan.toKill.map((p) => p.username),
    usd_session: tracker.fleetTotals().usd, usd_24h: budget.spent24h, budget_paused: budget.paused,
  });
  writeStatus();
  if (DRY) return plan;

  for (const p of plan.toKill) {
    // Don't kill if health module has them in unhealthy cooldown — let
    // the backoff run its course.
    const s = health.statusOf(p.username);
    if (s.unhealthy) continue;
    spawner.kill(p.username, 'scheduled');
  }
  if (budget.paused) {
    if (plan.toSpawn.length) log.info('budget_pause_skip_spawn', { skipped: plan.toSpawn.map((p) => p.username) });
    return plan;
  }
  plan.toSpawn.forEach((p, i) => {
    const s = health.statusOf(p.username);
    if (s.unhealthy) return;
    setTimeout(() => {
      if (shuttingDown) return;
      if (!spawner.isOnline(p.username)) spawner.spawn(p);
    }, i * SPAWN_STAGGER_MS).unref?.();
  });
  return plan;
}

if (ONCE) {
  const plan = tick();
  console.log(JSON.stringify({
    online: spawner.onlineCount(),
    toSpawn: plan.toSpawn.map((p) => p.username),
    toKill:  plan.toKill.map((p) => p.username),
    keep:    plan.keep.map((p) => p.username),
  }, null, 2));
  process.exit(0);
}

dashboard?.start();
tick();
// The tracker polls transcripts more often than the scheduler ticks so the
// dashboard's activity column is live.
const trackTimer = setInterval(() => { tracker.tick(); }, TRACK_MS);
trackTimer.unref?.();
// Main tick interval — intentionally NOT unref'd. This is the
// orchestrator's heartbeat and the only ref'd handle keeping the loop
// alive. Every other timer (dashboard render, staggered spawn, session
// end, hard-exit fallback) is unref'd, so without this the process
// would exit before the first setTimeout(0) spawn can fire. Shutdown
// still terminates cleanly via clearInterval + explicit process.exit.
const tickTimer = setInterval(tick, TICK_MS);

// ---------- shutdown ----------
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown_begin', { signal: sig });
  clearInterval(tickTimer);
  clearInterval(trackTimer);
  dashboard?.stop();
  web?.close();
  writeStatus();
  spawner.killAll('shutdown');
  if (redisClient) { try { redisClient.disconnect(); } catch {} }
  // Give bots 12s to exit gracefully before our own exit.
  setTimeout(() => process.exit(0), 12_000).unref();
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
