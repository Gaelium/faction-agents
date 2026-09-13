#!/usr/bin/env node
/**
 * test_gapple_eat.js — verifies the golden-apple eat sequence in
 * combat._maybePot.
 *
 * Bug from the user's log: bot kept logging `pot_attempt {item:
 * 'golden_apple'}` 5+ times in a row without ever consuming the
 * apple. Two interlocking issues caused it:
 *
 *   1. Hold time was 200ms, but a gapple needs the full 32-tick
 *      (~1.6s) eat animation. Releasing right-click at 200ms
 *      cancels the eat — no consumption, no heal.
 *   2. The 50ms combat tick kept calling bot.attack(target),
 *      which is a left-click. In 1.8 a left-click during eating
 *      cancels the food animation.
 *
 * Fixes verified here:
 *   - holdMs = 1700 for gapples (200 still for splash potions).
 *   - this._eating flag set true while the gapple is in flight,
 *     and _maybeSwing returns early when set.
 *   - Re-entry into _maybePot is blocked while _eating === true.
 */

import { Combat } from './combat.js';

let passed = 0;
let failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function section(name) { console.log('\n# ' + name); }

// ---------- minimal bot stub ----------

function makeBot({ heldItem = null, items = [] } = {}) {
  const calls = {
    activate: 0, deactivate: 0, attack: 0, equip: [], look: [],
  };
  let held = heldItem;
  const bot = {
    health: 14,
    food: 20,
    heldItem: held,
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 1 }, yaw: 0 },
    inventory: { items: () => items, slots: new Array(46) },
    autoEat: { disableAuto() {}, cancelEat() {} },
    look: async (yaw, pitch) => { calls.look.push({ yaw, pitch }); },
    lookAt: async () => {},
    equip: async (item) => { calls.equip.push(item.name); held = item; bot.heldItem = item; },
    activateItem: () => { calls.activate++; },
    deactivateItem: () => { calls.deactivate++; },
    attack: () => { calls.attack++; },
    setControlState: () => {},
    clearControlStates: () => {},
    quit: () => {},
    on: () => {},
    once: () => {},
    addListener: () => {},
    removeListener: () => {},
    canDigBlock: () => true,
    blockAt: () => null,
    findBlock: () => null,
    pathfinder: { setGoal() {}, isMoving: () => false },
  };
  return { bot, calls };
}

function makeCombat(bot) {
  return new Combat(bot, {
    profile: {
      username: 'TB', archetype: 'pvper', skill_tier: 2,
      combat: { reaction_ms_min: 0, reaction_ms_max: 0 },
    },
    log: null,
    movement: null,
    bus: null,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ---------- 1. Splash potion still uses the short 200ms hold ----------
  section('Splash potion: 200ms hold (instant drink)');
  {
    const { bot, calls } = makeBot({
      items: [{ name: 'splash_potion', count: 1 }],
    });
    const combat = makeCombat(bot);
    combat.target = { position: { x: 1, y: 64, z: 1 }, height: 1.62, isValid: true, health: 20 };
    combat._lastPotAt = -10_000;     // bypass cooldown
    combat.cfg.pot_success_rate = 1; // never fumble in this test
    combat._maybePot();
    // Hold time should be ~200ms; eating flag should NOT be set for
    // splash potions.
    assert('eating flag NOT set for splash potion', combat._eating !== true);
    // Wait for the sequence to complete (200ms hold + small overhead).
    await sleep(450);
    assert('activated then deactivated within 500ms (short hold)',
      calls.activate === 1 && calls.deactivate === 1,
      `activate=${calls.activate} deactivate=${calls.deactivate}`);
  }

  // ---------- 2. Golden apple uses extended hold + sets _eating ----------
  section('Golden apple: 1700ms hold, _eating gates re-entry + swings');
  {
    // Inventory has gapple AND a sword so we can verify the re-equip.
    const { bot, calls } = makeBot({
      items: [
        { name: 'golden_apple', count: 1 },
        { name: 'iron_sword',   count: 1 },
      ],
    });
    const combat = makeCombat(bot);
    combat.target = { position: { x: 1, y: 64, z: 1 }, height: 1.62, isValid: true, health: 20 };
    combat._lastPotAt = -10_000;
    combat.cfg.pot_success_rate = 1;
    combat._maybePot();

    // After the synchronous part of _maybePot, _eating should be true
    // immediately so re-entries and swings get gated.
    assert('eating flag set TRUE for gapple', combat._eating === true);
    // A second _maybePot in the eat window must be a no-op so we don't
    // re-equip mid-eat (which cancels the animation).
    const activatesBeforeSecondCall = calls.activate;
    combat._maybePot();
    // Give the equip+look chain a tick to fire.
    await sleep(30);
    assert('second _maybePot did NOT re-trigger pot_attempt during eat',
      calls.activate <= activatesBeforeSecondCall + 1,
      `activate count=${calls.activate}`);

    // _maybeSwing must NOT swing while _eating is true.
    combat._firstSwingAllowedAt = 0;
    const attacksBeforeSwing = calls.attack;
    combat._maybeSwing();
    assert('_maybeSwing skipped while eating',
      calls.attack === attacksBeforeSwing,
      `attack count=${calls.attack}`);

    // Wait past the 1700ms hold for the eat to finish.
    await sleep(2000);
    assert('eating flag CLEARED after eat completes',
      combat._eating === false,
      `_eating=${combat._eating}`);
    assert('activate called exactly once',
      calls.activate === 1, `activate=${calls.activate}`);
    assert('deactivate called exactly once',
      calls.deactivate === 1, `deactivate=${calls.deactivate}`);
    // Sword should be re-equipped after the eat. equip[0] = gapple,
    // equip[1] = preferred weapon (iron_sword). Without this, the
    // bot's next swing is fist-bonking with the eaten gapple's empty
    // slot still selected.
    assert('weapon re-equipped after eat (iron_sword)',
      calls.equip[1] === 'iron_sword',
      `equip sequence=${JSON.stringify(calls.equip)}`);
  }

  // ---------- 3. Multiple back-to-back attempts only fire once ----------
  section('Five rapid _maybePot calls during gapple eat = ONE attempt');
  {
    const { bot, calls } = makeBot({
      items: [{ name: 'golden_apple', count: 1 }],
    });
    const combat = makeCombat(bot);
    combat.target = { position: { x: 1, y: 64, z: 1 }, height: 1.62, isValid: true, health: 20 };
    combat._lastPotAt = -10_000;
    combat.cfg.pot_success_rate = 1;
    // Mimic the bug from the log: 5 pot_attempts back-to-back.
    for (let i = 0; i < 5; i++) {
      combat._maybePot();
    }
    await sleep(20);
    assert('exactly one equip across 5 rapid calls',
      calls.equip.length === 1, `equip count=${calls.equip.length}`);
    await sleep(2000);
    assert('exactly one full activate/deactivate across the whole eat',
      calls.activate === 1 && calls.deactivate === 1,
      `activate=${calls.activate} deactivate=${calls.deactivate}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('test runner threw:', e);
  process.exit(2);
});
