#!/usr/bin/env node
/**
 * test_orchestrator.js — stub-only smoke tests for the scheduler and
 * health monitor. No processes are actually spawned.
 *
 *   node orchestrator/test_orchestrator.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProfileNames, loadProfile } from '../bots/core/profileLoader.js';
import { Scheduler }     from './scheduler.js';
import { HealthMonitor } from './health.js';
import { EventEmitter }  from 'node:events';

let passes = 0, failures = 0;
function assert(label, cond, extra) {
  if (cond) { console.log('  ✓', label); passes++; }
  else      { console.log('  ✗', label, extra ?? ''); failures++; }
}

// ---------- archetype distribution ----------
console.log('\n== archetype distribution ==');
const names = listProfileNames();
const profiles = names.map(loadProfile);
const tally = {};
for (const p of profiles) tally[p.archetype] = (tally[p.archetype] ?? 0) + 1;

// The roster is whatever bots/profiles/ holds; pin the loader to the
// directory, not to a count that drifts every time a character is added.
const PROFILES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bots', 'profiles');
const yamlCount = fs.readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.yaml')).length;
const ARCHETYPES = ['pvper', 'builder', 'farmer', 'grinder', 'ratter', 'diplomat'];
assert('one profile per YAML file',   profiles.length === yamlCount && yamlCount > 0, `got ${profiles.length} of ${yamlCount}`);
assert('every profile has a known archetype', profiles.every((p) => ARCHETYPES.includes(p.archetype)), JSON.stringify(tally));
assert('every archetype is represented', ARCHETYPES.every((a) => (tally[a] ?? 0) >= 1), JSON.stringify(tally));
assert('every profile has schedule', profiles.every((p) => p.schedule?.primary_hours));
assert('every profile has ambition', profiles.every((p) => typeof p.ambition === 'number'));

// ---------- scheduler basics ----------
console.log('\n== scheduler ==');

// Build a clock that always reports 20:30 local time on a Saturday.
function fixedClock(hour, minute = 30, day = 6 /* Sat */) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  while (d.getDay() !== day) d.setDate(d.getDate() + 1);
  return () => d.getTime();
}

const target = [6, 12];
const sched = new Scheduler({ profiles, target, clock: fixedClock(20) });

// With no one online, plan should propose 6..12 to spawn.
const empty = sched.evaluate({ onlineSet: new Set() });
assert('toSpawn within target band',
  empty.toSpawn.length >= target[0] && empty.toSpawn.length <= target[1],
  `got ${empty.toSpawn.length}`);
assert('no kills from empty state', empty.toKill.length === 0);

// If a bot is already online, persistence bonus should keep them in.
const someOnline = new Set(profiles.slice(0, 4).map((p) => p.username));
const withOnline = sched.evaluate({ onlineSet: someOnline });
const stayed = [...someOnline].filter((u) =>
  withOnline.keep.some((p) => p.username === u)
  || !withOnline.toKill.some((p) => p.username === u));
assert('≥3 of 4 pre-online bots kept (persistence bonus)', stayed.length >= 3);

// Evaluation at 04:00 on a Tuesday — most schedules should exclude bots,
// so we fall back to the scheduler's minimum target.
const deadHour = new Scheduler({ profiles, target, clock: fixedClock(4, 0, 2 /* Tue */) });
const dead = deadHour.evaluate({ onlineSet: new Set() });
assert('dead-hour plan honors min target',
  dead.toSpawn.length >= target[0], `got ${dead.toSpawn.length}`);

// ---------- scheduler: primary-hour bias ----------
console.log('\n== scheduler primary-hour bias ==');
// Run scheduler 100 times at 20:30 local time with no one online.
// Profiles whose primary window contains 20 should dominate the selections.
const runs = 50;
const picks = new Map();
for (let i = 0; i < runs; i++) {
  const s = new Scheduler({ profiles, target, clock: fixedClock(20) });
  for (const p of s.evaluate({ onlineSet: new Set() }).toSpawn) {
    picks.set(p.username, (picks.get(p.username) ?? 0) + 1);
  }
}
const primaryAt20 = profiles.filter((p) => {
  const [lo, hi] = p.schedule.primary_hours;
  const span = hi - lo;
  const end = lo + span;
  if (end <= 24) return 20 >= lo && 20 < end;
  return 20 >= lo || 20 < (end - 24);
});
const nonPrimaryAt20 = profiles.filter((p) => !primaryAt20.includes(p));
const primaryAvg = avg(primaryAt20.map((p) => picks.get(p.username) ?? 0));
const nonPrimaryAvg = avg(nonPrimaryAt20.map((p) => picks.get(p.username) ?? 0));
assert(`primary-window bots selected more than off-hours bots (avg ${primaryAvg.toFixed(1)} vs ${nonPrimaryAvg.toFixed(1)})`,
  primaryAvg > nonPrimaryAvg);

// ---------- health monitor ----------
console.log('\n== health monitor ==');
class FakeSpawner extends EventEmitter {
  constructor() { super(); this.spawned = []; this.online = new Set(); }
  spawn(p) { this.spawned.push(p.username); this.online.add(p.username); }
  isOnline(u) { return this.online.has(u); }
}
const fakeSp = new FakeSpawner();
const byName = new Map(profiles.map((p) => [p.username, p]));
const h = new HealthMonitor({ spawner: fakeSp, profilesByName: byName, log: null });

// Simulate a crash (non-zero exit, short uptime).
fakeSp.online.delete('TestBot1');
fakeSp.emit('exit', 'TestBot1', { code: 1, signal: null, uptimeMs: 30_000, killReason: null });

const s1 = h.statusOf('TestBot1');
assert('1 crash recorded',     s1.crashes === 1, `got ${s1.crashes}`);
assert('not yet unhealthy',    !s1.unhealthy);

// Scheduled kill should NOT count as crash.
fakeSp.emit('exit', 'TestBot2', { code: null, signal: 'SIGTERM', uptimeMs: 60_000, killReason: 'session_end' });
assert('scheduled exit is not a crash', h.statusOf('TestBot2').crashes === 0);

// 5 crashes → unhealthy.
for (let i = 0; i < 4; i++) {
  fakeSp.emit('exit', 'TestBot1', { code: 1, signal: null, uptimeMs: 30_000, killReason: null });
}
const s5 = h.statusOf('TestBot1');
assert('marked unhealthy after 5 crashes', s5.unhealthy, `crashes=${s5.crashes}`);

// ---------- summary ----------
console.log(`\n${passes} passed / ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);

function avg(arr) { if (arr.length === 0) return 0; return arr.reduce((a,b)=>a+b, 0) / arr.length; }
