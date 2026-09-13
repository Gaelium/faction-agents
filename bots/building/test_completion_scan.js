#!/usr/bin/env node
/**
 * test_completion_scan.js — ground-truth blueprint completion.
 *
 * Bug class (TestBot17, 2026-06-06): the strategic LLM was told the
 * shelter was "74% done" because pre-existing hillside dirt counted
 * toward placed-block progress while the door and half the walls
 * were missing. scanCompletion re-reads the world: required cells
 * only, optional (water/seeds) excluded, missing broken down by
 * block, and `reliable: false` when chunks aren't loaded.
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

// World mock: blocks maps "x,y,z" → name; null entry = unloaded chunk.
function makeBuilder(blocks = {}) {
  const bot = {
    entity: { position: new Vec3(0.5, 65, 0.5) },
    blockAt: (v) => {
      const k = key(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z));
      if (Object.prototype.hasOwnProperty.call(blocks, k) && blocks[k] === null) return null;
      const name = blocks[k] ?? 'air';
      return {
        name,
        boundingBox: name === 'air' ? 'empty' : 'block',
        position: new Vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)),
      };
    },
  };
  const movement = { goTo: () => ({ done: Promise.resolve({ reached: true }), stop() {} }), cancel() {} };
  return new BlueprintBuilder({ bot, movement, log: { info() {}, warn() {}, debug() {} } });
}

// 2×1 footprint, one layer: a dirt cell and a water cell (optional),
// plus a second layer with an air token (excavation) over the dirt.
const blueprint = {
  id: 'scan_test',
  category: 'base',
  dimensions: { x: 2, z: 1 },
  token_map: { d: 'dirt', w: 'water', '.': null },
  layers: [
    ['dw'],   // y=0: dirt at x0, water at x1
    ['.w'],   // y=1: air token at x0, water at x1
  ],
};
const anchor = { x: 10, y: 64, z: 10 };

// =====================================================================
section('all required cells correct → 100%, optional ignored');
{
  // dirt placed, air cell empty; water cells missing entirely.
  const b = makeBuilder({ [key(10, 64, 10)]: 'dirt' });
  const scan = b.scanCompletion(blueprint, anchor, 0);
  assert('total counts required cells only (dirt + air)', scan.total === 2, `total=${scan.total}`);
  assert('pct 100', scan.pct === 100, `pct=${scan.pct}`);
  assert('reliable', scan.reliable === true);
  assert('nothing missing', Object.keys(scan.missing).length === 0);
}

// =====================================================================
section('missing cells broken down by block');
{
  // dirt cell empty; air cell occupied by stone (needs excavation).
  const b = makeBuilder({ [key(10, 65, 10)]: 'stone' });
  const scan = b.scanCompletion(blueprint, anchor, 0);
  assert('pct 0', scan.pct === 0, `pct=${scan.pct}`);
  assert('missing dirt 1', scan.missing.dirt === 1, JSON.stringify(scan.missing));
  assert('missing excavation 1', scan.missing['(excavate)'] === 1, JSON.stringify(scan.missing));
}

// =====================================================================
section('pre-existing terrain counts as correct — but missing cells keep pct honest');
{
  // The dirt cell happens to be natural terrain dirt: that's REAL
  // structural completion (the block is physically there). The air
  // cell is blocked by stone → 50%, with the blocker named.
  const b = makeBuilder({
    [key(10, 64, 10)]: 'dirt',
    [key(10, 65, 10)]: 'stone',
  });
  const scan = b.scanCompletion(blueprint, anchor, 0);
  assert('pct 50', scan.pct === 50, `pct=${scan.pct}`);
  assert('the gap is named', scan.missing['(excavate)'] === 1);
}

// =====================================================================
section('unloaded chunks make the scan unreliable');
{
  const b = makeBuilder({ [key(10, 64, 10)]: null });   // unloaded
  const scan = b.scanCompletion(blueprint, anchor, 0);
  assert('unloaded counted', scan.unloaded === 1, `unloaded=${scan.unloaded}`);
  assert('reliable false', scan.reliable === false);
}

// =====================================================================
section('non-solid placeables (torches) are best-effort — never block completion');
{
  // A 2-wide floor with one dirt cell + an interior torch the world is
  // missing. Before the fix the torch counted as required → stuck at 50%
  // forever (TestBot43: 95%, never confirmed done, place/break churn).
  const bpTorch = {
    id: 'scan_torch_test',
    category: 'base',
    dimensions: { x: 1, y: 2, z: 1 },
    token_map: { d: 'dirt' },
    layers: [['d']],
    interior: [{ token: 'torch', offset: { x: 0, y: 1, z: 0 } }],
  };
  const b = makeBuilder({ [key(10, 64, 10)]: 'dirt' });   // dirt placed, torch (10,65,10) absent
  const scan = b.scanCompletion(bpTorch, anchor, 0);
  assert('torch excluded from required total (only the dirt counts)', scan.total === 1, `total=${scan.total}`);
  assert('100% with the structure done despite the missing torch', scan.pct === 100, `pct=${scan.pct}`);
  assert('torch not reported missing', scan.missing.torch === undefined, JSON.stringify(scan.missing));
}

// =====================================================================
section('rotation respected');
{
  // 180° rotation flips x within the 2-wide footprint: dirt lands at
  // x=11 instead of x=10.
  const b = makeBuilder({ [key(11, 64, 10)]: 'dirt' });
  const scan = b.scanCompletion(blueprint, anchor, 180);
  assert('rotated dirt cell read as correct', scan.missing.dirt === undefined,
    JSON.stringify(scan.missing));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
