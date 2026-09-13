#!/usr/bin/env node
/**
 * test_door_pairs.js — doors are two blocks tall; the builder and the
 * blueprints must respect that.
 *
 * Bug (TestBot19, 2026-06-10): every door blueprint modeled the door
 * as ONE cell, and 8 of them put a solid block directly above it.
 * Placing the door auto-creates its top half there; the roof pass
 * then "corrected" the cell — pre-digging the top half destroys the
 * whole door — so the completion scan reported the door missing
 * forever (an eternal-96% project). The builder now heals the
 * geometry (_healDoorPairs), protects doors from pre-dig, and the
 * redesigned dirt_shelter gives the bot a livable interior + chest.
 */

import vec3Pkg from 'vec3';
import { BlueprintBuilder } from './blueprintBuilder.js';
import { BlueprintRegistry } from './blueprintRegistry.js';

const Vec3 = vec3Pkg.Vec3 ?? vec3Pkg;

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function section(n) { console.log('\n# ' + n); }

const key = (x, y, z) => `${x},${y},${z}`;

function makeBuilder(blocks = {}) {
  const bot = {
    entity: { position: new Vec3(0.5, 65, 0.5) },
    blockAt: (v) => {
      const k = key(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z));
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

// Old-style broken geometry: door with solid dirt directly above.
const brokenBlueprint = {
  id: 'door_test',
  category: 'base',
  dimensions: { x: 3, z: 1 },
  token_map: { D: 'dirt', W: 'wooden_door' },
  layers: [
    ['DDD'],   // floor
    ['DWD'],   // door bottom
    ['DDD'],   // roof — directly over the door
  ],
};
const anchor = { x: 10, y: 60, z: 10 };

// =====================================================================
section('_healDoorPairs: the cell above a door becomes the door top');
{
  const b = makeBuilder();
  const placements = b._buildPlacementList(brokenBlueprint, anchor, 0);
  const above = placements.find((p) =>
    p.world.x === 11 && p.world.y === 62 && p.world.z === 10);
  assert('cell above the door rewritten to wooden_door',
    above?.blockName === 'wooden_door', above?.blockName);
  const others = placements.filter((p) => p.world.y === 62 && p.blockName === 'dirt');
  assert('rest of the roof untouched', others.length === 2, `${others.length}`);
}

// =====================================================================
section('placed door verifies at 100% (no eternal-96%)');
{
  // World: floor + roof dirt, BOTH door halves present (what the game
  // creates when the bottom is placed).
  const blocks = {};
  for (const x of [10, 11, 12]) {
    blocks[key(x, 60, 10)] = 'dirt';
    if (x !== 11) { blocks[key(x, 61, 10)] = 'dirt'; blocks[key(x, 62, 10)] = 'dirt'; }
  }
  blocks[key(11, 61, 10)] = 'wooden_door';
  blocks[key(11, 62, 10)] = 'wooden_door';
  const b = makeBuilder(blocks);
  const scan = b.scanCompletion(brokenBlueprint, anchor, 0);
  assert('scan reports 100%', scan.pct === 100,
    `pct=${scan.pct} missing=${JSON.stringify(scan.missing)}`);
}

// =====================================================================
section('doors protected from pre-dig');
{
  const b = makeBuilder();
  assert('wooden_door protected', b._isProtected('wooden_door') === true);
  assert('spruce_door protected', b._isProtected('spruce_door') === true);
  assert('dirt still diggable', b._isProtected('dirt') === false);
}

// =====================================================================
section('every registry blueprint heals to vertical door pairs');
{
  const registry = new BlueprintRegistry({ log: null });
  const b = makeBuilder();
  let checked = 0;
  for (const bp of registry.all()) {
    const hasDoor = Object.values(bp.token_map ?? {})
      .some((n) => n && n.includes('door'));
    if (!hasDoor) continue;
    checked++;
    const placements = b._buildPlacementList(bp, { x: 0, y: 0, z: 0 }, 0);
    const byPos = new Map(placements.map((p) => [`${p.world.x},${p.world.y},${p.world.z}`, p]));
    // Invariant: every door BOTTOM half has its top half directly
    // above (solid above the TOP half is fine — doors are 2 tall).
    const bad = placements
      .filter((p) => p.blockName?.includes('door'))
      .filter((p) => {
        const below = byPos.get(`${p.world.x},${p.world.y - 1},${p.world.z}`);
        return !(below && below.blockName === p.blockName);   // bottoms only
      })
      .filter((p) => {
        const above = byPos.get(`${p.world.x},${p.world.y + 1},${p.world.z}`);
        return above && above.blockName !== p.blockName;
      });
    assert(`${bp.id}: every door bottom has its top half above`, bad.length === 0,
      JSON.stringify(bad.map((p) => p.world)));
  }
  assert('checked the door blueprints', checked >= 10, `checked=${checked}`);
}

// =====================================================================
section('redesigned dirt_shelter: livable interior + chest');
{
  const registry = new BlueprintRegistry({ log: null });
  const bp = registry.get('dirt_shelter');
  assert('blueprint loads', !!bp);
  assert('declares a chest', bp.materials?.chest === 1, JSON.stringify(bp.materials));
  assert('door accepts wood variants',
    Array.isArray(bp.substitutions?.wooden_door)
    && bp.substitutions.wooden_door.includes('birch_door'));

  const b = makeBuilder();
  const placements = b._buildPlacementList(bp, { x: 0, y: 0, z: 0 }, 0);
  const at = new Map(placements.map((p) => [`${p.world.x},${p.world.y},${p.world.z}`, p.blockName]));
  // Interior: at least two columns with TWO stacked air cells — the
  // 1.8-block-tall bot can stand inside.
  let standable = 0;
  for (let x = 0; x < 4; x++) {
    for (let z = 0; z < 4; z++) {
      if (at.get(`${x},1,${z}`) === null && at.get(`${x},2,${z}`) === null) standable++;
    }
  }
  assert('at least 2 standable interior columns', standable >= 2, `standable=${standable}`);
  const chestCell = placements.find((p) => p.blockName === 'chest');
  assert('chest placed inside (not on the perimeter)',
    chestCell && chestCell.world.x > 0 && chestCell.world.x < 3
    && chestCell.world.z > 0 && chestCell.world.z < 3,
    JSON.stringify(chestCell?.world));
  assert('air above the chest (openable lid)',
    at.get(`${chestCell?.world.x},2,${chestCell?.world.z}`) === null);
  // Door pair vertical.
  const doors = placements.filter((p) => p.blockName === 'wooden_door');
  assert('door occupies two stacked cells', doors.length === 2
    && doors[0].world.x === doors[1].world.x
    && doors[0].world.z === doors[1].world.z
    && Math.abs(doors[0].world.y - doors[1].world.y) === 1,
    JSON.stringify(doors.map((d) => d.world)));
}

// =====================================================================
section('interactive blocks avoided as placement references');
{
  // Target at (5,65,5): the cell below holds a DOOR (interactive),
  // the cell to the west holds stone. The reference must be the
  // stone — right-clicking the door toggles it instead of placing
  // (TestBot21 kept opening/closing its own front door trying to
  // place the roof row above the doorway).
  const b = makeBuilder({
    [key(5, 64, 5)]: 'wooden_door',
    [key(4, 65, 5)]: 'stone',
  });
  const ref = b._findReference(new Vec3(5, 65, 5));
  assert('solid face preferred over the door', ref?.block?.name === 'stone', ref?.block?.name);
  assert('not flagged interactive', ref?.interactive === false);

  // Only the door available → returned, but flagged for sneak-place.
  const only = makeBuilder({ [key(5, 64, 5)]: 'wooden_door' });
  const ref2 = only._findReference(new Vec3(5, 65, 5));
  assert('interactive face usable as fallback', ref2?.block?.name === 'wooden_door');
  assert('flagged interactive (caller sneaks)', ref2?.interactive === true);

  // Crafting table same deal — the chest-into-table-GUI bug.
  const table = makeBuilder({ [key(5, 64, 5)]: 'crafting_table' });
  assert('crafting table flagged interactive',
    table._findReference(new Vec3(5, 65, 5))?.interactive === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
