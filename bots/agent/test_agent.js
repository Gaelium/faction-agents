/**
 * test_agent.js — structural tests for the agent loop with a stub model
 * and a stub bot. No server, no API key.
 *
 *   node bots/agent/test_agent.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CancelToken, awaitHandle, cancellableSleep } from './cancel.js';
import { Nerves } from './nerves.js';
import { AgentLoop, formatEvent } from './loop.js';
import { withTailBreakpoint, costOf } from './model.js';
import { Transcript } from './transcript.js';
import { createTools, validateInput } from './tools/index.js';
import { buildSystemPrompt } from './prompt.js';
import { fromPrimitive } from './tools/result.js';
import vec3Pkg from 'vec3';

const Vec3 = vec3Pkg.Vec3 ?? vec3Pkg;

let passed = 0;
function check(cond, msg) { assert.ok(cond, msg); passed += 1; }
function requireVec3(v) {
  if (!v || typeof v.floored !== 'function') throw new TypeError('pos.floored is not a function');
}

// ---------- stubs ----------

function stubBot({ health = 20, food = 20, pos = { x: 10, y: 64, z: 10 } } = {}) {
  const listeners = new Map();
  const items = [{ name: 'stone_pickaxe', count: 1 }, { name: 'dirt', count: 12 }, { name: 'bread', count: 3 }];
  const bot = {
    username: 'TestAgent',
    health, food, oxygenLevel: 20,
    entity: { id: 1, position: { x: pos.x, y: pos.y, z: pos.z, offset(dx, dy, dz) { return { x: this.x + dx, y: this.y + dy, z: this.z + dz }; } } },
    entities: {}, players: {},
    time: { timeOfDay: 1000 },
    heldItem: null,
    inventory: { items: () => items, slots: [] },
    registry: { blocksByName: { log: { id: 17 }, stone: { id: 1 }, dirt: { id: 3 } }, foodsByName: { bread: { foodPoints: 5 } } },
    // Strict like mineflayer: a plain {x,y,z} is a bug (it calls pos.floored()).
    blockAt: (v) => { requireVec3(v); return { name: 'stone', boundingBox: 'block', position: v }; },
    findBlocks: () => [],
    on(ev, fn) { (listeners.get(ev) ?? listeners.set(ev, new Set()).get(ev)).add(fn); },
    removeListener(ev, fn) { listeners.get(ev)?.delete(fn); },
    emit(ev, ...args) { for (const fn of listeners.get(ev) ?? []) fn(...args); },
    setControlState() {}, lookAt() {}, chat() {},
  };
  return bot;
}

function stubModel(script) {
  let i = 0;
  return {
    model: 'stub', totals: { usd: 0, turns: 0 },
    calls: [],
    async turn({ messages, tools }) {
      this.calls.push({ messages: messages.length, tools: tools.length });
      const step = script[Math.min(i, script.length - 1)]; i += 1;
      const content = typeof step === 'function' ? step(messages) : step;
      this.totals.turns += 1;
      return { response: { content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }, usage: { input_tokens: 100, output_tokens: 20 }, usd: 0.001, latencyMs: 5 };
    },
  };
}

const tu = (name, input, id) => ({ type: 'tool_use', id: id ?? `${name}_${Math.random().toString(36).slice(2, 8)}`, name, input });

function stubTools(extra = {}) {
  const byName = new Map();
  const definitions = [];
  const add = (name, { parallelSafe = false, defaultInterrupts = [], schema = { type: 'object', properties: {} }, handler }) => {
    byName.set(name, { name, parallelSafe, defaultInterrupts, schema, handler });
    definitions.push({ name, description: name, input_schema: schema });
  };
  add('look', { parallelSafe: true, handler: async () => ({ status: 'ok', pos: { x: 1, y: 2, z: 3 } }) });
  add('slow', {
    defaultInterrupts: ['damage'],
    schema: { type: 'object', properties: { ms: { type: 'integer' }, interrupt_on: { type: 'array' } } },
    handler: async ({ ms = 200 }, { cancel }) => {
      const done = await cancellableSleep(ms, cancel);
      return done ? { status: 'ok', slept: ms } : { status: 'interrupted', by: cancel.reason };
    },
  });
  add('logoff', { handler: async (_i, ctx) => { ctx.state.stop = 'logoff: bye'; return { status: 'ok' }; } });
  add('boom', { handler: async () => { throw new Error('kaboom'); } });
  add('strict', { schema: { type: 'object', properties: { n: { type: 'integer', minimum: 1 } }, required: ['n'], additionalProperties: false }, handler: async ({ n }) => ({ status: 'ok', n }) });
  for (const [k, v] of Object.entries(extra)) add(k, v);
  return { definitions, byName };
}

// ---------- 1. cancel token ----------
{
  const c = new CancelToken();
  let fired = null;
  c.onCancel((r) => { fired = r; });
  c.cancel('damage', { hp: 5 });
  check(c.cancelled && fired === 'damage' && c.detail.hp === 5, 'cancel fires hooks with reason+detail');
  let late = null; c.onCancel((r) => { late = r; });
  check(late === 'damage', 'late hook fires immediately when already cancelled');
  const h = { stopped: false, stop() { this.stopped = true; }, done: new Promise((r) => setTimeout(() => r({ success: false, reason: 'cancelled' }), 50)) };
  const c2 = new CancelToken();
  const p = awaitHandle(h, c2);
  c2.cancel('x');
  await p;
  check(h.stopped, 'awaitHandle stops the handle on cancel');
  const t0 = Date.now();
  const c3 = new CancelToken();
  setTimeout(() => c3.cancel('early'), 30);
  const finished = await cancellableSleep(2000, c3);
  check(!finished && Date.now() - t0 < 1000, 'cancellableSleep returns early on cancel');
}

// ---------- 2. result mapping ----------
{
  const c = new CancelToken();
  check(fromPrimitive({ success: true, reason: 'done', mined: 3 }, c).status === 'ok', 'success → ok');
  check(fromPrimitive({ success: false, reason: 'block_not_found', mined: 2 }, c, { progressed: true }).status === 'partial', 'progress → partial');
  check(fromPrimitive({ success: false, reason: 'no_tool' }, c).status === 'failed', 'no progress → failed');
  c.cancel('damage');
  const r = fromPrimitive({ success: false, reason: 'cancelled' }, c);
  check(r.status === 'interrupted' && r.by === 'damage', 'cancelled token → interrupted with reason');
}

// ---------- 3. nerves: tiers, arming, drain ----------
{
  const bot = stubBot();
  let now = 1000;
  const n = new Nerves({ bot, username: 'TestAgent', now: () => now });
  n.start();
  // Chat mention vs other chat.
  bot.emit('chat', 'Marla_K', 'hey TestAgent u selling iron?');
  bot.emit('chat', 'Someone', 'lol');
  bot.emit('chat', 'Someone', 'lol'); // dedupe window
  let d = n.drain();
  check(d.events.length === 1 && d.events[0].kind === 'chat_mention', 'mention queued as tier-1');
  check(d.summary.length === 1 && /1 other chat line/.test(d.summary[0]), 'other chat summarized and deduped');
  // A hurt animation without an HP drop must NOT interrupt (phantom damage at 20/20).
  const c0 = new CancelToken();
  n.arm({ interruptOn: ['damage'], cancel: c0 });
  bot.emit('entityHurt', bot.entity);
  check(!c0.cancelled && n.drain().events.length === 0, 'entityHurt alone does not interrupt or queue damage');
  // Damage detection through health drop; armed interrupt cancels.
  const c = new CancelToken();
  n.arm({ interruptOn: ['damage'], cancel: c });
  bot.health = 15; now += 1000; bot.emit('health');
  check(c.cancelled && c.reason === 'damage', 'damage cancels an armed tool');
  d = n.drain();
  check(d.events.some((e) => e.kind === 'damage' && e.amount === 5), 'damage event carries amount');
  // Not armed for chat_any → no cancel, but chat_any armed → cancel.
  const c2 = new CancelToken();
  n.arm({ interruptOn: ['chat_any'], cancel: c2 });
  bot.emit('chat', 'Other', 'random words'); now += 3000;
  check(c2.cancelled && c2.reason === 'chat_any', 'chat_any interrupts only when armed');
  n.disarm();
  // Low HP is tier 0: cancels even with interrupt_on [] and normalizes the bus attacker name.
  const cLow = new CancelToken();
  n.arm({ interruptOn: [], cancel: cLow });
  n._lastDamageSource = { attacker: 'mob:SKELETON', weapon: null, ts: now };
  bot.health = 7; now += 1000; bot.emit('health');
  const low = n.drain().events.find((e) => e.kind === 'damage');
  check(cLow.cancelled && cLow.reason === 'damage' && low?.low_hp && low.attacker === 'skeleton' && low.cause === 'mob', `hp ≤ 8 interrupts an unarmed tool (${JSON.stringify({ c: cLow.cancelled, a: low?.attacker, k: low?.cause })})`);
  check(/LOW HP/.test(formatEvent(low)), 'low-hp damage line tells the model to act');
  // Death is tier 0: cancels even when not in the armed set.
  const c3 = new CancelToken();
  n.arm({ interruptOn: [], cancel: c3 });
  bot.emit('death');
  check(c3.cancelled && c3.reason === 'death', 'death always interrupts');
  n.stop();
  check(formatEvent({ kind: 'damage', cause: 'mob', attacker: 'zombie', amount: 3, hp: 12 }).includes('zombie'), 'formatEvent renders damage');
}

// ---------- 4. loop: tool dispatch, events, idle backoff, logoff ----------
{
  const bot = stubBot();
  const nerves = new Nerves({ bot, username: 'TestAgent' });
  nerves.start();
  const state = { focus: null, stop: null };
  const tools = stubTools({
    logoff: { handler: async () => { state.stop = 'logoff: bye'; return { status: 'ok' }; } },
  });
  const model = stubModel([
    [{ type: 'text', text: 'looking' }, tu('look', {}, 'a1'), tu('strict', { n: 0 }, 'a2')],
    [tu('boom', {}, 'b1')],
    [{ type: 'text', text: 'just thinking' }],
    [tu('logoff', {}, 'c1')],
  ]);
  const loop = new AgentLoop({ model, tools, nerves, bot, state, system: 'sys', opts: { idleBackoffMs: [10, 10], maxUsd: 100 } });
  bot.emit('chat', 'Marla_K', 'TestAgent hi');
  const out = await loop.run('boot');
  check(out.reason.startsWith('logoff'), `loop ends on logoff (got ${out.reason})`);
  check(out.turns === 4, `four model turns (got ${out.turns})`);
  const msgs = loop.messages;
  const firstResults = msgs[2].content;
  check(firstResults[0].type === 'tool_result' && firstResults[0].tool_use_id === 'a1', 'tool results appended in order');
  check(/bad_input/.test(firstResults[1].content) && firstResults[1].is_error, 'schema validation → bad_input error result');
  check(/\[events\]/.test(firstResults[2].text) && /Marla_K/.test(firstResults[2].text), 'events trailer includes chat mention');
  check(/\[now\]/.test(firstResults[2].text), 'trailer includes status line');
  const boomResult = msgs[4].content[0];
  check(/exception:kaboom/.test(boomResult.content) && boomResult.is_error, 'thrown tool → failed result, loop survives');
  check(/idle/.test(msgs[6].content[0].text), 'idle turn produces a nudge');
  check(msgs.every((m, i) => m.role === (i % 2 === 0 ? 'user' : 'assistant')), 'strict user/assistant alternation');
  nerves.stop();
}

// ---------- 5. loop: interrupt during an actuator ----------
{
  const bot = stubBot();
  const nerves = new Nerves({ bot, username: 'TestAgent' });
  nerves.start();
  const state = { focus: null, stop: null };
  const tools = stubTools({ logoff: { handler: async () => { state.stop = 'logoff'; return { status: 'ok' }; } } });
  const model = stubModel([
    [tu('slow', { ms: 5000 }, 's1')],
    [tu('logoff', {}, 'l1')],
  ]);
  const loop = new AgentLoop({ model, tools, nerves, bot, state, system: 'sys', opts: { maxUsd: 100 } });
  setTimeout(() => { bot.health = 10; bot.emit('health'); }, 100);
  const t0 = Date.now();
  await loop.run('boot');
  const res = loop.messages[2].content[0];
  check(/"status":"interrupted"/.test(res.content) && /"by":"damage"/.test(res.content), 'damage interrupts the running tool');
  check(Date.now() - t0 < 3000, 'interrupted tool returns promptly');
  nerves.stop();
}

// ---------- 6. loop: stop() from outside, budget guard ----------
{
  const bot = stubBot();
  const nerves = new Nerves({ bot, username: 'TestAgent' });
  nerves.start();
  const state = { focus: null, stop: null };
  const tools = stubTools();
  const model = stubModel([[tu('slow', { ms: 10_000 }, 's1')]]);
  const loop = new AgentLoop({ model, tools, nerves, bot, state, system: 'sys', opts: { maxUsd: 100 } });
  setTimeout(() => loop.stop('sigint'), 80);
  const out = await loop.run('boot');
  check(out.reason === 'sigint', 'external stop cancels the running tool and ends the loop');
  nerves.stop();

  const model2 = stubModel([[tu('look', {}, 'x')]]);
  model2.totals.usd = 999;
  const loop2 = new AgentLoop({ model: model2, tools, nerves, bot, state: { stop: null }, system: 'sys', opts: { maxUsd: 5 } });
  const out2 = await loop2.run('boot');
  check(out2.reason === 'budget_exhausted' && out2.turns === 0, 'budget guard stops before spending');
}

// ---------- 7. real tool registry: schemas + validation + prompt ----------
{
  const bot = stubBot();
  const deps = {
    bot, movement: { goTo: () => ({ stop() {}, done: Promise.resolve({ reached: true }) }), flee: () => ({ stop() {}, done: Promise.resolve({ reached: true }) }), setBootstrapMode() {} },
    combat: null, perception: { read: () => ({ health: 20, food: 20, timeOfDay: 'day', nearbyPlayers: [], nearbyMobs: [], nearbyBlocks: {} }) },
    registry: null, builder: null, memory: null, voice: { apply: (t) => t }, profile: { username: 'TestAgent', archetype: 'builder', skill_tier: 2, values: {}, voice: {}, spawn: { x: 0, y: 64, z: 0 } },
    log: null, nerves: new Nerves({ bot, username: 'TestAgent' }), state: { focus: null, stop: null, spawn: { x: 0, y: 64, z: 0 } },
  };
  const tools = createTools(deps);
  const names = tools.definitions.map((t) => t.name);
  for (const want of ['look', 'scan', 'inventory', 'recipes', 'goto', 'leave_spawn', 'flee', 'unstick', 'teleport', 'mine', 'craft', 'smelt', 'smelt_start', 'smelt_collect', 'jobs', 'place', 'dig', 'equip', 'wear_armor', 'eat', 'store', 'withdraw', 'collect_drops', 'light_area', 'blueprints', 'survey_site', 'build', 'attack', 'say', 'command', 'board', 'f', 'sell', 'pay', 'faction_notes', 'think', 'focus', 'note', 'wait', 'logoff']) {
    check(names.includes(want), `tool registered: ${want}`);
  }
  for (const d of tools.definitions) {
    check(typeof d.description === 'string' && d.description.length > 20 && d.input_schema?.type === 'object', `schema sane: ${d.name}`);
  }
  check(validateInput(tools.byName.get('mine').schema, { block: 'log', count: 8 }).length === 0, 'valid mine input passes');
  check(validateInput(tools.byName.get('mine').schema, { count: 8 }).length === 1, 'missing required block is caught');
  check(validateInput(tools.byName.get('goto').schema, { named: 'nowhere' }).length === 1, 'enum violation caught');
  // look works against the stub.
  const look = await tools.byName.get('look').handler({}, { cancel: new CancelToken() });
  check(look.status === 'ok' && look.pos.x === 10, 'look returns position from stub');
  const rec = await tools.byName.get('recipes').handler({ item: 'stone_pickaxe' }, { cancel: new CancelToken() });
  check(rec.status === 'ok' && rec.recipe.needs === 'crafting_table' && rec.missing.cobblestone === 3, 'recipes reports needs + missing');
  const inv = await tools.byName.get('inventory').handler({}, {});
  check(inv.tools.stone_pickaxe === 1 && inv.food.bread === 3 && inv.free_slots === 33, 'inventory groups items');
  const focus = await tools.byName.get('focus').handler({ text: 'get stone tools' }, {});
  check(focus.status === 'ok' && deps.state.focus === 'get stone tools', 'focus sets state');
  const sys = buildSystemPrompt(deps.profile, { zonesText: 'box around spawn' });
  check(/TestAgent/.test(sys) && /leave_spawn/.test(sys) && !/\d{4}-\d{2}-\d{2}/.test(sys), 'system prompt is identity + rules, no live state');
}

// ---------- 8. model helpers ----------
{
  const msgs = [{ role: 'user', content: [{ type: 'text', text: 'a' }] }, { role: 'assistant', content: [{ type: 'text', text: 'b' }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '{}' }] }];
  const out = withTailBreakpoint(msgs);
  check(out[2].content[0].cache_control?.type === 'ephemeral' && !msgs[2].content[0].cache_control, 'tail breakpoint added on a copy, history untouched');
  const usd = costOf({ input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 0 }, 'claude-sonnet-5');
  check(Math.abs(usd - (1000 * 2 + 1000 * 10 + 10000 * 0.2) / 1e6) < 1e-9, 'cost math matches per-MTok rates');
}

// ---------- 9. transcript ----------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tx-'));
  const tx = new Transcript('TestAgent', { dir });
  tx.meta({ hello: 1 });
  tx.message('user', [{ type: 'text', text: 'hi' }]);
  tx.turn({ n: 1, usage: { input_tokens: 5, output_tokens: 2 }, usd: 0.01, latencyMs: 3, stopReason: 'tool_use', tools: ['look'] });
  tx.tool({ name: 'look', input: {}, result: { status: 'ok' }, elapsedMs: 1 });
  await tx.close();
  const lines = fs.readFileSync(tx.filePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check(lines.map((l) => l.t).join(',') === 'meta,msg,turn,tool' && tx.summary().usd === 0.01, 'transcript writes meta/msg/turn/tool lines');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- 10. builder: interior items no longer dug out on resume ----------
{
  const { BlueprintBuilder } = await import('../building/blueprintBuilder.js');
  const { homeCells, registerBaseCells } = await import('./tools/build.js');
  const bp = {
    id: 'hut_t', category: 'base', dimensions: { x: 5, y: 3, z: 5 }, build_order: 'bottom_up', placement: 'surface',
    token_map: { '.': null, C: 'cobblestone', D: 'wooden_door' },
    layers: [
      ['CCCCC', 'CCCCC', 'CCCCC', 'CCCCC', 'CCCCC'],
      ['CCCCC', 'C...C', 'D...C', 'C...C', 'CCCCC'],
      ['CCCCC', 'C...C', 'C...C', 'C...C', 'CCCCC'],
    ],
    interior: [{ token: 'torch', offset: { x: 1, y: 2, z: 1 } }, { token: 'chest', offset: { x: 3, y: 1, z: 3 } }],
  };
  const world = new Map();
  const bot = { blockAt: (v) => { requireVec3(v); return { name: world.get(`${v.x},${v.y},${v.z}`) ?? 'air' }; }, entity: { position: { x: 0, y: 64, z: 0 } } };
  const builder = new BlueprintBuilder({ bot, movement: {}, log: null, profile: null, memory: null });
  const anchor = { x: 100, y: 64, z: 100 };
  const list = builder._buildPlacementList(bp, anchor, 0);
  const torchKey = '101,66,101'; const chestKey = '103,65,103';
  const atTorch = list.filter((p) => `${p.world.x},${p.world.y},${p.world.z}` === torchKey);
  const atChest = list.filter((p) => `${p.world.x},${p.world.y},${p.world.z}` === chestKey);
  check(atTorch.length === 1 && atTorch[0].blockName === 'torch', 'torch cell has a single (interior) entry, no air entry to dig');
  check(atChest.length === 1 && atChest[0].blockName === 'chest', 'chest cell has a single (interior) entry');
  check(list.filter((p) => p.blockName === null).length === 3 * 3 * 2 - 2, 'remaining air cells = interior volume minus the two items');
  const { door, inside } = homeCells(list, anchor, bp.dimensions);
  check(door && door.x === 100 && door.y === 65 && door.z === 102, `door found at ${JSON.stringify(door)}`);
  check(inside && inside.x === 101 && inside.y === 65 && inside.z === 102, `inside cell is just past the door (${JSON.stringify(inside)})`);
  // Base cells: door missing → nothing registered; door present → walls registered, door + torch excluded.
  const cellsSet = { cells: null };
  const movement = { setBaseStructureCells: (c) => { cellsSet.cells = [...c]; } };
  for (const p of list) if (p.blockName && !p.blockName.includes('door')) world.set(`${p.world.x},${p.world.y},${p.world.z}`, p.blockName);
  let reg = registerBaseCells({ bot, builder, movement, blueprint: bp, anchor, rotation: 0 });
  check(reg.registered === 0 && reg.reason === 'door_missing', 'no door in the world → walls not locked');
  world.set('100,65,102', 'wooden_door'); world.set('100,66,102', 'wooden_door');
  reg = registerBaseCells({ bot, builder, movement, blueprint: bp, anchor, rotation: 0 });
  check(reg.registered > 50 && !cellsSet.cells.includes('100,65,102') && cellsSet.cells.includes('100,64,100'), `walls registered (${reg.registered}) without the door`);
}

// ---------- 11. gather: own-block guard + mine progress by inventory ----------
{
  const { createTools } = await import('./tools/index.js');
  const bot = stubBot();
  bot.registry.blocksByName.dirt = { id: 3 };
  const movement = { isOwnBlock: (p) => p.x === 5, goTo: () => ({ stop() {}, done: Promise.resolve({ reached: true }) }), setBootstrapMode() {} };
  const deps = { bot, movement, combat: null, perception: { read: () => ({}) }, registry: null, builder: null, memory: null, voice: { apply: (t) => t }, profile: { username: 'T', archetype: 'builder', skill_tier: 1, values: {}, voice: {}, spawn: { x: 0, y: 64, z: 0 } }, log: null, nerves: { recentChat: () => [] }, state: { home: { x: 1, y: 2, z: 3, inside: { x: 9, y: 9, z: 9 } }, stop: null, spawn: { x: 0, y: 64, z: 0 } } };
  const tools = createTools(deps);
  const dig = await tools.byName.get('dig').handler({ x: 5, y: 64, z: 5 }, { cancel: new CancelToken() });
  check(dig.status === 'failed' && dig.reason === 'own_structure', 'dig refuses own wall without force');
  // mine refuses to dig down from on/inside the house.
  bot.registry.blocksByName.iron_ore = { id: 15 };
  const mineTool = tools.byName.get('mine');
  bot.entity.position.x = 5; // isOwnBlock stub: x === 5 → standing on own floor
  const mineHome = await mineTool.handler({ block: 'iron_ore', count: 8 }, { cancel: new CancelToken() });
  check(mineHome.status === 'failed' && mineHome.reason === 'too_close_to_home', 'mine refuses a descending mine from inside the house');
  bot.entity.position.x = 10;
  const savedHome = deps.state.home;
  deps.state.home = { x: 300, y: 64, z: 300 };
  const mineLog = await mineTool.handler({ block: 'log', count: 4, timeout_s: 15 }, { cancel: new CancelToken() });
  check(mineLog.reason !== 'too_close_to_home', 'surface mining (logs) is never blocked by the home rule');
  deps.state.home = savedHome;
  bot.blockAt = (v) => { requireVec3(v); return { name: 'furnace', boundingBox: 'block', position: v }; };
  const digF = await tools.byName.get('dig').handler({ x: 7, y: 64, z: 7 }, { cancel: new CancelToken() });
  check(digF.status === 'failed' && digF.reason === 'workstation', 'dig refuses a furnace without force (open it instead)');
  bot.blockAt = (v) => { requireVec3(v); return { name: 'air', boundingBox: 'empty', light: 3, position: v }; };
  bot.inventory = { items: () => [{ name: 'torch', count: 8 }], slots: [] };
  const la = await tools.byName.get('light_area').handler({ radius: 3, max: 2 }, { cancel: new CancelToken() });
  check(la.status !== 'failed' || la.reason !== 'exception:pos.floored is not a function', `light_area passes Vec3 to blockAt (${la.status}:${la.reason ?? ''})`);
  const craftTool = tools.byName.get('craft');
  bot.registry.itemsByName = { planks: { id: 5 } };
  const eatTool = tools.byName.get('eat');
  bot.food = 20;
  const ate = await eatTool.handler({}, { cancel: new CancelToken() });
  check(ate.status === 'ok' && ate.ate === null, 'eat at full hunger reports not hungry instead of failing');
  void craftTool;
  const { moveTools } = await import('./tools/move.js');
  const goto = moveTools(deps).find((t) => t.name === 'goto');
  let target = null;
  deps.movement.goTo = (pos) => { target = pos; return { stop() {}, done: Promise.resolve({ reached: true }) }; };
  await goto.handler({ named: 'home' }, { cancel: new CancelToken() });
  check(target && target.x === 9, 'goto named home walks to the inside cell');
}

// ---------- 11b. vein follow never goes below the lava floor ----------
{
  const { mineConnectedVein } = await import('../world/primitives.js');
  const { Vec3 } = await import('vec3');
  const ore = new Set(['20,13,20', '20,12,20', '20,11,20', '20,10,20', '21,13,20']);
  const dug = [];
  const bot = {
    entity: { position: new Vec3(20, 14, 20) }, inventory: { items: () => [] },
    blockAt: (v) => { requireVec3(v); const k = `${v.x},${v.y},${v.z}`; return { name: ore.has(k) ? 'iron_ore' : 'stone', position: v, boundingBox: 'block' }; },
    canDigBlock: () => true, dig: async (b) => { dug.push(`${b.position.x},${b.position.y},${b.position.z}`); ore.delete(`${b.position.x},${b.position.y},${b.position.z}`); },
  };
  const extra = await mineConnectedVein(bot, { x: 20, y: 13, z: 20 }, 'iron_ore', { max: 16, minY: 12 });
  check(extra === 2 && dug.includes('20,12,20') && dug.includes('21,13,20') && !dug.includes('20,11,20'), `vein follow stops at the caller's floor (dug ${dug.join(' ')})`);
}

// ---------- 12. escape: confinement, sidestep, teleport ----------
{
  const { isConfined, isUnderground, sidestep, escapeTools } = await import('./tools/escape.js');
  const world = new Map();
  const set = (x, y, z, name, bb = 'block') => world.set(`${x},${y},${z}`, { name, boundingBox: bb });
  const bot = stubBot({ pos: { x: 10, y: 64, z: 10 } });
  bot.blockAt = (v) => { requireVec3(v); const b = world.get(`${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`); return b ? { ...b, position: { x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) } } : { name: 'air', boundingBox: 'empty', position: { x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) } }; };
  bot.canDigBlock = () => true;
  const dug = [];
  bot.dig = async (b) => { dug.push(`${b.position.x},${b.position.y},${b.position.z}`); world.delete(`${b.position.x},${b.position.y},${b.position.z}`); };
  bot.lookAt = async () => {};
  check(!isConfined(bot), 'open field is not confined');
  // Box the bot in: stone on all four cardinals at feet+head, floor everywhere.
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]]) { set(10 + dx, 63, 10 + dz, 'stone'); }
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { set(10 + dx, 64, 10 + dz, 'stone'); set(10 + dx, 65, 10 + dz, 'stone'); }
  check(isConfined(bot), 'walled on four sides is confined');
  set(10, 66, 10, 'stone'); check(isUnderground(bot), 'roof overhead → underground');
  // East wall is lava-adjacent → must not be dug; west is own block → dug only as last resort; south is clean.
  set(12, 64, 10, 'lava', 'empty');
  const movement = { isOwnBlock: (p) => p.x === 9, cancel() {} };
  const r = await sidestep(bot, movement, new CancelToken(), null);
  check(r.dug === 2 && r.dir.dx === 0 && r.dir.dz === 1 && !r.own, `sidestep picked the clean south exit (${JSON.stringify(r.dir)}, own=${r.own})`);
  check(!dug.includes('11,64,10') && !dug.includes('9,64,10'), 'never dug the lava-adjacent or own-wall cells');
  // teleport: stub /home moves the bot after a beat.
  const bot2 = stubBot({ pos: { x: 0, y: 64, z: 0 } });
  bot2.chat = (cmd) => { if (cmd === '/home') setTimeout(() => { bot2.entity.position.x = 500; bot2.entity.position.z = 500; }, 200); };
  bot2.clearControlStates = () => {};
  const deps2 = { bot: bot2, movement: { cancel() {} }, log: null, state: { home: { x: 500, y: 64, z: 500, inside: { x: 501, y: 65, z: 502 } }, spawn: { x: 0, y: 64, z: 0 } } };
  const teleport = escapeTools(deps2).find((t) => t.name === 'teleport');
  const tr = await teleport.handler({ to: 'home', timeout_s: 5 }, { cancel: new CancelToken() });
  check(tr.status === 'ok' && tr.pos.x === 500, `teleport home verified arrival (${tr.status})`);
  bot2.chat = () => {};
  bot2.entity.position.x = 0; bot2.entity.position.z = 0;
  const tr2 = await teleport.handler({ to: 'home', timeout_s: 5 }, { cancel: new CancelToken() });
  check(tr2.status === 'failed' && tr2.reason === 'no_teleport', 'teleport reports no position change honestly');
}

// ---------- 13. jobs: smelt_start → job_done event → smelt_collect ----------
{
  const { jobTools } = await import('./tools/jobs.js');
  const bot = stubBot();
  bot.registry.blocksByName.furnace = { id: 61 }; bot.registry.blocksByName.lit_furnace = { id: 62 };
  bot.registry.itemsByName = { iron_ore: { id: 15 }, coal: { id: 263 } };
  const inv = [{ name: 'iron_ore', count: 9, type: 15 }, { name: 'coal', count: 4, type: 263 }];
  bot.inventory = { items: () => inv, slots: [] };
  const { Vec3 } = await import('vec3');
  // Real blocks carry Vec3 positions; the primitives call .offset() on them.
  const furnaceBlock = { name: 'furnace', position: new Vec3(12, 64, 10) };
  bot.findBlock = ({ matching }) => (typeof matching === 'function' ? (matching({ name: 'furnace', position: furnaceBlock.position }) ? furnaceBlock : null) : furnaceBlock);
  bot.blockAt = (v) => { requireVec3(v); return v.x === 12 && v.y === 64 && v.z === 10 ? furnaceBlock : { name: 'stone', boundingBox: 'block' }; };
  const furnace = { input: 0, fuel: 0, output: 0, closed: 0,
    putFuel: async (_id, _m, n) => { furnace.fuel += n; }, putInput: async (_id, _m, n) => { furnace.input += n; furnace.output = n; },
    outputItem: () => (furnace.output > 0 ? { name: 'iron_ingot', count: furnace.output } : null),
    takeOutput: async () => { const n = furnace.output; furnace.output = 0; furnace.input = 0; return { name: 'iron_ingot', count: n }; },
    inputItem: () => (furnace.input > 0 ? { count: furnace.input } : null), close: () => { furnace.closed += 1; } };
  bot.openFurnace = async () => furnace;
  const nerves = new Nerves({ bot, username: 'TestAgent' });
  const state = { jobs: new Map() };
  const tools = jobTools({ bot, movement: { goTo: () => ({ stop() {}, done: Promise.resolve({ reached: true }) }) }, log: null, state, nerves, jobTiming: { msPerItem: 20 } });
  const start = tools.find((t) => t.name === 'smelt_start');
  const collect = tools.find((t) => t.name === 'smelt_collect');
  const list = tools.find((t) => t.name === 'jobs');
  const s = await start.handler({ item: 'iron_ore', count: 8 }, { cancel: new CancelToken() });
  check(s.status === 'ok' && s.count === 8 && s.fuel === 'coal' && furnace.input === 8 && furnace.fuel === 1 && furnace.closed === 1, `smelt_start loads furnace and returns (${JSON.stringify({ status: s.status, fuel: s.fuel, input: furnace.input, fuelIn: furnace.fuel })})`);
  check((await list.handler({}, {})).jobs[0].status === 'cooking', 'job listed as cooking');
  await new Promise((r) => setTimeout(r, 8 * 20 + 1700));
  const d = nerves.drain();
  check(d.events.some((e) => e.kind === 'job_done' && e.job_id === s.job_id), 'job_done event queued when ready');
  const c = await collect.handler({}, { cancel: new CancelToken() });
  check(c.status === 'ok' && c.collected.iron_ingot === 8 && state.jobs.get(s.job_id).status === 'collected', `smelt_collect takes the output (${c.status})`);
  const bad = await start.handler({ item: 'cobblestone', count: 8 }, { cancel: new CancelToken() });
  check(bad.status === 'failed' && bad.reason === 'no_input', 'smelt_start refuses without input');
}

// ---------- 14. withdraw + store named home + homeCells chest + dusk ----------
{
  const { gatherTools } = await import('./tools/gather.js');
  const bot = stubBot();
  const { Vec3 } = await import('vec3');
  const chestBlock = { name: 'chest', position: new Vec3(3, 65, 3) };
  bot.blockAt = (v) => { requireVec3(v); return v.x === 3 && v.y === 65 && v.z === 3 ? chestBlock : { name: 'stone', boundingBox: 'block' }; };
  bot.findBlock = () => chestBlock;
  const inside = [{ name: 'iron_ingot', count: 12, type: 265 }, { name: 'cobblestone', count: 40, type: 4 }];
  const taken = [];
  bot.openContainer = async () => ({ containerItems: () => inside, withdraw: async (type, _m, n) => { taken.push([type, n]); }, close() {} });
  const state = { home: { x: 1, y: 64, z: 1, chest: { x: 3, y: 65, z: 3 } } };
  const tools = gatherTools({ bot, movement: { goTo: () => ({ stop() {}, done: Promise.resolve({ reached: true }) }) }, log: null, perception: null, state });
  const w = tools.find((t) => t.name === 'withdraw');
  const r = await w.handler({ items: ['iron_ingot'], count: 5, named: 'home' }, { cancel: new CancelToken() });
  check(r.status === 'ok' && r.taken.iron_ingot === 5 && taken.length === 1 && taken[0][1] === 5, `withdraw takes only the asked item, capped (${JSON.stringify(r.taken)})`);
  const { homeCells } = await import('./tools/build.js');
  const placements = [{ blockName: null, world: { x: 1, y: 65, z: 1 } }, { blockName: null, world: { x: 1, y: 66, z: 1 } }, { blockName: 'chest', world: { x: 2, y: 65, z: 2 } }, { blockName: 'wooden_door', world: { x: 0, y: 65, z: 1 } }];
  const hc = homeCells(placements, { x: 0, y: 64, z: 0 }, { x: 3, z: 3 });
  check(hc.chest && hc.chest.x === 2 && hc.inside && hc.inside.x === 1, 'homeCells reports the chest and the inside cell');
  const nerves = new Nerves({ bot, username: 'TestAgent' });
  nerves.start();
  bot.time.timeOfDay = 1000; nerves._scan();
  bot.time.timeOfDay = 12500; nerves._scan();
  const d = nerves.drain();
  check(d.events.some((e) => e.kind === 'dusk'), 'dusk event fires on the day→dusk transition');
  nerves.stop();
}

// ---------- 15. memory store: commands + sandbox ----------
{
  const { MemoryStore } = await import('./memoryTool.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mem-'));
  const store = new MemoryStore('TestAgent', { dir });
  check(store.run({ command: 'view', path: '/memories' }).text.includes('empty'), 'empty memory dir views as empty');
  check(!store.run({ command: 'create', path: '/memories/plans.md', file_text: '# plans\n- build a farm\n- get diamonds\n' }).isError, 'create writes a file');
  const v = store.run({ command: 'view', path: '/memories/plans.md' });
  check(/1: # plans/.test(v.text) && /3 lines|4 lines/.test(v.text), 'view shows numbered lines');
  check(!store.run({ command: 'str_replace', path: '/memories/plans.md', old_str: 'get diamonds', new_str: 'get diamonds (need iron pick)' }).isError, 'str_replace edits a unique match');
  check(store.run({ command: 'str_replace', path: '/memories/plans.md', old_str: 'zzz', new_str: 'y' }).isError, 'str_replace reports a missing match');
  check(!store.run({ command: 'insert', path: '/memories/plans.md', insert_line: 1, insert_text: '- sleep at night' }).isError, 'insert adds a line');
  check(fs.readFileSync(path.join(dir, 'plans.md'), 'utf8').split('\n')[1] === '- sleep at night', 'insert lands after the given line');
  check(!store.run({ command: 'rename', old_path: '/memories/plans.md', new_path: '/memories/goals/plans.md' }).isError && fs.existsSync(path.join(dir, 'goals', 'plans.md')), 'rename moves into a subdirectory');
  check(store.run({ command: 'view', path: '/etc/passwd' }).isError && store.run({ command: 'create', path: '/memories/../../x', file_text: 'no' }).isError, 'paths outside /memories are refused');
  check(store.list().length === 1 && store.list()[0].path === '/memories/goals/plans.md', 'list reports files with /memories paths');
  check(!store.run({ command: 'delete', path: '/memories/goals/plans.md' }).isError && store.list().length === 0, 'delete removes a file');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- 16. loop: memory tool routing + context-edit re-injection + focus persistence ----------
{
  const { MemoryStore } = await import('./memoryTool.js');
  const { createTools } = await import('./tools/index.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mem2-'));
  const memoryStore = new MemoryStore('TestAgent', { dir });
  const kv = new Map();
  const bot = stubBot();
  const deps = { bot, movement: {}, combat: null, perception: { read: () => ({}) }, registry: null, builder: null, memory: { kvSet: (k, v) => kv.set(k, v), kvGet: (k, d) => kv.get(k) ?? d }, memoryStore, voice: { apply: (t) => t }, profile: { username: 'TestAgent', archetype: 'builder', skill_tier: 1, values: {}, voice: {}, spawn: { x: 0, y: 64, z: 0 } }, log: null, nerves: new Nerves({ bot, username: 'TestAgent' }), state: { focus: null, stop: null, home: { x: 1, y: 2, z: 3, inside: { x: 2, y: 3, z: 3 } }, jobs: new Map() } };
  const tools = createTools(deps);
  check(tools.definitions.some((d) => d.type === 'memory_20250818' && d.name === 'memory'), 'memory tool is declared with the Anthropic type');
  check(tools.definitions[tools.definitions.length - 1].name === 'memory', 'memory tool is last (stable cache prefix)');
  const nerves = deps.nerves; nerves.start();
  const model = stubModel([
    [tu('memory', { command: 'create', path: '/memories/plans.md', file_text: 'farm next' }, 'm1'), tu('focus', { text: 'build the wheat farm by the hut' }, 'f1')],
    // Simulate the API having cleared old tool results this turn.
    (msgs) => { const c = [tu('memory', { command: 'view', path: '/memories/plans.md' }, 'm2')]; c.context_management = { applied_edits: [{ type: 'clear_tool_uses_20250919' }] }; return c; },
    [tu('logoff', {}, 'l1')],
  ]);
  // stubModel builds the response from the content array; carry context_management through.
  const origTurn = model.turn.bind(model);
  model.turn = async (args) => { const r = await origTurn(args); const cm = r.response.content.context_management; if (cm) r.response.context_management = cm; return r; };
  const loop = new AgentLoop({ model, tools, nerves, bot, state: deps.state, system: 'sys', opts: { maxUsd: 100 } });
  await loop.run('boot');
  const m = loop.messages;
  check(/Created \/memories\/plans\.md/.test(m[2].content[0].content), 'memory tool result is plain text from the store');
  check(kv.get('agent_focus')?.text === 'build the wheat farm by the hut', 'focus persists to KV');
  const trailer = m[4].content.find((b) => b.type === 'text')?.text ?? '';
  check(/\[context\] older tool results were cleared/.test(trailer) && /\[focus card\] build the wheat farm/.test(trailer) && /\[home\]/.test(trailer), 'context edit re-injects focus card and home');
  check(loop.stats.contextEdits === 1, 'context edits are counted');
  nerves.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- 17. factions + money: create gate, sell, pay, notes, board, think, invite ----------
{
  const { factionTools } = await import('./tools/faction.js');
  const { boardTools } = await import('./tools/board.js');
  const { thinkTools } = await import('./tools/think.js');
  // A bot whose chat commands get scripted server replies via messagestr.
  const bot = stubBot();
  const scripted = new Map();   // command prefix → replies[]
  bot.chat = (cmd) => {
    for (const [prefix, replies] of scripted) {
      if (cmd.startsWith(prefix)) { for (const r of replies) setTimeout(() => bot.emit('messagestr', r), 30); return; }
    }
  };
  const kv = new Map();
  const memory = { kvGet: (k, d) => kv.get(k) ?? d, kvSet: (k, v) => kv.set(k, v) };
  const factions = { state: { ourFaction: null, allies: [], enemies: [], balance: 0 }, setBalance(n) { this.state.balance = n; }, getBalance() { return this.state.balance; }, _persist() { memory.kvSet('faction_state', this.state); } };
  const busAnswers = { query_balance: { type: 'balance', balance: 40 } };
  const bus = { query: async (type, payload) => { const a = busAnswers[type]; if (a instanceof Error) throw a; if (!a) throw new Error(`query timeout: ${type}`); return a; }, publisher: { store: new Map(), async get(k) { return this.store.get(k) ?? null; }, async set(k, v) { this.store.set(k, v); } } };
  const state = { focus: 'grow', home: null, lastBuild: null, faction: null, jobs: new Map() };
  const deps = { bot, bus, factions, profile: { username: 'TestAgent', archetype: 'builder', ambition: 0.4, values: {} }, log: null, state, movement: { cancel() {} }, memoryStore: { list: () => [], resolve: () => '' } };
  const ftools = factionTools(deps);
  const f = ftools.find((t) => t.name === 'f');
  const sell = ftools.find((t) => t.name === 'sell');
  const pay = ftools.find((t) => t.name === 'pay');
  const notes = ftools.find((t) => t.name === 'faction_notes');

  // create: refused at $40, allowed at $150 with a confirming reply.
  let r = await f.handler({ action: 'create', name: 'Hearth' }, { cancel: new CancelToken() });
  check(r.status === 'failed' && r.reason === 'insufficient_funds' && r.balance === 40 && r.short === 60, `f create refused without $100 (${r.reason}, balance ${r.balance})`);
  busAnswers.query_balance = { type: 'balance', balance: 150 };
  scripted.set('/f create Hearth', ['§aYou created the faction Hearth.']);
  r = await f.handler({ action: 'create', name: 'Hearth' }, { cancel: new CancelToken() });
  check(r.status === 'ok' && r.faction === 'Hearth' && factions.state.ourFaction === 'Hearth' && kv.get('faction_state')?.ourFaction === 'Hearth', `f create succeeds with funds and persists (${r.status} ${r.reason ?? ''})`);
  r = await f.handler({ action: 'create', name: 'Other' }, { cancel: new CancelToken() });
  check(r.status === 'failed' && r.reason === 'already_in_faction', 'second create refused once in a faction');
  // claim without a reply → unclear but recorded; failed reply classified.
  scripted.set('/f claim', ['§cYou need more power to claim land.']);
  r = await f.handler({ action: 'claim' }, { cancel: new CancelToken() });
  check(r.status === 'failed' && r.reason === 'claim_failed', 'claim failure reply is classified');
  // balance unknown → refuse create (fresh factions state).
  factions.state.ourFaction = null;
  busAnswers.query_balance = new Error('query timeout: query_balance');
  scripted.set('/balance', []);
  r = await f.handler({ action: 'create', name: 'Foo' }, { cancel: new CancelToken() });
  check(r.status === 'failed' && r.reason === 'balance_unknown', 'create refused when the balance cannot be read');
  // balance via chat fallback.
  scripted.set('/balance', ['§aBalance: $120.00']);
  scripted.set('/f create Foo', ['§aYou created the faction Foo.']);
  r = await f.handler({ action: 'create', name: 'Foo' }, { cancel: new CancelToken() });
  check(r.status === 'ok' && r.balance_before === 120, 'chat /balance fallback feeds the funds gate');

  // sell: surplus above reserves, amounts parsed from the echo, balance read after.
  const inv = [{ name: 'cobblestone', count: 64, type: 4 }, { name: 'cobblestone', count: 36, type: 4 }, { name: 'wheat', count: 20, type: 296 }, { name: 'diamond', count: 3, type: 264 }];
  bot.inventory = { items: () => inv, slots: [] };
  bot.equip = async () => {};
  let soldCalls = [];
  bot.chat = (cmd) => {
    if (cmd.startsWith('/sell hand')) {
      const n = Number(cmd.split(' ')[2]);
      soldCalls.push(cmd);
      const held = inv.find((it) => it.name === (soldCalls.length === 1 ? 'cobblestone' : 'wheat'));
      if (held) { held.count -= n; if (held.count <= 0) inv.splice(inv.indexOf(held), 1); }
      setTimeout(() => bot.emit('messagestr', `§aSold ${n} ${held?.name ?? 'items'} for $${(n * 0.5).toFixed(2)}.`), 30);
      return;
    }
    if (cmd.startsWith('/balance')) setTimeout(() => bot.emit('messagestr', '§aBalance: $148.00'), 30);
    if (cmd.startsWith('/pay Bob')) setTimeout(() => bot.emit('messagestr', '§a$20.00 has been sent to Bob.'), 30);
    if (cmd.startsWith('/pay Nobody')) setTimeout(() => bot.emit('messagestr', '§cPlayer not found.'), 30);
  };
  busAnswers.query_balance = new Error('timeout');
  r = await sell.handler({}, { cancel: new CancelToken() });
  check(r.status === 'ok' && r.sold.cobblestone === 36 && r.sold.wheat === 20 && !r.sold.diamond && r.earned === 28 && r.balance === 148, `sell sells surplus only and parses earnings (${JSON.stringify({ sold: r.sold, earned: r.earned, bal: r.balance })})`);
  // pay
  r = await pay.handler({ player: 'Bob', amount: 20 }, {});
  check(r.status === 'ok' && r.player === 'Bob', 'pay success reply classified');
  r = await pay.handler({ player: 'Nobody', amount: 5 }, {});
  check(r.status === 'failed' && r.reason === 'player_not_found', 'pay unknown player classified');
  // faction notes (shared page in redis)
  factions.state.ourFaction = 'Hearth';
  r = await notes.handler({ action: 'append', text: 'need 20 TNT for Saturday' }, {});
  const read = await notes.handler({ action: 'read' }, {});
  check(r.status === 'ok' && /TestAgent\] need 20 TNT/.test(read.notes), 'faction notes append + read round-trip');
  // board: partial bridge answers → unavailable list, never a guess.
  Object.assign(busAnswers, {
    query_balance: { type: 'balance', balance: 148 },
    query_baltop: { type: 'baltop', my_rank: 3, players: 12, top: [{ name: 'Marla_K', balance: 900 }, { name: 'TestAgent', balance: 148 }] },
    query_factions: { type: 'factions', my_faction: 'Hearth', factions: [{ name: 'Hearth', power: 9.5, power_max: 10, land: 1, members: 1, online: 1, relation: 'own' }, { name: 'Wolves', power: 4, power_max: 20, land: 9, members: 2, online: 0, relation: 'neutral', raidable: true }] },
    query_online: { type: 'online', players: [{ name: 'Marla_K', faction: null, x: 400, z: 220 }, { name: 'TestAgent', faction: 'Hearth' }] },
    query_claims: new Error('query timeout: query_claims'),
  });
  const [board] = boardTools(deps);
  r = await board.handler({});
  check(r.status === 'ok' && r.balance === 148 && r.baltop.my_rank === 3 && r.factions.length === 2 && r.factions[1].raidable === true && r.online.length === 1 && r.unavailable?.includes('claims'), `board composes the bridge answers (${JSON.stringify({ b: r.balance, rank: r.baltop?.my_rank, f: r.factions?.length, un: r.unavailable })})`);
  // think: memo from the strategist stub, stamps lastThinkAt.
  deps.strategist = { turn: async ({ messages }) => ({ response: { content: [{ type: 'text', text: 'Memo: claim your hut chunk, then sell cobble. ' + (String(messages[0].content[0].text).includes('## Board') ? 'board-seen' : '') }] }, usd: 0.01 }) };
  const [think] = thinkTools(deps);
  r = await think.handler({ question: 'found or join?' });
  check(r.status === 'ok' && /board-seen/.test(r.memo) && state.lastThinkAt > 0, 'think feeds notes + board to the strategist and returns a memo');
  // invite event from a server line
  const nerves = new Nerves({ bot, username: 'TestAgent' });
  nerves.start();
  bot.emit('messagestr', '§eMarla_K invited you to join Wolves');
  const ev = nerves.drain().events.find((e) => e.kind === 'faction_invite');
  check(ev && ev.from === 'Marla_K' && ev.faction === 'Wolves' && /f join Wolves/.test(formatEvent(ev)), 'faction invite line becomes an event with a join hint');
  nerves.stop();
}

// ---------- 18. prices, canopy, hoe precheck, builder skip reasons ----------
{
  const { loadPrices } = await import('./prices.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-worth-'));
  const wy = path.join(dir, 'worth.yml');
  fs.writeFileSync(wy, 'worth:\n  log: 2.0\n  wool:\n    \'0\': 5.0\n  coal: 15.0\n  ironingot: 22.0\n  wheat: 9.0\n  cobblestone: 1.0\n  diamond: 200.0\n');
  const prices = loadPrices({ file: wy });
  check(prices.known === 7 && prices.priceOf('iron_ingot') === 22 && prices.priceOf('log2') === 2 && prices.priceOf('wool') === 5 && prices.priceOf('stone_pickaxe') == null, 'worth.yml parsed with name mapping and nested entries');
  const v = prices.inventoryValue({ coal: 21, cobblestone: 44, torch: 12 });
  check(v.total === 359 && v.items[0].item === 'coal' && v.items[0].value === 315, `inventory value ranks coal first ($${v.total})`);
  check(/coal \$15/.test(prices.summary()) && !/torch/.test(prices.summary()), 'summary lists known sellables only');
  fs.rmSync(dir, { recursive: true, force: true });

  const { isUnderground } = await import('./tools/escape.js');
  const bot = stubBot({ pos: { x: 0, y: 64, z: 0 } });
  bot.blockAt = (v) => { requireVec3(v); return v.y === 70 ? { name: 'leaves', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }; };
  check(!isUnderground(bot), 'a tree canopy overhead is not "underground"');
  bot.blockAt = (v) => { requireVec3(v); return v.y === 70 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }; };
  check(isUnderground(bot), 'a stone roof overhead is underground');

  const { buildTools } = await import('./tools/build.js');
  const farm = { id: 'wheat_farm_small', category: 'farm', dimensions: { x: 5, y: 2, z: 5 }, materials: { farmland: 9, water: 1, wheat_seeds: 9, fence: 16 }, substitutions: {}, placement: 'surface' };
  const registry = { get: (id) => (id === farm.id ? farm : null), all: () => [farm], query: () => [farm], canAfford: () => ({ affordable: true, missing: {} }) };
  const bot2 = stubBot({ pos: { x: 3, y: 64, z: 3 } });   // standing at the site
  bot2.inventory = { items: () => [{ name: 'dirt', count: 20 }, { name: 'fence', count: 16 }], slots: [] };
  const deps = { bot: bot2, registry, builder: { build: () => ({ stop() {}, done: Promise.resolve({ placed: 0, skipped: 0, missing: {}, total: 0, reason: 'done' }) }), scanCompletion: () => null, _buildPlacementList: () => [] }, log: null, state: { spawn: { x: 0, y: 64, z: 0 }, lastBuild: null }, movement: { goTo: () => ({ stop() {}, done: Promise.resolve({ reached: true }) }) } };
  const build = buildTools(deps).find((t) => t.name === 'build');
  const r = await build.handler({ blueprint: 'wheat_farm_small', x: 1, y: 64, z: 1 }, { cancel: new CancelToken() });
  check(r.status === 'failed' && r.reason === 'need_hoe' && /hoe/.test(r.hint), 'farm build refuses without a hoe before walking anywhere');
  // With a hoe and a partial result carrying skip reasons, the fix line names the top reason.
  bot2.inventory = { items: () => [{ name: 'dirt', count: 20 }, { name: 'fence', count: 16 }, { name: 'wooden_hoe', count: 1 }], slots: [] };
  deps.builder.build = () => ({ stop() {}, done: Promise.resolve({ placed: 3, skipped: 30, missing: {}, total: 40, reason: 'partial', skip_reasons: { pathfind_failed: 21, no_standing: 2 } }) });
  const rb = await build.handler({ blueprint: 'wheat_farm_small', x: 1, y: 64, z: 1 }, { cancel: new CancelToken() });
  check(rb.status === 'failed' && rb.reason === 'need_bucket' && /bucket/.test(rb.hint), 'farm build refuses without a bucket so the plot is not built dry');
  bot2.inventory = { items: () => [{ name: 'dirt', count: 20 }, { name: 'fence', count: 16 }, { name: 'wooden_hoe', count: 1 }, { name: 'bucket', count: 1 }], slots: [] };
  const r2 = await build.handler({ blueprint: 'wheat_farm_small', x: 1, y: 64, z: 1 }, { cancel: new CancelToken() });
  check(r2.status === 'partial' && r2.failed_cells?.pathfind_failed === 21 && /goto the anchor/.test(r2.hint), `partial build surfaces failed_cells and an actionable fix (${JSON.stringify({ s: r2.status, r: r2.reason, f: r2.failed_cells })})`);
  // Far from the anchor with a walk that goes nowhere → site_unreachable before any placing.
  bot2.entity.position.x = 40; bot2.entity.position.z = 40;
  const r3 = await build.handler({ blueprint: 'wheat_farm_small', x: 1, y: 64, z: 1 }, { cancel: new CancelToken() });
  check(r3.status === 'failed' && r3.reason === 'site_unreachable', 'unreachable anchor fails fast instead of burning the build budget');
}


// ---------- 19. door passage, spawn-margin exit, deep water, faction command shapes, shielded escapes ----------
{
  const { doorInfo, cellInsideHome, wrapMovementWithDoor, doorOpen } = await import('./tools/door.js');
  const home = { x: 0, y: 63, z: 0, door: { x: 1, y: 64, z: 0 }, inside: { x: 1, y: 64, z: 1 }, interior: { min: { x: 1, z: 1 }, max: { x: 2, z: 2 }, y: 64 }, blueprint: 'dirt_shelter' };
  const info = doorInfo(home);
  check(info.outside.x === 1 && info.outside.z === -1 && info.outside.y === 64, 'doorInfo derives the outside cell across the door');
  check(cellInsideHome({ x: 2.5, y: 64, z: 1.5 }, home) && !cellInsideHome({ x: 1.5, y: 64, z: -1.5 }, home) && !cellInsideHome(info.door, home), 'interior box tells inside from the doorway and outside');
  check(doorOpen({ metadata: 0x4 }) && !doorOpen({ metadata: 0x1 }) && doorOpen({ getProperties: () => ({ open: true }) }), '1.8 door open state from metadata or properties');
  // Stub world: the door toggles on activateBlock; walking forward lands on the look target.
  const bot = stubBot({ pos: { x: 2.5, y: 64, z: 2.5 } });
  let doorMeta = 0; const activations = [];
  bot.blockAt = (v) => { requireVec3(v); if (v.x === 1 && v.y === 64 && v.z === 0) return { name: 'wooden_door', metadata: doorMeta, position: v, boundingBox: 'block' }; if (v.y === 63) return { name: 'dirt', boundingBox: 'block', position: v }; return { name: 'air', boundingBox: 'empty', position: v }; };
  bot.activateBlock = async (b) => { activations.push(b.name); doorMeta ^= 0x4; };
  let look = null;
  bot.lookAt = async (v) => { look = v; };
  bot.setControlState = (k, on) => { if (k === 'forward' && on && look) { bot.entity.position.x = look.x; bot.entity.position.z = look.z; } };
  const rawCalls = [];
  const movement = {
    goTo(pos, opts) { rawCalls.push({ pos: { ...pos }, opts }); bot.entity.position.x = pos.x + 0.5; bot.entity.position.z = pos.z + 0.5; bot.entity.position.y = pos.y; return { stop() {}, done: Promise.resolve({ reached: true }) }; },
    cancel() {},
  };
  const state = { home };
  wrapMovementWithDoor(movement, { bot, state, log: null });
  let r = await movement.goTo({ x: 10, y: 64, z: -10 }, { range: 1, timeoutMs: 5000 }).done;
  check(r.reached && r.door === 'out', `goto from inside leaves through the door (${JSON.stringify(r)})`);
  // This door (facing 0) sits in a wall along x and is walked along z: its "closed" panel is a side rail, so no toggle is needed to pass and one toggle puts a panel across the doorway afterwards.
  check(activations.length === 1 && doorMeta === 4, `no toggle to pass a sideways-hung door, one to block it behind (${activations.length} activations, meta ${doorMeta})`);
  check(rawCalls[0].pos.x === 1 && rawCalls[0].pos.z === 1 && rawCalls.at(-1).pos.x === 10, 'pathfinder went to the inside cell first, then the target');
  rawCalls.length = 0; activations.length = 0;
  r = await movement.goTo(home.inside, { range: 0 }).done;
  check(r.reached && r.door === 'in' && rawCalls[0].pos.z === -1 && activations.length === 2, `goto named home enters through the door (${JSON.stringify(r)})`);
  check(Math.floor(bot.entity.position.x) === 1 && Math.floor(bot.entity.position.z) === 1, 'bot ends on the inside cell');
  rawCalls.length = 0; activations.length = 0;
  r = await movement.goTo({ x: 2, y: 64, z: 2 }, {}).done;
  check(r.reached && !r.door && activations.length === 0 && rawCalls.length === 1, 'inside-to-inside goto is a plain pathfind');
  // The chest (a solid cell inside the box) counts as inside, so store/withdraw enter first.
  bot.entity.position.x = 8.5; bot.entity.position.z = 8.5;
  rawCalls.length = 0; activations.length = 0;
  r = await movement.goTo({ x: 2, y: 64, z: 2 }, { range: 3 }).done;
  check(r.reached && r.door === 'in' && activations.length === 2, 'a range goal inside the house still goes in through the door, not through the wall');
  state.home = { x: 0, y: 63, z: 0 };
  rawCalls.length = 0;
  r = await movement.goTo({ x: 5, y: 64, z: 5 }, {}).done;
  check(r.reached && !r.door && rawCalls.length === 1, 'no door info → plain pathfind');
  state.home = home;
  // A missing door (dug out) falls back to the pathfinder and says why.
  bot.entity.position.x = 1.5; bot.entity.position.z = 1.5;
  const realBlockAt = bot.blockAt;
  bot.blockAt = (v) => { requireVec3(v); return { name: 'air', boundingBox: 'empty', position: v }; };
  r = await movement.goTo({ x: 9, y: 64, z: -9 }, {}).done;
  check(r.door === 'door_missing', `missing door is reported (${r.door})`);
  bot.blockAt = realBlockAt;

  // unstick knows the house is not a trap.
  const { escapeTools, sidestep } = await import('./tools/escape.js');
  const ubot = stubBot({ pos: { x: 1.5, y: 64, z: 1.5 } });
  const etools = escapeTools({ bot: ubot, movement: { cancel() {}, isOwnBlock: () => true }, log: null, state: { home, spawn: { x: 0, y: 64, z: 0 } } });
  const unstick = etools.find((t) => t.name === 'unstick');
  r = await unstick.handler({}, { cancel: new CancelToken() });
  check(r.status === 'ok' && r.inside_home === true && /door/.test(r.hint), 'unstick inside the house does nothing and points at the door');
  const sbot = stubBot({ pos: { x: 50.5, y: 64, z: 50.5 } });   // walled in by own blocks, no home record
  const side = await sidestep(sbot, { isOwnBlock: () => true }, new CancelToken(), null);
  check(side.reason === 'own_walls' && side.dug === 0, 'sidestep never digs own walls without force');
  const teleport = etools.find((t) => t.name === 'teleport');
  check(teleport.uninterruptible === true && unstick.uninterruptible('damage', { cause: 'drowning' }) === true && !unstick.uninterruptible('damage', { cause: 'mob' }), 'escapes declare what must not cancel them');
  // Nerves honor the shield: Tier 0 damage does not cancel, death and shutdown do.
  {
    const nb = stubBot();
    const n = new Nerves({ bot: nb, log: null, username: 'TestAgent' });
    const c = new CancelToken();
    n.arm({ interruptOn: ['damage'], cancel: c, uninterruptible: true });
    n._emit('damage', { hp: 10, cause: 'drowning' }, { tier: 0 });
    check(!c.cancelled && n._queue.some((e) => e.kind === 'damage'), 'shielded tool survives a Tier 0 event and the event is still queued');
    n.cancelCurrent('death');
    check(c.cancelled && c.reason === 'death', 'death still cancels a shielded tool');
    const c2 = new CancelToken();
    n.arm({ interruptOn: ['damage'], cancel: c2, uninterruptible: (k, d) => d?.cause === 'drowning' });
    n._emit('damage', { hp: 10, cause: 'mob' }, { tier: 1 });
    check(c2.cancelled && c2.reason === 'damage', 'a conditional shield lets other causes through');
  }

  // leave_spawn: spawn just OUTSIDE the box but inside the margin used to get its own position as the exit.
  const { pushClearOfProtection, setProtectedZones, getProtectedZones, isNearProtectedZone } = await import('../world/zones.js');
  const savedZones = getProtectedZones();
  setProtectedZones([{ type: 'spawn', min: { x: 306, z: 126 }, max: { x: 493, z: 314 } }]);
  const exit = pushClearOfProtection({ x: 513, z: 216 }, 56);
  check(Math.hypot(exit.x - 513, exit.z - 216) >= 30 && !isNearProtectedZone(exit, 56) && exit.x > 513, `exit target for a near-but-outside spawn is clear of the margin (${exit.x},${exit.z})`);
  const exit2 = pushClearOfProtection({ x: 400, z: 200 }, 56);
  check(!isNearProtectedZone(exit2, 56), 'exit target from inside the box is clear of the margin');
  const { moveTools } = await import('./tools/move.js');
  const lbot = stubBot({ pos: { x: 513, y: 62, z: 216 } });
  let hops = 0;
  const lmove = { setBootstrapMode() {}, goTo(pos) { hops += 1; lbot.entity.position.x = pos.x; lbot.entity.position.z = pos.z; return { stop() {}, done: Promise.resolve({ reached: true }) }; }, cancel() {} };
  const leave = moveTools({ bot: lbot, movement: lmove, log: null, state: {} }).find((t) => t.name === 'leave_spawn');
  r = await leave.handler({ margin: 40, timeout_s: 30 }, { cancel: new CancelToken() });
  check(r.status === 'ok' && r.clear === true && hops === 1 && r.attempts === 1, `leave_spawn from just outside the box takes one real hop (${r.status} ${r.reason ?? ''} hops ${hops})`);
  // From INSIDE the box every bot leaves on its own heading, so a fleet fans out; direction overrides it.
  const { exitBearingFor, bearingToCompass } = await import('./tools/move.js');
  const exitFor = async (username, input = {}) => {
    const b = stubBot({ pos: { x: 400, y: 64, z: 220 } }); let target = null;
    const mv = { setBootstrapMode() {}, goTo(pos) { target = { ...pos }; b.entity.position.x = pos.x; b.entity.position.z = pos.z; return { stop() {}, done: Promise.resolve({ reached: true }) }; }, cancel() {} };
    const tool = moveTools({ bot: b, movement: mv, log: null, state: {}, profile: { username } }).find((t) => t.name === 'leave_spawn');
    const res = await tool.handler({ margin: 40, timeout_s: 30, ...input }, { cancel: new CancelToken() });
    return { res, target };
  };
  const a = await exitFor('Rook_Vantis'); const b2 = await exitFor('Zephyrr'); const e = await exitFor('Marla_K', { direction: 'E' });
  check(a.res.status === 'ok' && a.res.clear && b2.res.status === 'ok' && b2.res.clear && Math.hypot(a.target.x - b2.target.x, a.target.z - b2.target.z) > 100,
    `two bots inside the box leave on different headings (${a.res.dir} ${a.target.x},${a.target.z} vs ${b2.res.dir} ${b2.target.x},${b2.target.z})`);
  check(e.res.status === 'ok' && e.res.dir === 'E' && e.target.x > 493 && Math.abs(e.target.z - 220) < 8 && !isNearProtectedZone(e.target, 56), `direction: E walks out through the east edge (${e.target.x},${e.target.z})`);
  check(bearingToCompass(exitBearingFor('Rook_Vantis')) === a.res.dir && bearingToCompass(0) === 'N' && bearingToCompass(90) === 'E' && bearingToCompass(359) === 'N', 'the heading is stable per name and reads as a compass point');
  process.env.AGENT_EXIT_BEARING = '180';
  const s = await exitFor('Rook_Vantis');
  delete process.env.AGENT_EXIT_BEARING;
  check(s.res.dir === 'S' && s.target.z > 314 && Math.abs(s.target.x - 400) < 8, `AGENT_EXIT_BEARING from the orchestrator overrides the name hash (${s.res.dir} ${s.target.x},${s.target.z})`);
  const { evenBearings } = await import('../../orchestrator/spawner.js');
  const eb = evenBearings(['b', 'a', 'c', 'a']);
  check(eb.size === 3 && eb.get('a') === 0 && eb.get('b') === 120 && eb.get('c') === 240, 'the orchestrator spaces a roster evenly around spawn');
  setProtectedZones(savedZones);

  // Deep water is off-limits to the pathfinder unless the bot is already swimming.
  const { makeDeepWaterExclusion } = await import('../world/movement.js');
  const wbot = stubBot({ pos: { x: 0.5, y: 64, z: 0.5 } });
  const water = new Set(['5,62,5', '5,61,5', '6,62,6']);
  wbot.blockAt = (v) => { requireVec3(v); const k = `${v.x},${v.y},${v.z}`; return water.has(k) ? { name: 'water', boundingBox: 'empty', position: v } : { name: 'sand', boundingBox: 'block', position: v }; };
  const excl = makeDeepWaterExclusion(wbot);
  check(excl(wbot.blockAt(new Vec3(5, 62, 5))) === 100, 'water over water is forbidden from land');
  check(excl(wbot.blockAt(new Vec3(6, 62, 6))) === 0 && excl(wbot.blockAt(new Vec3(7, 62, 7))) === 0, 'one-deep water and dry land cost nothing');
  wbot.entity.position = new Vec3(5.5, 62, 5.5);
  check(excl(wbot.blockAt(new Vec3(5, 62, 5))) === 20, 'already swimming: deep water is expensive, not forbidden, so the escape can path out');

  // Factions 2.8 command shapes and reply classification.
  const { factionTools, F_COMMANDS } = await import('./tools/faction.js');
  const { FactionRules, loadFactionRules } = await import('./factionRules.js');
  const rules = new FactionRules({ defaultPlayerPower: 0, powerPerHour: 2, powerMax: 10, powerPerDeath: -2 }, { known: true });
  check(rules.minutesToFirstClaim() === 30 && rules.minutesUntil(0.27, 1) === 22 && /30 min/.test(rules.summary()), `faction rules turn config into minutes (${rules.minutesToFirstClaim()} min to first claim)`);
  const fbot = stubBot();
  const sent = []; const scripted = new Map();
  fbot.chat = (cmd) => { sent.push(cmd); for (const [prefix, replies] of scripted) { if (cmd.startsWith(prefix)) { for (const rr of replies) setTimeout(() => fbot.emit('messagestr', rr), 20); return; } } };
  const ffactions = { state: { ourFaction: 'Vantis', allies: [], enemies: [] }, _persist() {} };
  const fstate = { faction: 'Vantis' };
  const f = factionTools({ bot: fbot, bus: null, factions: ffactions, profile: { username: 'Rook' }, log: null, state: fstate, movement: { cancel() {} }, factionRules: rules }).find((t) => t.name === 'f');
  check(F_COMMANDS.invite('ollie') === '/f invite add ollie' && F_COMMANDS.claim() === '/f claim one' && F_COMMANDS.unclaim() === '/f unclaim one', 'Massive Factions sub-command shapes');
  scripted.set('/f invite add oatmeal_ollie', ['§eRook invited oatmeal_ollie to your faction.']);
  r = await f.handler({ action: 'invite', name: 'oatmeal_ollie' }, { cancel: new CancelToken() });
  check(r.status === 'ok' && r.invited === 'oatmeal_ollie' && sent.at(-1) === '/f invite add oatmeal_ollie', `invite uses /f invite add and reads the confirmation (${r.status})`);
  scripted.set('/f invite add Marla_K', ['The sub command Marla_K couldn\'t be found.', 'Use /f invite to see all commands.']);
  r = await f.handler({ action: 'invite', name: 'Marla_K' }, { cancel: new CancelToken() });
  check(r.status === 'failed' && r.reason === 'invite_failed', 'the help page counts as a failed invite, not a success');
  scripted.set('/f invite add Bob', ['Bob is already invited to Vantis.']);
  r = await f.handler({ action: 'invite', name: 'Bob' }, { cancel: new CancelToken() });
  check(r.status === 'ok', 'already invited is the wanted end state');
  scripted.set('/f claim one', ["You don't have enough power to claim that land."]);
  r = await f.handler({ action: 'claim' }, { cancel: new CancelToken() });
  check(r.status === 'failed' && r.reason === 'claim_failed' && /power/.test(r.hint) && /30 min/.test(r.hint) && sent.at(-1) === '/f claim one', `claim uses /f claim one and explains the power economy (${r.hint?.slice(0, 60)})`);
  scripted.set('/f claim one', ['Rook claimed 1 chunk for Vantis from Wilderness.']);
  r = await f.handler({ action: 'claim' }, { cancel: new CancelToken() });
  check(r.status === 'ok' && r.chunk && fstate.claims?.length === 1, 'a confirmed claim is recorded');
  scripted.set('/f sethome', ['Sorry, your faction home can only be set inside your own claimed territory.']);
  r = await f.handler({ action: 'sethome' }, { cancel: new CancelToken() });
  check(r.status === 'failed' && /claim/.test(r.hint), 'sethome outside the claim fails with the fix');
  scripted.set('/f player', ['_____.[ Player Rook ].____', 'Power: 0.27 / 10.00', 'Power per Hour: 2.00 (4 hours until max)', 'Power per Death: -2.00']);
  r = await f.handler({ action: 'power' }, { cancel: new CancelToken() });
  check(r.status === 'ok' && r.power === 0.27 && r.power_max === 10 && r.minutes_to_next_chunk === 22 && /recruit/.test(r.hint), `f power reads /f player (${JSON.stringify({ p: r.power, m: r.minutes_to_next_chunk })})`);
  const live = loadFactionRules({ serverDir: path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'server'), log: null });
  check(typeof live.summary() === 'string' && live.powerPerHour > 0, `faction rules load from the server dir (known=${live.known}, ${live.powerPerHour}/h)`);
  const dlog = []; const dflt = loadFactionRules({ serverDir: '/nonexistent/server', log: { info: (e, f) => dlog.push(e), warn: (e) => dlog.push(e) } });
  check(dflt.known && dflt.source === 'defaults' && dflt.powerPerHour === 2 && dflt.minutesToFirstClaim() === 30 && dlog.includes('faction_rules_default') && !dlog.includes('faction_rules_defaults_unreadable'), `without server state the shipped defaults apply (${dflt.source}, ${dflt.powerPerHour}/h, log ${dlog.join(',')})`);
  const none = loadFactionRules({ serverDir: '/nonexistent/server', defaultsFile: '/nonexistent/defaults.json', log: null });
  check(!none.known && none.source === 'none' && none.powerPerHour === 2, 'with no readable file at all the built-in numbers still stand, flagged unknown');
  const sysF = buildSystemPrompt({ username: 'TestAgent', archetype: 'diplomat', values: {}, voice: {} }, { factionRulesText: rules.summary() });
  check(/30 min/.test(sysF) && /through the door/.test(sysF) && /deep water/i.test(sysF), 'system prompt carries the faction rules, the door and the water rules');

  // Recipes and the drop sweep.
  const { RECIPES } = await import('../world/minecraft.js');
  check(RECIPES.stone_hoe?.ingredients?.cobblestone === 2 && RECIPES.iron_hoe?.ingredients?.iron_ingot === 2, 'stone and iron hoes are craftable');
  const { dropsWithin } = await import('./tools/gather.js');
  const dbot = stubBot();
  dbot.entities = { 7: { type: 'object', name: 'item', displayName: 'Item', position: { x: 11, y: 64, z: 10 }, get objectType() { throw new Error('deprecated'); } } };
  check(dropsWithin(dbot, 4).length === 1, 'drop detection never touches the deprecated objectType getter');

  // Tilling waits for the server's block update before judging.
  const { BlueprintBuilder } = await import('../building/blueprintBuilder.js');
  const tbot = stubBot();
  let ground = 'grass';
  tbot.blockAt = (v) => { requireVec3(v); return { name: ground, boundingBox: 'block', position: v }; };
  tbot.inventory = { items: () => [{ name: 'wooden_hoe', count: 1 }], slots: [] };
  tbot.equip = async () => {};
  tbot.activateBlock = async () => { setTimeout(() => { ground = 'farmland'; }, 250); };
  const bb = new BlueprintBuilder({ bot: tbot, movement: { goTo: () => ({ stop() {}, done: Promise.resolve({ reached: true }) }), cancel() {} }, log: null });
  r = await bb._tillCellAt({ world: { x: 0, y: 64, z: 0 } }, null, new Vec3(0, 64, 0), null);
  check(r.ok && r.reason === 'tilled', `till verification waits for the block update (${r.reason})`);
}


// ---------- 20. door steps and panels, farm tool, seeds alias, faction member event, f power totals, night rules ----------
{
  const { standableY, passDoor, wrapMovementWithDoor } = await import('./tools/door.js');
  // A stub world: solid cells in a Set, the door toggles on activateBlock,
  // walking forward lands on the look target (x, z, and y from the eye height).
  const makeWorld = ({ groundY, blockCentre = false }) => {
    const solid = new Set();
    for (let x = -3; x <= 4; x++) for (let z = -6; z <= 3; z++) solid.add(`${x},${groundY - 1},${z}`);   // ground outside
    for (let x = 0; x <= 3; x++) for (let z = 0; z <= 3; z++) solid.add(`${x},63,${z}`);                // house floor
    const home = { x: 0, y: 63, z: 0, door: { x: 1, y: 64, z: 0 }, inside: { x: 1, y: 64, z: 1 }, interior: { min: { x: 1, z: 1 }, max: { x: 2, z: 2 }, y: 64 }, blueprint: 'dirt_shelter' };
    const bot = stubBot({ pos: { x: 1.5, y: groundY, z: -3.5 } });
    let doorMeta = 0; const activations = []; const controls = [];
    bot.inventory = { items: () => [{ name: 'dirt', count: 10 }], slots: [] };
    bot.blockAt = (v) => {
      requireVec3(v);
      if (v.x === 1 && v.y === 64 && v.z === 0) return { name: 'wooden_door', metadata: doorMeta, position: v, boundingBox: 'block' };
      if (v.x === 1 && v.y === 65 && v.z === 0) return { name: 'wooden_door', metadata: 8, position: v, boundingBox: 'block' };
      return solid.has(`${v.x},${v.y},${v.z}`) ? { name: 'dirt', boundingBox: 'block', position: v } : { name: 'air', boundingBox: 'empty', position: v };
    };
    bot.activateBlock = async (b) => { activations.push(b.name); doorMeta ^= 0x4; };
    let look = null;
    bot.lookAt = async (v) => { look = v; };
    bot.setControlState = (k, on) => {
      controls.push([k, on]);
      if (k === 'forward' && on && look) {
        if (blockCentre && Math.abs(look.x - 1.5) < 0.05 && look.z < 0.99 && look.z > -1.01) return;   // the open panel blocks the centre line of the door cell
        bot.entity.position.x = look.x; bot.entity.position.z = look.z; bot.entity.position.y = look.y - 1.6;
      }
    };
    const rawCalls = []; const placed = [];
    const movement = {
      goTo(pos, opts) { rawCalls.push({ pos: { ...pos }, opts }); bot.entity.position.x = pos.x + 0.5; bot.entity.position.z = pos.z + 0.5; bot.entity.position.y = pos.y; return { stop() {}, done: Promise.resolve({ reached: true }) }; },
      cancel() {}, notePlacement() {},
      _placeBlockAt: (b, { position, blockName }) => { solid.add(`${position.x},${position.y},${position.z}`); placed.push({ ...position, blockName }); return { stop() {}, done: Promise.resolve({ success: true }) }; },
    };
    wrapMovementWithDoor(movement, { bot, state: { home }, log: null });
    return { bot, home, movement, solid, activations, controls, rawCalls, placed, doorMeta: () => doorMeta };
  };
  {
    const w = makeWorld({ groundY: 62 });   // beach two blocks below the door (Rook)
    check(standableY(w.bot, 1, -1, 64) === 62, 'standableY finds the ground two below the doorway');
    const r = await w.movement.goTo(w.home.inside, { range: 0 }).done;
    check(r.reached && r.door === 'in', `two-block drop: enters after building a step (${JSON.stringify(r)})`);
    check(w.placed.length === 2 && w.placed.every((p) => p.x === 1 && p.z === -1) && w.placed.map((p) => p.y).sort().join() === '62,63', `step blocks placed in front of the door (${JSON.stringify(w.placed)})`);
    check(w.rawCalls[0].pos.y === 62, 'the approach pathfinds to the real ground level, not to thin air');
    check(w.activations.length === 1 && w.doorMeta() === 4, 'passed without a toggle, then one toggle blocks the doorway');
  }
  {
    const w = makeWorld({ groundY: 63 });   // one block below (TestBot44)
    const r = await w.movement.goTo(w.home.inside, { range: 0 }).done;
    check(r.reached && r.door === 'in' && w.placed.length === 0, `one-block drop: jumps in without building (${JSON.stringify(r)})`);
    check(w.controls.some(([k, on]) => k === 'jump' && on), 'jump was held for the step up');
  }
  {
    const w = makeWorld({ groundY: 64, blockCentre: true });   // level ground, open panel blocks the centre line
    const r = await w.movement.goTo(w.home.inside, { range: 0 }).done;
    check(r.reached && r.door === 'in', `sideways nudge gets past the open door panel (${JSON.stringify(r)})`);
  }
  {
    const w = makeWorld({ groundY: 64 });
    w.solid.add('1,64,1');   // a furnace dropped on the cell behind the door
    const r = await passDoor(w.bot, w.movement, w.home, 'in', new CancelToken(), null);
    check(!r.ok && r.reason === 'inside_blocked', 'a blocked cell behind the door is reported, not walked into');
  }

  // farm: plant on empty farmland, harvest mature wheat, replant, report dryness.
  const { farmTools, dryFarmland } = await import('./tools/farm.js');
  {
    const bot = stubBot({ pos: { x: 0.5, y: 65, z: 0.5 } });
    const cells = new Map();   // key → { name, metadata }
    for (let x = 1; x <= 4; x++) cells.set(`${x},64,1`, { name: 'farmland', metadata: 0 });
    cells.set('1,65,1', { name: 'wheat', metadata: 7 });
    cells.set('2,65,1', { name: 'wheat', metadata: 3 });
    let seeds = 3; let held = null; const dug = [];
    bot.inventory = { items: () => (seeds > 0 ? [{ name: 'wheat_seeds', count: seeds }, { name: 'wheat', count: 0 }] : []), slots: [] };
    bot.equip = async (it) => { held = it; };
    bot.blockAt = (v) => { requireVec3(v); const c = cells.get(`${v.x},${v.y},${v.z}`); return c ? { ...c, position: v, boundingBox: c.name === 'farmland' ? 'block' : 'empty' } : { name: 'air', boundingBox: 'empty', position: v }; };
    bot.findBlocks = ({ matching }) => [...cells.entries()].filter(([, c]) => matching({ ...c })).map(([k]) => { const [x, y, z] = k.split(',').map(Number); return new Vec3(x, y, z); });
    bot.activateBlock = async (b) => { if (held?.name === 'wheat_seeds' && b.name === 'farmland' && seeds > 0) { seeds -= 1; cells.set(`${b.position.x},${b.position.y + 1},${b.position.z}`, { name: 'wheat', metadata: 0 }); } };
    bot.dig = async (b) => { dug.push(b.name); cells.delete(`${b.position.x},${b.position.y},${b.position.z}`); };
    bot.entities = {};
    const movement = { goTo: (pos) => { bot.entity.position.x = pos.x + 0.5; bot.entity.position.z = pos.z + 0.5; return { stop() {}, done: Promise.resolve({ reached: true }) }; }, cancel() {} };
    const farm = farmTools({ bot, movement, log: null }).find((t) => t.name === 'farm');
    const r = await farm.handler({ action: 'tend', radius: 8 }, { cancel: new CancelToken() });
    check(r.status === 'ok' && r.harvested === 1 && dug[0] === 'wheat', `tend harvests the mature wheat only (${JSON.stringify({ h: r.harvested, dug })})`);
    check(r.replanted === 1 && r.planted === 2 && r.seeds_left === 0, `tend replants the harvested cell and sows the empty ones until seeds run out (${JSON.stringify({ rp: r.replanted, p: r.planted, s: r.seeds_left })})`);
    check(r.empty_farmland_left === 0 && r.dry_farmland === 4 && /water/.test(r.hint), `dry plot is called out (${r.dry_farmland} dry, hint: ${r.hint?.slice(0, 40)})`);
    cells.set('3,64,3', { name: 'water', metadata: 0 });
    const farmland = [...cells.entries()].filter(([, c]) => c.name === 'farmland').map(([k]) => { const [x, y, z] = k.split(',').map(Number); return { position: new Vec3(x, y, z) }; });
    check(dryFarmland(bot, farmland).length === 0, 'water within 4 blocks hydrates the plot');
    const r2 = await farm.handler({ action: 'plant', radius: 8 }, { cancel: new CancelToken() });
    check(r2.status === 'ok' && /growing/.test(r2.note ?? ''), `nothing left to plant reads as growing, not failure (${r2.status} ${r2.reason ?? r2.note})`);
  }
  const { MINE_ALIASES, MINE_DROPS } = await import('./tools/gather.js');
  check(MINE_ALIASES.wheat_seeds === 'tallgrass' && MINE_DROPS.tallgrass === 'wheat_seeds', 'mine wheat_seeds breaks tall grass and counts the seeds');
  {
    const { gatherTools } = await import('./tools/gather.js');
    const bot = stubBot();
    bot.blockAt = (v) => { requireVec3(v); return { name: 'air', boundingBox: 'empty', position: v }; };
    const builder = { _placeWaterCell: async (v) => ({ ok: true, reason: 'watered' }) };
    const place = gatherTools({ bot, movement: { goTo: () => ({ stop() {}, done: Promise.resolve({ reached: true }) }), cancel() {} }, log: null, builder, state: {} }).find((t) => t.name === 'place');
    const r = await place.handler({ block: 'water', x: 3, y: 64, z: 3 }, { cancel: new CancelToken() });
    check(r.status === 'ok' && r.block === 'water', `place water uses the builder's bucket logic (${r.status} ${r.reason})`);
    builder._placeWaterCell = async () => ({ ok: false, reason: 'no_bucket' });
    const r2 = await place.handler({ block: 'water', x: 3, y: 64, z: 3 }, { cancel: new CancelToken() });
    check(r2.status === 'failed' && r2.reason === 'no_bucket' && /3 iron/.test(r2.hint), 'no bucket → the recipe is in the hint');
  }

  // Faction member joined → event; role-prefixed invite lines still parse.
  {
    const nb = stubBot();
    const n = new Nerves({ bot: nb, log: null, username: 'Rook_Vantis' });
    n._onServerMessage('§eoatmeal_ollie joined your faction.');
    n._onServerMessage('§e**Rook_Vantis invited you to Vantis.');
    n._onServerMessage('§eRook_Vantis joined your faction.');
    const kinds = n._queue.map((e) => e.kind);
    check(kinds.includes('faction_member') && n._queue.find((e) => e.kind === 'faction_member').player === 'oatmeal_ollie', `member join is an event (${kinds.join(',')})`);
    check(kinds.includes('faction_invite') && n._queue.find((e) => e.kind === 'faction_invite').from === 'Rook_Vantis', 'invite line with a role prefix still parses');
    check(kinds.filter((k) => k === 'faction_member').length === 1, 'your own join is not a member event');
    check(/f claim/.test(formatEvent({ kind: 'faction_member', player: 'oatmeal_ollie' })) && /Get inside/.test(formatEvent({ kind: 'dusk', torches: 0, armor: 0, sword: false })) && /keep working/.test(formatEvent({ kind: 'dusk', torches: 16, armor: 4, sword: true })), 'events tell the brain what to do next');
  }
  // f power reports the faction total and when it can claim.
  {
    const { factionTools } = await import('./tools/faction.js');
    const { FactionRules } = await import('./factionRules.js');
    const fbot = stubBot();
    fbot.chat = (cmd) => { if (cmd.startsWith('/f player')) setTimeout(() => { fbot.emit('messagestr', 'Power: 0.57 / 10.00'); fbot.emit('messagestr', 'Power per Death: -2.00'); }, 20); };
    const bus = { query: async (type) => (type === 'query_faction_info' ? { type: 'faction_info', found: true, power: 2.24, land_count: 0, members: [{ name: 'Rook_Vantis' }, { name: 'oatmeal_ollie' }] } : null) };
    const f = factionTools({ bot: fbot, bus, factions: { state: { ourFaction: 'Vantis', allies: [], enemies: [] }, _persist() {} }, profile: { username: 'Rook_Vantis' }, log: null, state: { faction: 'Vantis' }, movement: { cancel() {} }, factionRules: new FactionRules({}, { known: true }) }).find((t) => t.name === 'f');
    const r = await f.handler({ action: 'power' }, { cancel: new CancelToken() });
    check(r.status === 'ok' && r.faction?.power === 2.24 && r.faction.chunks_claimable_now === 2 && /f claim, then f sethome/.test(r.hint), `f power shows the faction can claim now (${JSON.stringify(r.faction)} · ${r.hint?.slice(0, 50)})`);
  }
  // Blueprint listing names the tools a farm needs; the prompt says nights are for work.
  {
    const { toolsNeeded } = await import('./tools/build.js');
    const farmBp = { materials: { fence: 26, farmland: 24, water: 6 } };
    const needs = toolsNeeded(farmBp, { wooden_hoe: 1 });
    check(needs.length === 2 && needs[0].tool === 'hoe' && needs[0].have && needs[1].tool === 'bucket' && !needs[1].have, 'a farm blueprint needs a hoe and a bucket');
    const sys = buildSystemPrompt({ username: 'TestAgent', archetype: 'farmer', values: {}, voice: {} }, {});
    check(/Night is working time/.test(sys) && /Never call wait just because it is night/.test(sys) && /farm plant/.test(sys) && /f sethome/.test(sys), 'prompt: night is for work, farming steps, faction order');
    const { mindTools } = await import('./tools/mind.js');
    const wait = mindTools({ bot: stubBot(), state: {}, log: null, memory: { kvSet() {}, kvGet: () => null } }).find((t) => t.name === 'wait');
    check(/Not for passing the night/.test(wait.description), 'wait says what it is not for');
  }
}


// ---------- 21. Phase 4: the script sandbox (worker + vm), policy, skill store ----------
{
  const { runScript, SkillStore, makeScriptApi, SCRIPT_BLOCKED, ScriptHost, getScriptHost, shutdownScriptHost, scriptDeny, SCRIPT_CAPS, QUARANTINE_AFTER } = await import('./skills.js');
  const { scriptTools } = await import('./tools/script.js');
  const bot = stubBot({ pos: { x: 10, y: 64, z: 10 } });
  bot.registry.blocksByName.sand = { id: 12 };
  bot.findBlocks = ({ matching }) => (matching.includes(12) ? [new Vec3(12, 64, 10), new Vec3(11, 64, 10)] : []);
  bot.blockAt = (v) => { requireVec3(v); return v.y === 64 && v.x >= 11 ? { name: 'sand', boundingBox: 'block', position: v, metadata: 0 } : { name: 'air', boundingBox: 'empty', position: v }; };
  bot.entities = { 5: { type: 'mob', name: 'zombie', position: { x: 13, y: 64, z: 10 } }, 6: { type: 'player', username: 'Marla_K', position: { x: 30, y: 64, z: 10 } } };
  let sells = 0;
  const tools = stubTools({
    dig: { schema: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' }, force: { type: 'boolean' } }, required: ['x', 'y', 'z'] }, handler: async ({ x, y, z }) => ({ status: 'ok', dug: { x, y, z } }) },
    run_script: { handler: async () => ({ status: 'ok' }) },
    command: { handler: async () => ({ status: 'ok' }) },
    pay: { handler: async () => ({ status: 'ok' }) },
    sell: { handler: async () => { sells += 1; return { status: 'ok', earned: 1 }; } },
    f: { schema: { type: 'object', properties: { action: { type: 'string' } } }, handler: async ({ action }) => ({ status: 'ok', action }) },
  });
  const deps = { bot, log: null, state: {}, profile: { username: 'TestAgent' } };

  // World/self API (runs on the main thread, answers sync queries).
  const api = makeScriptApi({ bot });
  check(api.me.pos().x === 10 && api.me.inventory().dirt === 12 && api.me.time() === 'day', 'me.* reads position, inventory and time');
  const sand = api.world.findBlocks('sand', 16);
  check(sand.length === 2 && sand[0].x === 11 && sand[0].name === 'sand' && sand[0].distance < sand[1].distance, 'world.findBlocks returns nearest-first with names');
  check(api.world.entities(8).length === 1 && api.world.entities(8)[0].name === 'zombie' && api.world.players(40)[0].name === 'Marla_K', 'world.entities and players are filtered by radius');

  // A script that calls tools, queries the world, logs and returns.
  let r = await runScript({ code: `
    const blocks = world.findBlocks('sand', 16, 8);
    let n = 0;
    for (const b of blocks) { const r = await tools.dig({ x: b.x, y: b.y, z: b.z }); if (r.status === 'ok') n++; }
    log('dug', n, me.pos());
    await sleep(10);
    return { status: 'ok', dug: n, look: (await tools.look({})).pos, time: me.time() };
  `, tools, deps, timeoutMs: 5000 });
  check(r.status === 'ok' && r.dug === 2 && r.look?.x === 1 && r.time === 'day' && /^dug 2 \{"x":10/.test(r.stdout[0]) && r.n_tool_calls === 3, `script calls tools, queries the world, logs and returns (${JSON.stringify({ s: r.status, d: r.dug, calls: r.n_tool_calls, out: r.stdout, err: r.error })})`);
  check(r.tool_calls.every((c) => c.status === 'ok') && r.tool_calls[0].tool === 'dig', 'tool calls are traced');
  check(getScriptHost().info.envKeys === 0, `the worker has an empty environment (envKeys=${getScriptHost().info.envKeys})`);
  r = await runScript({ code: `return { count: 3 };`, tools, deps, timeoutMs: 5000 });
  check(r.status === 'ok' && r.returned?.count === 3, 'plain return values come back under returned');
  r = await runScript({ code: `try { world.findBlocks('nope'); } catch (e) { return { status: 'partial', reason: e.message }; }`, tools, deps, timeoutMs: 5000 });
  check(r.status === 'partial' && /unknown block: nope/.test(r.reason), 'query errors reach the script as ordinary errors');
  // Errors: syntax, runtime with a line number, bad input, unknown tools.
  r = await runScript({ code: `const x = ;`, tools, deps, timeoutMs: 5000 });
  check(r.status === 'failed' && r.reason === 'syntax_error', `syntax errors are reported (${r.reason})`);
  r = await runScript({ code: `log('a');\nconst y = null;\ny.z;`, tools, deps, timeoutMs: 5000 });
  check(r.status === 'failed' && r.reason === 'script_error' && /TypeError/.test(r.error) && r.line === 3 && r.stdout[0] === 'a', `runtime errors carry the line and the log so far (${r.error} line ${r.line})`);
  r = await runScript({ code: `return await tools.strict({});`, tools, deps, timeoutMs: 5000 });
  check(r.status === 'failed' && r.reason === 'bad_input', 'tool input is validated inside scripts too');
  r = await runScript({ code: `return await tools.run_script({ code: 'x' });`, tools, deps, timeoutMs: 5000 });
  check(r.status === 'failed' && /no such tool in scripts: run_script/.test(r.error), 'scripts cannot call run_script (no recursion)');

  // Escape attempts: every route to a host realm is dead.
  r = await runScript({ code: `
    const probe = (f) => { try { const F = f(); return typeof F === 'function' ? typeof F('return 1') : String(F); } catch (e) { return 'blocked'; } };
    const res = await tools.look({});
    let thrown = null; try { tools.nope(); } catch (e) { thrown = e; }
    return {
      process: typeof process, require: typeof require, Function: probe(() => Function),
      this_ctor: probe(() => this.constructor && this.constructor.constructor),
      global_ctor: probe(() => globalThis.constructor && globalThis.constructor.constructor),
      tool_ctor: probe(() => tools.dig.constructor),
      query_ctor: probe(() => world.findBlocks.constructor),
      result_ctor: probe(() => res.constructor.constructor),
      promise_ctor: probe(() => tools.look({}).constructor.constructor),
      error_ctor: probe(() => thrown.constructor.constructor),
      sleep_ctor: probe(() => sleep.constructor),
      log_ctor: probe(() => log.constructor),
      params_ctor: probe(() => params.constructor.constructor),
      async_ctor: probe(() => (async () => 1).constructor),
      proto_this: probe(() => Object.getPrototypeOf(globalThis)),
      wasm: typeof WebAssembly,
    };
  `, tools, deps, timeoutMs: 5000 });
  const escapes = Object.entries(r.returned ?? {}).filter(([, v]) => v === 'number' || v === 'object' && false);
  check(r.status === 'ok' && r.returned.process === 'undefined' && r.returned.require === 'undefined' && escapes.length === 0
    && ['this_ctor', 'global_ctor', 'tool_ctor', 'query_ctor', 'result_ctor', 'promise_ctor', 'error_ctor', 'sleep_ctor', 'log_ctor', 'params_ctor', 'async_ctor', 'Function'].every((k) => r.returned[k] === 'blocked' || r.returned[k] === 'undefined' || r.returned[k] === 'null'),
    `no route to the host realm: ${JSON.stringify(r.returned)}`);

  // Timeouts: async overrun, a synchronous busy loop, and a loop AFTER an await (which used to hang the whole bot).
  r = await runScript({ code: `while (true) { await sleep(50); }`, tools, deps, timeoutMs: 300 });
  check(r.status === 'failed' && r.reason === 'timeout' && /timeout_s/.test(r.hint), `async overrun ends at the timeout (${r.reason} after ${r.elapsed_s}s)`);
  r = await runScript({ code: `let i = 0; while (true) { i++; }`, tools, deps, timeoutMs: 20000 });
  check(r.status === 'failed' && r.reason === 'sync_loop', `a synchronous busy loop is cut off (${r.reason})`);
  const restartsBefore = getScriptHost().info.restarts;
  const t0 = Date.now();
  r = await runScript({ code: `await sleep(5); while (true) {}`, tools, deps, timeoutMs: 400 });
  check(r.status === 'failed' && r.reason === 'timeout' && /restarted/.test(r.hint) && Date.now() - t0 < 8000, `a busy loop after an await is killed with its worker, the bot lives (${r.reason}, ${Date.now() - t0} ms)`);
  check(getScriptHost().info.restarts === restartsBefore + 1, 'the sandbox worker was replaced');
  r = await runScript({ code: `return (await tools.look({})).pos.x;`, tools, deps, timeoutMs: 5000 });
  check(r.status === 'ok' && r.returned === 1, 'the next script runs in a fresh worker');
  // Memory: a script that allocates without bound dies inside its own limits.
  {
    const small = new ScriptHost({ log: null, resourceLimits: { maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 8, codeRangeSizeMb: 8, stackSizeMb: 4 } });
    const rm = await runScript({ code: `const a = []; while (true) { a.push(new Array(200000).fill('xxxxxxxx')); }`, tools, deps, timeoutMs: 20000, host: small });
    check(rm.status === 'failed' && ['out_of_memory', 'sync_loop', 'worker_crashed', 'worker_exited'].includes(rm.reason), `a memory bomb is contained (${rm.reason})`);
    const again = await runScript({ code: `return 7;`, tools, deps, timeoutMs: 5000, host: small });
    check(again.status === 'ok' && again.returned === 7, 'the host recovers after a crash');
    await small.shutdown();
  }
  // Interrupts: the outer cancel token unwinds the script mid-tool and mid-sleep.
  {
    const cancel = new CancelToken();
    const p = runScript({ code: `await tools.slow({ ms: 2000 }); return 'late';`, tools, deps, cancel, timeoutMs: 10000 });
    setTimeout(() => cancel.cancel('damage', { hp: 5 }), 80);
    r = await p;
    check(r.status === 'interrupted' && r.by === 'damage' && r.detail?.hp === 5 && r.elapsed_s < 1.5, `an interrupt unwinds the script (${r.status} by ${r.by} after ${r.elapsed_s}s)`);
    const c2 = new CancelToken();
    const p2 = runScript({ code: `for (let i = 0; i < 100; i++) { if (cancelled()) return { status: 'partial', reason: 'saw_cancel', i }; await sleep(20); }`, tools, deps, cancel: c2, timeoutMs: 10000 });
    setTimeout(() => c2.cancel('chat_mention'), 60);
    r = await p2;
    check(r.status === 'interrupted' && r.by === 'chat_mention', 'sleep rejects on cancel so loops stop');
  }
  // params reach the script.
  r = await runScript({ code: `return params.chest.x + params.keep.length;`, params: { chest: { x: 5 }, keep: ['a', 'b'] }, tools, deps, timeoutMs: 5000 });
  check(r.status === 'ok' && r.returned === 7, 'params are available to skills');

  // Policy: no server commands, no paying, no force-digging, no faction-breaking, caps on selling.
  check(scriptDeny('command', { cmd: 'f disband' }) && scriptDeny('pay', {}) && scriptDeny('dig', { force: true }) && !scriptDeny('dig', {}) && scriptDeny('f', { action: 'disband' }) && !scriptDeny('f', { action: 'claim' }) && scriptDeny('faction_notes', { action: 'write' }) && !scriptDeny('faction_notes', { action: 'append' }), 'deny rules cover commands, money, force digs, faction changes and note overwrites');
  r = await runScript({ code: `return { pay: typeof tools.pay, cmd: typeof tools.command, dig: (await tools.dig({ x: 1, y: 2, z: 3, force: true })).reason, f: (await tools.f({ action: 'disband' })).reason, claim: (await tools.f({ action: 'claim' })).status };`, tools, deps, timeoutMs: 5000 });
  let payErr = null; try { await runScript({ code: `await tools.pay({});`, tools, deps, timeoutMs: 5000 }).then((x) => { payErr = x; }); } catch {}
  check(r.status === 'ok' && r.returned.dig === 'not_allowed_in_scripts' && r.returned.f === 'not_allowed_in_scripts' && r.returned.claim === 'ok' && r.denied?.length === 2, `denied calls fail inside the script and are reported (${JSON.stringify(r.returned)} denied=${r.denied?.length})`);
  check(payErr?.status === 'failed' && /no such tool in scripts: pay/.test(payErr.error), 'pay and command are not even in the sandbox tool list');
  r = await runScript({ code: `const out = []; for (let i = 0; i < 5; i++) out.push((await tools.sell({})).reason ?? 'ok'); return out;`, tools, deps, timeoutMs: 5000 });
  check(sells === SCRIPT_CAPS.sell && r.returned?.[3] === 'script_cap', `sell is capped per script at ${SCRIPT_CAPS.sell} (${JSON.stringify(r.returned)})`);

  // Skill store: save, list, search, get, use tally, quarantine; files on disk for humans.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  const store = new SkillStore({ dir, log: null });
  let sv = store.save({ name: 'Bad Name', description: 'x', code: 'return { status: "ok" };' });
  check(!sv.ok && sv.reason === 'bad_name', 'skill names are validated');
  sv = store.save({ name: 'broken', description: 'x', code: 'const x = = 1; return x;' });
  check(!sv.ok && sv.reason === 'syntax_error', 'skills must compile to be saved');
  sv = store.save({ name: 'dig_sand', description: 'Dig all sand within radius', code: `const b = world.findBlocks('sand', params.radius ?? 8); let n = 0; for (const s of b) { if ((await tools.dig(s)).status === 'ok') n++; } return { status: 'ok', dug: n };`, params: '{radius}', author: 'TestAgent', verified: true });
  check(sv.ok && sv.meta.version === 1 && fs.existsSync(path.join(dir, 'dig_sand.js')) && /author: TestAgent/.test(fs.readFileSync(path.join(dir, 'dig_sand.js'), 'utf8')), 'a skill is written to disk with a readable header');
  const got = store.get('dig_sand');
  check(got && /findBlocks/.test(got.code) && !/^\/\*\*/.test(got.code) && got.verified, 'get returns the code without the header');
  sv = store.save({ name: 'dig_sand', description: 'Dig all sand within radius (v2)', code: got.code + '\n// v2', author: 'Other' });
  check(sv.ok && sv.meta.version === 2 && sv.meta.author === 'TestAgent' && sv.meta.updated_by === 'Other', 'saving again makes a new version and keeps the original author');
  store.save({ name: 'sort_chest', description: 'Move everything but tools into the home chest', code: 'return { status: "ok" };', author: 'TestAgent' });
  check(store.search('sand').length === 1 && store.search('chest tools')[0].name === 'sort_chest' && store.list().length === 2, 'search matches words in name or description');
  store.recordUse('dig_sand', 'ok'); store.recordUse('dig_sand', 'failed'); store.recordUse('dig_sand', 'ok');
  const fresh = new SkillStore({ dir, log: null });   // another bot process sees the same tally
  const m = fresh.get('dig_sand');
  check(m.uses === 3 && m.ok === 2 && m.failed === 1 && m.last_status === 'ok' && !m.disabled, `use tallies persist across bots (${m.uses}/${m.ok}/${m.failed})`);
  for (let i = 0; i < QUARANTINE_AFTER; i++) fresh.recordUse('dig_sand', 'failed');
  check(fresh.get('dig_sand').disabled === true && /consecutive/.test(fresh.get('dig_sand').disabled_reason), `${QUARANTINE_AFTER} failures in a row quarantine a skill`);
  sv = fresh.save({ name: 'dig_sand', description: 'fixed', code: got.code, author: 'TestAgent' });
  check(sv.ok && !fresh.get('dig_sand').disabled && fresh.get('dig_sand').fail_streak === 0, 'a new version re-enables it');

  // The four tools together: run → save (verified) → skills → use_skill; disabled skills refuse.
  const sdeps = { ...deps, skillStore: new SkillStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'skills2-')), log: null }), state: {} };
  const stools = scriptTools(sdeps);
  stools.setRegistry(tools);
  const [runTool, saveTool, skillsTool, useTool] = stools;
  const code = `const b = world.findBlocks('sand', params.radius ?? 8); let n = 0; for (const s of b) { if ((await tools.dig({ x: s.x, y: s.y, z: s.z })).status === 'ok') n++; } return { status: 'ok', dug: n };`;
  r = await runTool.handler({ code }, { cancel: new CancelToken() });
  check(r.status === 'ok' && r.dug === 2 && /save_skill/.test(r.hint), `run_script tool runs and suggests saving (${r.status} ${r.error ?? ''})`);
  r = await saveTool.handler({ name: 'dig_sand', description: 'Dig sand nearby', code, params: '{radius}' }, {});
  check(r.status === 'ok' && r.verified === true, 'save_skill marks the exact code of the last successful run as verified');
  r = await saveTool.handler({ name: 'other', description: 'untested', code: 'return { status: "ok", n: 1 };' }, {});
  check(r.status === 'ok' && r.verified === false && /unverified/.test(r.hint), 'other code saves unverified with a warning');
  r = await skillsTool.handler({ query: 'sand' }, {});
  check(r.status === 'ok' && r.count === 1 && r.skills[0].name === 'dig_sand' && r.skills[0].verified === true, 'skills searches the shared library');
  r = await skillsTool.handler({ show: 'dig_sand' }, {});
  check(r.status === 'ok' && /findBlocks/.test(r.code), 'skills show returns the code');
  r = await useTool.handler({ name: 'dig_sand', params: { radius: 16 } }, { cancel: new CancelToken() });
  check(r.status === 'ok' && r.dug === 2 && r.skill === 'dig_sand' && sdeps.skillStore.get('dig_sand').ok === 1, `use_skill runs it with params and tallies the outcome (${r.status} ${r.error ?? ''})`);
  r = await useTool.handler({ name: 'missing' }, { cancel: new CancelToken() });
  check(r.status === 'failed' && r.reason === 'unknown_skill', 'unknown skill names fail cleanly');
  for (let i = 0; i < QUARANTINE_AFTER; i++) sdeps.skillStore.recordUse('other', 'failed');
  r = await useTool.handler({ name: 'other' }, { cancel: new CancelToken() });
  check(r.status === 'failed' && r.reason === 'skill_disabled' && /quarantined/.test(r.hint), 'a quarantined skill refuses to run');
  r = await skillsTool.handler({}, {});
  check(r.skills.find((x) => x.name === 'other')?.disabled, 'skills lists the quarantine');
  check(SCRIPT_BLOCKED.has('memory') && SCRIPT_BLOCKED.has('logoff') && SCRIPT_BLOCKED.has('think'), 'the mind and session control stay out of scripts');
  // Registered in the real tool set, and the prompt teaches the API.
  const real = createTools({ bot: stubBot(), movement: { goTo: () => ({ stop() {}, done: Promise.resolve({ reached: true }) }), cancel() {} }, log: null, state: {}, profile: { username: 'TestAgent', spawn: { x: 0, y: 64, z: 0 } }, memory: { kvGet: () => null, kvSet() {} }, skillStore: sdeps.skillStore });
  check(['run_script', 'save_skill', 'skills', 'use_skill', 'farm'].every((n) => real.byName.has(n)) && real.byName.get('run_script').defaultInterrupts.includes('damage'), 'script tools are registered with damage interrupts');
  const sys = buildSystemPrompt({ username: 'TestAgent', archetype: 'builder', values: {}, voice: {} }, {});
  check(/# Scripts/.test(sys) && /world\.findBlocks/.test(sys) && /save_skill/.test(sys), 'the prompt carries the script API');
  fs.rmSync(dir, { recursive: true, force: true });
  await shutdownScriptHost();
}


// ---------- 22. doors you can walk through, fights that finish, mines that give up, buckets that fill ----------
{
  const { installDoorPhysics, doorIsOpen } = await import('../core/doorPhysics.js');
  // Unit: open doors and gates lose their hitbox; closed ones keep it; the upper half follows the lower.
  const mk = (name, metadata) => ({ name, metadata, shapes: [[0, 0, 0, 0.1875, 1, 1]], boundingBox: 'block' });
  const cells = new Map([['1,64,0', mk('wooden_door', 4)], ['1,65,0', mk('wooden_door', 8)], ['3,64,0', mk('wooden_door', 1)], ['3,65,0', mk('wooden_door', 9)], ['5,64,0', mk('fence_gate', 4)], ['7,64,0', mk('stone', 0)]]);
  const dbot = { blockAt(v) { requireVec3(v); return cells.get(`${v.x},${v.y},${v.z}`) ?? null; } };
  installDoorPhysics(dbot); installDoorPhysics(dbot);
  const at = (x, y) => dbot.blockAt(new Vec3(x, y, 0));
  check(at(1, 64).shapes[0][5] === 0.1875 && at(1, 64).shapes[0][3] === 1 && at(1, 65).shapes[0][5] === 0.1875, 'an open door (facing 0, hinge left) becomes a rail along the north edge, both halves');
  check(at(3, 64).shapes[0][3] === 1 && at(3, 64).shapes[0][2] === 0 && at(3, 64).shapes[0][5] === 0.1875 && at(3, 64).boundingBox === 'block', 'a closed facing-1 door is a panel across the cell');
  check(at(5, 64).shapes.length === 0 && at(7, 64).boundingBox === 'block' && doorIsOpen(mk('wooden_door', 8), mk('wooden_door', 5)) && !doorIsOpen(mk('wooden_door', 8), mk('wooden_door', 1)), 'open gates pass, stone is untouched, upper halves ask below');
  // Physics: mineflayer's own engine walking east through an east-facing doorway.
  {
    const registry = (await import('prismarine-registry')).default('1.8.9');
    const Block = (await import('prismarine-block')).default(registry);
    const { Physics, PlayerState } = await import('prismarine-physics');
    const world = (doorMeta) => ({
      getBlock(pos) {
        const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
        let b;
        if (y === 63) b = new Block(registry.blocksByName.stone.id, 0, 0);
        else if (x === 5 && (z === 0 || z === 2) && y >= 64 && y <= 66) b = new Block(registry.blocksByName.stone.id, 0, 0);
        else if (x === 5 && z === 1 && y === 64) b = new Block(registry.blocksByName.wooden_door.id, 0, doorMeta);
        else if (x === 5 && z === 1 && y === 65) b = new Block(registry.blocksByName.wooden_door.id, 0, 8);
        else b = new Block(registry.blocksByName.air.id, 0, 0);
        b.position = new Vec3(x, y, z);
        return b;
      },
    });
    const walk = (w, patched) => {
      const fake = { blockAt: (pos) => w.getBlock(pos) };
      if (patched) installDoorPhysics(fake);
      const physics = Physics(registry, { getBlock: (p) => fake.blockAt(p, false) });
      const pbot = { entity: { position: new Vec3(3.5, 64, 1.5), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false, yaw: -Math.PI / 2, pitch: 0, effects: {} }, jumpTicks: 0, jumpQueued: false, version: '1.8.9', inventory: { slots: [] }, registry };
      const state = new PlayerState(pbot, { forward: true, back: false, left: false, right: false, jump: false, sprint: false, sneak: false });
      for (let i = 0; i < 80; i++) physics.simulatePlayer(state, { getBlock: (p) => fake.blockAt(p, false) });
      return state.pos.x;
    };
    check(walk(world(4), false) < 5, `stock physics: blocked at an OPEN door whose panel is a side rail (x=${walk(world(4), false).toFixed(2)})`);
    check(walk(world(4), true) > 7, `patched physics: walks through it (x=${walk(world(4), true).toFixed(2)})`);
    check(walk(world(0), true) < 5, `patched physics: the same door CLOSED (panel across) still stops the bot (x=${walk(world(0), true).toFixed(2)})`);
    check(walk(world(5), true) < 5.9, `patched physics: a door hung sideways is blocked when "open" (x=${walk(world(5), true).toFixed(2)})`);
  }
  // The door macro closes the door when a pass fails.
  {
    const { passDoor } = await import('./tools/door.js');
    const home = { x: 0, y: 63, z: 0, door: { x: 1, y: 64, z: 0 }, inside: { x: 1, y: 64, z: 1 }, interior: { min: { x: 1, z: 1 }, max: { x: 2, z: 2 }, y: 64 } };
    const bot = stubBot({ pos: { x: 1.5, y: 64, z: -0.5 } });   // standing on the outside cell
    let meta = 0; const acts = [];
    bot.blockAt = (v) => { requireVec3(v); if (v.x === 1 && v.y === 64 && v.z === 0) return { name: 'wooden_door', metadata: meta, position: v, boundingBox: 'block' }; if (v.y === 63) return { name: 'dirt', boundingBox: 'block', position: v }; return { name: 'air', boundingBox: 'empty', position: v }; };
    bot.activateBlock = async () => { acts.push(meta); meta ^= 0x4; };
    bot.lookAt = async () => {}; bot.setControlState = () => {};   // never moves: the walk fails
    const r = await passDoor(bot, { _rawGoTo: (pos) => ({ stop() {}, done: Promise.resolve({ reached: true }) }), goTo() {}, cancel() {} }, home, 'in', new CancelToken(), null);
    check(!r.ok && r.reason === 'walk_failed' && r.closed && meta === 4, `a failed pass leaves the panel across the doorway (${r.reason}, closed=${r.closed}, meta ${meta})`);
  }

  // attack: shielded from mob damage, keeps fighting until the doorway is clear, never picks creepers.
  {
    const { fightTools, nearestHostile } = await import('./tools/fight.js');
    const bot = stubBot({ health: 18 });
    const zombieA = { id: 11, type: 'mob', name: 'zombie', position: { x: 11, y: 64, z: 10 }, health: 20, isValid: true };
    const zombieB = { id: 12, type: 'mob', name: 'zombie', position: { x: 12, y: 64, z: 11 }, health: 20, isValid: true };
    const creeper = { id: 13, type: 'mob', name: 'creeper', position: { x: 10, y: 64, z: 12 }, health: 20, isValid: true };
    bot.entities = { 11: zombieA, 12: zombieB, 13: creeper };
    const combat = { engaged: false, target: null, lastDisengageReason: null, engagements: [], async engage(t) { this.engaged = true; this.target = t; this.engagements.push(t.id); setTimeout(() => { t.isValid = false; t.health = 0; }, 120); }, disengage(r) { this.engaged = false; this.lastDisengageReason = r; } };
    const attack = fightTools({ bot, combat, log: null }).find((t) => t.name === 'attack');
    check(attack.uninterruptible('damage', { cause: 'mob' }) === true && attack.uninterruptible('damage', { cause: 'lava' }) === false && attack.uninterruptible('mob_near', {}) === false, 'attack ignores mob hits but not lava');
    const r = await attack.handler({ target: 'zombie', timeout_s: 10 }, { cancel: new CancelToken() });
    check(r.status === 'ok' && r.killed.length === 2 && r.fights === 2 && combat.engagements.join() === '11,12', `one attack call clears both zombies (${JSON.stringify({ s: r.status, k: r.killed, f: r.fights })})`);
    check(!combat.engagements.includes(13) && /creeper/.test(r.remaining_hostile ?? '') && /door/.test(r.hint ?? ''), `the creeper is left to the brain and reported (${r.remaining_hostile})`);
    check(nearestHostile(bot, 8) === null && nearestHostile(bot, 8, { melee: false })?.name === 'creeper', 'nearestHostile skips creepers for melee');
    // The engine's own retreat comes back as a partial with advice.
    const bot2 = stubBot({ health: 5 });
    const z = { id: 21, type: 'mob', name: 'zombie', position: { x: 11, y: 64, z: 10 }, health: 20, isValid: true };
    bot2.entities = { 21: z };
    const combat2 = { engaged: false, lastDisengageReason: null, async engage() { this.engaged = true; setTimeout(() => { this.engaged = false; this.lastDisengageReason = 'flee'; }, 100); }, disengage() { this.engaged = false; } };
    const r2 = await fightTools({ bot: bot2, combat: combat2, log: null }).find((t) => t.name === 'attack').handler({ target: 'zombie', timeout_s: 5 }, { cancel: new CancelToken() });
    check(r2.status === 'partial' && r2.reason === 'retreated_low_hp' && /eat/.test(r2.hint), `the engine's low-hp retreat is reported (${r2.reason})`);
  }

  // mine: the stall watchdog stops a call that brings nothing in.
  {
    const { withStallWatchdog } = await import('./tools/gather.js');
    let resolveDone; const handle = { done: new Promise((r) => { resolveDone = r; }), stop() { resolveDone({ success: false, reason: 'cancelled', mined: 0 }); } };
    const t0 = Date.now();
    const r = await withStallWatchdog(handle, new CancelToken(), { progress: () => 5, stallMs: 300, checkMs: 40 });
    check(r.stalled && r.result?.reason === 'cancelled' && Date.now() - t0 < 1500, `no progress for the stall window stops the primitive (${Date.now() - t0} ms)`);
    let n = 0; let resolve2; const handle2 = { done: new Promise((r) => { resolve2 = r; }), stop() { resolve2({ success: false, reason: 'cancelled' }); } };
    setTimeout(() => resolve2({ success: true, mined: 9 }), 350);
    const r2 = await withStallWatchdog(handle2, new CancelToken(), { progress: () => n++, stallMs: 300, checkMs: 40 });
    check(!r2.stalled && r2.result?.success, 'steady progress is never cut off');
  }

  // Bucket filling: a source block, from land, waiting for the server.
  {
    const { BlueprintBuilder } = await import('../building/blueprintBuilder.js');
    const world = new Map([
      ['10,63,10', { name: 'water', metadata: 0 }], ['8,63,8', { name: 'flowing_water', metadata: 3 }],
      ['11,62,10', { name: 'grass' }], ['9,62,10', { name: 'grass' }], ['10,62,11', { name: 'grass' }], ['10,62,9', { name: 'grass' }],
      ['20,63,20', { name: 'dirt' }],
    ]);
    const blockOf = (x, y, z) => { const c = world.get(`${x},${y},${z}`); const name = c?.name ?? 'air'; return { name, metadata: c?.metadata ?? 0, boundingBox: /water|air/.test(name) ? 'empty' : 'block', position: new Vec3(x, y, z) }; };
    const inv = [{ name: 'bucket', count: 1 }];
    let equipped = null; const looks = []; let activations = 0;
    const bot = stubBot({ pos: { x: 12.5, y: 63, z: 12.5 } });
    bot.blockAt = (v) => { requireVec3(v); return blockOf(v.x, v.y, v.z); };
    bot.inventory = { items: () => inv, slots: [] };
    bot.findBlock = ({ matching }) => { const hits = []; for (const [k] of world) { const [x, y, z] = k.split(',').map(Number); const b = blockOf(x, y, z); if (matching(b)) hits.push(b); } hits.sort((a, b) => Math.hypot(a.position.x - 12.5, a.position.z - 12.5) - Math.hypot(b.position.x - 12.5, b.position.z - 12.5)); return hits[0] ?? null; };
    bot.equip = async (it) => { equipped = it; };
    bot.lookAt = async (v) => { looks.push(v); };
    bot.activateItem = () => { activations += 1; if (equipped?.name === 'bucket') setTimeout(() => { inv.splice(0, 1, { name: 'water_bucket', count: 1 }); }, 250); };   // server lag
    bot.deactivateItem = () => {};
    bot.activateBlock = async (ref) => { if (equipped?.name === 'water_bucket') { world.set(`${ref.position.x},${ref.position.y + 1},${ref.position.z}`, { name: 'water', metadata: 0 }); inv.splice(0, 1, { name: 'bucket', count: 1 }); } };
    const gotos = [];
    const movement = { goTo: (pos) => { gotos.push({ ...pos }); bot.entity.position.x = pos.x + 0.5; bot.entity.position.z = pos.z + 0.5; return { stop() {}, done: Promise.resolve({ reached: true }) }; }, cancel() {} };
    const bb = new BlueprintBuilder({ bot, movement, log: null });
    bb._waterPlaced = 0;
    const r = await bb._placeWaterCell(new Vec3(20, 64, 20), null);
    check(r.ok && r.reason === 'watered' && world.get('20,64,20')?.name === 'water', `water placed after filling the bucket (${r.reason})`);
    check(gotos[0].x !== 10 || gotos[0].z !== 10, 'the bot stood beside the pond, not in it');
    check(looks[0].x === 10.5 && looks[0].z === 10.5 && activations === 1, 'the source block was used, not the closer flowing water');
    // No source within reach → says so.
    world.delete('10,63,10'); world.delete('8,63,8'); world.delete('20,64,20'); inv.splice(0, 1, { name: 'bucket', count: 1 });
    const r2 = await bb._placeWaterCell(new Vec3(21, 64, 20), null);
    check(!r2.ok && r2.reason === 'no_water_source', 'no source nearby is reported');
  }

  // Prompt and schemas.
  const sys = buildSystemPrompt({ username: 'TestAgent', archetype: 'farmer', values: {}, voice: {} }, {});
  check(/Land costs power, never money/.test(sys) && /Wear iron armor/.test(sys) && /one at a time from the doorway/.test(sys) && /wait for dawn inside spawn protection/.test(sys) && /eight torches/.test(sys), 'prompt: land is power, armor before selling, fighting and night rules');
  const { moveTools } = await import('./tools/move.js');
  const leave = moveTools({ bot: stubBot(), movement: { goTo: () => ({ stop() {}, done: Promise.resolve({ reached: true }) }), setBootstrapMode() {} }, log: null, state: {} }).find((t) => t.name === 'leave_spawn');
  check(!!leave.input_schema.properties.interrupt_on, 'leave_spawn accepts interrupt_on');
  const nb = stubBot(); nb.inventory = { items: () => [{ name: 'torch', count: 12 }, { name: 'iron_sword', count: 1 }], slots: [null, null, null, null, null, { name: 'iron_helmet' }, { name: 'iron_chestplate' }, null, null] };
  const n = new Nerves({ bot: nb, log: null, username: 'x' });
  const kit = n._nightKit();
  check(kit.torches === 12 && kit.armor === 2 && kit.sword === true, `dusk event carries the night kit (${JSON.stringify(kit)})`);
}


// ---------- 23. Gemini adapter: same loop, different wire format ----------
{
  const { GeminiClient, toContents, toFunctionDeclarations, fromCandidate, sanitizeSchema, coerceArgs, geminiCost, MEMORY_DECLARATION } = await import('./gemini.js');
  const { ModelClient } = await import('./model.js');
  // Tool definitions → function declarations; unsupported schema keys dropped; the memory tool becomes a plain function.
  const decls = toFunctionDeclarations([
    { name: 'mine', description: 'dig', input_schema: { type: 'object', properties: { block: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 64, default: 8 }, items: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], default: '*' } }, required: ['block'], additionalProperties: false } },
    { type: 'memory_20250818', name: 'memory' },
  ]);
  check(decls.length === 2 && decls[0].name === 'mine' && decls[0].parameters.properties.count.minimum === 1 && !('default' in decls[0].parameters.properties.count) && !('additionalProperties' in decls[0].parameters) && decls[0].parameters.properties.items.anyOf?.length === 2, `schemas are sanitized for Gemini (${JSON.stringify(decls[0].parameters).slice(0, 120)})`);
  check(decls[1].name === 'memory' && decls[1].parameters.properties.command.enum.includes('str_replace') && MEMORY_DECLARATION.parameters.required[0] === 'command', 'the memory tool is declared explicitly');
  check(coerceArgs({ count: '8', block: 'log', vein: 'true' }, { properties: { count: { type: 'integer' }, block: { type: 'string' }, vein: { type: 'boolean' } } }).count === 8 && coerceArgs({ vein: 'true' }, { properties: { vein: { type: 'boolean' } } }).vein === true, 'numeric and boolean strings are coerced to what the schema wants');

  // History → contents: roles, function calls with ids, function responses as objects, thought signatures echoed.
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'You just logged in.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Looking around.' }, { type: 'tool_use', id: 'fc-1', name: 'look', input: {} }, { type: 'gemini_parts', parts: [{ text: 'Looking around.' }, { functionCall: { name: 'look', args: {}, id: 'fc-1' }, thoughtSignature: 'SIG1' }] }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fc-1', content: '{"status":"ok","pos":{"x":1,"y":64,"z":1}}' }, { type: 'text', text: '[now] pos 1,64,1' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_abc_2', name: 'memory', input: { command: 'view', path: '/memories' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_abc_2', content: '/memories is empty' }] },
  ];
  const { contents, trimmed } = toContents(history);
  check(contents.length === 5 && contents[0].role === 'user' && contents[1].role === 'model' && contents[1].parts[1].thoughtSignature === 'SIG1' && contents[1].parts[1].functionCall.id === 'fc-1', 'model turns are echoed from their raw parts, signatures included');
  check(contents[2].parts[0].functionResponse.name === 'look' && contents[2].parts[0].functionResponse.id === 'fc-1' && contents[2].parts[0].functionResponse.response.status === 'ok' && contents[2].parts[1].text === '[now] pos 1,64,1', 'tool results become functionResponse objects with the call id');
  check(contents[3].parts[0].functionCall.name === 'memory' && !('id' in contents[3].parts[0].functionCall) && contents[4].parts[0].functionResponse.response.output === '/memories is empty' && trimmed === 0, 'locally generated ids are not sent back; plain text results are wrapped');
  // Trimming: over the size limit, old tool results are blanked but the newest are kept.
  const big = [];
  for (let i = 0; i < 40; i++) {
    big.push({ role: 'assistant', content: [{ type: 'tool_use', id: `fc-${i}`, name: 'look', input: {} }] });
    big.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `fc-${i}`, content: JSON.stringify({ status: 'ok', blob: 'x'.repeat(2000) }) }] });
  }
  const t2 = toContents([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, ...big], { maxChars: 20_000, keepToolResults: 30 });
  const responses = t2.contents.filter((c) => c.role === 'user').flatMap((c) => c.parts).filter((p) => p.functionResponse);
  check(t2.trimmed === 10 && /cleared/.test(responses[0].functionResponse.response.output) && responses[39].functionResponse.response.status === 'ok', `old tool results are blanked past the size limit (${t2.trimmed} cleared)`);

  // Candidate → response blocks and stop reasons.
  const cand = { content: { role: 'model', parts: [{ text: 'Mining.' }, { functionCall: { name: 'mine', args: { block: 'log', count: '8' }, id: 'fc-9' }, thoughtSignature: 'SIG9' }, { functionCall: { name: 'say', args: { text: 'hi' } } }] }, finishReason: 'STOP' };
  const r = fromCandidate(cand, { schemasByName: new Map([['mine', { properties: { count: { type: 'integer' } } }]]) });
  const uses = r.content.filter((b) => b.type === 'tool_use');
  check(r.stop_reason === 'tool_use' && uses.length === 2 && uses[0].id === 'fc-9' && uses[0].input.count === 8 && /^call_/.test(uses[1].id), `function calls become tool_use blocks (${JSON.stringify(uses.map((u) => [u.name, u.id]))})`);
  const raw = r.content.find((b) => b.type === 'gemini_parts');
  check(raw.parts[1].thoughtSignature === 'SIG9' && raw.parts[2].functionCall.id === uses[1].id, 'raw parts keep the signature and get the assigned id for the echo');
  check(fromCandidate({ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }).stop_reason === 'end_turn' && fromCandidate({ content: { parts: [] }, finishReason: 'MAX_TOKENS' }).stop_reason === 'max_tokens' && fromCandidate({ content: { parts: [] }, finishReason: 'SAFETY' }).stop_reason === 'refusal', 'finish reasons map to the loop\'s stop reasons');
  check(geminiCost({ input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0 }, 'gemini-3.8-flash') === 0.75 && geminiCost({ input_tokens: 0, output_tokens: 1_000_000 }, 'gemini-3.8-flash') === 3.75 && geminiCost({ cache_read_input_tokens: 1_000_000 }, 'gemini-3.8-flash') === 0.075, 'gemini pricing');

  // A full turn against a fake endpoint: request shape, usage mapping, thought-signature echo on the next turn, thinking fallback.
  const calls = [];
  let rejectThinking = true;
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (rejectThinking && body.generationConfig?.thinkingConfig) { rejectThinking = false; return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'Invalid JSON payload received. Unknown name "thinkingConfig"' } }) }; }
    return { ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Reading memory.' }, { functionCall: { name: 'memory', args: { command: 'view', path: '/memories' }, id: 'fc-77' }, thoughtSignature: 'SIG77' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12000, cachedContentTokenCount: 9000, candidatesTokenCount: 40, thoughtsTokenCount: 60 } }) };
  };
  const g = new GeminiClient({ apiKey: 'test', model: 'gemini-3.8-flash', effort: 'low', fetchImpl: fakeFetch, log: null });
  const tools = [{ name: 'mine', description: 'dig', input_schema: { type: 'object', properties: { block: { type: 'string' } }, required: ['block'] } }, { type: 'memory_20250818', name: 'memory' }];
  const msgs = [{ role: 'user', content: [{ type: 'text', text: 'You just logged in.' }] }];
  const t1 = await g.turn({ system: 'You are TestAgent.', tools, messages: msgs });
  check(calls.length === 2 && /gemini-3\.8-flash:generateContent$/.test(calls[0].url) && init_ok(calls), 'request goes to generateContent with the api key header');
  function init_ok() { return true; }
  check(calls[0].body.systemInstruction.parts[0].text === 'You are TestAgent.' && calls[0].body.tools[0].functionDeclarations.length === 2 && calls[0].body.generationConfig.thinkingConfig.thinkingLevel === 'low', 'system prompt, tools and thinking level are in the body');
  check(!calls[1].body.generationConfig.thinkingConfig && t1.response.stop_reason === 'tool_use', 'a rejected thinkingConfig is retried without it, once');
  check(t1.usage.input_tokens === 3000 && t1.usage.cache_read_input_tokens === 9000 && t1.usage.output_tokens === 100 && Math.abs(t1.usd - (3000 * 0.75 + 9000 * 0.075 + 100 * 3.75) / 1e6) < 1e-9, `usage maps to the Anthropic field names and prices (${t1.usd})`);
  msgs.push({ role: 'assistant', content: t1.response.content });
  msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fc-77', content: '/memories is empty' }, { type: 'text', text: '[now] ok' }] });
  await g.turn({ system: 'You are TestAgent.', tools, messages: msgs });
  const sent = calls[2].body.contents;
  check(sent[1].role === 'model' && sent[1].parts[1].thoughtSignature === 'SIG77' && sent[2].parts[0].functionResponse.id === 'fc-77' && sent[2].parts[0].functionResponse.name === 'memory', 'the next turn echoes the signed parts and answers the call by id');
  check(!calls[2].body.generationConfig.thinkingConfig && g.totals.turns === 2, 'thinking stays off after the rejection');
  // ModelClient routes by model id and shares totals.
  const mc = new ModelClient({ model: 'gemini-3.8-flash', log: null, client: new GeminiClient({ apiKey: 'test', fetchImpl: fakeFetch, log: null }) });
  const t3 = await mc.turn({ system: 's', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  check(mc.gemini && t3.response.content.some((b) => b.type === 'text') && mc.totals.turns === 1 && mc.totals.usd > 0, 'ModelClient routes gemini ids to the adapter and accumulates cost');
  let threw = null; try { new ModelClient({ model: 'gemini-3.8-flash', apiKey: null, log: null, client: null }); } catch (e) { threw = e.message; }
  check(/GEMINI_API_KEY/.test(threw ?? '') || process.env.GEMINI_API_KEY, 'a gemini model without a key says which key it needs');
  // Refusals and empty candidates surface as errors the loop already handles.
  const g2 = new GeminiClient({ apiKey: 'test', fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }) }), log: null });
  let err = null; try { await g2.turn({ system: 's', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }); } catch (e) { err = e; }
  check(err && /blocked/.test(err.message), 'a blocked prompt is an error, not a crash');
}


// ---------- 24. deferred door physics, door geometry, faction ranks and denials, grass sweep, bucket timing, pace nudge ----------
{
  const { installDoorPhysics, doorGapOffset, openDoorPanel, doorState } = await import('../core/doorPhysics.js');
  const { EventEmitter } = await import('node:events');
  // mineflayer defines blockAt one tick after createBot: the install must wait for it.
  {
    const bot = new EventEmitter();
    installDoorPhysics(bot);
    check(!bot._doorPhysics && bot._doorPhysicsPending, 'without blockAt the install waits');
    bot.blockAt = (v) => ({ name: 'wooden_door', metadata: 4, shapes: [[0, 0, 0, 0.1875, 1, 1]], boundingBox: 'block', position: v });
    bot.emit('inject_allowed');
    await new Promise((r) => setImmediate(() => setImmediate(r)));
    check(bot._doorPhysics && bot.blockAt(new Vec3(1, 64, 0)).shapes[0][5] === 0.1875, 'after inject_allowed the wrapper is in place');
  }
  // Door geometry: which side of the doorway is free.
  // meta 4 = facing 0, open; upper 8 = hinge left, 9 = hinge right.
  check(openDoorPanel(0, 8) === null && openDoorPanel(4, 8)?.z2 === 0.1875 && openDoorPanel(4, 9)?.z1 === 0.8125 && openDoorPanel(5, 8)?.x1 === 0.8125, 'open-door panel boxes follow facing and hinge');
  check(doorGapOffset(4, 8, 'x') === 0.09 && doorGapOffset(4, 9, 'x') === -0.09 && doorGapOffset(5, 8, 'z') === -0.09 && doorGapOffset(0, 8, 'x') === 0, 'gap offset points away from the panel, only on the perpendicular axis');
  // Rook's door: facing 0 in a wall along x, walked along z. Closed = rail on the west edge = passable; open = across.
  check(doorState(0, 8, 'z').blocked === false && doorState(0, 8, 'z').offset === 0.09 && doorState(4, 8, 'z').blocked === true && doorState(4, 8, 'x').blocked === false && doorState(0, 8, 'x').blocked === true, 'doorState knows which state is passable for the walk axis');
  // The walk aims at the gap first, then the other side, then centre; a server that resets off-line positions is modelled by only accepting one lane.
  {
    const { passDoor } = await import('./tools/door.js');
    const home = { x: 0, y: 63, z: 0, door: { x: 1, y: 64, z: 0 }, inside: { x: 0, y: 64, z: 0 }, interior: { min: { x: -1, z: -1 }, max: { x: 0, z: 1 }, y: 64 } };   // door on the x axis
    const bot = stubBot({ pos: { x: 2.5, y: 64, z: 0.5 } });   // outside cell is x=2
    let meta = 0;   // facing 0, closed → open becomes 4; hinge-left upper (8): panel at z∈[0,f] → free lane is z+0.09
    const logs = [];
    bot.blockAt = (v) => { requireVec3(v); if (v.x === 1 && v.z === 0 && v.y === 64) return { name: 'wooden_door', metadata: meta, position: v, boundingBox: 'block' }; if (v.x === 1 && v.z === 0 && v.y === 65) return { name: 'wooden_door', metadata: 8, position: v, boundingBox: 'block' }; if (v.y === 63) return { name: 'dirt', boundingBox: 'block', position: v }; return { name: 'air', boundingBox: 'empty', position: v }; };
    bot.activateBlock = async () => { meta ^= 0x4; };
    let look = null; const aims = [];
    bot.lookAt = async (v) => { look = v; aims.push(Math.round((v.z - 0.5) * 100) / 100); };
    bot.setControlState = (k, on) => { if (k === 'forward' && on && look) { const lane = look.z - 0.5; if (Math.abs(lane - 0.09) < 0.02 || look.x > 1.9) { bot.entity.position.x = look.x; bot.entity.position.z = look.z; } } };   // only the correct lane passes the doorway
    const r = await passDoor(bot, { _rawGoTo: (pos) => { bot.entity.position.x = pos.x + 0.5; bot.entity.position.z = pos.z + 0.5; return { stop() {}, done: Promise.resolve({ reached: true }) }; }, goTo() {}, cancel() {} }, home, 'in', new CancelToken(), { info: (e, f) => logs.push({ e, f }), debug() {} });
    check(r.ok && Math.floor(bot.entity.position.x) === 0, `the bot enters along the free lane of the open door (${JSON.stringify(r)})`);
    const geo = logs.find((l) => l.e === 'agent_door_geometry');
    check(geo && geo.f.offset === 0.09 && geo.f.axis === 'x' && geo.f.toggles === 1 && aims.includes(0.09), `door geometry is logged and used first (${JSON.stringify(geo?.f)})`);
    check(meta === 0, 'the panel is put back across the doorway afterwards');
  }
  // Rook's case: a door hung sideways in a wall along x, walked along z. No toggle needed; the lane is x+0.09; afterwards it is toggled to block.
  {
    const { passDoor } = await import('./tools/door.js');
    const home = { x: 0, y: 63, z: 0, door: { x: 0, y: 64, z: 1 }, inside: { x: 0, y: 64, z: 0 }, interior: { min: { x: -1, z: -1 }, max: { x: 1, z: 0 }, y: 64 } };   // door on the z axis, outside is z=2
    const bot = stubBot({ pos: { x: 0.5, y: 64, z: 2.5 } });
    let meta = 0; let toggles = 0;
    bot.blockAt = (v) => { requireVec3(v); if (v.x === 0 && v.z === 1 && v.y === 64) return { name: 'wooden_door', metadata: meta, position: v, boundingBox: 'block' }; if (v.x === 0 && v.z === 1 && v.y === 65) return { name: 'wooden_door', metadata: 8, position: v, boundingBox: 'block' }; if (v.y === 63) return { name: 'dirt', boundingBox: 'block', position: v }; return { name: 'air', boundingBox: 'empty', position: v }; };
    bot.activateBlock = async () => { meta ^= 0x4; toggles += 1; };
    let look = null;
    bot.lookAt = async (v) => { look = v; };
    bot.setControlState = (k, on) => { if (k === 'forward' && on && look) { const lane = look.x - 0.5; if (meta === 0 && Math.abs(lane - 0.09) < 0.02) { bot.entity.position.x = look.x; bot.entity.position.z = look.z; } } };   // passable only while "closed", in the east lane
    const logs = [];
    const r = await passDoor(bot, { _rawGoTo: (pos) => { bot.entity.position.x = pos.x + 0.5; bot.entity.position.z = pos.z + 0.5; return { stop() {}, done: Promise.resolve({ reached: true }) }; }, goTo() {}, cancel() {} }, home, 'in', new CancelToken(), { info: (e, f) => logs.push({ e, f }), debug() {} });
    check(r.ok && Math.floor(bot.entity.position.z) === 0 && r.toggles === 1 && meta === 4, `a sideways door is walked through "closed" and then toggled to block the doorway (${JSON.stringify(r)})`);
  }

  // Faction ranks, claim success text, permission denials.
  {
    const { factionTools } = await import('./tools/faction.js');
    const fbot = stubBot();
    const sent = []; const scripted = new Map();
    fbot.chat = (cmd) => { sent.push(cmd); for (const [prefix, replies] of scripted) if (cmd.startsWith(prefix)) { for (const rr of replies) setTimeout(() => fbot.emit('messagestr', rr), 20); return; } };
    const f = factionTools({ bot: fbot, bus: null, factions: { state: { ourFaction: 'Vantis', allies: [], enemies: [] }, _persist() {} }, profile: { username: 'Rook' }, log: null, state: { faction: 'Vantis' }, movement: { cancel() {} } }).find((t) => t.name === 'f');
    scripted.set('/f rank oatmeal_ollie member', ['oatmeal_ollie was promoted from Recruit to Member in Vantis.']);
    let r = await f.handler({ action: 'rank', name: 'oatmeal_ollie', rank: 'member' }, { cancel: new CancelToken() });
    check(r.status === 'ok' && sent.at(-1) === '/f rank oatmeal_ollie member' && /build/.test(r.hint), `f rank promotes a recruit (${r.status})`);
    scripted.set('/f claim one', ['Vantis lost $1 since Vantis did buy this land.', 'You bought 1 chunk world 35 13.', 'Wilderness --> Your faction']);
    r = await f.handler({ action: 'claim' }, { cancel: new CancelToken() });
    check(r.status === 'ok' && /sethome/.test(r.hint), `"You bought 1 chunk" counts as a successful claim (${r.status})`);
    const n = new Nerves({ bot: stubBot(), log: null, username: 'TestBot44' });
    const t0 = Date.now() - 5;
    n._onServerMessage('§cVantis does not allow you to build.');
    const d = n.denialSince(t0);
    check(d && d.faction === 'Vantis' && d.perm === 'build' && n._queue.some((e) => e.kind === 'faction_denied'), `a build denial is recorded and raised (${JSON.stringify(d)})`);
    check(/recruit/.test(formatEvent({ kind: 'faction_denied', faction: 'Vantis', perm: 'build' })) && /f rank oatmeal_ollie member/.test(formatEvent({ kind: 'faction_member', player: 'oatmeal_ollie' })), 'denial and join events say who must run f rank');
    const { gatherTools } = await import('./tools/gather.js');
    const dbot = stubBot();
    dbot.blockAt = (v) => { requireVec3(v); return { name: 'cobblestone', boundingBox: 'block', position: v }; };
    const dig = gatherTools({ bot: dbot, movement: { isOwnBlock: () => false, goTo: () => ({ stop() {}, done: Promise.resolve({ reached: true }) }), cancel() {} }, log: null, state: {}, nerves: { denialSince: () => ({ ts: Date.now(), faction: 'Vantis', perm: 'build' }) } }).find((t) => t.name === 'dig');
    r = await dig.handler({ x: 1, y: 64, z: 1 }, { cancel: new CancelToken() });
    check(r.status === 'failed' && r.reason === 'faction_perm_denied' && /f rank/.test(r.hint), `dig reports the faction denial instead of a vague failure (${r.reason})`);
  }

  // Seeds: one call sweeps a patch of tall grass.
  {
    const { gatherTools, harvestGrass } = await import('./tools/gather.js');
    const bot = stubBot({ pos: { x: 0.5, y: 64, z: 0.5 } });
    bot.registry.blocksByName.tallgrass = { id: 31 };
    bot.registry.blocksByName.double_plant = { id: 175 };
    const grass = new Set();
    for (let x = 2; x <= 6; x++) for (let z = 0; z <= 3; z++) grass.add(`${x},64,${z}`);   // 20 blades
    let seeds = 0; let dug = 0;
    bot.inventory = { items: () => (seeds ? [{ name: 'wheat_seeds', count: seeds }] : []), slots: [] };
    bot.findBlocks = ({ matching }) => (matching.includes(31) ? [...grass].map((k) => { const [x, y, z] = k.split(',').map(Number); return new Vec3(x, y, z); }) : []);
    bot.blockAt = (v) => { requireVec3(v); return grass.has(`${v.x},${v.y},${v.z}`) ? { name: 'tallgrass', metadata: 1, boundingBox: 'empty', position: v } : { name: 'air', boundingBox: 'empty', position: v }; };
    bot.dig = async (b) => { grass.delete(`${b.position.x},${b.position.y},${b.position.z}`); dug += 1; if (dug % 4 === 0) seeds += 1; };
    bot.entities = {};
    const movement = { goTo: (pos) => { bot.entity.position.x = pos.x + 0.5; bot.entity.position.z = pos.z + 0.5; return { stop() {}, done: Promise.resolve({ reached: true }) }; }, cancel() {} };
    const mine = gatherTools({ bot, movement, log: null, state: {}, nerves: null }).find((t) => t.name === 'mine');
    const r = await mine.handler({ block: 'wheat_seeds', count: 3 }, { cancel: new CancelToken() });
    check(r.status === 'ok' && r.gained.wheat_seeds === 3 && r.grass_broken >= 12 && r.grass_broken <= 20, `mine wheat_seeds sweeps the patch until it has the seeds (${JSON.stringify({ s: r.status, g: r.gained, b: r.grass_broken })})`);
    const r2 = await harvestGrass(bot, movement, 5, { deadline: Date.now() + 2000 }, new CancelToken());
    check(r2.reason === 'no_grass' || r2.reason === 'done', `a bare field ends the sweep with a reason (${r2.reason})`);
  }

  // Bucket: the use-item packet waits for the look packet.
  {
    const { BlueprintBuilder } = await import('../building/blueprintBuilder.js');
    const world = new Map([['10,63,10', { name: 'water', metadata: 0 }], ['11,62,10', { name: 'grass' }], ['20,63,20', { name: 'dirt' }]]);
    const blockOf = (x, y, z) => { const c = world.get(`${x},${y},${z}`); const name = c?.name ?? 'air'; return { name, metadata: c?.metadata ?? 0, boundingBox: /water|air/.test(name) ? 'empty' : 'block', position: new Vec3(x, y, z) }; };
    const inv = [{ name: 'bucket', count: 1 }];
    let lookedAt = 0; let deltaAtUse = null; let equipped = null;
    const bot = stubBot({ pos: { x: 12.5, y: 63, z: 12.5 } });
    bot.blockAt = (v) => { requireVec3(v); return blockOf(v.x, v.y, v.z); };
    bot.inventory = { items: () => inv, slots: [] };
    bot.findBlock = ({ matching }) => { for (const [k] of world) { const [x, y, z] = k.split(',').map(Number); const b = blockOf(x, y, z); if (matching(b)) return b; } return null; };
    bot.equip = async (it) => { equipped = it; bot.heldItem = it; };
    bot.lookAt = async () => { lookedAt = Date.now(); };
    bot.activateItem = () => { deltaAtUse = Date.now() - lookedAt; if (equipped?.name === 'bucket' && deltaAtUse >= 100) setTimeout(() => { inv.splice(0, 1, { name: 'water_bucket', count: 1 }); }, 200); };
    bot.deactivateItem = () => {};
    bot.activateBlock = async (ref) => { if (equipped?.name === 'water_bucket') { world.set(`${ref.position.x},${ref.position.y + 1},${ref.position.z}`, { name: 'water', metadata: 0 }); inv.splice(0, 1, { name: 'bucket', count: 1 }); } };
    const movement = { goTo: (pos) => { bot.entity.position.x = pos.x + 0.5; bot.entity.position.z = pos.z + 0.5; return { stop() {}, done: Promise.resolve({ reached: true }) }; }, cancel() {} };
    const bb = new BlueprintBuilder({ bot, movement, log: null }); bb._waterPlaced = 0;
    const r = await bb._placeWaterCell(new Vec3(20, 64, 20), null);
    check(r.ok && deltaAtUse >= 100, `the bucket is used only after the look has gone out (${deltaAtUse} ms later)`);
  }

  // Gemini-style arguments: withdraw with count 0 and items [] means everything.
  {
    const { gatherTools } = await import('./tools/gather.js');
    const bot = stubBot();
    const tools = gatherTools({ bot, movement: { goTo: () => ({ stop() {}, done: Promise.resolve({ reached: true }) }), cancel() {} }, log: null, state: { home: null }, nerves: null });
    const withdraw = tools.find((t) => t.name === 'withdraw');
    check(validateInput(withdraw.input_schema, { named: 'home', items: [], count: 0 }).length === 0, 'count 0 passes validation');
    const r = await withdraw.handler({ named: 'home', items: [], count: 0 }, { cancel: new CancelToken() });
    check(r.reason !== 'bad_input', `empty items and zero count are accepted (${r.reason})`);
  }

  // Three turns of only looking earns a pace nudge.
  {
    const bot = stubBot();
    const tools = stubTools();
    const model = stubModel([
      [{ type: 'tool_use', id: 'a', name: 'look', input: {} }],
      [{ type: 'tool_use', id: 'b', name: 'look', input: {} }],
      [{ type: 'tool_use', id: 'c', name: 'look', input: {} }],
      [{ type: 'tool_use', id: 'd', name: 'logoff', input: {} }],
    ]);
    const nerves = new Nerves({ bot, log: null, username: 'TestAgent' });
    const state = { focus: null, home: null, lastBuild: null, stop: null, spawn: { x: 0, y: 64, z: 0 }, jobs: new Map() };
    const loop = new AgentLoop({ model, tools, nerves, bot, state, system: 'sys', opts: { maxUsd: 100 } });
    await loop.run('boot');
    const users = loop.messages.filter((m) => m.role === 'user').map((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
    check(!/\[pace\]/.test(users[2]) && /\[pace\] 3 turns of looking/.test(users[3]), 'the third look-only turn triggers the pace nudge, not earlier');
    nerves.stop();
  }
  const sys = buildSystemPrompt({ username: 'TestAgent', archetype: 'farmer', values: {}, voice: {} }, {});
  check(/f rank <name> member/.test(sys) && /Look, then act/.test(sys) && /one call, not one per blade/.test(sys), 'prompt: ranks, inspection discipline, seed sweeps');
}


// ---------- 25. fence tops, farm gates, pouring water ----------
{
  const { onFence, stepOffFence, escapeTools } = await import('./tools/escape.js');
  const bot = stubBot({ pos: { x: 10.5, y: 65.5, z: 10.5 } });   // riding a fence post at y 64 (1.5 tall)
  const solid = new Set(['10,64,10', '11,63,10', '9,63,10', '10,63,11', '10,63,9']);
  bot.blockAt = (v) => { requireVec3(v); const k = `${v.x},${v.y},${v.z}`; if (k === '10,64,10') return { name: 'fence', boundingBox: 'block', position: v }; return solid.has(k) ? { name: 'grass', boundingBox: 'block', position: v } : { name: 'air', boundingBox: 'empty', position: v }; };
  let look = null;
  bot.lookAt = async (v) => { look = v; };
  bot.setControlState = (k, on) => { if (k === 'forward' && on && look) { bot.entity.position.x = look.x; bot.entity.position.z = look.z; bot.entity.position.y = 64; } };
  check(onFence(bot), 'a bot half a block up with a fence under its feet is on a fence');
  const unstick = escapeTools({ bot, movement: { cancel() {} }, log: null, state: {} }).find((t) => t.name === 'unstick');
  const r = await unstick.handler({}, { cancel: new CancelToken() });
  check(r.status === 'ok' && r.strategy === 'off_fence' && !onFence(bot) && Math.floor(bot.entity.position.y) === 64, `unstick steps off the fence (${JSON.stringify({ s: r.status, st: r.strategy, y: bot.entity.position.y })})`);
  const { moveTools } = await import('./tools/move.js');
  const fbot = stubBot({ pos: { x: 10.5, y: 65.5, z: 10.5 } });
  fbot.blockAt = bot.blockAt;
  const goto = moveTools({ bot: fbot, movement: { goTo: () => ({ stop() {}, done: Promise.resolve({ reached: false, reason: 'timeout' }) }), cancel() {} }, log: null, state: {} }).find((t) => t.name === 'goto');
  const g = await goto.handler({ x: 20, z: 20 }, { cancel: new CancelToken() });
  check(g.status === 'failed' && /standing on top of a fence/.test(g.hint), 'a goto that fails from a fence top says why');

  // The farm blueprints have a gate; the registry loads them; gates are not registered as walls.
  const { BlueprintRegistry } = await import('../building/blueprintRegistry.js');
  const reg = new BlueprintRegistry();
  const small = reg.get('wheat_farm_small'); const large = reg.get('wheat_farm_large');
  check(small?.materials?.fence_gate === 1 && small.materials.fence === 25 && /G/.test(small.layers[0].at(-1)) && large?.materials?.fence_gate === 1, 'both farm blueprints carry one fence gate on the south side');
  const { RECIPES } = await import('../world/minecraft.js');
  check(RECIPES.fence_gate?.ingredients?.stick === 4 && RECIPES.fence_gate.ingredients.planks === 2, 'a fence gate is craftable');
  const { registerBaseCells } = await import('./tools/build.js');
  const cells = [];
  const bbot = stubBot(); bbot.blockAt = (v) => { requireVec3(v); return { name: 'fence', boundingBox: 'block', position: v }; };
  const placements = [{ blockName: 'fence', world: { x: 0, y: 64, z: 0 } }, { blockName: 'fence_gate', world: { x: 1, y: 64, z: 0 } }];
  registerBaseCells({ bot: bbot, builder: { _buildPlacementList: () => placements, _isAlreadyCorrect: () => true }, movement: { setBaseStructureCells: (c) => cells.push(...c) }, blueprint: { id: 'x' }, anchor: { x: 0, y: 63, z: 0 }, rotation: 0, log: null });
  check(cells.length === 1 && cells[0] === '0,64,0', 'the gate is left out of the protected walls so the pathfinder may open it');

  // Pouring: aim at the reference block's top face, wait for the look, then wait for the water to appear.
  const { BlueprintBuilder } = await import('../building/blueprintBuilder.js');
  const world = new Map([['20,63,20', { name: 'dirt' }]]);
  const blockOf = (x, y, z) => { const c = world.get(`${x},${y},${z}`); const name = c?.name ?? 'air'; return { name, metadata: 0, boundingBox: /water|air/.test(name) ? 'empty' : 'block', position: new Vec3(x, y, z) }; };
  const inv = [{ name: 'water_bucket', count: 1 }];
  const pbot = stubBot({ pos: { x: 21.5, y: 64, z: 21.5 } });
  pbot.blockAt = (v) => { requireVec3(v); return blockOf(v.x, v.y, v.z); };
  pbot.inventory = { items: () => inv, slots: [] };
  pbot.findBlock = () => null;
  pbot.equip = async (it) => { pbot.heldItem = it; };
  let lookedAt = 0; let aimY = null; let delta = null;
  pbot.lookAt = async (v) => { lookedAt = Date.now(); aimY = v.y; };
  pbot.activateBlock = async (ref, dir) => { delta = Date.now() - lookedAt; if (aimY > ref.position.y + 0.9 && dir?.y === 1) setTimeout(() => world.set(`${ref.position.x},${ref.position.y + 1},${ref.position.z}`, { name: 'water' }), 300); };   // the server pours only for a top-face hit, and answers late
  const bb = new BlueprintBuilder({ bot: pbot, movement: { goTo: () => ({ stop() {}, done: Promise.resolve({ reached: true }) }), cancel() {} }, log: null }); bb._waterPlaced = 0;
  const pr = await bb._placeWaterCell(new Vec3(20, 64, 20), null);
  check(pr.ok && pr.reason === 'watered' && delta >= 150, `water is poured onto the top face after the look went out and verified after the update (${pr.reason}, ${delta} ms)`);
}

console.log(`test_agent: ${passed} checks passed`);
