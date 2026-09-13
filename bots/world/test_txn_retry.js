#!/usr/bin/env node
/**
 * test_txn_retry.js — the 1.8 inventory-transaction recovery wrapper.
 *
 * Root cause (TestBot32): planks craft in the 2x2 inventory grid hit a
 * deterministic "Server rejected transaction for clicking on slot 0, on
 * window with id 0" and there was no retry, so one reject became a hard
 * craft_error → planks frozen at have:3/need:4 → ESTABLISH_BASE aborted,
 * and the planner re-issue loop turned it into a 75-reject storm.
 *
 * These pin the wrapper's contract (the adversarial-review hazards):
 *   - retries ONLY transaction rejects/timeouts, not genuine failures;
 *   - cancel-aware (stops mid-retry, reports 'cancelled' so the planner
 *     routes it through EXTERNAL_INTERRUPTION, not the cascade brake);
 *   - never over-crafts (fn recomputes the shortfall each attempt);
 *   - a throw whose effect actually landed is reported as success;
 *   - and craftItem/equipItem recover end-to-end.
 */

import {
  isTransactionError,
  normalizeError,
  withTransactionRetry,
} from './txnRetry.js';
import { craftItem, equipItem } from './primitives.js';

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function section(n) { console.log('\n# ' + n); }

const REJECT = 'Server rejected transaction for clicking on slot 0, on window with id 0.';
const TIMEOUT = "Server didn't respond to transaction for clicking on slot 0 on window with id 0.";
const FAST = { backoffMs: 1, maxAttempts: 3 };

async function main() {
  section('isTransactionError / normalizeError');
  {
    assert('matches reject string', isTransactionError(REJECT));
    assert('matches timeout string (unreliable net)', isTransactionError(TIMEOUT));
    assert('matches doubly-wrapped Error message', isTransactionError('Error: ' + REJECT));
    assert('does NOT match missing ingredient', !isTransactionError('missing ingredient'));
    assert('does NOT match an assertion', !isTransactionError('AssertionError: expected null'));
    assert('null is not a txn error', !isTransactionError(null));
    assert('unwraps doubled Error: prefixes',
      normalizeError(new Error('Error: Error: ' + REJECT)) === REJECT,
      normalizeError(new Error('Error: Error: ' + REJECT)));
  }

  section('withTransactionRetry: rejects twice then succeeds');
  {
    let calls = 0;
    const r = await withTransactionRetry({}, async () => {
      calls++;
      if (calls < 3) throw new Error(REJECT);
    }, FAST);
    assert('eventually ok', r.ok === true, JSON.stringify(r));
    assert('took 3 attempts', r.attempts === 3, 'calls=' + calls);
  }

  section('withTransactionRetry: genuine (non-txn) error passes through immediately');
  {
    let calls = 0;
    const r = await withTransactionRetry({}, async () => {
      calls++; throw new Error('missing ingredient');
    }, FAST);
    assert('not ok', r.ok === false);
    assert('reason is the real error', r.reason === 'missing ingredient', r.reason);
    assert('did NOT retry a genuine failure', calls === 1, 'calls=' + calls);
  }

  section('withTransactionRetry: cancel mid-retry stops and reports cancelled');
  {
    let calls = 0;
    const r = await withTransactionRetry({}, async () => {
      calls++; throw new Error(REJECT);
    }, { ...FAST, isCancelled: () => calls >= 1 });
    assert('reports cancelled', r.cancelled === true, JSON.stringify(r));
    assert('reason cancelled (→ EXTERNAL_INTERRUPTION, not cascade brake)', r.reason === 'cancelled');
    assert('stopped after the first attempt', calls === 1, 'calls=' + calls);
  }

  section('withTransactionRetry: a throw whose effect landed is success (verify in catch)');
  {
    const inv = { planks: 0 };
    let calls = 0;
    const r = await withTransactionRetry({}, async () => {
      calls++; inv.planks += 4;           // the craft DID land...
      throw new Error(REJECT);             // ...but the confirm packet threw
    }, { ...FAST, verify: () => inv.planks >= 4 });
    assert('reported success', r.ok === true, JSON.stringify(r));
    assert('did not re-run after the effect landed', calls === 1, 'calls=' + calls);
  }

  section('withTransactionRetry: never over-crafts on a partial-batch throw');
  {
    const inv = { planks: 0 };
    const target = 8, outPer = 4;
    let firstThrow = true, totalCrafted = 0;
    const r = await withTransactionRetry({}, async () => {
      const have = inv.planks;
      const batches = Math.max(1, Math.ceil((target - have) / outPer));
      if (firstThrow) {                    // 1st call: 1 of 2 batches lands, then reject
        firstThrow = false;
        inv.planks += outPer; totalCrafted += outPer;
        throw new Error(REJECT);
      }
      inv.planks += batches * outPer; totalCrafted += batches * outPer;
    }, { ...FAST, verify: () => inv.planks >= target });
    assert('ok', r.ok === true, JSON.stringify(r));
    assert('crafted EXACTLY the target (no over-craft)', totalCrafted === target, 'crafted=' + totalCrafted);
  }

  // ===================================================================
  section('craftItem: recovers from a transaction reject (planks)');
  {
    const bot = makeCraftBot({ throwTimes: 1 });
    const r = await craftItem(bot, { recipeName: 'planks', count: 1 },
      { log: { info() {}, debug() {} } }).done;
    assert('craft succeeded after the reject', r.success === true, JSON.stringify(r));
    assert('reports 4 planks crafted', r.crafted?.count === 4, JSON.stringify(r.crafted));
    assert('inventory has exactly 4 planks (no over-craft)',
      (bot.inventory.items().find((i) => i.name === 'planks')?.count) === 4);
  }

  section('craftItem: a genuine missing-ingredient is NOT retried as a transaction');
  {
    const bot = makeCraftBot({ throwMsg: 'missing ingredient', throwTimes: 99 });
    const t0 = Date.now();
    const r = await craftItem(bot, { recipeName: 'planks', count: 1 },
      { log: { info() {}, debug() {} } }).done;
    assert('fails', r.success === false);
    assert('surfaced as craft_error (genuine)', /craft_error:missing ingredient/.test(r.reason), r.reason);
    assert('failed fast (no backoff spin)', Date.now() - t0 < 400, 'ms=' + (Date.now() - t0));
  }

  section('equipItem: recovers from a transaction reject');
  {
    const bot = makeEquipBot({ throwTimes: 1 });
    const r = await equipItem(bot, { itemName: 'wooden_pickaxe', destination: 'hand' },
      { log: { debug() {} } }).done;
    assert('equip succeeded after the reject', r.success === true, JSON.stringify(r));
    assert('verified held item', r.reason === 'done', r.reason);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// --- mocks -----------------------------------------------------------

function makeCraftBot({ throwTimes = 1, throwMsg = REJECT } = {}) {
  const items = [{ name: 'log', count: 8, type: 17 }];
  let thrown = 0;
  return {
    entity: { position: { x: 0, y: 64, z: 0, offset: () => ({ x: 0, y: 64, z: 0 }) } },
    health: 20,
    registry: { itemsByName: { planks: { id: 5, name: 'planks' }, log: { id: 17, name: 'log' } } },
    inventory: { items: () => items, slots: [] },
    recipesFor: () => [{ tag: 'planks_recipe', result: { id: 5, count: 4 } }],
    craft: async (_recipe, batches = 1) => {
      if (thrown < throwTimes) { thrown++; throw new Error(throwMsg); }
      const p = items.find((i) => i.name === 'planks');
      const add = batches * 4;
      if (p) p.count += add; else items.push({ name: 'planks', count: add, type: 5 });
    },
  };
}

function makeEquipBot({ throwTimes = 1 } = {}) {
  const items = [{ name: 'wooden_pickaxe', count: 1, type: 270 }];
  let thrown = 0, held = null;
  return {
    entity: { position: { x: 0, y: 64, z: 0 } },
    health: 20,
    inventory: { items: () => items, slots: [] },
    get heldItem() { return held; },
    equip: async (item) => {
      if (thrown < throwTimes) { thrown++; throw new Error(REJECT); }
      held = { name: item.name };
    },
  };
}

main();
