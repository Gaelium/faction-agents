#!/usr/bin/env node
/**
 * test_scaffold.js — Phase 1.1: scaffolding for no-reference cells.
 *
 * _placeOne fails with reason 'no_reference' when a target cell has no
 * solid neighbour to place against (floating roof / overhang / chest in
 * mid-air), and those cells were skipped forever so structures never
 * reached 100%. The scaffold path drops a temporary support block against
 * an adjacent air cell that DOES have a reference, builds the target
 * against it, then removes it. This pins the pure planner (_planScaffold)
 * + _findScaffoldMaterial, which decide IF/WHERE a scaffold can go.
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

// Fake world: map "x,y,z" -> block name. Missing cells are air.
function makeCtx(world) {
  const bot = {
    blockAt: (pos) => {
      const name = world[`${pos.x},${pos.y},${pos.z}`] ?? 'air';
      return { name, position: pos, boundingBox: name === 'air' ? 'empty' : 'block' };
    },
    inventory: { items: () => [] },
  };
  // Exercise the real methods against a minimal `this` (they only touch
  // this.bot / this._findReference / module constants).
  const ctx = { bot, log: null };
  ctx._findReference = BlueprintBuilder.prototype._findReference.bind(ctx);
  ctx._planScaffold = BlueprintBuilder.prototype._planScaffold.bind(ctx);
  ctx._findItemByName = BlueprintBuilder.prototype._findItemByName.bind(ctx);
  ctx._findScaffoldMaterial = BlueprintBuilder.prototype._findScaffoldMaterial.bind(ctx);
  return ctx;
}
const key = (v) => `${v.x},${v.y},${v.z}`;

section('_planScaffold: floating cell with solid ground 2 below → vertical scaffold');
{
  // Floor at y=3; target floats at y=5 (its y=4 down-neighbour is air, all
  // others air too → no_reference). Scaffold should go at y=4 (placed on
  // the floor), target then placed on top of it.
  const ctx = makeCtx({ '0,3,0': 'cobblestone' });
  // sanity: target itself has no solid neighbour
  assert('target (0,5,0) has no reference', ctx._findReference(new Vec3(0, 5, 0)) === null);
  const plan = ctx._planScaffold(new Vec3(0, 5, 0));
  assert('a scaffold plan is returned', !!plan, JSON.stringify(plan));
  assert('scaffold support is the cell directly below the target', plan && key(plan.supportPos) === '0,4,0',
    plan && key(plan.supportPos));
  assert('targetFace is the up vector (place target on top of scaffold)',
    plan && plan.targetFace.x === 0 && plan.targetFace.y === 1 && plan.targetFace.z === 0);
  assert('scaffold itself has a real reference (the floor)',
    plan && !!plan.scaffoldRef && plan.scaffoldRef.interactive === false);
}

section('_planScaffold: truly isolated cell (nothing within 2) → null');
{
  // Floor far below; target at y=10 with nothing within one scaffold hop.
  const ctx = makeCtx({ '0,0,0': 'cobblestone' });
  const plan = ctx._planScaffold(new Vec3(0, 10, 0));
  assert('no scaffold plan when no support has its own reference', plan === null);
}

section('_planScaffold: support reachable horizontally off a wall');
{
  // A wall column at x=0 (y=4 solid). Target floats at (2,5,0): its
  // neighbours are all air, but the cell at (1,5,0) is air AND has the
  // wall block (0,5,0)? No — wall is at x=0,y=4. Put a solid at (0,5,0)
  // so (1,5,0) has a west reference. Scaffold goes to (1,5,0).
  const ctx = makeCtx({ '0,5,0': 'cobblestone' });
  assert('target (2,5,0) has no direct reference', ctx._findReference(new Vec3(2, 5, 0)) === null);
  const plan = ctx._planScaffold(new Vec3(2, 5, 0));
  assert('plan found via horizontal hop', !!plan);
  assert('support is the adjacent air cell toward the wall', plan && key(plan.supportPos) === '1,5,0',
    plan && key(plan.supportPos));
}

section('_planScaffold: interactive-only support is skipped');
{
  // The only nearby solid is a door (interactive) below the support cell —
  // a scaffold can't be placed against a door without activating it, and
  // _findReference flags it interactive, so the planner must skip it.
  const ctx = makeCtx({ '0,3,0': 'wooden_door' });
  const plan = ctx._planScaffold(new Vec3(0, 5, 0));
  assert('interactive-only support yields no plan', plan === null, JSON.stringify(plan));
}

section('_findScaffoldMaterial: picks a cheap non-gravity block from inventory');
{
  const ctx = makeCtx({});
  ctx.bot.inventory.items = () => [{ name: 'diamond', count: 5 }, { name: 'cobblestone', count: 64 }];
  const mat = ctx._findScaffoldMaterial();
  assert('finds cobblestone', mat && mat.name === 'cobblestone');

  ctx.bot.inventory.items = () => [{ name: 'dirt', count: 10 }];
  assert('falls back to dirt', ctx._findScaffoldMaterial()?.name === 'dirt');

  ctx.bot.inventory.items = () => [{ name: 'diamond', count: 5 }];
  assert('null when no scaffold material held', ctx._findScaffoldMaterial() === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
