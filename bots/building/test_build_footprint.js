#!/usr/bin/env node
/**
 * test_build_footprint.js — the builder must build from OUTSIDE the
 * structure footprint, never from inside it.
 *
 * Bug (TestBot17, 2026-06-06): dirt_shelter is a near-solid 3×3×3 dirt
 * cube; the bot stood INSIDE it at the anchor and tried to place dirt
 * into the cells its own body occupied. The server never confirms those
 * placements, so bot.placeBlock hangs 5s per cell — the bot "stood in
 * the spot trying to place dirt but failing" for minutes. Fixes: exclude
 * footprint cells from standing poses, and step out of the footprint at
 * build start.
 */

import vec3Pkg from 'vec3';
import { BlueprintBuilder } from './blueprintBuilder.js';

const Vec3 = vec3Pkg.Vec3 ?? vec3Pkg;

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function section(n) { console.log('\n# ' + n); }

const key = (x, y, z) => `${x},${y},${z}`;

// Flat world: solid stone at y<=63, air above. Bot at (1,64,1).
function makeBuilder({ botPos = new Vec3(1, 64, 1), gotoSpy } = {}) {
  const bot = {
    entity: { position: botPos },
    blockAt: (v) => ({
      name: v.y <= 63 ? 'stone' : 'air',
      boundingBox: v.y <= 63 ? 'block' : 'empty',
      position: new Vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)),
    }),
    canDigBlock: () => true,
  };
  const movement = {
    goTo: (t) => { if (gotoSpy) gotoSpy.push(t); return { done: Promise.resolve({ reached: true }), stop() {} }; },
    cancel() {},
  };
  return new BlueprintBuilder({ bot, movement, log: { info() {}, warn() {}, debug() {} } });
}

// A 3×3 footprint of dirt at y=64, anchor (0,64,0) → cells (0..2, 64, 0..2).
function set3x3Footprint(builder) {
  builder._footprint = new Set();
  for (let x = 0; x <= 2; x++) for (let z = 0; z <= 2; z++) {
    builder._footprint.add(key(x, 64, z));
  }
}

// =====================================================================
section('_inFootprint identifies structure cells');
{
  const b = makeBuilder();
  set3x3Footprint(b);
  assert('center cell is footprint', b._inFootprint(1, 64, 1) === true);
  assert('outside cell is not', b._inFootprint(4, 64, 1) === false);
  assert('different Y is not', b._inFootprint(1, 65, 1) === false);
}

// =====================================================================
section('_findAllStanding never returns a pose inside the footprint');
{
  const b = makeBuilder();
  set3x3Footprint(b);
  // Target an EDGE cell (0,64,1) — it has neighbors outside the 3×3 (at
  // x=-1), so a valid exterior standing pose exists; all returned poses
  // must be OUTSIDE the footprint. (The CENTER cell legitimately has no
  // adjacent exterior pose and is reached from an exterior pose instead.)
  const poses = b._findAllStanding({ x: 0, y: 64, z: 1 });
  assert('found at least one exterior standing pose', poses.length > 0, JSON.stringify(poses.slice(0, 3)));
  const anyInside = poses.some((p) =>
    b._inFootprint(p.x, p.y, p.z) || b._inFootprint(p.x, p.y + 1, p.z));
  assert('no standing pose is inside the footprint (feet or head)', !anyInside,
    JSON.stringify(poses.filter((p) => b._inFootprint(p.x, p.y, p.z) || b._inFootprint(p.x, p.y + 1, p.z))));
}

// =====================================================================
section('_stepOutOfFootprint walks the bot out when standing inside');
{
  const gotoSpy = [];
  const b = makeBuilder({ botPos: new Vec3(1, 64, 1), gotoSpy }); // inside the 3x3
  set3x3Footprint(b);
  await b._stepOutOfFootprint(() => false);
  assert('issued a goTo to leave the footprint', gotoSpy.length === 1, JSON.stringify(gotoSpy));
  const dest = gotoSpy[0];
  assert('destination is OUTSIDE the footprint',
    dest && !b._inFootprint(dest.x, dest.y, dest.z) && !b._inFootprint(dest.x, dest.y + 1, dest.z),
    JSON.stringify(dest));
}

// =====================================================================
section('_stepOutOfFootprint is a no-op when already clear');
{
  const gotoSpy = [];
  const b = makeBuilder({ botPos: new Vec3(10, 64, 10), gotoSpy }); // far outside
  set3x3Footprint(b);
  await b._stepOutOfFootprint(() => false);
  assert('no goTo issued (already clear)', gotoSpy.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
