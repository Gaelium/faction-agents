#!/usr/bin/env node
/**
 * test_farm_builder.js — BlueprintBuilder builds a JSON farm correctly.
 *
 * This is the path BUILD_INCOME_FARM actually uses (executor →
 * blueprintBuilder.build), distinct from the placeBlueprint primitive.
 * Before the fix it placed DIRT where farmland belonged (via the
 * farmland:['dirt'] substitution + lenient _isAlreadyCorrect) and counted
 * un-bucketed water as a missing material, so the farm never became a
 * real farm and/or never reported done. Now: farmland is hoed into
 * farmland, seeds are planted, water is skipped best-effort, and the
 * build completes.
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

const key = (x, y, z) => `${Math.round(x)},${Math.round(y)},${Math.round(z)}`;

// A 2×2 farmland plot (y=0), a water row behind it, and wheat seeds above
// the farmland. token_map keys: F farmland, W water, S seeds, . air.
const FARM = {
  id: 'test_json_farm', name: 'JSON Farm', category: 'farm',
  archetypes: ['farmer'], tier_min: 1, tier_max: 1, placement: 'surface',
  dimensions: { x: 2, y: 2, z: 2 },
  materials: { farmland: 4, water: 2, wheat_seeds: 4 },
  substitutions: { farmland: ['dirt', 'grass'], water: [] },
  token_map: { '.': null, F: 'farmland', W: 'water', S: 'wheat_seeds' },
  layers: [
    ['FF', 'WW'],   // y=0: z=0 two farmland, z=1 two water
    ['SS', '..'],   // y=1: seeds above the farmland row
  ],
  build_order: 'bottom_up',
  interior: [],
  _totalBlocks: 8,
};

// Mutable world. Grass at the farmland cells (tillable in place), solid
// stone under everything (reference + standing), air elsewhere.
function makeWorld() {
  const w = new Map();
  for (let x = 0; x <= 1; x++) {
    for (let z = 0; z <= 1; z++) {
      w.set(key(x, 64, 0 + z), z === 0 ? 'grass' : 'air'); // y0 row: grass / air(water)
      w.set(key(x, 63, 0 + z), 'stone');                   // floor below
    }
  }
  return {
    raw: w,
    at: (pos) => {
      const name = w.get(key(pos.x, pos.y, pos.z)) ?? 'air';
      return { name, boundingBox: name === 'air' ? 'empty' : 'block',
        position: new Vec3(Math.round(pos.x), Math.round(pos.y), Math.round(pos.z)) };
    },
    set: (x, y, z, name) => w.set(key(x, y, z), name),
  };
}

function makeBot(world, inv) {
  let equipped = null;
  const take = (name) => { const it = inv.find((i) => i.name === name && i.count > 0); if (it) it.count--; return it; };
  const give = (name) => { const it = inv.find((i) => i.name === name); if (it) it.count++; else inv.push({ name, count: 1 }); };
  return {
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inv.filter((i) => (i.count ?? 0) > 0) },
    blockAt: (pos) => world.at(pos),
    findBlock: ({ matching, maxDistance = 16 }) => {
      // Scan the mock world for the nearest block satisfying `matching`.
      let best = null, bestD = Infinity;
      const me = { x: 0, y: 64, z: 0 };
      for (const [k] of world.raw) {
        const [x, y, z] = k.split(',').map(Number);
        const b = world.at(new Vec3(x, y, z));
        const ok = typeof matching === 'function' ? matching(b) : false;
        if (!ok) continue;
        const d = Math.abs(x - me.x) + Math.abs(y - me.y) + Math.abs(z - me.z);
        if (d <= maxDistance && d < bestD) { best = b; bestD = d; }
      }
      return best;
    },
    canDigBlock: () => true,
    dig: async () => {},
    equip: async (item) => { equipped = item; },
    lookAt: async () => {},
    activateItem: () => {
      // Fill: empty bucket on water → water_bucket.
      if (equipped?.name === 'bucket') { take('bucket'); give('water_bucket'); equipped = inv.find((i) => i.name === 'water_bucket'); }
    },
    deactivateItem: () => {},
    activateBlock: async (block) => {
      const p = block.position;
      if (equipped?.name?.endsWith('_hoe') && (block.name === 'dirt' || block.name === 'grass')) {
        world.set(p.x, p.y, p.z, 'farmland');
      } else if (equipped?.name?.endsWith('_seeds')) {
        world.set(p.x, p.y + 1, p.z, 'wheat'); // crop appears above
      } else if (equipped?.name === 'water_bucket') {
        // Place water in the cell above the reference (the targeted cell).
        world.set(p.x, p.y + 1, p.z, 'water');
        take('water_bucket'); give('bucket'); equipped = inv.find((i) => i.name === 'bucket');
      }
    },
    placeBlock: async (ref, face) => {
      world.set(ref.position.x + face.x, ref.position.y + face.y, ref.position.z + face.z,
        equipped?.name ?? 'air');
    },
    quit() {}, clearControlStates() {},
  };
}

function makeMovement() {
  return { goTo: () => ({ done: Promise.resolve({ reached: true }), stop() {} }), cancel() {} };
}

async function main() {
  // =================================================================
  section('farm with hoe + dirt + seeds → tilled, planted, done');
  {
    const world = makeWorld();
    const bot = makeBot(world, [
      { name: 'wooden_hoe', count: 1 },
      { name: 'dirt', count: 16 },
      { name: 'wheat_seeds', count: 16 },
    ]);
    const builder = new BlueprintBuilder({
      bot, movement: makeMovement(),
      log: { info() {}, warn() {}, debug() {} },
    });
    const res = await builder.build(FARM, { x: 0, y: 64, z: 0 }, 0).done;

    assert('build reports done', res.reason === 'done', JSON.stringify(res));
    assert('cell (0,0) is farmland (tilled, not dirt)',
      world.at(new Vec3(0, 64, 0)).name === 'farmland', world.at(new Vec3(0, 64, 0)).name);
    assert('cell (1,0) is farmland',
      world.at(new Vec3(1, 64, 0)).name === 'farmland', world.at(new Vec3(1, 64, 0)).name);
    assert('seeds planted above farmland (crop at y=65)',
      world.at(new Vec3(0, 65, 0)).name === 'wheat', world.at(new Vec3(0, 65, 0)).name);
    assert('water cells skipped (no bucket) but build still done',
      res.reason === 'done', JSON.stringify(res));
  }

  // =================================================================
  section('farm with a bucket + nearby water → cells get hydrated');
  {
    const world = makeWorld();
    world.set(5, 64, 5, 'water');            // a natural source to fill from
    world.set(5, 63, 5, 'stone');
    const bot = makeBot(world, [
      { name: 'wooden_hoe', count: 1 },
      { name: 'dirt', count: 16 },
      { name: 'wheat_seeds', count: 16 },
      { name: 'bucket', count: 1 },          // ONE empty bucket
    ]);
    const builder = new BlueprintBuilder({
      bot, movement: makeMovement(),
      log: { info() {}, warn() {}, debug() {} },
    });
    const res = await builder.build(FARM, { x: 0, y: 64, z: 0 }, 0).done;
    assert('build done', res.reason === 'done', JSON.stringify(res));
    assert('water cell (0,1) hydrated', world.at(new Vec3(0, 64, 1)).name === 'water',
      world.at(new Vec3(0, 64, 1)).name);
    assert('second water cell (1,1) hydrated too (one bucket refilled)',
      world.at(new Vec3(1, 64, 1)).name === 'water', world.at(new Vec3(1, 64, 1)).name);
  }

  // =================================================================
  section('farm with NO bucket → completes dry (water best-effort)');
  {
    const world = makeWorld();
    const bot = makeBot(world, [
      { name: 'wooden_hoe', count: 1 },
      { name: 'dirt', count: 16 },
    ]);
    const builder = new BlueprintBuilder({
      bot, movement: makeMovement(),
      log: { info() {}, warn() {}, debug() {} },
    });
    const res = await builder.build(FARM, { x: 0, y: 64, z: 0 }, 0).done;
    assert('still completes without water (best-effort)', res.reason === 'done', JSON.stringify(res));
    assert('water cell stayed air (no bucket → skipped, not failed)',
      world.at(new Vec3(0, 64, 1)).name === 'air', world.at(new Vec3(0, 64, 1)).name);
  }

  // =================================================================
  section('farm with NO hoe → partial (farmland blocks surface as failure)');
  {
    const world = makeWorld();
    const bot = makeBot(world, [{ name: 'dirt', count: 16 }]); // no hoe
    const builder = new BlueprintBuilder({
      bot, movement: makeMovement(),
      log: { info() {}, warn() {}, debug() {} },
    });
    const res = await builder.build(FARM, { x: 0, y: 64, z: 0 }, 0).done;
    assert('not done without a hoe', res.reason !== 'done', JSON.stringify(res));
    assert('farmland was NOT left as raw grass/dirt counted as built',
      world.at(new Vec3(0, 64, 0)).name !== 'farmland', world.at(new Vec3(0, 64, 0)).name);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error('runner threw:', e); process.exit(2); });
