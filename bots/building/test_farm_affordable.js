#!/usr/bin/env node
/**
 * test_farm_affordable.js — farms must become AFFORDABLE once the
 * gatherable backbone (dirt for farmland, a bucket, a hoe) is in hand.
 *
 * Bug (TestBot39): canAfford re-counted water + seeds + the literal
 * `farmland` block as missing even after a perfect gather, while
 * gatherablesForMissing correctly strips water/seeds (best-effort placed)
 * and maps farmland→dirt+hoe. The two gates disagreed, so every farm was
 * "unaffordable" forever and looped in the gather phase. canAfford now
 * honors isOptionalBlock (water/seeds) and the till substitution
 * (farmland←dirt), matching the gather + completion gates.
 */

import { BlueprintRegistry } from './blueprintRegistry.js';
import { isMaterialObtainable } from './blueprintSelector.js';

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function section(n) { console.log('\n# ' + n); }

const reg = Object.create(BlueprintRegistry.prototype);
const wheat = { id: 'wheat_farm_t1', materials: { farmland: 56, water: 8, wheat_seeds: 56 }, substitutions: { water: [] } };
const cane = { id: 'sugarcane_row', materials: { sand: 8, reeds: 8, water: 8 }, substitutions: { sand: ['dirt'], water: [] } };

section('canAfford: optional water/seeds never block; farmland satisfied by dirt');
{
  const empty = reg.canAfford(wheat, {});
  assert('empty inventory → not affordable', empty.affordable === false);
  assert('only farmland (as dirt) is missing — NOT water/seeds', JSON.stringify(empty.missing) === JSON.stringify({ farmland: 56 }), JSON.stringify(empty.missing));

  const stocked = reg.canAfford(wheat, { dirt: 56 });
  assert('56 dirt → AFFORDABLE (water/seeds are best-effort)', stocked.affordable === true, JSON.stringify(stocked));

  const partial = reg.canAfford(wheat, { dirt: 30 });
  assert('partial dirt → still missing the shortfall under "farmland"', partial.affordable === false && partial.missing.farmland === 26, JSON.stringify(partial.missing));
}

section('canAfford: sugarcane optional reeds/water dropped, sand counted');
{
  const empty = reg.canAfford(cane, {});
  assert('only sand missing (reeds + water are optional)', JSON.stringify(empty.missing) === JSON.stringify({ sand: 8 }), JSON.stringify(empty.missing));
  assert('with 8 dirt (sand sub) → affordable', reg.canAfford(cane, { dirt: 8 }).affordable === true);
}

section('non-farm blueprints are unaffected');
{
  const base = { materials: { cobblestone: 144, wooden_door: 1, chest: 2, torch: 3 }, substitutions: {} };
  assert('base with full mats → affordable', reg.canAfford(base, { cobblestone: 144, wooden_door: 1, chest: 2, torch: 3 }).affordable === true);
  const short = reg.canAfford(base, { cobblestone: 100 });
  assert('base short on cobble → missing cobble (counted normally)', short.missing.cobblestone === 44, JSON.stringify(short.missing));
  assert('base torch counted (NOT optional)', short.missing.torch === 3, JSON.stringify(short.missing));
}

section('selector no longer sees the optional blockers (they leave canAfford.missing)');
{
  // The selector buckets feasibility over canAfford.missing. Since water +
  // seeds are now dropped from missing, the selector only ever judges the
  // gatherable backbone (farmland/sand/dirt) — all obtainable — so a farm
  // is never bucketed "infeasible" on a best-effort crop again.
  const wheatMissing = Object.keys(reg.canAfford(wheat, {}).missing);
  const caneMissing = Object.keys(reg.canAfford(cane, {}).missing);
  assert('wheat farm missing-set has no seeds/water', !wheatMissing.includes('wheat_seeds') && !wheatMissing.includes('water'));
  assert('cane farm missing-set has no reeds/water', !caneMissing.includes('reeds') && !caneMissing.includes('water'));
  assert('every remaining missing material is obtainable', [...wheatMissing, ...caneMissing].every((m) => isMaterialObtainable(m)), JSON.stringify([...wheatMissing, ...caneMissing]));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
