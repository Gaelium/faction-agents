#!/usr/bin/env node
/**
 * test_place_guard.js — pre-flight classification + poll-verified
 * placement.
 *
 * Bug class (TestBot17, 2026-06-06): 80 placements failed as generic
 * "blockUpdate did not fire within 5000ms". Causes were diagnosable
 * before the call (cell occupied by terrain, bot standing in the
 * cell) or weren't failures at all (block landed, event missed).
 * placeGuard classifies before placing and verifies by polling the
 * world instead of trusting the event.
 */

import vec3Pkg from 'vec3';
import {
  classifyCell,
  entityInCell,
  classifyPlaceFailure,
  placeAndVerify,
  withinPlaceReach,
} from './placeGuard.js';
import { BlueprintBuilder } from './blueprintBuilder.js';
import { setProtectedZones } from '../world/zones.js';

const Vec3 = vec3Pkg.Vec3 ?? vec3Pkg;

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function section(n) { console.log('\n# ' + n); }

// No protection zones in these tests — protection classification is
// asserted explicitly in its own section.
setProtectedZones([]);

const key = (x, y, z) => `${x},${y},${z}`;

/**
 * World mock: `blocks` maps "x,y,z" → block name. Unlisted cells are
 * air; cells listed as undefined are "unloaded" (blockAt → null).
 */
function makeBot({
  blocks = {},
  botPos = new Vec3(10.5, 64, 10.5),
  entities = {},
  placeBehavior = null,   // (ref, face) => Promise — overrides default
} = {}) {
  const boxFor = (name) => (
    ['tallgrass', 'snow_layer', 'red_flower'].includes(name) ? 'empty' : 'block'
  );
  return {
    entity: { position: botPos, type: 'player' },
    entities,
    blockAt: (v) => {
      const k = key(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z));
      if (Object.prototype.hasOwnProperty.call(blocks, k) && blocks[k] === null) return null;
      const name = blocks[k] ?? 'air';
      return {
        name,
        boundingBox: name === 'air' ? 'empty' : boxFor(name),
        position: new Vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)),
      };
    },
    placeBlock: placeBehavior ?? (() => Promise.resolve()),
    equip: () => Promise.resolve(),
    dig: () => Promise.resolve(),
    inventory: { items: () => [] },
  };
}

// =====================================================================
section('classifyCell');
{
  const bot = makeBot({ blocks: {
    [key(0, 64, 0)]: 'stone',
    [key(1, 64, 0)]: 'tallgrass',
    [key(2, 64, 0)]: 'water',
    [key(3, 64, 0)]: null,        // unloaded
  } });
  assert('solid block → occupied', classifyCell(bot, { x: 0, y: 64, z: 0 }) === 'occupied');
  assert('tallgrass → replaceable', classifyCell(bot, { x: 1, y: 64, z: 0 }) === 'replaceable');
  assert('water → replaceable', classifyCell(bot, { x: 2, y: 64, z: 0 }) === 'replaceable');
  assert('null blockAt → unloaded', classifyCell(bot, { x: 3, y: 64, z: 0 }) === 'unloaded');
  assert('empty cell → air', classifyCell(bot, { x: 9, y: 64, z: 9 }) === 'air');
}

// =====================================================================
section('entityInCell');
{
  // Bot feet at (5.5, 64, 5.5) — body occupies cells y=64 and y=65.
  const bot = makeBot({ botPos: new Vec3(5.5, 64, 5.5) });
  assert('own feet cell → self', entityInCell(bot, { x: 5, y: 64, z: 5 }) === 'self');
  assert('own head cell → self', entityInCell(bot, { x: 5, y: 65, z: 5 }) === 'self');
  assert('cell above head → null', entityInCell(bot, { x: 5, y: 66, z: 5 }) === null);
  assert('adjacent cell → null', entityInCell(bot, { x: 7, y: 64, z: 5 }) === null);

  const withMob = makeBot({
    botPos: new Vec3(20.5, 64, 20.5),
    entities: {
      1: { type: 'mob', position: new Vec3(5.5, 64, 5.5) },
      2: { type: 'object', position: new Vec3(8.5, 64, 8.5) }, // dropped item
    },
  });
  assert('mob in cell → other', entityInCell(withMob, { x: 5, y: 64, z: 5 }) === 'other');
  assert('dropped item ignored', entityInCell(withMob, { x: 8, y: 64, z: 8 }) === null);
}

// =====================================================================
section('withinPlaceReach');
{
  const bot = makeBot({ botPos: new Vec3(10.5, 64, 10.5) });
  assert('adjacent cell in reach', withinPlaceReach(bot, { x: 11, y: 64, z: 10 }) === true);
  assert('8 blocks away out of reach', withinPlaceReach(bot, { x: 18, y: 64, z: 10 }) === false);
}

// =====================================================================
section('classifyPlaceFailure priority');
{
  // Self-collision wins over everything.
  const selfBot = makeBot({ botPos: new Vec3(5.5, 64, 5.5) });
  assert('self in cell → self_collision',
    classifyPlaceFailure(selfBot, { x: 5, y: 64, z: 5 }, 'timeout') === 'self_collision');

  // Occupied cell next.
  const occBot = makeBot({ blocks: { [key(11, 64, 10)]: 'dirt' } });
  assert('occupied cell → cell_occupied',
    classifyPlaceFailure(occBot, { x: 11, y: 64, z: 10 }, 'timeout') === 'cell_occupied');

  // Out of reach.
  const farBot = makeBot();
  assert('far cell → out_of_reach',
    classifyPlaceFailure(farBot, { x: 30, y: 64, z: 10 }, 'timeout') === 'out_of_reach');

  // Preconditions fine + error message → server_rejected.
  const okBot = makeBot();
  assert('clean preconditions + error → server_rejected',
    classifyPlaceFailure(okBot, { x: 11, y: 64, z: 10 }, 'timeout') === 'server_rejected');

  // Protected zone (registered explicitly).
  setProtectedZones([{ center: { x: 11, z: 10 }, radius: 50, type: 'spawn' }]);
  assert('protected zone → protected_zone',
    classifyPlaceFailure(okBot, { x: 11, y: 64, z: 10 }, 'timeout') === 'protected_zone');
  setProtectedZones([]);
}

// =====================================================================
section('placeAndVerify — poll succeeds even when blockUpdate is missed');
await (async () => {
  // placeBlock never resolves (event missed), but the block appears
  // in the world after 200ms — the old code waited 5s then counted a
  // FAILURE; the guard must report success.
  const blocks = {};
  const bot = makeBot({
    blocks,
    placeBehavior: () => new Promise(() => {}),    // hangs forever
  });
  setTimeout(() => { blocks[key(11, 64, 10)] = 'dirt'; }, 200);
  const t0 = Date.now();
  const r = await placeAndVerify(bot, bot.blockAt(new Vec3(11, 63, 10)),
    new Vec3(0, 1, 0), { x: 11, y: 64, z: 10 });
  assert('verified as placed', r.ok === true, JSON.stringify(r));
  assert('resolved fast (<1.5s)', Date.now() - t0 < 1500, `${Date.now() - t0}ms`);
})();

// =====================================================================
section('placeAndVerify — fast classified failure on rejection');
await (async () => {
  // placeBlock rejects quickly and the world never changes → failure
  // must come back classified, well under mineflayer's 5s timeout.
  const bot = makeBot({
    placeBehavior: () => Promise.reject(new Error('blockUpdate timeout')),
  });
  const t0 = Date.now();
  const r = await placeAndVerify(bot, bot.blockAt(new Vec3(11, 63, 10)),
    new Vec3(0, 1, 0), { x: 11, y: 64, z: 10 });
  assert('failed', r.ok === false);
  assert('classified server_rejected', r.reason === 'server_rejected', r.reason);
  assert('failed fast (<1s)', Date.now() - t0 < 1000, `${Date.now() - t0}ms`);
})();

// =====================================================================
section('placeAndVerify — slow rejection bounded by our own timeout');
await (async () => {
  // placeBlock hangs (mineflayer would wait 5s); world never changes.
  // The guard gives up at its own ~2.5s deadline, not mineflayer's.
  const bot = makeBot({ placeBehavior: () => new Promise(() => {}) });
  const t0 = Date.now();
  const r = await placeAndVerify(bot, bot.blockAt(new Vec3(11, 63, 10)),
    new Vec3(0, 1, 0), { x: 11, y: 64, z: 10 }, );
  const ms = Date.now() - t0;
  assert('failed', r.ok === false);
  assert('bounded ~2.5s not 5s', ms < 3500, `${ms}ms`);
})();

// =====================================================================
section('builder _placeOne skips doomed calls');
await (async () => {
  // Target cell occupied by terrain that pre-dig cannot clear (dig
  // resolves but the mock world keeps the block — mirrors a server
  // rejecting the dig). placeBlock must never be called.
  let placeCalls = 0;
  const blocks = {
    [key(0, 64, 0)]: 'stone',   // target cell — occupied, undiggable
    [key(0, 63, 0)]: 'stone',   // reference below
  };
  const bot = makeBot({
    botPos: new Vec3(1.5, 64, 1.5),
    blocks,
    placeBehavior: () => { placeCalls++; return Promise.resolve(); },
  });
  bot.inventory = { items: () => [{ name: 'dirt' }] };
  const movement = {
    goTo: () => ({ done: Promise.resolve({ reached: true }), stop() {} }),
    cancel() {},
  };
  const b = new BlueprintBuilder({ bot, movement, log: { info() {}, warn() {}, debug() {} } });
  b._footprint = new Set();
  const r = await b._placeOne(
    { world: { x: 0, y: 64, z: 0 }, blockName: 'dirt' },
    { name: 'dirt' },
    () => false,
  );
  assert('result not ok', r.ok === false);
  assert('reason cell_occupied', r.reason === 'cell_occupied', r.reason);
  assert('placeBlock never called', placeCalls === 0, `${placeCalls} calls`);
})();

// =====================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
