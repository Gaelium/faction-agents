#!/usr/bin/env node
/**
 * main.js — boot one bot on the agent loop.
 *
 *   node --env-file=.env bots/agent/main.js <profile>
 *
 * Env: LLM_MODEL (default claude-opus-5), AGENT_EFFORT (medium),
 *      AGENT_MAX_USD (5), AGENT_MAX_TURNS (600), AGENT_CONTEXT_EDIT (1),
 *      MC_SERVER_DIR (default <repo>/server: protection zones, sell prices, faction rules).
 *
 * Boot: profile → zones → bus → bot → spawn → /kit starter → wear armor →
 * senses + hands + nerves → one continuous agent loop until logoff,
 * disconnect, budget, or SIGINT.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import collectBlockPkg from 'mineflayer-collectblock';
import { loader as autoEatLoader } from 'mineflayer-auto-eat';
import armorManager from 'mineflayer-armor-manager';

import { loadProfile } from '../core/profileLoader.js';
import { createBot } from '../core/bot.js';
import { EventBus } from '../core/eventBus.js';
import { createLogger } from '../core/logger.js';
import { loadServerZones, isInProtectedZone } from '../world/zones.js';
import { Movement } from '../world/movement.js';
import { Perception } from '../world/perception.js';
import { Combat } from '../world/combat.js';
import { Memory } from '../social/memory.js';
import { VoiceFilter } from '../social/voiceFilter.js';
import { Factions } from '../world/factions.js';
import { attachEconomyChat } from '../social/economyChat.js';
import { BlueprintRegistry, BlueprintBuilder } from '../building/index.js';

import { Nerves } from './nerves.js';
import { ModelClient } from './model.js';
import { Transcript } from './transcript.js';
import { AgentLoop } from './loop.js';
import { buildSystemPrompt } from './prompt.js';
import { createTools } from './tools/index.js';
import { botBearing, bearingToCompass } from './tools/move.js';
import { readJournal, appendJournal } from './tools/mind.js';
import { groupInventory } from './tools/perceive.js';
import { registerBaseCells, refreshHomeCells, rotationTowardSpawn } from './tools/build.js';
import { wrapMovementWithDoor } from './tools/door.js';
import { loadFactionRules } from './factionRules.js';
import { SkillStore, shutdownScriptHost } from './skills.js';
import { installDoorPhysics } from '../core/doorPhysics.js';
import { MemoryStore } from './memoryTool.js';
import { loadPrices } from './prices.js';

const name = process.argv[2];
if (!name) { console.error('usage: node --env-file=.env bots/agent/main.js <profile>'); process.exit(1); }

const profile = loadProfile(name);
const log = createLogger(profile.username);
log.info('agent_boot', { archetype: profile.archetype, model: process.env.AGENT_MODEL ?? process.env.LLM_MODEL ?? 'claude-opus-5' });

let prices;
let factionRules;
{
  const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const serverDir = process.env.MC_SERVER_DIR ?? path.join(repoRoot, 'server');
  loadServerZones({ serverDir, log });
  prices = loadPrices({ serverDir, log });
  factionRules = loadFactionRules({ serverDir, log });
}

// Model first: fail fast on a missing key before touching the server.
const model = new ModelClient({ log });
// The strategist: a slower, stronger pass used by the `think` tool. Shares
// the session's dollar total so the budget guard sees both.
const strategist = new ModelClient({
  log, model: process.env.AGENT_STRATEGIST_MODEL ?? 'claude-opus-5', effort: process.env.AGENT_STRATEGIST_EFFORT ?? 'high',
  maxTokens: 2500, contextEditing: false, compaction: false, memoryTool: false,
});
strategist.totals = model.totals;

const bus = new EventBus({
  host: profile.redis.host, port: profile.redis.port, password: profile.redis.password,
  db: profile.redis.db, channels: profile.redis.channels, logger: log,
});
let busUp = false;
try { await bus.start(); busUp = true; } catch (e) { log.warn('bus_start_failed', { msg: e.message }); }

const bot = createBot(profile);
// 1.8 collision data says an open door is still a wall; the server disagrees.
// (Installs itself once mineflayer's plugins have injected.)
installDoorPhysics(bot, { log });
try { bot.loadPlugin(collectBlockPkg?.plugin ?? collectBlockPkg); } catch (e) { log.warn('collectblock_load_failed', { msg: e.message }); }

const memory = new Memory(profile.username);
const voice = new VoiceFilter(profile);
const state = { focus: null, home: null, lastBuild: null, stop: null, spawn: profile.spawn, mood: 'neutral', jobs: new Map(), lastThinkAt: null };
// Faction state (own faction, allies, enemies, balance tally) persists in the
// same SQLite KV. The old autonomous behaviors (auto-found timer, auto-join
// on parsed invites, loyalty/betrayal checks) are NOT started: attach() is
// never called. Only the bus-driven state tracking is wired below.
const factions = new Factions({ profile, memory, log });
state.faction = factions.state.ourFaction ?? null;
if (busUp) { factions.bus = bus; try { factions._wireBus(bus); } catch (e) { log.warn('factions_wire_failed', { msg: e.message }); } }
// Parse /sell, /balance and /baltop replies into the faction balance tally.
let detachEconomy = null;
try { detachEconomy = attachEconomyChat({ bot, bus: busUp ? bus : null, factions, worldModel: null, profile, log }); } catch (e) { log.warn('economy_chat_failed', { msg: e.message }); }
// A house built in an earlier session is still home. Movement re-arms the
// wall protection from the same SQLite KV on its first pathfind.
try {
  const saved = memory.kvGet('agent_home', null);
  if (saved && Number.isFinite(saved.x)) { state.home = saved; log.info('agent_home_loaded', { home: saved }); }
  const focus = memory.kvGet('agent_focus', null);
  if (focus?.text) { state.focus = focus.text; state.focusSetAt = focus.ts ?? null; log.info('agent_focus_loaded', { focus: focus.text.slice(0, 120) }); }
} catch {}
const memoryStore = new MemoryStore(profile.username);
const skillStore = new SkillStore({ log });
let loop = null;
let nerves = null;
let transcript = null;

bot.on('login', () => log.info('mc_login'));
bot.on('kicked', (r) => log.warn('mc_kicked', { reason: String(r) }));
bot.on('error', (e) => log.warn('mc_error', { msg: e?.message }));
bot.on('end', (reason) => {
  log.info('mc_end', { reason });
  if (loop && !loop.stopReason) loop.stop(`disconnected:${reason}`);
  else if (!loop) setTimeout(() => process.exit(1), 200);
});

// Respawn watchdog: mineflayer's respawn:true handles the common case;
// retry explicitly if the bot sits on the death screen.
let diedAt = 0;
bot.on('death', () => { diedAt = Date.now(); log.info('agent_died', { pos: bot.entity?.position ?? null }); });
bot.on('spawn', () => { if (diedAt) { log.info('agent_respawned', { after_ms: Date.now() - diedAt }); diedAt = 0; } });
const respawnTimer = setInterval(() => {
  if (!diedAt) return;
  const since = Date.now() - diedAt;
  if (since > 3000 && since < 3600) { try { bot.respawn(); } catch {} }
  if (since > 8000 && since < 8600) { try { bot._client.write('client_command', { payload: 0 }); } catch {} }
  if (since > 15000 && since < 15600) { try { bot.chat('/respawn'); } catch {} }
}, 500);
respawnTimer.unref?.();

bot.once('spawn', async () => {
  try {
    await sleep(1500);
    const actualSpawn = bot.entity?.position && Number.isFinite(bot.entity.position.x)
      ? { x: Math.round(bot.entity.position.x), y: Math.round(bot.entity.position.y), z: Math.round(bot.entity.position.z) }
      : profile.spawn;
    state.spawn = actualSpawn;
    log.info('agent_spawned', { pos: actualSpawn, hp: bot.health, food: bot.food, in_protection: isInProtectedZone(actualSpawn) });
    if (busUp) { try { await bus.publishCommand({ type: 'give_event_subscription', bot: profile.username }); } catch {} }

    // Reflex plugins: hunger and armor are handled below the brain.
    try {
      bot.loadPlugin(autoEatLoader);
      bot.autoEat.setOpts({ priority: 'foodPoints', minHealth: 14, minHunger: 15, bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato'], offhand: false });
      bot.autoEat.enableAuto();
    } catch (e) { log.warn('autoeat_setup_failed', { msg: e.message }); }
    try { bot.loadPlugin(armorManager); } catch (e) { log.warn('armor_manager_failed', { msg: e.message }); }

    bot.sayLine('/kit starter');
    await sleep(2500);
    try { bot.armorManager?.equipAll?.(); } catch {}

    const movement = new Movement(bot, { memory });
    // The pathfinder cannot pass a two-block door; door.js walks the bot
    // through its own front door whenever a goTo crosses the threshold.
    wrapMovementWithDoor(movement, { bot, state, log });
    const combat = new Combat(bot, { profile, log, movement, bus: busUp ? bus : null });
    const perception = new Perception(bot, { combat });
    const registry = new BlueprintRegistry({ log });
    const builder = new BlueprintBuilder({ bot, movement, log, profile, memory, worldModel: null });
    nerves = new Nerves({ bot, bus: busUp ? bus : null, log, username: profile.username });
    nerves.start();

    const deps = {
      bot, movement, combat, perception, registry, builder, memory, memoryStore, voice, profile, log, nerves, state,
      bus: busUp ? bus : null, factions, strategist, prices, factionRules, skillStore,
    };
    const tools = createTools(deps);

    // Re-arm wall protection for a home built in an earlier session when the
    // registry has no cells yet (a session that predates persistence, or a
    // wiped KV) and the house is close enough to be loaded.
    try {
      const h = state.home;
      const p = bot.entity?.position;
      if (h?.blueprint && p && movement.getBaseStructureCells().size === 0
          && Math.hypot(p.x - h.x, p.z - h.z) < 96) {
        const bp = registry.get(h.blueprint);
        if (bp) {
          const rotation = Number.isFinite(h.rotation) ? h.rotation : rotationTowardSpawn(h, state.spawn);
          const reg = registerBaseCells({ bot, builder, movement, blueprint: bp, anchor: { x: h.x, y: h.y, z: h.z }, rotation, log });
          log.info('agent_home_walls_rearmed', { ...reg, blueprint: h.blueprint });
        }
      }
    } catch (e) { log.debug?.('home_rearm_failed', { msg: e.message }); }
    // Homes saved before door.js existed lack the interior box; fill it in.
    try {
      if (state.home?.blueprint && !state.home.interior) {
        const fresh = refreshHomeCells({ builder, registry, home: state.home, spawn: state.spawn });
        if (fresh) { state.home = fresh; memory.kvSet('agent_home', fresh); log.info('agent_home_cells_refreshed', { door: fresh.door ?? null, inside: fresh.inside ?? null, interior: fresh.interior ?? null }); }
      }
    } catch (e) { log.debug?.('home_refresh_failed', { msg: e.message }); }
    transcript = new Transcript(profile.username);
    transcript.meta({ profile: profile.username, archetype: profile.archetype, model: model.model, effort: model.effort, spawn: actualSpawn, tools: tools.definitions.map((t) => t.name) });
    const system = buildSystemPrompt(profile, { pricesText: prices.known ? prices.summary() : null, factionRulesText: factionRules?.known ? factionRules.summary() : null });

    loop = new AgentLoop({ model, tools, nerves, bot, log, transcript, state, system });
    const bootstrap = buildBootstrap({ bot, profile, actualSpawn, memoryStore, skillStore });
    log.info('agent_loop_start', { transcript: transcript.filePath, tools: tools.definitions.length });
    const outcome = await loop.run(bootstrap);
    log.info('agent_loop_end', { ...outcome, ...transcript.summary(), nerves: nerves.stats, context_edits: loop.stats.contextEdits });
    await shutdown(outcome.reason);
  } catch (e) {
    log.error('agent_boot_failed', { msg: e?.message, stack: e?.stack?.split('\n').slice(0, 3).join(' | ') });
    await shutdown('boot_failed');
  }
});

function buildBootstrap({ bot, profile, actualSpawn, memoryStore, skillStore = null }) {
  const journal = readJournal(profile.username, 12);
  const { groups } = groupInventory(bot);
  const parts = [];
  parts.push(`You just logged in (${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC).`);
  if (state.focus) {
    const age = state.focusSetAt ? Math.round((Date.now() - state.focusSetAt) / 60000) : null;
    parts.push(`Your focus card from last time${age != null ? ` (${age} min ago)` : ''}: ${state.focus}`);
  }
  parts.push(journal.length ? `Your journal (latest last):\n${journal.join('\n')}` : 'Your journal is empty: this is your first session on this server.');
  const files = memoryStore?.list?.() ?? [];
  const others = files.filter((f) => !/\/journal\.md$/.test(f.path));
  parts.push(others.length
    ? `Your memory files (memory tool): ${others.map((f) => `${f.path} (${f.bytes} B)`).join(', ')}. Read the ones that matter before you decide.`
    : 'No memory files yet besides the journal. Create /memories/plans.md, places.md and people.md as you learn things.');
  parts.push(`Inventory: ${JSON.stringify(groups)}`);
  parts.push(`Spawn is at ${actualSpawn.x},${actualSpawn.y},${actualSpawn.z}${isInProtectedZone(actualSpawn) ? ' (inside protection)' : ''}. Your side of spawn is roughly ${bearingToCompass(botBearing(profile.username))}: leave_spawn already heads out on your exact bearing (call it without direction), and other bots leave on other sides, so build and gather there unless you have a reason to go elsewhere.`);
  if (state.home) parts.push(`Your home (${state.home.blueprint ?? 'base'}) is at ${state.home.x},${state.home.y},${state.home.z}${state.home.chest ? `, chest at ${state.home.chest.x},${state.home.chest.y},${state.home.chest.z}` : ''}; goto named home walks you inside.`);
  if (state.faction) parts.push(`You are in the faction ${state.faction}. Read faction_notes when you have a moment.`);
  parts.push(`Money: about $${Math.round(factions.getBalance())} last time you checked (board gives the true figure).`);
  try {
    const saved = skillStore?.list?.() ?? [];
    if (saved.length) parts.push(`Saved skills every bot shares (skills lists them, use_skill runs one): ${saved.slice(0, 12).map((m) => `${m.name}${m.ok ? ` (worked ${m.ok}×)` : ''}`).join(', ')}.`);
  } catch {}
  parts.push(state.focus ? 'Pick up where you left off unless the situation changed. Look around first.' : 'Start by looking around, then set a focus card and get going.');
  return parts.join('\n\n');
}

let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('agent_shutdown', { reason });
  try { nerves?.stop(); } catch {}
  try { detachEconomy?.(); } catch {}
  try { factions.shutdown(); } catch {}
  try { clearInterval(respawnTimer); } catch {}
  try { await shutdownScriptHost(); } catch {}
  if (loop && !/^logoff/.test(String(reason))) {
    try { appendJournal(profile.username, `session ended (${reason})${state.focus ? ` | focus: ${state.focus}` : ''}`); } catch {}
  }
  try { await transcript?.close(); } catch {}
  try { bot.quit('agent_shutdown'); } catch {}
  try { await bus.stop(); } catch {}
  try { memory.close(); } catch {}
  await log.close();
  process.exit(/^(logoff|max_turns|budget)/.test(String(reason)) ? 0 : 1);
}

process.on('SIGINT', () => { if (loop) loop.stop('sigint'); else shutdown('sigint'); });
process.on('SIGTERM', () => { if (loop) loop.stop('sigterm'); else shutdown('sigterm'); });
process.on('uncaughtException', (err) => log.error('uncaught_exception', { msg: err?.message, stack: err?.stack?.split('\n')[1] ?? '' }));
process.on('unhandledRejection', (err) => log.warn('unhandled_rejection', { msg: err?.message ?? String(err) }));

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
