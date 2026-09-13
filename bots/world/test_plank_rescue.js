#!/usr/bin/env node
/**
 * test_plank_rescue.js — door crafting survives 1.8 wood-variant
 * strictness.
 *
 * Bug (TestBot19, 2026-06-10): `craft 3x wooden_door` failed with
 * missing_ingredients SEVEN times in a row. The bot held 6 planks —
 * but 4 oak + 2 birch, and a 1.8 door recipe needs 6 planks of the
 * SAME wood. The planner counts `planks` generically so it kept
 * re-emitting the bare craft task. Two rescues now live in craftItem:
 *   1. mixed-plank: craft a fresh same-variant batch from any log,
 *      retry the recipe once;
 *   2. door-variant: `wooden_door` is the OAK door — if it stays
 *      uncraftable, craft whichever door variant the planks support
 *      (blueprints accept variants via substitutions).
 */

import { craftItem } from './primitives.js';

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function section(n) { console.log('\n# ' + n); }

const IDS = { wooden_door: 324, birch_door: 428, planks: 5, crafting_table: 58 };

/**
 * Scripted crafting bot. `script.door` is a queue of recipe-list
 * results for wooden_door lookups; other items resolve from
 * `script[name]` directly.
 */
function makeBot({ items = [], script = {} } = {}) {
  const crafted = [];
  const idToName = Object.fromEntries(Object.entries(IDS).map(([n, i]) => [i, n]));
  return {
    crafted,
    entity: { position: { x: 0, y: 64, z: 0, offset: () => ({ x: 0, y: 64, z: 0 }) } },
    health: 20,
    registry: {
      itemsByName: Object.fromEntries(
        Object.entries(IDS).map(([n, id]) => [n, { id, name: n }]),
      ),
    },
    inventory: { items: () => items },
    findBlock: () => ({
      name: 'crafting_table',
      position: { x: 1, y: 64, z: 1, offset: () => ({}) },
    }),
    recipesFor: (id) => {
      const name = idToName[id];
      const entry = script[name];
      if (Array.isArray(entry)) return entry.length ? [entry.shift()].filter(Boolean) : [];
      return entry ? [entry] : [];
    },
    craft: async (recipe) => { crafted.push(recipe.tag); },
  };
}

async function main() {
  // ===================================================================
  section('mixed planks + a log: crafts fresh planks, then the door');
  {
    // Door lookup fails first (mixed variants), succeeds after the
    // plank batch normalizes the variant.
    const bot = makeBot({
      items: [{ name: 'log', count: 2 }, { name: 'planks', count: 6 }],
      script: {
        wooden_door: [null, { tag: 'door_recipe' }],   // 1st lookup [], 2nd hit
        planks: { tag: 'planks_recipe' },
      },
    });
    const r = await craftItem(bot, { recipeName: 'wooden_door', count: 1 },
      { log: { info() {}, debug() {} } }).done;
    assert('craft succeeded', r.success === true, JSON.stringify(r));
    assert('planks crafted before the door',
      bot.crafted[0] === 'planks_recipe' && bot.crafted[1] === 'door_recipe',
      JSON.stringify(bot.crafted));
  }

  // ===================================================================
  section('oak door impossible, birch planks available: crafts birch_door');
  {
    const bot = makeBot({
      items: [{ name: 'planks', count: 6 }],          // birch planks, no logs
      script: {
        wooden_door: [],                              // never craftable
        birch_door: { tag: 'birch_door_recipe' },
      },
    });
    const r = await craftItem(bot, { recipeName: 'wooden_door', count: 1 },
      { log: { info() {}, debug() {} } }).done;
    assert('craft succeeded via variant', r.success === true, JSON.stringify(r));
    assert('crafted the birch door', bot.crafted.includes('birch_door_recipe'));
    assert('result names the variant', r.crafted?.item === 'birch_door', r.crafted?.item);
  }

  // ===================================================================
  section('nothing craftable: clean missing_ingredients');
  {
    const bot = makeBot({
      items: [{ name: 'planks', count: 2 }],
      script: { wooden_door: [] },
    });
    const r = await craftItem(bot, { recipeName: 'wooden_door', count: 1 },
      { log: { info() {}, debug() {} } }).done;
    assert('fails', r.success === false);
    assert('reason missing_ingredients', r.reason === 'missing_ingredients', r.reason);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
