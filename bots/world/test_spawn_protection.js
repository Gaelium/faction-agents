#!/usr/bin/env node
/**
 * test_spawn_protection.js — the bot must not try to place a workstation
 * inside the spawn safezone.
 *
 * TestBot35: the bot got pinned at the spawn box edge (494,177) trying to
 * place a crafting table — the 1.8 server silently rejects placement in
 * the safezone, so each cardinal face ate a full 5s blockUpdate timeout
 * (~20s dead) before reporting no_crafting_table_placed, and the
 * protection-blind relocate kept dropping it back at the boundary. 0
 * tables placed in 22 minutes. placeWorkstation now bails FAST when in or
 * hugging protection so the (now protection-aware) relocate can move the
 * bot clear before retrying.
 */

import { craftItem } from './primitives.js';
import { isInProtectedZone } from './zones.js';

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function section(n) { console.log('\n# ' + n); }

function spyLog() {
  const events = [];
  return { events, info: (e) => events.push(e), debug() {}, warn() {} };
}

function makeBot(pos) {
  let placeCalls = 0;
  const items = [
    { name: 'crafting_table', count: 1, type: 58 },
    { name: 'cobblestone', count: 3, type: 4 },
    { name: 'stick', count: 2, type: 280 },
  ];
  return {
    placeCalls: () => placeCalls,
    entity: { position: { x: pos.x, y: pos.y, z: pos.z, offset: (a, b, c) => ({ x: pos.x + a, y: pos.y + b, z: pos.z + c }) } },
    health: 20,
    registry: { itemsByName: {
      stone_pickaxe: { id: 274, name: 'stone_pickaxe' },
      crafting_table: { id: 58, name: 'crafting_table' },
      cobblestone: { id: 4, name: 'cobblestone' },
      stick: { id: 280, name: 'stick' },
    } },
    inventory: { items: () => items, slots: [] },
    findBlock: () => null,                       // no pre-existing table nearby
    blockAt: () => null,                         // placement will fail to verify (fine — we assert it isn't attempted)
    recipesFor: () => [{ tag: 'pick_recipe', result: { id: 274, count: 1 } }],
    placeBlock: async () => { placeCalls++; },
    equip: async () => {},
    craft: async () => {},
    lookAt: async () => {},
  };
}

async function main() {
  section('craftItem refuses to place a crafting table inside spawn protection');
  {
    const inZone = { x: 400, y: 64, z: 200 };
    assert('sanity: (400,200) is inside the spawn zone', isInProtectedZone(inZone));
    const bot = makeBot(inZone);
    const log = spyLog();
    const r = await craftItem(bot, { recipeName: 'stone_pickaxe', count: 1 }, { log }).done;
    assert('craft fails (needs a table it cannot place here)', r.success === false, JSON.stringify(r));
    assert('reason is no_crafting_table_placed (→ relocate out)', r.reason === 'no_crafting_table_placed', r.reason);
    assert('logged workstation_skip_protection', log.events.includes('workstation_skip_protection'));
    assert('did NOT attempt any block placement in protection', bot.placeCalls() === 0, 'placeCalls=' + bot.placeCalls());
  }

  section('clear of protection: the guard does NOT fire (placement proceeds)');
  {
    const clear = { x: 800, y: 64, z: 800 };
    assert('sanity: (800,800) is clear of protection', !isInProtectedZone(clear));
    const bot = makeBot(clear);
    const log = spyLog();
    await craftItem(bot, { recipeName: 'stone_pickaxe', count: 1 }, { log }).done;
    assert('did NOT skip on protection grounds', !log.events.includes('workstation_skip_protection'));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
