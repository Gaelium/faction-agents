#!/usr/bin/env node
/**
 * test_lava_bridge.js — pathfinder lava-bridging guard (movement.js).
 *
 * Root cause (observed repeatedly, TestBot9/TestBot12): pathfinder's
 * getMoveForward treats a lava floor the same as air — lava's bounding
 * box is empty, so the floor block's `.physical` is false — and plans
 * "place ONE scaffold over the lava, then step onto it". In 1.8 that
 * placement is unreliable, so the bot slips into the lava and dies the
 * same way every time.
 *
 * makeLavaExclusion returns a pathfinder exclusion-area function that
 * weights any step/placement landing ON or directly OVER lava above 100,
 * which makes pathfinder discard the move and route AROUND the lava.
 */

import vec3Pkg from 'vec3';
import { makeLavaExclusion } from './movement.js';

const Vec3 = vec3Pkg.Vec3 ?? vec3Pkg;

let passed = 0;
let failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function section(name) { console.log('\n# ' + name); }

const AIR = { name: 'air', boundingBox: 'empty' };
const STONE = { name: 'stone', boundingBox: 'block' };
const LAVA = { name: 'lava', boundingBox: 'empty' };
const FLOWING_LAVA = { name: 'flowing_lava', boundingBox: 'empty' };

// A world is a map of "x,y,z" -> block. blockAt returns AIR for unset.
function makeBot(world) {
  return {
    blockAt: (v) => world[`${v.x},${v.y},${v.z}`] ?? AIR,
  };
}
// A pathfinder candidate block carries its world position (a real Vec3
// so .offset works, exactly as prismarine-block provides).
const blk = (base, x, y, z) => ({ ...base, position: new Vec3(x, y, z) });

// =====================================================================
section('forbids stepping ONTO lava');
{
  const bot = makeBot({ '5,10,5': LAVA });
  const weight = makeLavaExclusion(bot);
  assert('lava block itself → discarded (>100)', weight(blk(LAVA, 5, 10, 5)) > 100);
  assert('flowing_lava block → discarded',
    weight(blk(FLOWING_LAVA, 5, 10, 5)) > 100);
}

// =====================================================================
section('forbids stepping/placing directly OVER lava (the bridge case)');
{
  // The fatal move: bot wants to stand in the air block at y=11 whose
  // floor (y=10) is lava. getMoveForward would place a scaffold there.
  const bot = makeBot({ '5,10,5': LAVA });
  const weight = makeLavaExclusion(bot);
  assert('air with lava one block below → discarded',
    weight(blk(AIR, 5, 11, 5)) > 100);

  const flowingBot = makeBot({ '5,10,5': FLOWING_LAVA });
  assert('air over flowing_lava → discarded',
    makeLavaExclusion(flowingBot)(blk(AIR, 5, 11, 5)) > 100);
}

// =====================================================================
section('does NOT over-block safe terrain');
{
  // Solid floor → free. This is the regression guard: we must not make
  // ordinary walking expensive, only lava crossings.
  const bot = makeBot({ '5,9,5': STONE });
  const weight = makeLavaExclusion(bot);
  assert('air over stone → free (0)', weight(blk(AIR, 5, 10, 5)) === 0);

  // SPEC CHANGE (2026-06-10, user: "far more careful with lava"):
  // walking BESIDE lava is now PENALIZED — 1.8 momentum, corner cuts,
  // and knockback make pool rims exactly where bots slip in — but NOT
  // discarded (≤100), so a 1-wide corridor past lava remains usable
  // as a last resort instead of noPath-ing the bot into the lockout
  // escape.
  const besideBot = makeBot({ '6,9,5': LAVA, '5,9,5': STONE });
  const wBeside = makeLavaExclusion(besideBot)(blk(AIR, 5, 10, 5));
  assert('air over stone with lava on the rim → penalized', wBeside > 0, `w=${wBeside}`);
  assert('rim penalty does not discard the move (≤100)', wBeside <= 100, `w=${wBeside}`);

  // Void crossing (air below, NOT lava) is left to pathfinder's normal
  // scaffold logic — we only veto lava.
  const voidBot = makeBot({});
  assert('air over air (void) → free (not our concern)',
    makeLavaExclusion(voidBot)(blk(AIR, 5, 10, 5)) === 0);
}

// =====================================================================
section('robust to missing position / world-not-loaded');
{
  const bot = makeBot({});
  const weight = makeLavaExclusion(bot);
  assert('no block → 0', weight(null) === 0);
  assert('block without position → 0', weight({ name: 'air' }) === 0);

  const throwingBot = { blockAt: () => { throw new Error('chunk not loaded'); } };
  assert('blockAt throwing → treated as passable (0)',
    makeLavaExclusion(throwingBot)(blk(AIR, 5, 10, 5)) === 0);
}

// =====================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
