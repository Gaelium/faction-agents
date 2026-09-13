/**
 * faction.js — the factions and money tools: f, sell, pay, faction_notes.
 *
 * Every command goes through the server and the tool reports what the
 * server actually replied, classified as best it can. Money: no buying on
 * this server; income is /sell hand and /pay from other players. Founding
 * a faction costs FACTION_CREATE_COST and the tool refuses without a
 * verified balance that covers it.
 */

import { RESERVES, computeSellable } from '../../world/economy.js';
import { parseEconomyMessage } from '../../social/economyChat.js';
import { countInventory } from '../../world/primitives.js';
import { cancellableSleep } from '../cancel.js';
import { captureReplies, readBalance } from './board.js';
import { ok, fail, partial, interrupted, roundPos, distance } from './result.js';

export const FACTION_CREATE_COST = 100;
const NOTES_MAX_BYTES = 8 * 1024;
const NEVER_SELL_EXPLICIT = /diamond|_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$|^bow$/;

const DENIED = /do not have access|no permission|don't have permission|unknown command/i;
// Massive Factions 2.8 answers a malformed command with its help page
// ("The sub command X couldn't be found." / "Help for command ..."). Those
// are failures even though they mention the verb we were looking for.
const F_FAIL = /not enough|have enough|need more|you need|can't afford|cannot afford|insufficient|already|not in a faction|must be in|no faction|too close|protected|invalid|not found|does not exist|cannot|can't|unable|only the leader|you are not|not allowed|denied|couldn't be found|sub command|see all commands|help for command|sorry|can only be/i;
const F_OK = {
  create: /created|now the leader|you are now/i,
  claim: /claimed|now owns|claimed by|bought \d+ chunk|--> your faction/i,
  rank: /promoted|demoted|was moved|were moved|gave .* the leadership|is now|are now/i,
  unclaim: /unclaimed|no longer/i,
  invite: /invited \S+ to your faction|invited \S+ to \S+|already invited/i,
  join: /joined|welcome|now a member/i,
  leave: /left|no longer a member/i,
  ally: /ally|allied|alliance/i,
  enemy: /enemy|enemies/i,
  neutral: /neutral/i,
  sethome: /home set|set.*home/i,
  home: /teleport|home/i,
  disband: /disband/i,
};

function classify(action, replies) {
  const joined = replies.join(' | ');
  if (DENIED.test(joined)) return 'denied';
  const okRe = F_OK[action];
  // "already invited" / "already a member" are the wanted end state.
  if (action === 'invite' && /already (invited|a member)/i.test(joined)) return 'ok';
  if (okRe && okRe.test(joined) && !F_FAIL.test(joined)) return 'ok';
  if (F_FAIL.test(joined)) return 'failed';
  return replies.length ? 'unclear' : 'silent';
}

// Massive Factions 2.8 command shapes. Sub-commands are mandatory: a bare
// "/f claim" or "/f invite <name>" only prints the help page.
export const F_COMMANDS = {
  invite: (name) => `/f invite add ${name}`,
  claim: () => '/f claim one',
  unclaim: () => '/f unclaim one',
  sethome: () => '/f sethome',
  rank: (name, rank) => `/f rank ${name} ${rank}`,
};
const RANKS = ['recruit', 'member', 'officer', 'leader', 'promote', 'demote'];

export function factionTools(deps) {
  const { bot, bus, factions, profile, log, state, movement, factionRules } = deps;
  const me = profile.username;
  const claimHint = () => factionRules?.claimHint?.() ?? 'claims need faction power (1 per chunk; power grows while online, drops on death) and land not already owned or protected; recruiting members adds their power';
  // Faction state lives in factions.js (persisted); state.faction is only a
  // mirror for the bootstrap. Trust the persisted record when it exists.
  const myFaction = () => (factions?.state ? (factions.state.ourFaction ?? null) : (state?.faction ?? null));
  const persist = () => { try { factions?._persist?.(); } catch {} };

  const f = {
    name: 'f',
    description: `Factions commands with the server's reply. Actions: create <name> (costs $${FACTION_CREATE_COST}; refused without the funds), claim (the chunk you stand in; costs 1 faction power), unclaim, invite <player> (exact name), join <faction> (needs an invite), leave, ally|enemy|neutral <faction>, home (teleport to the faction home), sethome (only inside your claim), info <faction>, who <player>, power (your own power and when the next chunk becomes affordable), rank <player> <rank> (leaders/officers: new members join as recruits who cannot build on faction land; rank them member so they can). Check board first for factions, relations, your faction's power and your balance.`,
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'claim', 'unclaim', 'invite', 'join', 'leave', 'ally', 'enemy', 'neutral', 'home', 'sethome', 'info', 'who', 'power', 'rank'] },
        name: { type: 'string', maxLength: 40, description: 'faction name or player name, depending on the action' },
        rank: { type: 'string', enum: RANKS, description: 'for rank: member (lets them build on faction land), officer, recruit, or promote/demote one step' },
      },
      required: ['action'], additionalProperties: false,
    },
    defaultInterrupts: [],
    async handler({ action, name, rank }, { cancel }) {
      const needsName = ['create', 'invite', 'join', 'ally', 'enemy', 'neutral', 'info', 'who', 'rank'];
      if (needsName.includes(action) && !name) return fail('missing_name', { action });
      const clean = name ? String(name).trim().replace(/[^A-Za-z0-9_]/g, '') : null;

      if (action === 'rank') {
        if (!myFaction()) return fail('no_faction');
        const r = String(rank ?? 'member').toLowerCase();
        if (!RANKS.includes(r)) return fail('bad_rank', { hint: `rank must be one of ${RANKS.join(', ')}` });
        const replies = await captureReplies(bot, F_COMMANDS.rank(clean, r), { waitMs: 2500, until: /promoted|demoted|moved|leadership|now|not|permission|cannot|can't|couldn't/i });
        const outcome = classify('rank', replies);
        if (outcome === 'ok') return ok({ player: clean, rank: r, replies: replies.slice(0, 4), hint: r === 'member' || r === 'officer' || r === 'promote' ? `${clean} can now build on faction land` : undefined });
        if (outcome === 'unclear' || outcome === 'silent') return partial('unclear', { player: clean, rank: r, replies: replies.slice(0, 4), hint: 'no confirmation; f who <player> shows their rank' });
        return fail(outcome === 'denied' ? 'denied' : 'rank_failed', { player: clean, rank: r, replies: replies.slice(0, 4), hint: 'only the leader (or an officer, for lower ranks) can change ranks' });
      }

      if (action === 'power') {
        const replies = await captureReplies(bot, '/f player', { waitMs: 2500, until: /power per death|power per hour|not found|no player/i });
        const m = replies.map((r) => r.match(/Power:\s*([\d.]+)\s*\/\s*([\d.]+)/i)).find(Boolean);
        if (!m) return replies.length ? partial('unclear', { replies: replies.slice(0, 6) }) : fail('no_reply');
        const power = parseFloat(m[1]); const max = parseFloat(m[2]);
        const nextChunk = Math.floor(power) + 1;
        const minutes = factionRules?.minutesUntil?.(power, nextChunk) ?? null;
        // The faction's total is what claims are paid from.
        let faction = null;
        const mine = myFaction();
        if (mine && bus?.query) {
          try {
            const r = await bus.query('query_faction_info', { faction: mine }, { timeoutMs: 4000 });
            if (r && r.type !== 'error' && r.found) {
              const land = Number.isFinite(r.land_count) ? r.land_count : (r.claims?.length ?? 0);
              faction = { name: mine, power: Number(r.power) || 0, land, members: (r.members ?? []).length };
              faction.chunks_claimable_now = Math.max(0, Math.floor(faction.power) - land);
            }
          } catch (e) { log?.debug?.('faction_power_query_failed', { msg: e.message }); }
        }
        let hint;
        if (faction?.chunks_claimable_now >= 1 && faction.land === 0) hint = `your faction can claim ${faction.chunks_claimable_now} chunk(s) right now: goto named home, f claim, then f sethome`;
        else if (faction?.chunks_claimable_now >= 1) hint = `your faction can claim ${faction.chunks_claimable_now} more chunk(s) (touching the first)`;
        else if (faction) hint = `faction power ${faction.power.toFixed(2)} vs ${faction.land} claimed chunks: recruit members (f invite; their power adds up) or wait; power only grows while online`;
        else if (power < 1) hint = 'not enough for a claim on your own yet: recruit members (their power adds to the faction) or wait; power only grows while online';
        return ok({
          power, power_max: max, chunks_affordable_alone: Math.floor(power),
          minutes_to_next_chunk: Number.isFinite(minutes) ? minutes : null,
          faction: faction ?? undefined, hint,
        });
      }

      if (action === 'info' || action === 'who') {
        if (bus?.query) {
          try {
            if (action === 'who') {
              const r = await bus.query('query_player_faction', { player: clean }, { timeoutMs: 4000 });
              if (r && r.type !== 'error') return ok({ player: clean, faction: r.faction ?? null });
            } else {
              const r = await bus.query('query_faction_info', { faction: clean }, { timeoutMs: 4000 });
              if (r && r.type !== 'error') {
                if (!r.found) return fail('unknown_faction', { faction: clean });
                return ok({ faction: clean, power: r.power, land: r.land_count, members: (r.members ?? []).map((m) => `${m.name}${m.role ? ` (${m.role.toLowerCase()})` : ''}`), claims: (r.claims ?? []).length });
              }
            }
          } catch (e) { log?.debug?.('faction_query_failed', { msg: e.message }); }
        }
        const replies = await captureReplies(bot, action === 'who' ? `/f who ${clean}` : `/f who ${clean}`, { waitMs: 2500 });
        return replies.length ? ok({ replies: replies.slice(0, 8) }) : fail('no_reply');
      }

      if (action === 'create') {
        if (myFaction()) return fail('already_in_faction', { faction: myFaction(), hint: 'leave first, or invite others to this one' });
        if (!clean || clean.length < 2 || clean.length > 18) return fail('bad_name', { hint: '2-18 letters or digits, no spaces' });
        const balance = await readBalance(deps);
        if (balance == null) return fail('balance_unknown', { cost: FACTION_CREATE_COST, hint: 'could not read your balance; call board or command balance first' });
        if (balance < FACTION_CREATE_COST) {
          return fail('insufficient_funds', { balance, cost: FACTION_CREATE_COST, short: Math.ceil(FACTION_CREATE_COST - balance), hint: 'sell surplus (sell) or earn from other players (pay), or join an existing faction instead' });
        }
        const replies = await captureReplies(bot, `/f create ${clean}`, { waitMs: 3000, until: /created|already|afford|money|permission/i });
        const outcome = classify('create', replies);
        if (outcome === 'ok') {
          if (factions?.state) { factions.state.ourFaction = clean; factions.state.foundedAt = Date.now(); persist(); }
          if (state) state.faction = clean;
          log?.info?.('agent_faction_created', { faction: clean, balance_before: balance });
          return ok({ faction: clean, cost: FACTION_CREATE_COST, balance_before: balance, replies: replies.slice(0, 4), hint: 'claim the chunk your house stands in (f claim) so it is protected, then sethome' });
        }
        return fail(outcome === 'denied' ? 'denied' : outcome === 'silent' ? 'no_reply' : 'create_failed', { replies: replies.slice(0, 4), balance });
      }

      if (action === 'join') {
        const replies = await captureReplies(bot, `/f join ${clean}`, { waitMs: 3000, until: /joined|welcome|invite|not|permission/i });
        const outcome = classify('join', replies);
        if (outcome === 'ok') {
          if (factions?.state) { factions.state.ourFaction = clean; factions.state.foundedAt = Date.now(); persist(); }
          if (state) state.faction = clean;
          return ok({ faction: clean, replies: replies.slice(0, 4), hint: 'your power now counts for the faction. You joined as a recruit and cannot build or break on faction land until the leader runs f rank <you> member: ask for it in chat. Read faction_notes' });
        }
        return fail(outcome === 'denied' ? 'denied' : 'join_failed', { replies: replies.slice(0, 4), hint: 'you usually need an invite from a member first; ask in chat' });
      }

      if (action === 'leave') {
        if (!myFaction()) return fail('no_faction');
        const replies = await captureReplies(bot, '/f leave', { waitMs: 3000 });
        const outcome = classify('leave', replies);
        if (outcome === 'ok') {
          if (factions?.state) { factions.state.ourFaction = null; factions.state.allies = []; factions.state.enemies = []; persist(); }
          if (state) state.faction = null;
          return ok({ left: true, replies: replies.slice(0, 4) });
        }
        return fail('leave_failed', { replies: replies.slice(0, 4), hint: 'a leader must hand over leadership or disband first' });
      }

      if (['ally', 'enemy', 'neutral'].includes(action)) {
        if (!myFaction()) return fail('no_faction', { hint: 'join or create a faction first' });
        const replies = await captureReplies(bot, `/f ${action} ${clean}`, { waitMs: 3000 });
        const outcome = classify(action, replies);
        if (outcome === 'ok') {
          if (factions?.state) {
            const list = action === 'ally' ? factions.state.allies : action === 'enemy' ? factions.state.enemies : null;
            if (list && !list.some((x) => x.faction === clean)) list.push({ faction: clean, target_player: null, declared_at: Date.now() });
            if (action === 'neutral') {
              factions.state.allies = (factions.state.allies ?? []).filter((x) => x.faction !== clean);
              factions.state.enemies = (factions.state.enemies ?? []).filter((x) => x.faction !== clean);
            }
            persist();
          }
          return ok({ relation: action, faction: clean, replies: replies.slice(0, 4), note: action === 'ally' ? 'alliances need both sides to declare' : undefined });
        }
        if (outcome === 'unclear' || outcome === 'silent') return partial('unclear', { relation: action, faction: clean, replies: replies.slice(0, 4), hint: 'check board for the relation' });
        return fail(outcome === 'denied' ? 'denied' : 'relation_failed', { replies: replies.slice(0, 4) });
      }

      if (action === 'invite') {
        if (!myFaction()) return fail('no_faction');
        const replies = await captureReplies(bot, F_COMMANDS.invite(clean), { waitMs: 2500, until: /invited|already|not found|couldn't|no player/i });
        const outcome = classify('invite', replies);
        if (outcome === 'ok') return ok({ invited: clean, replies: replies.slice(0, 4), hint: 'tell them in chat to run /f join ' + myFaction() });
        if (outcome === 'unclear' || outcome === 'silent') return partial('unclear', { invited: clean, replies: replies.slice(0, 4), hint: 'no confirmation; ask them to try f join, or check board' });
        return fail(outcome === 'denied' ? 'denied' : 'invite_failed', { replies: replies.slice(0, 4), hint: /not found|no player|couldn't/i.test(replies.join(' ')) ? 'the player name must be exact (see board online list)' : undefined });
      }

      if (action === 'claim' || action === 'unclaim' || action === 'sethome') {
        if (!myFaction()) return fail('no_faction', { hint: 'join or create a faction first' });
        const here = roundPos(bot.entity?.position);
        const replies = await captureReplies(bot, F_COMMANDS[action](), { waitMs: 3000, until: /claimed|power|already|cannot|can't|sorry|home|protected|wilderness|not allowed/i });
        const outcome = classify(action, replies);
        const chunk = here ? { chunk_x: Math.floor(here.x / 16), chunk_z: Math.floor(here.z / 16) } : null;
        if (outcome === 'ok') {
          if (action === 'claim' && state) { state.claims = [...(state.claims ?? []), chunk].filter(Boolean).slice(-64); }
          const hint = action === 'claim' ? 'claimed. Now f sethome here (it only works inside the claim) so f home works for everyone, and write the claim into faction_notes'
            : action === 'sethome' ? 'faction home set: f home teleports every member here' : undefined;
          return ok({ action, at: here, chunk, replies: replies.slice(0, 4), hint });
        }
        if (outcome === 'unclear' || outcome === 'silent') {
          return partial('unclear', { action, at: here, chunk, replies: replies.slice(0, 4), hint: 'the server reply did not confirm it; check board (claims_nearby) to see whether the chunk is yours' });
        }
        const joined = replies.join(' ');
        const hint = action === 'claim'
          ? (/power/i.test(joined) ? `not enough power yet: ${claimHint()}` : claimHint())
          : action === 'sethome' && /claimed territory|only be set/i.test(joined) ? 'the faction home must be inside your own claim: claim this chunk first (f claim), then sethome' : undefined;
        return fail(outcome === 'denied' ? 'denied' : `${action}_failed`, { replies: replies.slice(0, 4), hint });
      }

      if (action === 'home') {
        if (!myFaction()) return fail('no_faction');
        const start = roundPos(bot.entity?.position);
        try { movement?.cancel?.(); bot.pathfinder?.setGoal?.(null); bot.clearControlStates?.(); } catch {}
        const replies = await captureReplies(bot, '/f home', { waitMs: 1500 });
        const deadline = Date.now() + 12_000;
        let moved = 0;
        while (Date.now() < deadline && !cancel.cancelled) {
          await cancellableSleep(500, cancel);
          try { bot.clearControlStates?.(); } catch {}
          moved = distance(start, roundPos(bot.entity?.position)) ?? 0;
          if (moved > 8) break;
        }
        const end = roundPos(bot.entity?.position);
        if (cancel.cancelled) return interrupted(cancel, { pos: end });
        if (moved > 8) return ok({ pos: end, moved, replies: replies.slice(0, 3) });
        return fail(DENIED.test(replies.join(' ')) ? 'denied' : 'no_teleport', { pos: end, replies: replies.slice(0, 3), hint: 'set a faction home first with f sethome (inside your claim)' });
      }

      return fail('unknown_action', { action });
    },
  };

  const sell = {
    name: 'sell',
    description: 'Sell items for money with /sell hand (works anywhere). With no items given it sells your surplus above sensible reserves (crops fully; cobble above 64; ore/ingots above a reserve; never diamonds, tools, armor, or building materials during a build). Give items to sell specific things. Reports what sold, what it earned, and your new balance.',
    input_schema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'string' }, description: 'item names; omit to sell surplus automatically' },
        ignore_reserves: { type: 'boolean', default: false, description: 'sell listed items entirely (still never diamonds/tools/armor)' },
      },
      additionalProperties: false,
    },
    defaultInterrupts: ['damage'],
    async handler({ items, ignore_reserves = false }, { cancel }) {
      const inv = countInventory(bot);
      let plan;
      if (Array.isArray(items) && items.length) {
        plan = [];
        for (const raw of items) {
          const item = String(raw);
          if (NEVER_SELL_EXPLICIT.test(item)) continue;
          const have = inv[item] ?? 0;
          const reserve = ignore_reserves ? 0 : (Number.isFinite(RESERVES[item]) ? RESERVES[item] : 0);
          const n = have - reserve;
          if (n > 0) plan.push({ item, count: n });
        }
      } else {
        plan = computeSellable(inv, { buildActive: !!state?.lastBuild });
      }
      if (deps.prices?.known) {
        for (const p of plan) { p.each = deps.prices.priceOf(p.item); p.expected = p.each != null ? Math.round(p.each * p.count * 100) / 100 : null; }
        plan.sort((a, b) => (b.expected ?? 0) - (a.expected ?? 0));
      }
      if (!plan.length) return ok({ sold: {}, earned: 0, note: items?.length ? 'nothing sellable among those (missing, reserved, or never-sell items)' : 'no surplus above reserves to sell' });
      const sold = {}; let earned = 0; let denied = false;
      for (const { item, count } of plan) {
        let remaining = count;
        for (let i = 0; i < 8 && remaining > 0 && !cancel.cancelled; i++) {
          const stack = (bot.inventory?.items?.() ?? []).find((it) => it?.name === item);
          if (!stack) break;
          try { await bot.equip(stack, 'hand'); } catch (e) { log?.debug?.('sell_equip_failed', { item, msg: e.message }); break; }
          const n = Math.min(remaining, stack.count);
          const before = countInventory(bot)[item] ?? 0;
          const replies = await captureReplies(bot, `/sell hand ${n}`, { waitMs: 2500, until: /sold|\$|access|permission|cannot|can't|not/i });
          if (DENIED.test(replies.join(' '))) { denied = true; break; }
          let amount = 0;
          for (const r of replies) { const p = parseEconomyMessage(r, { username: me }); if (p?.kind === 'sell') amount += p.amount; }
          const after = countInventory(bot)[item] ?? 0;
          const gone = Math.max(0, before - after);
          if (gone === 0 && amount === 0) { log?.info?.('sell_no_effect', { item, replies: replies.slice(0, 3) }); break; }
          sold[item] = (sold[item] ?? 0) + (gone || n);
          earned += amount;
          remaining -= (gone || n);
          await cancellableSleep(300, cancel);
        }
        if (denied || cancel.cancelled) break;
      }
      const balance = await readBalance(deps);
      const base = { sold, earned: Math.round(earned * 100) / 100, balance: balance ?? undefined, planned: plan };
      if (cancel.cancelled) return interrupted(cancel, base);
      if (denied) return fail('denied', { ...base, hint: 'the server refused /sell hand; selling may need a permission or a shop' });
      if (!Object.keys(sold).length) return fail('nothing_sold', base);
      log?.info?.('agent_sold', base);
      return earned > 0 ? ok(base) : partial('sold_but_no_amount_seen', base);
    },
  };

  const pay = {
    name: 'pay',
    description: 'Pay another player with /pay. Use for trades you agreed in chat, faction dues, or favors. Reports the server reply and your new balance.',
    input_schema: {
      type: 'object',
      properties: { player: { type: 'string' }, amount: { type: 'number', minimum: 1, maximum: 100000 } },
      required: ['player', 'amount'], additionalProperties: false,
    },
    defaultInterrupts: [],
    async handler({ player, amount }) {
      const who = String(player).trim().replace(/[^A-Za-z0-9_]/g, '');
      const amt = Math.round(Number(amount) * 100) / 100;
      const replies = await captureReplies(bot, `/pay ${who} ${amt}`, { waitMs: 2500, until: /sent|paid|enough|not found|invalid|access|permission/i });
      const joined = replies.join(' | ');
      const balance = await readBalance(deps);
      if (DENIED.test(joined)) return fail('denied', { replies: replies.slice(0, 3) });
      if (/not enough|insufficient|afford/i.test(joined)) return fail('insufficient_funds', { balance: balance ?? undefined, replies: replies.slice(0, 3) });
      if (/not found|never played|unknown player|offline/i.test(joined)) return fail('player_not_found', { player: who, replies: replies.slice(0, 3) });
      if (/sent|paid|has been/i.test(joined)) { log?.info?.('agent_paid', { player: who, amount: amt, balance }); return ok({ player: who, amount: amt, balance: balance ?? undefined, replies: replies.slice(0, 2) }); }
      return partial('unclear', { player: who, amount: amt, balance: balance ?? undefined, replies: replies.slice(0, 3) });
    },
  };

  const factionNotes = {
    name: 'faction_notes',
    description: 'The shared notes of your faction (all members read and write the same page): plans, who needs what, raid targets, stash locations. read shows the page; append adds a dated line under your name; write replaces the whole page. Needs a faction.',
    input_schema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['read', 'append', 'write'] }, text: { type: 'string', maxLength: 2000 } },
      required: ['action'], additionalProperties: false,
    },
    parallelSafe: true,
    async handler({ action, text }) {
      const faction = myFaction();
      if (!faction) return fail('no_faction', { hint: 'faction notes exist once you are in a faction' });
      const redis = deps.redis ?? bus?.publisher ?? null;
      if (!redis?.get) return fail('no_redis');
      const key = `aif:faction_notes:${faction}`;
      let cur = '';
      try { cur = (await redis.get(key)) ?? ''; } catch (e) { return fail('redis_error', { msg: e.message }); }
      if (action === 'read') return ok({ faction, notes: cur || '(empty)', bytes: Buffer.byteLength(cur) });
      const body = String(text ?? '').trim();
      if (!body) return fail('empty');
      let next;
      if (action === 'write') next = body;
      else next = `${cur ? cur.replace(/\s+$/, '') + '\n' : ''}- [${new Date().toISOString().slice(0, 16).replace('T', ' ')} ${me}] ${body.replace(/\s+/g, ' ')}`;
      if (Buffer.byteLength(next) > NOTES_MAX_BYTES) return fail('too_long', { hint: 'rewrite the page shorter with write' });
      try { await redis.set(key, next); } catch (e) { return fail('redis_error', { msg: e.message }); }
      log?.info?.('agent_faction_notes', { faction, action, bytes: Buffer.byteLength(next) });
      return ok({ faction, action, lines: next.split('\n').length });
    },
  };

  return [f, sell, pay, factionNotes];
}
