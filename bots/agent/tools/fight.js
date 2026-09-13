/**
 * fight.js — attack. Wraps tactical/combat.js (1.8-accurate, skill-tier
 * driven). The tool blocks until the target is dead/gone, combat stalls,
 * the timeout hits, or the token cancels; combat's own 20 Hz tick does the
 * aiming, chasing, swinging, and low-HP fleeing meanwhile.
 */

import { cancellableSleep } from '../cancel.js';
import { HOSTILE } from '../nerves.js';
import { findMobByName } from './move.js';
import { ok, fail, partial, interrupted, roundPos, distance } from './result.js';

const CLEAR_RANGE = 6;          // after a kill, keep fighting hostiles this close
const CONTINUE_MIN_HP = 7;      // but only above this (the engine flees below its own threshold)
const NO_MELEE = new Set(['creeper', 'ghast', 'blaze', 'witch']);   // the brain decides about these

/** Nearest hostile mob within `range`, excluding `skip`; creepers etc. never auto-picked. */
export function nearestHostile(bot, range, { skip = null, melee = true } = {}) {
  const me = bot.entity?.position;
  if (!me) return null;
  let best = null; let bestD = Infinity;
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e?.position || e === bot.entity || e === skip || e.isValid === false) continue;
    if (e.type === 'player' || e.type === 'object') continue;
    const name = String(e.name ?? e.displayName ?? '').toLowerCase();
    if (!HOSTILE.has(name)) continue;
    if (melee && NO_MELEE.has(name)) continue;
    if (typeof e.health === 'number' && e.health <= 0) continue;
    const d = distance(me, e.position);
    if (d != null && d <= range && d < bestD) { best = e; bestD = d; }
  }
  return best;
}

export function fightTools(deps) {
  const { bot, combat, log } = deps;

  const attack = {
    name: 'attack',
    description: 'Fight a player or mob by name until it is dead, out of reach, or `timeout_s` passes. Combat handles aiming, chasing and swinging, and retreats on its own when your health gets low; being hit does not interrupt it. With until_clear (default) it keeps going for any other zombie/skeleton/spider within 6 blocks after the first dies, so one call clears a doorway. Creepers are never auto-targeted. Returns the outcome, kills, and both health values.',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'player name or mob name (zombie, skeleton, cow, …)' },
        timeout_s: { type: 'integer', minimum: 5, maximum: 120, default: 30 },
        until_clear: { type: 'boolean', default: true, description: 'after the target dies, fight other nearby hostiles too' },
      },
      required: ['target'], additionalProperties: false,
    },
    defaultInterrupts: [],
    // A hit from the thing you are fighting must not hand control back to the
    // brain mid-swing (TestBot44 lost a zombie fight that way at 8 hp: the
    // attack was cancelled, the model took 3 s to answer, the zombie did not).
    // Lava, fire and drowning still interrupt.
    uninterruptible: (kind, data) => kind === 'damage' && !['lava', 'drowning', 'fire'].includes(data?.cause),
    async handler({ target, timeout_s = 30, until_clear = true }, { cancel }) {
      if (!combat) return fail('no_combat');
      let ent = bot.players?.[target]?.entity ?? findMobByName(bot, target);
      if (!ent?.position) return fail('target_not_visible', { target });
      const start = Date.now();
      const deadline = start + timeout_s * 1000;
      const hpStart = bot.health;
      const isPlayer = ent.type === 'player';
      const killed = [];
      let outcome = null;
      let fights = 0;
      while (ent && Date.now() < deadline && !cancel.cancelled) {
        fights += 1;
        try { await combat.engage(ent); } catch (e) { outcome = 'engage_failed'; log?.debug?.('attack_engage_failed', { msg: e.message }); break; }
        outcome = null;
        while (Date.now() < deadline) {
          if (cancel.cancelled) { outcome = 'interrupted'; break; }
          if (typeof bot.health === 'number' && bot.health <= 0) { outcome = 'died'; break; }
          const alive = ent.isValid !== false && (typeof ent.health !== 'number' || ent.health > 0);
          if (!alive) { outcome = 'target_dead'; break; }
          if (!combat.engaged) { outcome = combat.lastDisengageReason ?? 'disengaged'; break; }
          const d = distance(bot.entity?.position, ent.position);
          if (d != null && d > 40) { outcome = 'target_escaped'; break; }
          await cancellableSleep(250, cancel);
        }
        if (!outcome) outcome = 'timeout';
        if (outcome === 'target_dead') killed.push(ent.username ?? ent.name ?? 'mob');
        try { combat.disengage(outcome); } catch {}
        if (outcome !== 'target_dead' || !until_clear || isPlayer) break;
        if (typeof bot.health === 'number' && bot.health < CONTINUE_MIN_HP) { outcome = 'low_hp'; break; }
        // Another one at the door? Keep the sword out.
        ent = nearestHostile(bot, CLEAR_RANGE, { skip: ent });
      }
      const remaining = nearestHostile(bot, CLEAR_RANGE + 2, { melee: false });
      const base = {
        target, player: isPlayer, outcome, killed, fights,
        my_hp: bot.health,
        damage_taken: typeof hpStart === 'number' && typeof bot.health === 'number' ? Math.round((hpStart - bot.health) * 10) / 10 : null,
        remaining_hostile: remaining ? `${remaining.name ?? 'mob'} ${Math.round(distance(bot.entity?.position, remaining.position) ?? 0)}b` : null,
        pos: roundPos(bot.entity?.position),
        seconds: Math.round((Date.now() - start) / 1000),
      };
      log?.info?.('attack_result', base);
      if (outcome === 'interrupted') return interrupted(cancel, base);
      if (outcome === 'died') return fail('died', base);
      if (outcome === 'target_dead' || (killed.length && outcome === 'low_hp')) return ok({ ...base, hint: remaining ? 'a hostile is still near; get behind a door or fight it next' : undefined });
      if (outcome === 'flee') return partial('retreated_low_hp', { ...base, hint: 'eat behind a door, then decide' });
      if (outcome === 'engage_failed') return fail('engage_failed', base);
      return partial(outcome, base);
    },
  };

  return [attack];
}
