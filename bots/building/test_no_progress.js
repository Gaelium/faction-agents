#!/usr/bin/env node
/**
 * test_no_progress.js — verifies the BlueprintBuilder distinguishes
 * "build genuinely complete" from "bot was nowhere near the anchor
 * so every placement attempt failed". The old code reported
 * `reason: 'done'` and called `markStructureComplete()` even when
 * 0 blocks were placed and 26 were skipped due to standing-position
 * lookup failing, which corrupted project progress in the
 * worldModel.
 */

import { BlueprintBuilder } from './blueprintBuilder.js';

let passed = 0;
let failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function section(name) { console.log('\n# ' + name); }

// Tiny blueprint: 2 cobblestone placements at known positions.
const TINY_BLUEPRINT = {
  id: 'test_two_cobble',
  name: 'Two Cobble',
  category: 'base',
  archetypes: ['builder'],
  tier_min: 1,
  tier_max: 1,
  placement: 'surface',
  dimensions: { x: 2, y: 1, z: 1 },
  materials: { cobblestone: 2 },
  token_map: { '.': null, C: 'cobblestone' },
  layers: [['CC']],
  build_order: 'bottom_up',
  interior: [],
  _totalBlocks: 2,
};

function makeBot({ findStanding = false, hasItem = true } = {}) {
  // _findStanding looks up bot.blockAt for legs/head/ground. To force
  // _findStanding to ALWAYS fail (mimic "bot is hundreds of blocks
  // away from the anchor"), return a solid non-overlapping block for
  // every position so legs/head/ground checks all see non-air →
  // standing rejected. We avoid 'stone' here because
  // _isAlreadyCorrect's loose match treats 'cobblestone'.includes('stone')
  // as "already correct"; using 'dirt' guarantees the placement loop
  // proceeds to the place-attempt branch.
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => hasItem ? [{ name: 'cobblestone', count: 64 }] : [] },
    blockAt: () => ({ name: 'dirt', boundingBox: 'block' }),
    canDigBlock: () => true,
    quit() {},
    clearControlStates() {},
  };
  return bot;
}

function makeMovement() {
  return {
    goTo: () => ({
      done: Promise.resolve({ reached: false, reason: 'noPath' }),
      stop() {},
    }),
    cancel() {},
  };
}

async function main() {
  // ---------- 1. all standing lookups fail → reason 'no_progress' ----------
  section('Build with unreachable anchor reports reason="no_progress"');
  {
    let markComplete = 0;
    let markBlock = 0;
    const worldModel = {
      startStructure: () => 1,
      markBlockPlaced: () => { markBlock++; },
      markStructureComplete: () => { markComplete++; },
    };
    const events = [];
    const log = {
      info: (event, data) => events.push({ level: 'info', event, data }),
      warn: (event, data) => events.push({ level: 'warn', event, data }),
      debug: (event, data) => events.push({ level: 'debug', event, data }),
    };
    const builder = new BlueprintBuilder({
      bot: makeBot(),
      movement: makeMovement(),
      log,
      worldModel,
    });
    const handle = builder.build(TINY_BLUEPRINT, { x: 0, y: 64, z: 0 }, 0);
    const r = await handle.done;
    assert('result reason is no_progress', r?.reason === 'no_progress',
      JSON.stringify(r));
    assert('placed is 0', r?.placed === 0, JSON.stringify(r));
    assert('total is 2', r?.total === 2, JSON.stringify(r));
    assert('worldModel.markStructureComplete was NOT called',
      markComplete === 0, `markComplete=${markComplete}`);
    assert('worldModel.markBlockPlaced was NOT called',
      markBlock === 0, `markBlock=${markBlock}`);
  }

  // ---------- 2. all blocks already correct → reason 'done' ----------
  section('Build with everything already correct reports reason="done"');
  {
    // Make blockAt return cobblestone at the placement positions —
    // _isAlreadyCorrect short-circuits skipped++ and the placement
    // attempt counter never increments, so noProgress is false.
    const bot = makeBot();
    bot.blockAt = (pos) => {
      // Return cobblestone for any position lookup (the placements
      // hit dx=0..1, the standing checks hit y±1; everything looks
      // "complete enough").
      return { name: 'cobblestone', boundingBox: 'block' };
    };
    let markComplete = 0;
    const worldModel = {
      startStructure: () => 2,
      markBlockPlaced: () => {},
      markStructureComplete: () => { markComplete++; },
    };
    const builder = new BlueprintBuilder({
      bot,
      movement: makeMovement(),
      log: null,
      worldModel,
    });
    const handle = builder.build(TINY_BLUEPRINT, { x: 0, y: 64, z: 0 }, 0);
    const r = await handle.done;
    assert('result reason is done', r?.reason === 'done', JSON.stringify(r));
    assert('placed is 0 (everything already correct)', r?.placed === 0);
    assert('skipped is 2 (both already correct)', r?.skipped === 2);
    assert('worldModel.markStructureComplete WAS called',
      markComplete === 1, `markComplete=${markComplete}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('test runner threw:', e);
  process.exit(2);
});
