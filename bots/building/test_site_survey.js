#!/usr/bin/env node
/**
 * test_site_survey.js — terrain survey that picks a flat, fluid-free,
 * unprotected anchor for a structure footprint.
 *
 * Bug class (TestBot17, 2026-06-06): the build anchor was whatever
 * the home-fallback chain gave up at — pinned BELOW grade at y=63,
 * so the shelter was placed into a hillside and the server rejected
 * every cell. The survey must return ground+1 (on the surface) and
 * route around slopes, water, trees, protection, and blacklisted
 * sites.
 */

import vec3Pkg from 'vec3';
import { surveySite } from './siteSurvey.js';
import { setProtectedZones } from '../world/zones.js';

const Vec3 = vec3Pkg.Vec3 ?? vec3Pkg;

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function section(n) { console.log('\n# ' + n); }

setProtectedZones([]);

/**
 * Terrain mock: `groundAt(x, z)` → surface Y (topmost solid). Columns
 * in `waterCols` ("x,z") read water at the surface; cells in `extra`
 * ("x,y,z" → name) override.
 */
function makeBot({ groundAt = () => 63, waterCols = new Set(), extra = {} } = {}) {
  return {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: {},
    blockAt: (v) => {
      const x = Math.floor(v.x), y = Math.floor(v.y), z = Math.floor(v.z);
      const ek = `${x},${y},${z}`;
      let name;
      if (extra[ek] !== undefined) {
        name = extra[ek];
      } else if (waterCols.has(`${x},${z}`) && y <= groundAt(x, z)) {
        name = 'water';
      } else {
        name = y <= groundAt(x, z) ? 'stone' : 'air';
      }
      const empty = ['air', 'tallgrass'].includes(name);
      return { name, boundingBox: empty ? 'empty' : 'block', position: new Vec3(x, y, z) };
    },
  };
}

const dims = { x: 3, z: 3 };

// =====================================================================
section('flat ground: anchor lands ON the surface at the preferred spot');
{
  const bot = makeBot({ groundAt: () => 63 });
  const site = surveySite({ bot, dims, preferred: { x: 0, y: 63, z: 0 } });
  assert('site found', !!site);
  assert('anchor y = ground+1 (64)', site?.anchor.y === 64, `y=${site?.anchor.y}`);
  assert('stayed at preferred x/z', site?.anchor.x === 0 && site?.anchor.z === 0,
    JSON.stringify(site?.anchor));
  assert('zero earthwork', site?.earthwork === 0);
}

// =====================================================================
section('below-grade hint (the TestBot17 case): survey corrects the Y');
{
  // Ground is at y=70 but the stored anchor claims y=63 — 7 blocks
  // below the surface. Survey must come back with 71, not 63.
  const bot = makeBot({ groundAt: () => 70 });
  const site = surveySite({ bot, dims, preferred: { x: 0, y: 63, z: 0 } });
  assert('site found despite bad hint', !!site);
  assert('anchor snapped to surface (71)', site?.anchor.y === 71, `y=${site?.anchor.y}`);
}

// =====================================================================
section('slope at preferred: survey moves to the flat side');
{
  // x < 6: steep slope (1 block per x). x >= 6: flat plateau at y=68.
  const bot = makeBot({ groundAt: (x) => (x < 6 ? 62 + x : 68) });
  const site = surveySite({ bot, dims, preferred: { x: 0, y: 64, z: 0 } });
  assert('site found', !!site);
  assert('moved onto the plateau (x >= 6)', site?.anchor.x >= 6, `x=${site?.anchor.x}`);
  assert('zero earthwork on plateau', site?.earthwork === 0, `earthwork=${site?.earthwork}`);
}

// =====================================================================
section('water at preferred: survey moves to dry land');
{
  // Lake covering x in [-4, 4] × z in [-4, 4].
  const waterCols = new Set();
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) waterCols.add(`${x},${z}`);
  const bot = makeBot({ groundAt: () => 63, waterCols });
  const site = surveySite({ bot, dims, preferred: { x: 0, y: 63, z: 0 } });
  assert('site found', !!site);
  const dry = site && (site.anchor.x > 4 || site.anchor.x < -4 - 2
    || site.anchor.z > 4 || site.anchor.z < -4 - 2);
  assert('footprint clear of the lake', dry, JSON.stringify(site?.anchor));
}

// =====================================================================
section('nothing buildable in radius → null');
{
  // Water everywhere.
  const bot = makeBot({ groundAt: () => 63, waterCols: { has: () => true } });
  const site = surveySite({ bot, dims, preferred: { x: 0, y: 63, z: 0 }, searchRadius: 9 });
  assert('returns null on an all-water radius', site === null);
}

// =====================================================================
section('protected zone at preferred: survey moves outside');
{
  setProtectedZones([{ type: 'spawn', center: { x: 0, z: 0 }, radius: 8 }]);
  const bot = makeBot({ groundAt: () => 63 });
  const site = surveySite({ bot, dims, preferred: { x: 0, y: 63, z: 0 } });
  assert('site found', !!site);
  const out = site && Math.hypot(site.anchor.x, site.anchor.z) > 8;
  assert('footprint outside the zone', out, JSON.stringify(site?.anchor));
  setProtectedZones([]);
}

// =====================================================================
section('avoid list: blacklisted site is skipped');
{
  const bot = makeBot({ groundAt: () => 63 });
  const site = surveySite({
    bot, dims, preferred: { x: 0, y: 63, z: 0 },
    avoid: [{ x: 0, z: 0, radius: 6 }],
  });
  assert('site found', !!site);
  const clear = site && Math.hypot(site.anchor.x, site.anchor.z) > 6;
  assert('anchor outside the blacklist radius', clear, JSON.stringify(site?.anchor));
}

// =====================================================================
section('tree at preferred: clean spot beats chopping');
{
  // A 1×1 trunk + canopy on the preferred footprint.
  const extra = {};
  for (let y = 64; y <= 68; y++) extra[`1,${y},1`] = 'log';
  for (let x = 0; x <= 2; x++) for (let z = 0; z <= 2; z++) extra[`${x},69,${z}`] = 'leaves';
  const bot = makeBot({ groundAt: () => 63, extra });
  const site = surveySite({ bot, dims, preferred: { x: 0, y: 63, z: 0 } });
  assert('site found', !!site);
  assert('moved off the tree (zero vegetation)', site?.vegetation === 0,
    `veg=${site?.vegetation} at ${JSON.stringify(site?.anchor)}`);
}

// =====================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
