#!/usr/bin/env node
/**
 * test_economy_chat.js — the chat parser turns server economy messages into
 * state: sell echo → local economy_transaction (income), /balance → ground
 * truth, /baltop → rank. Without this, /sell hand income was invisible.
 */

import { parseEconomyMessage, attachEconomyChat } from './economyChat.js';

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function section(n) { console.log('\n# ' + n); }

// =====================================================================
section('parseEconomyMessage — sell / balance / baltop / none');
{
  const sell = parseEconomyMessage('Sold 36 Cobblestone for $18.00 (0.50 each).');
  assert('sell parsed', sell?.kind === 'sell' && sell.amount === 18, JSON.stringify(sell));

  const bal = parseEconomyMessage('Balance: $5,000.00');
  assert('balance parsed (commas + decimals)', bal?.kind === 'balance' && bal.amount === 5000, JSON.stringify(bal));

  const bal2 = parseEconomyMessage('Your balance is $1234');
  assert('balance alt phrasing', bal2?.kind === 'balance' && bal2.amount === 1234);

  const ranked = parseEconomyMessage('You are ranked #7 out of 50 players');
  assert('baltop "ranked #N" parsed', ranked?.kind === 'baltop' && ranked.rank === 7, JSON.stringify(ranked));

  const selfRow = parseEconomyMessage('3. MyBot 5,000', { username: 'MyBot' });
  assert('baltop self-row parsed', selfRow?.kind === 'baltop' && selfRow.rank === 3, JSON.stringify(selfRow));

  const selfRow2 = parseEconomyMessage('#2 MyBot $9,999', { username: 'MyBot' });
  assert('baltop self-row with # and $', selfRow2?.kind === 'baltop' && selfRow2.rank === 2);

  assert('plain chat → null', parseEconomyMessage('MyBot joined the game') === null);
  assert('sell beats balance when both words absent', parseEconomyMessage('hello world') === null);
}

// =====================================================================
section('attachEconomyChat — wires parsed signals to consumers');
{
  // Fake bot emitter + captured consumers.
  const handlers = {};
  const bot = {
    on: (ev, fn) => { (handlers[ev] ??= []).push(fn); },
    removeListener: (ev, fn) => { handlers[ev] = (handlers[ev] || []).filter((h) => h !== fn); },
    _emit: (ev, m) => { for (const h of handlers[ev] || []) h(m); },
  };
  const emitted = [];
  const bus = { emitLocal: (e) => emitted.push(e) };
  let setBal = null;
  const factions = { setBalance: (n) => { setBal = n; } };
  let baltop = null;
  const worldModel = { setBaltop: (b) => { baltop = b; } };

  const detach = attachEconomyChat({ bot, bus, factions, worldModel, profile: { username: 'MyBot' }, log: null });

  bot._emit('messagestr', 'Sold 64 Wheat for $320');
  assert('sell → economy_transaction emitted', emitted.length === 1);
  assert('event type economy_transaction', emitted[0]?.event === 'economy_transaction');
  assert('recipient = me (so projects matcher fires)', emitted[0]?.recipient === 'MyBot');
  assert('positive amount', emitted[0]?.amount === 320);
  assert('reason sell:hand', emitted[0]?.reason === 'sell:hand');

  bot._emit('messagestr', 'Balance: $7,500');
  assert('balance → factions.setBalance(7500)', setBal === 7500);

  bot._emit('messagestr', 'You are ranked #4');
  assert('baltop → worldModel.setBaltop rank 4', baltop?.rank === 4);

  bot._emit('messagestr', 'random chatter');
  assert('non-economy line does nothing new', emitted.length === 1 && setBal === 7500);

  detach();
  bot._emit('messagestr', 'Sold 1 Wheat for $5');
  assert('after detach, no more emits', emitted.length === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
