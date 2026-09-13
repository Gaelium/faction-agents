#!/usr/bin/env node
/**
 * test_dig_protection.js — guards the protected-zone dig gate that keeps
 * a bot from hammering doomed digs inside spawn.
 *
 * Regression: TestBot26 (2026-06-16) spawned INSIDE the WorldGuard spawn
 * box and the initial home-walk (bot.goto) used the pathfinder's default
 * Movements (canDig=true), so it dug through spawn and the server rejected
 * every break ("you can't break that block here") in a loop until timeout.
 * The fix routes the home-walk through movement.updateDigPermission first.
 * This test pins the load-bearing mechanism: updateDigPermission must set
 * canDig=false while inside/near protection, re-enable it outside, and not
 * rebuild Movements when the suppression state hasn't changed.
 */

import vec3Pkg from 'vec3';
import registryLoader from 'prismarine-registry';
import { Movement } from './movement.js';
import { setProtectedZones } from './zones.js';

const Vec3 = vec3Pkg.Vec3 ?? vec3Pkg;

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function section(n) { console.log('\n# ' + n); }

// Mirror the real spawn cuboid (x 306-493, z 126-314).
setProtectedZones([{ type: 'region:spawn', min: { x: 306, z: 126 }, max: { x: 493, z: 314 } }]);

function makeMovement() {
  const captured = [];
  const bot = {
    entity: { position: { x: 400, y: 66, z: 220 } },
    pathfinder: { setMovements: (mv) => captured.push(mv) },
  };
  const m = new Movement(bot);
  // Avoid building real pathfinder Movements (needs a live block registry);
  // capture only the canDig decision, which is all this gate controls.
  m._buildMovements = (canDig) => ({ canDig, _stub: true });
  return { m, captured };
}

section('updateDigPermission gates canDig by protection');
{
  const { m, captured } = makeMovement();

  // Inside the spawn box → suppress digging.
  m.updateDigPermission({ x: 400, y: 66, z: 220 });
  assert('inside protection → setMovements called', captured.length === 1);
  assert('inside protection → canDig=false', captured[0]?.canDig === false);

  // A block just outside the box but within the buffer still suppresses.
  m.updateDigPermission({ x: 499, y: 66, z: 220 }); // 6 blocks past x-max=493 (< PROTECTION_DIG_BUFFER 8)
  assert('within buffer of boundary → still suppressed (no rebuild)', captured.length === 1);

  // Far outside → re-enable digging.
  m.updateDigPermission({ x: 700, y: 66, z: 700 });
  assert('far outside → setMovements called again', captured.length === 2);
  assert('far outside → canDig=true', captured[1]?.canDig === true);

  // Same state → no redundant rebuild.
  m.updateDigPermission({ x: 720, y: 66, z: 720 });
  assert('unchanged state → no extra setMovements', captured.length === 2);

  // Back inside → suppress again.
  m.updateDigPermission({ x: 400, y: 66, z: 220 });
  assert('re-entering protection → suppressed again', captured.length === 3 && captured[2]?.canDig === false);
}

section('updateDigPermission ignores bad input');
{
  const { m, captured } = makeMovement();
  m.updateDigPermission(null);
  m.updateDigPermission({ x: 'nope' });
  m.updateDigPermission(undefined);
  assert('no setMovements for invalid position', captured.length === 0);
}

section('pathfinder Movements make protected blocks un-breakable (TestBot37)');
{
  // The real fix for mining INTO spawn: even with canDig=true, the
  // pathfinder must never plan to break a block inside a protected zone
  // (it dug east THROUGH the box to reach an east target → 27 denials).
  const registry = registryLoader('1.8.8');
  const bot = {
    registry,
    entity: { position: { x: 400, y: 66, z: 220 } },
    pathfinder: { setMovements() {} },
  };
  const m = new Movement(bot);
  const mv = m._buildMovements(true);   // canDig TRUE — exclusion must still bite
  assert('exclusionAreasBreak has the protection guard', Array.isArray(mv.exclusionAreasBreak) && mv.exclusionAreasBreak.length >= 1);

  const stone = registry.blocksByName.stone;
  const inProt = { type: stone.id, name: 'stone', position: new Vec3(400, 11, 200) };   // inside the box
  const outProt = { type: stone.id, name: 'stone', position: new Vec3(200, 11, 200) };  // west of the box
  assert('block inside protection → exclusionBreak >= 100 (un-diggable)', mv.exclusionBreak(inProt) >= 100, String(mv.exclusionBreak(inProt)));
  assert('block outside protection → exclusionBreak 0', mv.exclusionBreak(outProt) === 0);
  // isolate from the liquid/falling-block neighbour checks (need a live world)
  mv.dontCreateFlow = false;
  mv.dontMineUnderFallingBlock = false;
  assert('safeToBreak FALSE inside protection (pathfinder routes around)', mv.safeToBreak(inProt) === false);
  assert('safeToBreak TRUE outside protection (normal mining unaffected)', mv.safeToBreak(outProt) === true);
}

setProtectedZones([]);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
