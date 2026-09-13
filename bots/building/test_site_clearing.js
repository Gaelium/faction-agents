#!/usr/bin/env node
/**
 * test_site_clearing.js — natural obstructions (tree logs, leaves, wool,
 * terrain) in a build cell must be CLEARABLE during site prep / pre-dig, or a
 * single trunk deadlocks the whole build (TestBot41: one log → 36
 * cell_occupied events, 18-min stall). Containers / ores / doors stay
 * protected. The narrower `_isSiteClearProtected` governs clearing; the
 * broader `_isProtected` still shields logs from incidental digging elsewhere.
 */

import { BlueprintBuilder } from './blueprintBuilder.js';

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function section(n) { console.log('\n# ' + n); }

const bb = Object.create(BlueprintBuilder.prototype);

section('natural obstructions are clearable (not site-clear-protected)');
for (const n of ['log', 'log2', 'leaves', 'oak_leaves', 'wool', 'dirt', 'grass', 'gravel', 'stone', 'sand']) {
  assert(`${n} clearable`, bb._isSiteClearProtected(n) === false);
}

section('valuables / containers / doors stay protected');
for (const n of ['chest', 'trapped_chest', 'furnace', 'crafting_table', 'enchanting_table',
                 'anvil', 'bed', 'iron_ore', 'diamond_ore', 'wooden_door', 'iron_door', 'hopper']) {
  assert(`${n} protected from clearing`, bb._isSiteClearProtected(n) === true);
}

section('the broad _isProtected still shields logs (incidental digging)');
{
  assert('log still _isProtected (non-clearing paths unchanged)', bb._isProtected('log') === true);
  assert('wool still _isProtected', bb._isProtected('wool') === true);
  assert('chest still _isProtected', bb._isProtected('chest') === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
