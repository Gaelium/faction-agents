#!/usr/bin/env node
/**
 * test_economy.js — computeSellable honours per-item reserves so the bot
 * sells crops + surplus but keeps materials it needs (and never diamonds).
 */

import { computeSellable, totalSellableSurplus, MIN_SELL_STACK } from './economy.js';

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function section(n) { console.log('\n# ' + n); }
const get = (list, item) => list.find((g) => g.item === item)?.count ?? null;

section('crops (reserve 0) sell fully');
{
  const s = computeSellable({ wheat: 70, sugar_cane: 40, carrot: 64 });
  assert('wheat 70 → sell 70', get(s, 'wheat') === 70);
  assert('sugar_cane 40 → sell 40', get(s, 'sugar_cane') === 40);
}

section('bulk blocks keep a building reserve');
{
  const s = computeSellable({ cobblestone: 100 });   // reserve 64
  assert('cobblestone 100 → sell 36 (surplus)', get(s, 'cobblestone') === 36);
  const s2 = computeSellable({ cobblestone: 70 });    // surplus 6 < MIN_SELL_STACK
  assert('cobblestone 70 → not sold (below MIN_SELL_STACK)', get(s2, 'cobblestone') === null);
}

section('ores/ingots sell only surplus above a generous reserve');
{
  const s = computeSellable({ iron_ingot: 80 });     // reserve 64
  assert('iron_ingot 80 → sell 16', get(s, 'iron_ingot') === 16);
  const s2 = computeSellable({ iron_ingot: 70 });    // surplus 6 < 16
  assert('iron_ingot 70 → not sold', get(s2, 'iron_ingot') === null);
  const s3 = computeSellable({ iron_ore: 30 });      // reserve 0
  assert('iron_ore 30 → sell 30', get(s3, 'iron_ore') === 30);
}

section('never sells diamonds or non-allowlisted items');
{
  const s = computeSellable({ diamond: 1000, oak_planks: 500, iron_pickaxe: 3, bread: 200 });
  assert('diamond never sold', get(s, 'diamond') === null);
  assert('planks (not on allowlist) never sold', get(s, 'oak_planks') === null);
  assert('tools never sold', get(s, 'iron_pickaxe') === null);
  assert('food never sold', get(s, 'bread') === null);
  assert('nothing sellable at all', s.length === 0);
}

section('build materials are NOT sold while a build is active');
{
  const inv = { cobblestone: 200, dirt: 100, wheat: 64, iron_ingot: 200 };
  const idle = computeSellable(inv);
  assert('idle: cobblestone surplus sellable', get(idle, 'cobblestone') === 136);
  const building = computeSellable(inv, { buildActive: true });
  assert('building: cobblestone NOT sold', get(building, 'cobblestone') === null);
  assert('building: dirt NOT sold', get(building, 'dirt') === null);
  assert('building: wheat (crop) still sold', get(building, 'wheat') === 64);
  assert('building: iron_ingot surplus still sold', get(building, 'iron_ingot') === 136);
}

section('buildNeeds raises the effective reserve for specific items');
{
  const inv = { iron_ingot: 100 };   // normal reserve 64 → surplus 36 normally
  const withNeed = computeSellable(inv, { buildNeeds: { iron_ingot: 90 } });
  assert('iron_ingot kept when a build needs 90', get(withNeed, 'iron_ingot') === null);
}

section('totalSellableSurplus sums correctly');
{
  const inv = { wheat: 64, cobblestone: 100, diamond: 99 };
  assert('total = 64 + 36 = 100', totalSellableSurplus(inv) === 100);
}

section('MIN_SELL_STACK boundary');
{
  assert(`exactly MIN_SELL_STACK (${MIN_SELL_STACK}) sells`,
    get(computeSellable({ wheat: MIN_SELL_STACK }), 'wheat') === MIN_SELL_STACK);
  assert('one below MIN_SELL_STACK does not',
    get(computeSellable({ wheat: MIN_SELL_STACK - 1 }), 'wheat') === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
