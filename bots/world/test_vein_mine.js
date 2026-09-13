#!/usr/bin/env node
/**
 * test_vein_mine.js — mineConnectedVein BFS-clears the ore vein connected to a
 * just-mined block, so the bot takes the WHOLE 8-block vein, not just the 3 it
 * "needed" (the user's complaint). Bounded; stops on full inventory; never
 * crosses into a different ore type or non-ore.
 */

import vec3Pkg from 'vec3';
import { mineConnectedVein, sameOreFamily } from './primitives.js';

const Vec3 = vec3Pkg.Vec3 ?? vec3Pkg;
let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function section(n) { console.log('\n# ' + n); }
const K = (x, y, z) => `${x},${y},${z}`;

// Fake bot over a sparse world map. collectBlock removes the block.
function makeBot(world, { invFull = false } = {}) {
  const dug = [];
  return {
    dug,
    entity: { position: new Vec3(1000, 11, 1000) },   // dry, far from spawn
    blockAt: (v) => world[K(v.x, v.y, v.z)] ?? { name: 'air', position: { x: v.x, y: v.y, z: v.z } },
    canDigBlock: () => true,
    inventory: { items: () => (invFull ? new Array(36).fill({ name: 'dirt', count: 64, stackSize: 64 }) : []) },
    collectBlock: {
      collect: async (b) => { delete world[K(b.position.x, b.position.y, b.position.z)]; dug.push(b.position); },
    },
  };
}

section('clears a connected iron vein, leaves the rest of the world');
{
  // Origin (1000,11,1000) already mined by the caller. A 5-block connected vein.
  const world = {};
  const veinCells = [[1001, 11, 1000], [1002, 11, 1000], [1001, 12, 1000], [1001, 11, 1001], [1000, 11, 1001]];
  for (const [x, y, z] of veinCells) world[K(x, y, z)] = { name: 'iron_ore', position: { x, y, z } };
  // A disconnected iron_ore far away — must NOT be taken.
  world[K(1050, 11, 1050)] = { name: 'iron_ore', position: { x: 1050, y: 11, z: 1050 } };
  // A diamond_ore adjacent to the vein — different family, must NOT be taken.
  world[K(1003, 11, 1000)] = { name: 'diamond_ore', position: { x: 1003, y: 11, z: 1000 } };

  const bot = makeBot(world);
  const extra = await mineConnectedVein(bot, { x: 1000, y: 11, z: 1000 }, 'iron_ore', { expectedDrop: 'iron_ore' });
  assert('mined all 5 connected vein blocks', extra === 5, `extra=${extra}`);
  assert('disconnected ore left in world', !!world[K(1050, 11, 1050)]);
  assert('adjacent diamond_ore (different family) left', !!world[K(1003, 11, 1000)]);
}

section('stops when inventory is full');
{
  const world = {};
  for (let i = 1; i <= 5; i++) world[K(1000 + i, 11, 1000)] = { name: 'iron_ore', position: { x: 1000 + i, y: 11, z: 1000 } };
  const bot = makeBot(world, { invFull: true });
  const extra = await mineConnectedVein(bot, { x: 1000, y: 11, z: 1000 }, 'iron_ore', { expectedDrop: 'iron_ore' });
  assert('mined nothing (inventory full)', extra === 0, `extra=${extra}`);
}

section('respects the max bound (runaway guard)');
{
  const world = {};
  // A long 50-block straight iron vein; max defaults to 32.
  for (let i = 1; i <= 50; i++) world[K(1000 + i, 11, 1000)] = { name: 'iron_ore', position: { x: 1000 + i, y: 11, z: 1000 } };
  const bot = makeBot(world, {});
  const extra = await mineConnectedVein(bot, { x: 1000, y: 11, z: 1000 }, 'iron_ore', { expectedDrop: 'iron_ore', max: 32 });
  assert('capped at max=32', extra === 32, `extra=${extra}`);
}

section('sameOreFamily folds redstone lit/unlit, rejects cross-type');
{
  assert('iron == iron', sameOreFamily('iron_ore', 'iron_ore') === true);
  assert('lit_redstone == redstone', sameOreFamily('lit_redstone_ore', 'redstone_ore') === true);
  assert('iron != diamond', sameOreFamily('iron_ore', 'diamond_ore') === false);
  assert('iron != stone', sameOreFamily('iron_ore', 'stone') === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
