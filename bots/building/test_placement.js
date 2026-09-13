#!/usr/bin/env node
/**
 * test_placement.js — the farm-build placement model.
 *
 * BUILD_INCOME_FARM was unbuildable (TestBot12, 2026-06-05): `farmland`
 * and `water` are not inventory items, so the gather chased a non-existent
 * farmland recipe and the placement could never find the item. This model
 * teaches the pipeline that farmland is TILLED from dirt (+ a hoe) and
 * that water/seeds are best-effort.
 */

import {
  placementMethod, isOptionalBlock, defaultSource,
  gatherablesForMissing, hasHoe, hasBucket,
} from './placement.js';

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function section(n) { console.log('\n# ' + n); }

// =====================================================================
section('placement method by block');
{
  assert('farmland → till', placementMethod('farmland') === 'till');
  assert('water → water', placementMethod('water') === 'water');
  assert('wheat_seeds → plant', placementMethod('wheat_seeds') === 'plant');
  assert('sugar_cane → plant', placementMethod('sugar_cane') === 'plant');
  assert('cobblestone → place (default)', placementMethod('cobblestone') === 'place');
  assert('fence → place', placementMethod('fence') === 'place');
}

// =====================================================================
section('optionality (best-effort layer)');
{
  assert('water is optional', isOptionalBlock('water') === true);
  assert('seeds are optional', isOptionalBlock('wheat_seeds') === true);
  assert('farmland is REQUIRED (structural)', isOptionalBlock('farmland') === false);
  assert('fence is required', isOptionalBlock('fence') === false);
}

// =====================================================================
section('defaultSource');
{
  assert('farmland sources from dirt', defaultSource('farmland') === 'dirt');
  assert('cobblestone sources from itself', defaultSource('cobblestone') === 'cobblestone');
}

// =====================================================================
section('gatherablesForMissing: the BUILD_INCOME_FARM case');
{
  // wheat_farm_large missing (no dirt, no hoe held).
  const missing = { fence: 42, farmland: 70, water: 20, torch: 4 };
  const subs = { fence: ['wooden_fence'], farmland: ['dirt', 'grass'], water: [] };
  const g = gatherablesForMissing(missing, subs, {});
  assert('farmland → dirt (70)', g.dirt === 70, JSON.stringify(g));
  assert('adds a wooden_hoe (none held)', g.wooden_hoe === 1, JSON.stringify(g));
  assert('water (the block) dropped — placed best-effort', !('water' in g), JSON.stringify(g));
  assert('adds ONE bucket to hydrate (water needed, none held)', g.bucket === 1, JSON.stringify(g));
  assert('fence gathered as `fence` (recipe key), NOT the wooden_fence alias',
    g.fence === 42 && !('wooden_fence' in g), JSON.stringify(g));
  assert('torch passes through', g.torch === 4, JSON.stringify(g));
  assert('does NOT ask for un-gatherable farmland', !('farmland' in g), JSON.stringify(g));
}

// =====================================================================
section('gatherablesForMissing: bucket already held → no extra bucket');
{
  const g = gatherablesForMissing(
    { farmland: 10, water: 8 }, { farmland: ['dirt'], water: [] },
    { water_bucket: 1, stone_hoe: 1 },
  );
  assert('no bucket gathered (already have water_bucket)', !('bucket' in g), JSON.stringify(g));
  assert('hasBucket detects water_bucket', hasBucket({ water_bucket: 1 }) === true);
  assert('hasBucket detects empty bucket', hasBucket({ bucket: 2 }) === true);
  assert('hasBucket false on empty', hasBucket({}) === false);
  assert('no bucket gathered when no water cells',
    !('bucket' in gatherablesForMissing({ farmland: 4 }, { farmland: ['dirt'] }, {})),
    'farmland-only should not request a bucket');
}

// =====================================================================
section('gatherablesForMissing: hoe already held → no extra hoe');
{
  const g = gatherablesForMissing(
    { farmland: 10 }, { farmland: ['dirt'] }, { stone_hoe: 1 },
  );
  assert('dirt requested', g.dirt === 10, JSON.stringify(g));
  assert('no wooden_hoe (already have a hoe)', !('wooden_hoe' in g), JSON.stringify(g));
  assert('hasHoe detects stone_hoe', hasHoe({ stone_hoe: 1 }) === true);
  assert('hasHoe false on empty', hasHoe({}) === false);
}

// =====================================================================
section('gatherablesForMissing: plain base materials pass through');
{
  const g = gatherablesForMissing(
    { cobblestone: 64, wooden_door: 1, torch: 2 }, {}, {},
  );
  assert('cobblestone passes', g.cobblestone === 64, JSON.stringify(g));
  assert('door passes', g.wooden_door === 1, JSON.stringify(g));
  assert('no spurious hoe (no till blocks)', !('wooden_hoe' in g), JSON.stringify(g));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
