#!/usr/bin/env node
/**
 * test_fleet.js — the Phase 5 slice: args/roster, the transcript tracker,
 * the budget maths and both dashboard views, all against synthetic files.
 *
 *   node orchestrator/test_fleet.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { parseArgs, applyRoster } from './args.js';
import { FleetTracker, summarizeInput, sessionStartFromName } from './tracker.js';
import { Dashboard } from './dashboard.js';
import { WebDashboard } from './web.js';

let passes = 0, failures = 0;
function assert(label, cond, extra) {
  if (cond) { console.log('  ✓', label); passes++; }
  else { console.log('  ✗', label, extra ?? ''); failures++; }
}
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

// ---------- args ----------
console.log('\n== args ==');
{
  const o = parseArgs(['--only', 'Rook_Vantis,oatmeal_ollie', '--budget', '15', '--session=60,120', '--target', '2', '--no-dashboard']);
  assert('roster parsed', o.only?.length === 2 && o.only[1] === 'oatmeal_ollie');
  assert('budget, session, target parsed', o.budget === 15 && o.session[0] === 60 && o.session[1] === 120 && o.target[0] === 2 && o.target[1] === 2 && o.noDashboard);
  const e = parseArgs([], { FLEET_MAX_USD_PER_DAY: '20', FLEET_BUDGET_ACTION: 'kill' });
  assert('env fallbacks', e.budget === 20 && e.budgetAction === 'kill');
  const profiles = [
    { username: 'Rook_Vantis', schedule: { primary_hours: [18, 23], session_minutes: [90, 240] } },
    { username: 'oatmeal_ollie', schedule: { primary_hours: [8, 12], session_minutes: [60, 120] } },
    { username: 'ghosst', schedule: { primary_hours: [0, 4] } },
  ];
  const r = applyRoster(profiles, o);
  assert('roster filters and pins online', r.profiles.length === 2 && r.profiles.every((p) => p.schedule.always_online) && r.target[0] === 2);
  assert('session override applied', r.profiles[0].schedule.session_minutes[0] === 60 && r.profiles[0].schedule.session_minutes[1] === 120);
  const r2 = applyRoster(profiles, parseArgs(['--only', 'ghosst', '--respect-schedule']));
  assert('--respect-schedule keeps the hours', !r2.profiles[0].schedule.always_online && r2.target[0] === 1);
  const r3 = applyRoster(profiles, parseArgs([]));
  assert('no roster → everyone, default target', r3.profiles.length === 3 && r3.target[0] === 6 && r3.target[1] === 12);
}

// ---------- tracker ----------
console.log('\n== tracker ==');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-'));
const sessions = path.join(root, 'sessions'); const memory = path.join(root, 'memory');
fs.mkdirSync(path.join(sessions, 'bot1'), { recursive: true });
fs.mkdirSync(path.join(memory, 'bot1'), { recursive: true });
fs.writeFileSync(path.join(memory, 'bot1', 'plans.md'), '# Standing goals\n- Found a faction\n- Claim the house chunk\n\n# Current project\nHome base east of spawn\n');
fs.writeFileSync(path.join(memory, 'bot1', 'journal.md'), '- 2026-09-04 16:24 session ended\n- 2026-09-05 19:32 Sold 48 bread for $1440\n');
const file1 = path.join(sessions, 'bot1', '2026-09-05T19-21-02-051Z.jsonl');
const T = (s) => `2026-09-05T19:${s}Z`;
const lines = [
  { ts: T('21:02.051'), t: 'meta', profile: 'bot1', archetype: 'diplomat', model: 'claude-opus-5', effort: 'medium', spawn: { x: 1, y: 64, z: 1 } },
  { ts: T('21:02.100'), t: 'msg', role: 'user', content: [{ type: 'text', text: 'You just logged in.\n\nYour focus card from last time (10 min ago): Claim the house chunk, then sethome.\n\nInventory: {}' }] },
  { ts: T('21:11.000'), t: 'turn', n: 1, usd: 0.09, total_usd: 0.09, text: 'Reading memory first.', tools: ['memory'] },
  { ts: T('21:12.000'), t: 'tool', name: 'mine', input: { block: 'coal_ore', count: 16 }, result: { status: 'ok', gained: { coal: 12 } }, elapsedMs: 32000 },
  { ts: T('21:50.000'), t: 'turn', n: 2, usd: 0.02, total_usd: 0.11, text: 'Selling the coal.' },
  { ts: T('21:51.000'), t: 'tool', name: 'sell', input: { items: ['coal'] }, result: { status: 'ok', earned: 180, balance_after: 270 }, elapsedMs: 800 },
  { ts: T('21:52.000'), t: 'tool', name: 'f', input: { action: 'create', name: 'Vantis' }, result: { status: 'ok', faction: 'Vantis' }, elapsedMs: 240 },
  { ts: T('21:53.000'), t: 'tool', name: 'focus', input: { text: 'Vantis founded. Next: invite Ollie, claim at home, sethome.' }, result: { status: 'ok' }, elapsedMs: 1 },
  { ts: T('21:54.000'), t: 'tool', name: 'say', input: { text: 'vantis is up' }, result: { status: 'ok', said: 'vantis is up', to: 'public' }, elapsedMs: 1 },
  { ts: T('21:55.000'), t: 'msg', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '{}' }, { type: 'text', text: '[events]\n- chat: <oatmeal_ollie> invite me\n- damage (mob:ZOMBIE) -3 → hp 17 at 1,64,1\n- player oatmeal_ollie 4.5b W\n[now] pos 1,64,1' }] },
  { ts: T('21:56.000'), t: 'tool', name: 'goto', input: { named: 'home' }, result: { status: 'interrupted', by: 'damage', detail: { cause: 'mob' } }, elapsedMs: 5000 },
  { ts: T('21:57.000'), t: 'msg', role: 'user', content: [{ type: 'text', text: 'YOU DIED (killed by zombie) at 1,64,1; you respawn at spawn' }] },
  { ts: T('21:58.000'), t: 'tool', name: 'run_script', input: { code: 'return 1;' }, result: { status: 'ok', returned: 1 }, elapsedMs: 300 },
  { ts: T('21:59.000'), t: 'tool', name: 'save_skill', input: { name: 'dig_sand', description: 'x', code: 'return 1;' }, result: { status: 'ok' }, elapsedMs: 2 },
  { ts: T('22:00.000'), t: 'turn', n: 3, usd: 0.03, total_usd: 0.14, text: 'Saved the skill.' },
];
fs.writeFileSync(file1, lines.slice(0, 6).map((l) => JSON.stringify(l)).join('\n') + '\n');
const backdate = (f, iso) => { const t = new Date(iso); fs.utimesSync(f, t, t); };
let now = Date.parse('2026-09-05T20:00:00Z');
const tracker = new FleetTracker({ sessionsDir: sessions, memoryDir: memory, clock: () => now });
tracker.track('bot1');
tracker.tick();
let st = tracker.botState('bot1');
assert('session detected from the newest file', st.session?.model === 'claude-opus-5' && st.session.startedAt === sessionStartFromName(file1));
assert('cost, turns, tools counted', st.usd === 0.11 && st.turns === 2 && st.toolCalls === 2 && st.toolsOk === 2);
assert('focus taken from the login bootstrap until the bot sets one', /Claim the house chunk/.test(st.focus));
assert('money from sell', st.money === 270 && st.recentEvents.some((e) => /sold for \$180/.test(e.text)));
assert('last tool summarised', st.lastTool.summary === 'sell coal' && st.recentTools[0].summary === 'mine coal_ore ×16');
// Append the rest: the tracker picks up new lines without re-reading the file.
fs.appendFileSync(file1, lines.slice(6).map((l) => JSON.stringify(l)).join('\n') + '\n');
tracker.tick();
st = tracker.botState('bot1');
assert('faction and focus update from tool calls', st.faction === 'Vantis' && /invite Ollie/.test(st.focus) && st.focusAt != null);
assert('chat in and out', st.recentChat.some((c) => c.dir === 'out' && c.text === 'vantis is up') && st.recentChat.some((c) => c.dir === 'in' && c.from === 'oatmeal_ollie'));
assert('events: damage kept, player noise dropped, death counted', st.recentEvents.some((e) => /damage \(mob:ZOMBIE\)/.test(e.text)) && !st.recentEvents.some((e) => /player oatmeal/.test(e.text)) && st.deaths === 1);
assert('interrupts and scripts tallied', st.interrupts === 1 && st.scripts.run === 1 && st.scripts.ok === 1 && st.scripts.saved === 1 && st.usd === 0.14 && st.turns === 3);
assert('thoughts kept', st.recentThoughts.length === 3 && st.lastThought.text === 'Saved the skill.');
// A new session file: totals roll over, focus/faction carry.
backdate(file1, '2026-09-05T19:40:00Z');
const file2 = path.join(sessions, 'bot1', '2026-09-05T21-00-00-000Z.jsonl');
fs.writeFileSync(file2, JSON.stringify({ ts: '2026-09-05T21:00:00.000Z', t: 'meta', model: 'claude-opus-5', effort: 'low' }) + '\n' + JSON.stringify({ ts: '2026-09-05T21:00:05.000Z', t: 'turn', n: 1, usd: 0.05, total_usd: 0.05 }) + '\n');
backdate(file2, '2026-09-05T21:00:05Z');
tracker.tick();
st = tracker.botState('bot1');
assert('new session rolls the old cost into pastUsd', st.session.effort === 'low' && st.usd === 0.05 && st.pastUsd === 0.14 && st.sessions === 2 && st.faction === 'Vantis' && /invite Ollie/.test(st.focus));
assert('feeds carry across sessions, counters restart', st.recentTools.length === 8 && st.recentEvents.some((e) => /YOU DIED/.test(e.text)) && st.deaths === 0 && st.scripts.run === 0 && st.turns === 1);
assert('fleet totals', tracker.fleetTotals().usdAll === 0.19 && tracker.fleetTotals().usd === 0.05);
assert('usdSince sums the last turn of every recent session', tracker.usdSince(Date.parse('2026-09-05T00:00:00Z')) === 0.19 && tracker.usdSince(Date.parse('2026-09-05T20:30:00Z')) === 0.05);
const goals = tracker.goals('bot1');
assert('goals read plans.md head and journal tail', goals.plans[1] === '- Found a faction' && /Sold 48 bread/.test(goals.journal.at(-1)));
assert('snapshot is JSON-safe', JSON.parse(JSON.stringify(tracker.snapshot())).bots.bot1.usd === 0.05);
assert('summaries read well', summarizeInput('goto', { x: 10, z: 20, range: 1 }) === 'goto 10,20' && summarizeInput('f', { action: 'invite', name: 'ollie' }) === 'f invite ollie' && summarizeInput('say', { text: 'hello there friend' }) === 'say "hello there friend"' && summarizeInput('place', { block: 'torch', x: 1, y: 2, z: 3 }) === 'place torch 1,2,3');

// ---------- dashboard ----------
console.log('\n== dashboard ==');
{
  const spawner = new EventEmitter();
  const wall = Date.now();   // the dashboard reads the real clock for uptimes
  const online = new Map([['bot1', { profile: { username: 'bot1', archetype: 'diplomat', skill_tier: 3 }, startedAt: wall - 30 * 60_000 }]]);
  Object.assign(spawner, { onlineUsernames: () => [...online.keys()], onlineCount: () => online.size, getRecord: (u) => online.get(u) ?? null });
  const health = new EventEmitter();
  const outLines = [];
  const out = { columns: 140, write: (s) => outLines.push(s) };
  const budget = { perDay: 20, spent24h: 7.5, projectedPerDay: 30, paused: false };
  const d = new Dashboard({ spawner, health, scheduler: { min: 1, max: 1 }, tracker, getProfile: () => null, getBudget: () => budget, orchestratorStart: wall - 30 * 60_000, out, input: {} });
  const fleet = strip(d.renderFleet(140).join('\n'));
  assert('fleet header shows online count, session cost and budget', /1\/1-1 online/.test(fleet) && /session \$0\.05/.test(fleet) && /budget \$20\/day \(38%\)/.test(fleet) && /proj \$30\/day/.test(fleet));
  assert('fleet row shows faction, cost, tools and focus', /bot1\s+diplomat\s+Vantis/.test(fleet) && /0\.05/.test(fleet) && /save_skill dig_sand ok/.test(fleet) && /Vantis founded/.test(fleet));
  assert('fleet view lists events and chat from the tracker', /sold for \$180/.test(fleet) && /vantis is up/.test(fleet));
  d.handleKey('\r');
  assert('enter zooms into the selected bot', d.view === 'bot' && d.zoomed === 'bot1');
  const bot = strip(d.renderBot('bot1', 140).join('\n'));
  assert('bot view: header, focus, goals, journal', /bot1 · diplomat tier 3 · claude-opus-5\/low · online 00:30:0\d/.test(bot) && /FOCUS/.test(bot) && /Vantis founded\. Next: invite Ollie/.test(bot) && /Found a faction/.test(bot) && /Sold 48 bread/.test(bot));
  assert('bot view: activity with results, thoughts, events, chat', /mine coal_ore ×16\s+ok/.test(bot) && /goto home\s+interrupted\s+by damage/.test(bot) && /Saved the skill\./.test(bot) && /YOU DIED/.test(bot) && /<oatmeal_ollie>: invite me/.test(bot));
  assert('bot view: money, faction, scripts line', /faction Vantis/.test(bot) && /money \$270/.test(bot) && /scripts run 0 \(ok 0\)/.test(bot) && /earlier sessions \$0\.14/.test(bot));
  assert('b goes back, q quits', d.handleKey('b') === 'back' && d.view === 'fleet' && (() => { let q = false; d.on('quit', () => { q = true; }); d.handleKey('q'); return q; })());
  d.render();
  assert('render writes a frame to the output', outLines.length >= 1 && outLines.at(-1).includes('AI Factions'));
  budget.paused = true; budget.spent24h = 21;
  assert('a paused budget is shown', /PAUSED/.test(strip(d.renderFleet(140).join('\n'))));
  const noTty = new Dashboard({ spawner, health, scheduler: { min: 1, max: 1 }, tracker, getProfile: () => null, out, input: { isTTY: false } });
  noTty.start(); noTty.stop();
  assert('start/stop without a TTY does not throw', true);
}
// ---------- web dashboard ----------
console.log('\n== web ==');
{
  const spawner = new EventEmitter();
  const online = new Map([['bot1', { profile: { username: 'bot1', archetype: 'diplomat', skill_tier: 3 }, startedAt: Date.now() - 30 * 60_000 }]]);
  Object.assign(spawner, { onlineUsernames: () => [...online.keys()], onlineCount: () => online.size, getRecord: (u) => online.get(u) ?? null });
  tracker._sample(true);
  const web = new WebDashboard({ tracker, spawner, health: new EventEmitter(), scheduler: { min: 1, max: 1 }, getBudget: () => ({ perDay: 20, spent24h: 7.5, projectedPerDay: 30, paused: false }), orchestratorStart: Date.now() - 30 * 60_000 });
  web.recordChat({ sender: 'Marla_K', message: 'hello bots', channel: 'global' });
  web.setRedisOk(true);
  const url = await web.start({ port: 0 });
  assert('web server listens on localhost', /^http:\/\/127\.0\.0\.1:\d+$/.test(url));
  const fleet = await (await fetch(url + '/api/fleet')).json();
  assert('/api/fleet: header, budget, rows, feeds', fleet.online === 1 && fleet.redis === true && fleet.budget.perDay === 20 && fleet.bots[0].user === 'bot1' && fleet.bots[0].online && fleet.bots[0].faction === 'Vantis' && fleet.bots[0].usd === 0.05);
  assert('/api/fleet: relayed chat and bot chat merged, events present', fleet.chat.some((c) => c.from === 'Marla_K') && fleet.chat.some((c) => c.text === 'vantis is up') && fleet.events.some((e) => /YOU DIED/.test(e.text)));
  assert('/api/fleet: cost series for the chart', Array.isArray(fleet.series) && fleet.series.length >= 1 && fleet.bots[0].series.length >= 1 && fleet.bots[0].series[0].length === 3);
  const bot = await (await fetch(url + '/api/bot/bot1')).json();
  assert('/api/bot: goals, journal, activity, thoughts, chat', bot.goals.plans[1] === '- Found a faction' && /Sold 48 bread/.test(bot.goals.journal.at(-1)) && bot.recentTools.length === 8 && bot.recentThoughts.length === 3 && bot.recentChat.length === 2 && bot.session.model === 'claude-opus-5' && /invite Ollie/.test(bot.focus));
  const missing = await fetch(url + '/api/bot/nobody');
  assert('/api/bot: unknown bot is a 404', missing.status === 404);
  const page = await (await fetch(url + '/')).text();
  assert('/ serves the page', /<title>AI Factions Fleet<\/title>/.test(page) && /\/api\/fleet/.test(page) && /prefers-color-scheme: dark/.test(page));
  const badPath = await fetch(url + '/etc/passwd');
  assert('other paths are 404', badPath.status === 404);
  // The page's script compiles (no browser here, but syntax errors would show).
  const vm = await import('node:vm');
  const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? '';
  let compiled = true; try { new vm.Script(script, { filename: 'index.html' }); } catch (e) { compiled = e.message; }
  assert('page script compiles', compiled === true, compiled);
  await web.close();
}
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${passes} passed / ${failures} failed`);
process.exit(failures ? 1 : 0);
