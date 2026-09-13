#!/usr/bin/env node
/**
 * test_submerged_target.js — the two water guards behind the drown↔mine
 * livelock fix (TestBot40 kept mining cobblestone in a surface pool, the
 * drown reflex cancelled the task, the planner re-picked the same wet
 * block, repeat → 71 drown_escape / 0 progress).
 *
 * Two guards with DIFFERENT geometry, on purpose:
 *  - targetSubmerged(bot, pos): SEARCH-time. Models the TARGET's column
 *    (own cell + cell directly above). Rejects seabed/pool-floor targets so
 *    they're never the nearest legal candidate. Must NOT look at horizontal
 *    neighbours — a dry block beside a river/beach is a legitimate shore
 *    mine and stays selectable.
 *  - standingWouldDrown(bot): DIG-time. Models the BOT's actual head cell
 *    ("am I submerged right now?"), identical to the drown reflex. Ankle-
 *    deep (feet wet, head dry) is ALLOWED; only a submerged head is skipped.
 */

import vec3Pkg from 'vec3';
import { targetSubmerged, standingWouldDrown } from './primitives.js';

const Vec3 = vec3Pkg.Vec3 ?? vec3Pkg;

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function section(n) { console.log('\n# ' + n); }

const AIR = { name: 'air', boundingBox: 'empty' };
const STONE = { name: 'stone', boundingBox: 'block' };
const COBBLE = { name: 'cobblestone', boundingBox: 'block' };
const WATER = { name: 'water', boundingBox: 'empty' };
const FLOWING_WATER = { name: 'flowing_water', boundingBox: 'empty' };
const ICE = { name: 'ice', boundingBox: 'block' };
const PACKED_ICE = { name: 'packed_ice', boundingBox: 'block' };
const LILY = { name: 'lily_pad', boundingBox: 'empty' };

// world: "x,y,z" -> block. blockAt returns AIR for unset (matches the
// prismarine default of a loaded-but-empty cell).
function makeBot(world) {
  return { blockAt: (v) => world[`${v.x},${v.y},${v.z}`] ?? AIR };
}
// A bot whose blockAt returns null for unset cells — models an UNLOADED
// chunk at an ocean border. The guards must treat null as "not water".
function makeNullBot(world) {
  return { blockAt: (v) => world[`${v.x},${v.y},${v.z}`] ?? null };
}
const at = (x, y, z) => new Vec3(x, y, z);

// =====================================================================
section('targetSubmerged — rejects targets in a water column');
{
  // The TestBot40 geometry: cobblestone at the pool floor, water above it.
  const seabed = makeBot({ '488,62,369': WATER });
  assert('dry-column cobble with WATER directly above → submerged',
    targetSubmerged(seabed, at(488, 61, 369)) === true);

  const ownWater = makeBot({ '488,61,369': WATER });
  assert('own cell is water (defensive) → submerged',
    targetSubmerged(ownWater, at(488, 61, 369)) === true);

  const flowing = makeBot({ '10,40,10': FLOWING_WATER });
  assert('flowing_water in own cell → submerged',
    targetSubmerged(flowing, at(10, 40, 10)) === true);
}

// =====================================================================
section('targetSubmerged — does NOT reject legitimate shore / dry mining');
{
  // Dry stone, AIR above, water on ONE horizontal neighbour only. This is
  // beach/river-edge mining and MUST stay selectable (hard requirement #2).
  const shore = makeBot({
    '5,40,5': STONE,        // the target itself
    '6,40,5': WATER,        // water on the +x side only
    // '5,41,5' (above) is unset → AIR
  });
  assert('dry block with water on a SIDE only → NOT submerged (shore mining)',
    targetSubmerged(shore, at(5, 40, 5)) === false);

  const underground = makeBot({
    '5,40,5': STONE, '5,41,5': STONE, '5,39,5': STONE,
  });
  assert('stone fully underground (solid above) → NOT submerged',
    targetSubmerged(underground, at(5, 40, 5)) === false);
}

// =====================================================================
section('targetSubmerged — ice / packed_ice / lily_pad are NOT water');
{
  // Pins the water-name boundary: a future maintainer broadening the set
  // would start wrongly blocking ice-surface and lily-pad mining.
  assert('ice in own cell → NOT submerged',
    targetSubmerged(makeBot({ '5,40,5': ICE }), at(5, 40, 5)) === false);
  assert('packed_ice above → NOT submerged',
    targetSubmerged(makeBot({ '5,41,5': PACKED_ICE }), at(5, 40, 5)) === false);
  assert('lily_pad above → NOT submerged',
    targetSubmerged(makeBot({ '5,41,5': LILY }), at(5, 40, 5)) === false);
}

// =====================================================================
section('targetSubmerged — null (unloaded chunk) is treated as not-water');
{
  const border = makeNullBot({});   // every cell null
  assert('null own + null above → NOT submerged (no spurious chunk-border reject)',
    targetSubmerged(border, at(999, 61, 999)) === false);
  // Guard tolerance: no bot.blockAt / no pos.
  assert('missing blockAt → false', targetSubmerged({}, at(0, 0, 0)) === false);
  assert('non-offsettable pos → false', targetSubmerged(makeBot({}), { x: 0, y: 0, z: 0 }) === false);
}

// =====================================================================
section('standingWouldDrown — reads the bot’s actual HEAD cell');
{
  // Bot feet at y61, head cell at y62.
  const submerged = {
    entity: { position: at(488, 61, 369) },
    blockAt: (v) => (v.y === 62 ? WATER : STONE),
  };
  assert('head cell is water → would drown', standingWouldDrown(submerged) === true);

  // Ankle-deep: feet in 1-deep water, HEAD in air. The reflex never fires
  // here (it needs headInWater), so the guard must NOT skip it.
  const ankleDeep = {
    entity: { position: at(488, 61, 369) },
    blockAt: (v) => (v.y === 61 ? WATER : AIR),   // feet wet, head (62) dry
  };
  assert('feet wet but head dry → NOT drowning (ankle-deep allowed)',
    standingWouldDrown(ankleDeep) === false);

  const onLand = {
    entity: { position: at(488, 61, 369) },
    blockAt: () => AIR,
  };
  assert('head in air (on land / raining) → NOT drowning', standingWouldDrown(onLand) === false);

  // Chunk border: head cell null.
  const border = {
    entity: { position: at(488, 61, 369) },
    blockAt: () => null,
  };
  assert('null head cell → NOT drowning', standingWouldDrown(border) === false);

  assert('missing entity → false', standingWouldDrown({ blockAt: () => WATER }) === false);
  assert('missing blockAt → false', standingWouldDrown({ entity: { position: at(0, 0, 0) } }) === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
