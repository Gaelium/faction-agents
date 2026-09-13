#!/usr/bin/env node
/**
 * test_own_structure.js — the "don't break my own blocks" registry on the
 * Movement class, plus the pathfinder break-exclusion factory.
 *
 * Two populations, both keyed "x,y,z":
 *  • _baseStructureCells — the completed base's solid walls (persistent,
 *    ground-truth). The pathfinder routes AROUND them (uses the door) and
 *    safeFindBlock won't mine them.
 *  • _recentPlacements — cells the bot just placed (pillar/scaffold), TTL'd,
 *    so _digToEscape won't dig out the block it just placed under its feet.
 *
 * Anti-trap: a verified completion re-arms the wall exclusion; the entombment
 * valve (setBaseExclusionSuppressed) can disarm it so a sealed bot escapes.
 */

import { Movement, makeBaseStructureExclusion } from './movement.js';

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function section(n) { console.log('\n# ' + n); }

const K = (x, y, z) => `${x},${y},${z}`;
function fakeMemory() {
  const m = new Map();
  return {
    kvGet: (k, fb = null) => (m.has(k) ? m.get(k) : fb),
    kvSet: (k, v) => { m.set(k, v); },
    _map: m,
  };
}
// Movement's constructor only stores bot; the registry methods don't touch it.
const bot = {};

// =====================================================================
section('makeBaseStructureExclusion — weight, fast path, liveness');
{
  let cells = new Set([K(1, 2, 3)]);
  const excl = makeBaseStructureExclusion(() => cells);
  const blk = (x, y, z) => ({ position: { x, y, z } });
  assert('in-set block → 100 (safeToBreak rejects at >=100)', excl(blk(1, 2, 3)) === 100);
  assert('out-of-set block → 0', excl(blk(9, 9, 9)) === 0);
  assert('null block → 0', excl(null) === 0);
  assert('block without position → 0', excl({}) === 0);
  // Liveness: reassign the Set the getter closes over — no rebuild needed.
  cells = new Set([K(5, 6, 7)]);
  assert('after reassigning the set, new member excluded', excl(blk(5, 6, 7)) === 100);
  assert('old member no longer excluded', excl(blk(1, 2, 3)) === 0);
  // Empty-set fast path.
  cells = new Set();
  assert('empty set → 0 (fresh bot pays nothing)', excl(blk(1, 2, 3)) === 0);
}

// =====================================================================
section('base cells — set / get / isOwnBlock / persistence');
{
  const mem = fakeMemory();
  const mv = new Movement(bot, { memory: mem });
  mv.setBaseStructureCells([K(10, 64, 10), { x: 11, y: 64, z: 10 }]);
  assert('getBaseStructureCells has the string cell', mv.getBaseStructureCells().has(K(10, 64, 10)));
  assert('accepts {x,y,z} objects too', mv.getBaseStructureCells().has(K(11, 64, 10)));
  assert('isOwnBlock true for a base cell', mv.isOwnBlock({ x: 10, y: 64, z: 10 }) === true);
  assert('isOwnBlock false for an unrelated cell', mv.isOwnBlock({ x: 0, y: 0, z: 0 }) === false);
  assert('persisted to KV', Array.isArray(mem.kvGet('base_structure_cells')) && mem.kvGet('base_structure_cells').includes(K(10, 64, 10)));
}

// =====================================================================
section('restart re-arm — a fresh Movement hydrates base cells from KV');
{
  const mem = fakeMemory();
  new Movement(bot, { memory: mem }).setBaseStructureCells([K(20, 64, 20)]);
  // Simulate a reconnect: brand-new instance over the same memory.
  const reborn = new Movement(bot, { memory: mem });
  // No setBaseStructureCells call — the FIRST read hydrates from KV.
  assert('hydrated from KV on first getBaseStructureCells', reborn.getBaseStructureCells().has(K(20, 64, 20)));
  assert('isOwnBlock works after reload', reborn.isOwnBlock({ x: 20, y: 64, z: 20 }) === true);
}

// =====================================================================
section('overwrite-not-merge — newest completed structure wins');
{
  const mem = fakeMemory();
  const mv = new Movement(bot, { memory: mem });
  mv.setBaseStructureCells([K(1, 1, 1), K(2, 2, 2)]);
  mv.setBaseStructureCells([K(3, 3, 3)]);
  const set = mv.getBaseStructureCells();
  assert('only the second set remains', set.size === 1 && set.has(K(3, 3, 3)));
  assert('stale cell evicted', !set.has(K(1, 1, 1)));
}

// =====================================================================
section('no memory — does not throw, empty set');
{
  const mv = new Movement(bot);
  assert('getBaseStructureCells empty', mv.getBaseStructureCells().size === 0);
  let threw = false;
  try { mv.setBaseStructureCells([K(1, 1, 1)]); } catch { threw = true; }
  assert('setBaseStructureCells without memory does not throw', threw === false);
  assert('in-memory set still updated', mv.getBaseStructureCells().has(K(1, 1, 1)));
}

// =====================================================================
section('recent placements — notePlacement / isRecentlyPlaced / TTL prune');
{
  const mv = new Movement(bot);
  mv.notePlacement({ x: 5, y: 60, z: 5 });
  assert('freshly placed cell is recent', mv.isRecentlyPlaced({ x: 5, y: 60, z: 5 }) === true);
  assert('floors fractional coords', mv.isRecentlyPlaced({ x: 5.7, y: 60.1, z: 5.9 }) === true);
  assert('never-placed cell is not recent', mv.isRecentlyPlaced({ x: 9, y: 9, z: 9 }) === false);
  assert('isOwnBlock true for a recent placement', mv.isOwnBlock({ x: 5, y: 60, z: 5 }) === true);
  // Expired entry is pruned on read (self-heal).
  mv._recentPlacements.set(K(7, 60, 7), Date.now() - 1000);
  assert('expired entry reads as not-recent', mv.isRecentlyPlaced({ x: 7, y: 60, z: 7 }) === false);
  assert('expired entry pruned from the map', !mv._recentPlacements.has(K(7, 60, 7)));
}

// =====================================================================
section('entombment valve — suppress flag + re-arm on completion');
{
  const mv = new Movement(bot, { memory: fakeMemory() });
  assert('armed by default', mv._baseExclusionSuppressed === false);
  mv.setBaseExclusionSuppressed(true);
  assert('suppressed when valve tripped', mv._baseExclusionSuppressed === true);
  // A verified completion re-arms the protection.
  mv.setBaseStructureCells([K(1, 1, 1)]);
  assert('re-armed by setBaseStructureCells (a verified completion)', mv._baseExclusionSuppressed === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
