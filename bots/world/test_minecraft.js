/**
 * test_minecraft.js — assertions over the data module.
 *
 * Run with:  node bots/data/test_minecraft.js
 *
 * No external deps. Exits non-zero on the first failure.
 */

import {
  RECIPES,
  TOOL_REQUIREMENTS,
  BLOCK_HARDNESS,
  SMELTABLE,
  FUEL_VALUES,
  FARMABLE_CROPS,
  GEAR_TIERS,
  SPECIAL_BLOCKS,
} from './minecraft.js';

let passed = 0;
let failed = 0;

function check(label, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------
// 1. Frozen-ness sanity check.
// ---------------------------------------------------------------------
console.log('# frozen exports');
for (const [name, m] of Object.entries({
  RECIPES, TOOL_REQUIREMENTS, BLOCK_HARDNESS, SMELTABLE,
  FUEL_VALUES, FARMABLE_CROPS, SPECIAL_BLOCKS,
})) {
  check(`${name} is frozen`, Object.isFrozen(m));
}
check('GEAR_TIERS is frozen array', Object.isFrozen(GEAR_TIERS) && Array.isArray(GEAR_TIERS));

// ---------------------------------------------------------------------
// 2. At least 40 recipes.
// ---------------------------------------------------------------------
console.log('\n# recipe coverage');
const recipeCount = Object.keys(RECIPES).length;
check(`>= 40 recipes (got ${recipeCount})`, recipeCount >= 40);

// ---------------------------------------------------------------------
// 3. Every recipe ingredient resolves to a known source.
//
// Valid sources (the user spec's three categories, plus the natural
// supersets that 1.8 craft graphs require):
//   - another recipe's output
//   - a FARMABLE_CROPS entry (key, seed_item, or harvest_drop)
//   - a mineable block (TOOL_REQUIREMENTS key or .drops value)
//   - a SPECIAL_BLOCKS entry (covers obsidian, mob drops like
//     slimeball / apple that appear in recipe inputs)
// ---------------------------------------------------------------------
console.log('\n# ingredient resolution');

const recipeOutputs = new Set(Object.keys(RECIPES));

const farmableItems = new Set();
for (const [k, v] of Object.entries(FARMABLE_CROPS)) {
  farmableItems.add(k);
  if (v.seed_item) farmableItems.add(v.seed_item);
  if (v.harvest_drop) farmableItems.add(v.harvest_drop);
  if (v.block_name) farmableItems.add(v.block_name);
}

const mineableItems = new Set();
for (const [block, info] of Object.entries(TOOL_REQUIREMENTS)) {
  mineableItems.add(block);
  if (info.drops) mineableItems.add(info.drops);
}

const specialItems = new Set(Object.keys(SPECIAL_BLOCKS));

function resolves(item) {
  return recipeOutputs.has(item)
    || farmableItems.has(item)
    || mineableItems.has(item)
    || specialItems.has(item);
}

let unresolved = [];
for (const [name, recipe] of Object.entries(RECIPES)) {
  for (const ing of Object.keys(recipe.ingredients)) {
    if (!resolves(ing)) unresolved.push(`${name} <- ${ing}`);
  }
}
check(
  'every recipe ingredient resolves to a known source',
  unresolved.length === 0,
  unresolved.length ? `unresolved: ${unresolved.join(', ')}` : '',
);

// ---------------------------------------------------------------------
// 4. TOOL_REQUIREMENTS references real tool names.
// ---------------------------------------------------------------------
console.log('\n# tool name validity');
const realTools = new Set([
  null,
  'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe',
  'wooden_axe', 'stone_axe', 'iron_axe', 'diamond_axe',
  'wooden_shovel', 'stone_shovel', 'iron_shovel', 'diamond_shovel',
  'wooden_sword', 'stone_sword', 'iron_sword', 'diamond_sword',
  'shears', 'fishing_rod',
]);

let badTools = [];
for (const [block, info] of Object.entries(TOOL_REQUIREMENTS)) {
  if (!realTools.has(info.tool)) badTools.push(`${block}->${info.tool}`);
  if (info.multipliers) {
    for (const t of Object.keys(info.multipliers)) {
      if (!realTools.has(t)) badTools.push(`${block} multiplier ${t}`);
    }
  }
}
check(
  'TOOL_REQUIREMENTS uses only real tool names',
  badTools.length === 0,
  badTools.join(', '),
);

// Tools referenced by minimum-tool requirements must themselves be
// craftable from RECIPES (or null).
let uncraftableTools = [];
for (const info of Object.values(TOOL_REQUIREMENTS)) {
  if (info.tool && !RECIPES[info.tool] && info.tool !== 'shears' && info.tool !== 'fishing_rod') {
    uncraftableTools.push(info.tool);
  }
}
check(
  'every required tool has a recipe',
  uncraftableTools.length === 0,
  [...new Set(uncraftableTools)].join(', '),
);

// ---------------------------------------------------------------------
// 5. GEAR_TIERS ascending by armor_total.
// ---------------------------------------------------------------------
console.log('\n# gear tier ordering');
let monotonic = true;
for (let i = 1; i < GEAR_TIERS.length; i++) {
  if (GEAR_TIERS[i].armor_total <= GEAR_TIERS[i - 1].armor_total) {
    monotonic = false;
    break;
  }
}
check('GEAR_TIERS is strictly ascending in armor_total', monotonic);

// User-specified order: leather < gold < chainmail < iron < diamond.
const expectedOrder = ['leather', 'gold', 'chainmail', 'iron', 'diamond'];
const actualOrder = GEAR_TIERS.map((t) => t.name);
check(
  'GEAR_TIERS order matches leather<gold<chainmail<iron<diamond',
  JSON.stringify(actualOrder) === JSON.stringify(expectedOrder),
  `got ${actualOrder.join(',')}`,
);

// ---------------------------------------------------------------------
// 6. Diamond pickaxe recipe chain.
//
//    log -> planks                     (RECIPES.planks needs log)
//    planks -> stick                   (RECIPES.stick needs planks)
//    planks -> crafting_table          (RECIPES.crafting_table needs planks)
//    stick + diamond -> diamond_pickaxe
//
// We assert each step exists and the ingredients line up.
// ---------------------------------------------------------------------
console.log('\n# diamond_pickaxe chain');

check('planks recipe consumes log',
  RECIPES.planks?.ingredients?.log >= 1);
check('stick recipe consumes planks',
  RECIPES.stick?.ingredients?.planks >= 1);
check('crafting_table recipe consumes planks',
  RECIPES.crafting_table?.ingredients?.planks >= 1);
check('diamond_pickaxe recipe consumes stick + diamond',
  RECIPES.diamond_pickaxe?.ingredients?.stick >= 1
    && RECIPES.diamond_pickaxe?.ingredients?.diamond >= 1);
check('diamond_pickaxe needs a crafting_table',
  RECIPES.diamond_pickaxe?.tool_required === 'crafting_table');
check('diamond is a mineable item',
  mineableItems.has('diamond'));
check('log is a mineable item',
  mineableItems.has('log'));

// Walk the chain transitively and confirm every step resolves.
function chainResolves(target, depth = 0, seen = new Set()) {
  if (depth > 8) return false;
  if (seen.has(target)) return true;
  seen.add(target);
  if (!RECIPES[target]) {
    return mineableItems.has(target) || farmableItems.has(target) || specialItems.has(target);
  }
  for (const ing of Object.keys(RECIPES[target].ingredients)) {
    if (!chainResolves(ing, depth + 1, seen)) return false;
  }
  return true;
}
check('diamond_pickaxe chain fully resolves to mineable inputs',
  chainResolves('diamond_pickaxe'));

// ---------------------------------------------------------------------
// 7. SMELTABLE / RECIPES consistency.
// ---------------------------------------------------------------------
console.log('\n# smeltable <-> recipes');
let furnaceMismatches = [];
for (const [name, r] of Object.entries(RECIPES)) {
  if (r.tool_required === 'furnace') {
    const inputs = Object.keys(r.ingredients);
    if (inputs.length !== 1) {
      furnaceMismatches.push(`${name} has ${inputs.length} inputs`);
      continue;
    }
    const input = inputs[0];
    if (SMELTABLE[input] !== name) {
      furnaceMismatches.push(`SMELTABLE['${input}'] != '${name}'`);
    }
    if (typeof r.smelt_time_ticks !== 'number') {
      furnaceMismatches.push(`${name} missing smelt_time_ticks`);
    }
  }
}
check(
  'every furnace RECIPE has a matching SMELTABLE entry and smelt_time_ticks',
  furnaceMismatches.length === 0,
  furnaceMismatches.join('; '),
);

// ---------------------------------------------------------------------
// Done.
// ---------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
