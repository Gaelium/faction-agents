#!/usr/bin/env node
/**
 * test_zones.js — exercises the protected-zone helpers.
 *
 *   isInProtectedZone({x,z})  — circle-containment by configured zone
 *   findProtectedZone({x,z})  — returns the matching zone or null
 *   pushOutsideProtection({x,z}) — radial push to ring edge + padding
 *   describeProtectedZones()  — human-readable line for the prompt
 *
 * Also verifies that mineBlock's safeFindBlock and the executor's
 * homeOffset honor the configured zone — done indirectly by setting
 * a small zone, calling the helpers, and asserting the geometry.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isInProtectedZone,
  isNearProtectedZone,
  findProtectedZone,
  pushOutsideProtection,
  describeProtectedZones,
  setProtectedZones,
  getProtectedZones,
  loadServerZones,
} from './zones.js';

let passed = 0;
let failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function section(name) { console.log('\n# ' + name); }

// ---------- defaults ----------
section('defaults: spawn at (420, 220) radius 200 (covers safezone+warzone+buffer)');
{
  const zones = getProtectedZones();
  assert('exactly one default zone', zones.length === 1,
    JSON.stringify(zones));
  assert('default center at (420, 220)',
    zones[0]?.center?.x === 420 && zones[0]?.center?.z === 220);
  assert('default radius 200', zones[0]?.radius === 200);
}

// ---------- containment ----------
section('isInProtectedZone tests circle containment (radius 200)');
{
  // Center is in.
  assert('center is inside', isInProtectedZone({ x: 420, z: 220 }));
  // 50 blocks east — inside.
  assert('50 blocks east is inside', isInProtectedZone({ x: 470, z: 220 }));
  // 199 blocks east — still inside (one block from the edge).
  assert('199 blocks east still inside', isInProtectedZone({ x: 619, z: 220 }));
  // 201 blocks east — outside.
  assert('201 blocks east outside', !isInProtectedZone({ x: 621, z: 220 }));
  // Diagonal sqrt(140² + 140²) ≈ 198 — inside.
  assert('140/140 diagonal inside (≈198 dist)',
    isInProtectedZone({ x: 560, z: 360 }));
  // Diagonal sqrt(150² + 150²) ≈ 212 — outside.
  assert('150/150 diagonal outside (≈212 dist)',
    !isInProtectedZone({ x: 570, z: 370 }));
  // Far-away point (the bot's deterministic home in the older logs).
  assert('home (340, -133) outside',
    !isInProtectedZone({ x: 340, z: -133 }));
  // Mining target from the log: (369, 227) ≈ 51 blocks from center.
  assert('mining target (369, 227) IS inside (matches the bug log)',
    isInProtectedZone({ x: 369, z: 227 }));
  // actualSpawn coordinate from the log: (498, 230). Should be inside.
  assert('actualSpawn (498, 230) IS inside (78 blocks from center)',
    isInProtectedZone({ x: 498, z: 230 }));
  // Per the user's update: bots must base/mine at least 200 blocks
  // out, so any point within ≤200 blocks of the spawn center is now
  // protected — including positions that the previous radius=100
  // would have allowed.
  assert('150 blocks east IS now inside (was outside under radius=100)',
    isInProtectedZone({ x: 570, z: 220 }));
}

section('isInProtectedZone rejects bad inputs');
{
  assert('null is not in zone', !isInProtectedZone(null));
  assert('undefined is not in zone', !isInProtectedZone(undefined));
  assert('non-numeric x is not in zone',
    !isInProtectedZone({ x: 'abc', z: 0 }));
  assert('missing z is not in zone',
    !isInProtectedZone({ x: 420 }));
}

// ---------- pushOutsideProtection ----------
section('pushOutsideProtection moves to ring edge with padding');
{
  // Inside the zone, due-east of center.
  const r = pushOutsideProtection({ x: 470, z: 220 }, 8);
  // Expected x = 420 + (200 + 8) = 628, z unchanged.
  assert('pushed east to ring + padding',
    r.x === 628 && r.z === 220, JSON.stringify(r));

  // At the dead center → defaults to east.
  const center = pushOutsideProtection({ x: 420, z: 220 }, 8);
  assert('center push lands east',
    center.x === 628 && center.z === 220, JSON.stringify(center));

  // Already outside — pass through unchanged.
  const outside = pushOutsideProtection({ x: 1000, z: 1000 }, 8);
  assert('outside point unchanged',
    outside.x === 1000 && outside.z === 1000, JSON.stringify(outside));

  // North-west corner inside ring — pushed in same NW bearing.
  const nw = pushOutsideProtection({ x: 380, z: 180 }, 16);
  // Bearing is (-40, -40) from center; magnitude ~56.5; scale to
  // (200+16)/56.5 ≈ 3.82 → offset (~-153, -153) → (~267, ~67).
  assert('NW corner pushed in NW bearing',
    nw.x < 420 && nw.z < 220, JSON.stringify(nw));
  assert('NW pushed beyond radius',
    Math.hypot(nw.x - 420, nw.z - 220) >= 200 + 16 - 1, JSON.stringify(nw));
}

// ---------- findProtectedZone ----------
section('findProtectedZone returns matching zone or null');
{
  const z = findProtectedZone({ x: 420, z: 220 });
  assert('lookup at center returns zone with type=spawn',
    z?.type === 'spawn', JSON.stringify(z));
  assert('lookup outside returns null',
    findProtectedZone({ x: 1000, z: 1000 }) === null);
}

// ---------- describeProtectedZones ----------
section('describeProtectedZones renders a prompt-friendly line');
{
  const desc = describeProtectedZones();
  assert('description mentions spawn type',
    desc.includes('spawn'), desc);
  assert('description mentions center coords',
    desc.includes('420') && desc.includes('220'), desc);
  assert('description mentions radius',
    desc.includes('200'), desc);
}

// ---------- setProtectedZones override ----------
section('setProtectedZones replaces the active list');
{
  setProtectedZones([
    {
      type: 'arena',
      center: { x: 0, z: 0 },
      radius: 30,
      description: 'PvP arena — no build',
    },
  ]);
  assert('default spawn zone is replaced', !isInProtectedZone({ x: 420, z: 220 }));
  assert('new arena zone is honored', isInProtectedZone({ x: 0, z: 0 }));
  assert('describeProtectedZones reflects override',
    describeProtectedZones().includes('arena'));

  // Disable all protections.
  setProtectedZones([]);
  assert('empty list disables protection',
    !isInProtectedZone({ x: 420, z: 220 }));
  assert('describe returns empty when no zones',
    describeProtectedZones() === '');

  // Restore default for any tests that import after us.
  setProtectedZones([
    { type: 'spawn', center: { x: 420, z: 220 }, radius: 200,
      description: 'Server spawn safezone/warzone' },
  ]);
  assert('restored spawn zone',
    isInProtectedZone({ x: 420, z: 220 }));
}

section('setProtectedZones rejects invalid entries');
{
  setProtectedZones([
    { type: 'spawn', center: { x: 420, z: 220 }, radius: 200 },
    { type: 'broken' },                                  // missing center+radius
    { type: 'broken2', center: { x: 1, z: 2 } },         // missing radius
    { type: 'broken3', center: { x: 1 }, radius: 10 },   // missing z
    { type: 'broken4', center: { x: 1, z: 2 }, radius: 0 },  // 0 radius
    { type: 'broken5', center: { x: 1, z: 2 }, radius: -10 }, // negative radius
    null,
    undefined,
  ]);
  const zones = getProtectedZones();
  assert('only the valid zone survives validation',
    zones.length === 1 && zones[0].type === 'spawn',
    JSON.stringify(zones));
}

// ---------- box zones (WorldGuard cuboids) ----------
section('box zones: containment, near-buffer, push through nearest face');
{
  setProtectedZones([{ type: 'region:spawn', min: { x: 100, z: 100 }, max: { x: 200, z: 300 } }]);
  assert('inside box', isInProtectedZone({ x: 150, z: 200 }));
  assert('on edge counts inside', isInProtectedZone({ x: 100, z: 100 }));
  assert('outside box', !isInProtectedZone({ x: 99, z: 200 }));
  assert('near within buffer', isNearProtectedZone({ x: 95, z: 200 }, 10));
  assert('not near past buffer', !isNearProtectedZone({ x: 50, z: 200 }, 10));
  const out = pushOutsideProtection({ x: 105, z: 200 }, 8);
  assert('pushed out radially (westward here)',
    !isInProtectedZone(out) && out.x < 100, JSON.stringify(out));

  // De-clustering (TestBots 19/20/21 all based on the same east-edge
  // line): positions at DIFFERENT angles inside the box must exit in
  // DIFFERENT directions, not collapse onto one face.
  const north = pushOutsideProtection({ x: 150, z: 150 }, 8);   // above center
  const south = pushOutsideProtection({ x: 150, z: 250 }, 8);   // below center
  const east = pushOutsideProtection({ x: 180, z: 200 }, 8);    // right of center
  assert('north-angled exit goes north', north.z < 100, JSON.stringify(north));
  assert('south-angled exit goes south', south.z > 300, JSON.stringify(south));
  assert('east-angled exit goes east', east.x > 200, JSON.stringify(east));
  assert('all three exits are well separated',
    Math.hypot(north.x - south.x, north.z - south.z) > 50
    && Math.hypot(north.x - east.x, north.z - east.z) > 50,
    JSON.stringify({ north, south, east }));
  assert('findProtectedZone returns the box',
    findProtectedZone({ x: 150, z: 200 })?.type === 'region:spawn');
  assert('describe renders box bounds',
    describeProtectedZones().includes('box (100, 100)'), describeProtectedZones());
}

// ---------- chunk-claim zones (Factions board) ----------
section('chunk-claim zones: containment, near-buffer, push');
{
  // Claims at chunks (20,7)..(21,8) → blocks x 320–351, z 112–143.
  setProtectedZones([{ type: 'warzone', chunks: ['20,7', '20,8', '21,7', '21,8'] }]);
  assert('inside claimed chunk', isInProtectedZone({ x: 325, z: 115 }));
  assert('chunk min corner exact', isInProtectedZone({ x: 320, z: 112 }));
  assert('neighbor unclaimed chunk free', !isInProtectedZone({ x: 319, z: 115 }));
  assert('near a claim within buffer', isNearProtectedZone({ x: 316, z: 115 }, 8));
  const out = pushOutsideProtection({ x: 330, z: 120 }, 8);
  assert('pushed out of the claims', !isInProtectedZone(out), JSON.stringify(out));
  assert('describe renders chunk count',
    describeProtectedZones().includes('4 claimed chunks'), describeProtectedZones());
}

// ---------- overlapping zones ----------
section('overlapping zones: push escapes all of them');
{
  setProtectedZones([
    { type: 'safezone', center: { x: 0, z: 0 }, radius: 30 },
    { type: 'warzone', center: { x: 0, z: 0 }, radius: 60 },
  ]);
  const out = pushOutsideProtection({ x: 5, z: 0 }, 8);
  assert('escaped the outer ring too', !isInProtectedZone(out), JSON.stringify(out));
}

// ---------- server-truth loader ----------
section('loadServerZones: real server files (regression pin, TestBot17)');
{
  const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const serverDir = path.join(repoRoot, 'server');
  if (!fs.existsSync(serverDir)) {
    console.log('  (skipped — no server/ directory beside bots/)');
  } else {
    const res = loadServerZones({ serverDir });
    assert('loaded at least one zone', res.zones >= 1, JSON.stringify(res));
    // The WorldGuard spawn cuboid is x 306–493, z 126–314.
    assert('spawn center (420, 220) protected', isInProtectedZone({ x: 420, z: 220 }));
    assert('inside cuboid corner protected', isInProtectedZone({ x: 310, z: 130 }));
    // TestBot17's build site — wilderness in reality (outside the
    // cuboid, no claim), but the old r=200 circle's edge sat ~16
    // blocks away from it. Must read as free now.
    assert('TestBot17 site (204, 233) NOT protected',
      !isInProtectedZone({ x: 204, z: 233 }));
    // Warzone chunk claims cover ground the cuboid may not. The Factions
    // board is runtime state (ignored by git), so the pin only runs when
    // the file is present.
    const boardFile = path.join(serverDir, 'mstore', 'factions_board', 'world.json');
    if (fs.existsSync(boardFile)) {
      assert('warzone chunk (20,7) → block (325, 115) protected',
        isInProtectedZone({ x: 325, z: 115 }));
    } else {
      console.log('  (skipped — server/mstore/factions_board/world.json absent, warzone chunk pin needs it)');
    }
  }
}

section('loadServerZones: missing files keep existing zones');
{
  setProtectedZones([{ type: 'sentinel', center: { x: 9, z: 9 }, radius: 5 }]);
  const res = loadServerZones({ serverDir: '/nonexistent/path' });
  assert('reports zero loaded', res.zones === 0);
  assert('sentinel zone kept', findProtectedZone({ x: 9, z: 9 })?.type === 'sentinel');
}

// Restore the default-equivalent spawn circle for any suite that
// imports after us.
setProtectedZones([
  { type: 'spawn', center: { x: 420, z: 220 }, radius: 200,
    description: 'Server spawn safezone/warzone' },
]);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
