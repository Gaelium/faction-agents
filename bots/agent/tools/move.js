/**
 * move.js — goto, leave_spawn, flee. All wrap tactical/movement.js and
 * honor the cancel token by stopping the pathfinder.
 */

import { isInProtectedZone, isNearProtectedZone, pushClearOfProtection, nearestProtectedZone, zoneCenter } from '../../world/zones.js';
import { awaitHandle, cancellableSleep } from '../cancel.js';
import { ok, fail, partial, interrupted, roundPos, distance, compassDir, toVec3 } from './result.js';

export const INTERRUPT_SCHEMA = {
  type: 'array',
  items: { type: 'string', enum: ['damage', 'chat_mention', 'whisper', 'chat_any', 'mob_near', 'player_near', 'hunger'] },
  description: 'Events that pull you out of this action early. Default: ["damage"]. Pass [] to stay heads-down.',
};

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const COMPASS_DEG = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

/**
 * A stable heading (degrees, 0 = north, 90 = east) derived from the bot's
 * name, so a fleet that spawns on one block fans out instead of walking the
 * same line to the same trees (ten bots ended a session within 40 blocks of
 * each other on 2026-09-13).
 */
export function exitBearingFor(name) {
  let h = 2166136261;
  for (const ch of String(name ?? '')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h % 360;
}
export function bearingToCompass(deg) { return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]; }

/** The first point along `deg` from the zone's centre that is clear of the margin; null when no zone is near. */
function exitAlongBearing(here, deg, buffer) {
  const zone = nearestProtectedZone(here, buffer);
  if (!zone) return null;
  const c = zoneCenter(zone);
  const rad = (deg * Math.PI) / 180; const ux = Math.sin(rad); const uz = -Math.cos(rad);
  for (let r = 8; r <= 640; r += 8) {
    const p = { x: Math.round(c.x + ux * r), z: Math.round(c.z + uz * r) };
    if (!isNearProtectedZone(p, buffer)) return p;
  }
  return null;
}

function surroundings(bot, pos) {
  if (!pos || typeof bot.blockAt !== 'function') return null;
  // Cells, not rounded coordinates: a bot at x 10.5 stands in cell 10.
  const raw = bot.entity?.position ?? pos;
  const c = { x: Math.floor(raw.x), y: Math.floor(raw.y), z: Math.floor(raw.z) };
  const at = (dx, dy, dz) => { try { return bot.blockAt(toVec3({ x: c.x + dx, y: c.y + dy, z: c.z + dz }))?.name ?? '?'; } catch { return '?'; } };
  // A bot on a fence rides half a block up, so its rounded y is one too high; report the fence, not the air above it.
  const below1 = at(0, -1, 0); const below2 = at(0, -2, 0);
  return { below: below1 === 'air' && /fence|wall/.test(below2) ? below2 : below1, above: at(0, 2, 0), E: at(1, 0, 0), W: at(-1, 0, 0), S: at(0, 0, 1), N: at(0, 0, -1) };
}

function resolveTarget(deps, input) {
  const { bot, state } = deps;
  if (typeof input.player === 'string' && input.player) {
    const ent = bot.players?.[input.player]?.entity;
    if (!ent?.position) return { error: fail('player_not_visible', { player: input.player }) };
    return { pos: roundPos(ent.position), label: input.player };
  }
  if (input.named === 'home') {
    if (!state?.home) return { error: fail('no_home', { hint: 'build a shelter first, or set one with the command tool (/sethome)' }) };
    // "home" means standing inside, through the door, not the anchor
    // corner (which is a wall cell).
    const h = state.home;
    const pos = h.inside ?? { x: h.x, y: h.y, z: h.z };
    return { pos, label: 'home' };
  }
  if (input.named === 'spawn') {
    return { pos: state?.spawn ?? deps.profile?.spawn ?? { x: 0, y: 64, z: 0 }, label: 'spawn' };
  }
  if ([input.x, input.z].every((v) => Number.isFinite(v))) {
    const y = Number.isFinite(input.y) ? input.y : Math.round(bot.entity?.position?.y ?? 64);
    return { pos: { x: input.x, y, z: input.z }, label: null };
  }
  return { error: fail('bad_target', { hint: 'give x,z (y optional), or named: home|spawn, or player: <name>' }) };
}

export function moveTools(deps) {
  const { bot, movement, log } = deps;

  const goto = {
    name: 'goto',
    description: 'Walk to a position (pathfinding, digs through simple terrain when allowed; uses your own front door in and out, never your walls; avoids deep water). Give x,z (y optional), or named: home|spawn (home = inside your house), or player: <name>. Stops within `range` blocks. Returns where you ended up and, when it could not get there, what is around you so you can decide.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
        named: { type: 'string', enum: ['home', 'spawn'] },
        player: { type: 'string' },
        range: { type: 'number', minimum: 0, maximum: 8, default: 1 },
        timeout_s: { type: 'integer', minimum: 5, maximum: 180, default: 45 },
        interrupt_on: INTERRUPT_SCHEMA,
      },
      additionalProperties: false,
    },
    defaultInterrupts: ['damage'],
    async handler(input, { cancel }) {
      const t = resolveTarget(deps, input);
      if (t.error) return t.error;
      const range = input.range ?? 1;
      const timeoutMs = (input.timeout_s ?? 45) * 1000;
      const start = roundPos(bot.entity?.position);
      const handle = movement.goTo(t.pos, { timeoutMs, range });
      const r = await awaitHandle(handle, cancel);
      const end = roundPos(bot.entity?.position);
      const left = distance(end, t.pos);
      const base = { target: t.label ?? t.pos, pos: end, remaining: left, moved: distance(start, end) };
      if (r?.door) base.door = r.door;   // 'out' / 'in' when the house door was used, else why it was not
      if (cancel.cancelled) return interrupted(cancel, base);
      if (r?.reached || (left != null && left <= Math.max(range, 1.5))) return ok(base);
      const why = r?.reason ?? 'unreached';
      const extra = { ...base, around: surroundings(bot, end) };
      if (why === 'noPath') extra.hint = 'no path found: try a closer waypoint, a different y, dig/place your way, or pick another target';
      if (why === 'timeout') extra.hint = (base.moved ?? 0) < 1 ? 'you did not move at all: the area may not be loaded or you may be wedged; try unstick, teleport, or a short hop of 5-10 blocks' : 'ran out of time; call goto again from here, or use a shorter hop';
      // A fence under the feet explains any failure: the pathfinder has no move from up there.
      if (extra.around?.below && /fence|wall/.test(extra.around.below)) extra.hint = 'you are standing on top of a fence: the pathfinder cannot move from there; call unstick first';
      return (base.moved ?? 0) > 3 ? partial(why, extra) : fail(why, extra);
    },
  };

  const leaveSpawn = {
    name: 'leave_spawn',
    description: 'Walk clear of the spawn protection zone (you cannot break or place blocks inside it, and digging is suppressed near its edge; you may spawn just outside the box but still within that margin). Every bot has its own exit heading, so a fleet fans out around spawn instead of crowding one side; pass direction to choose a side yourself (for example towards your home). Keeps walking until you are clear by a comfortable margin. Use this first after logging in at spawn.',
    input_schema: {
      type: 'object',
      properties: {
        margin: { type: 'integer', minimum: 8, maximum: 128, default: 48, description: 'how far past the boundary to get' },
        direction: { type: 'string', enum: COMPASS, description: 'which side of spawn to leave on; default: your own heading (reported as dir in the result)' },
        timeout_s: { type: 'integer', minimum: 30, maximum: 300, default: 150 },
        interrupt_on: INTERRUPT_SCHEMA,
      },
      additionalProperties: false,
    },
    defaultInterrupts: ['damage'],
    async handler({ margin = 48, timeout_s = 150, direction = null }, { cancel }) {
      const start = roundPos(bot.entity?.position);
      if (!start) return fail('no_position');
      const bearing = direction && COMPASS_DEG[direction] != null ? COMPASS_DEG[direction] : exitBearingFor(deps.profile?.username ?? bot.username);
      const dir = bearingToCompass(bearing);
      if (!isNearProtectedZone(start, margin)) return ok({ already_clear: true, pos: start, dir });
      const deadline = Date.now() + timeout_s * 1000;
      movement.setBootstrapMode?.(true);
      let attempts = 0; let last = null; let fails = 0;
      try {
        while (Date.now() < deadline && !cancel.cancelled) {
          const here = bot.entity?.position;
          if (!isNearProtectedZone(here, margin)) break;
          // Inside the zone: leave along this bot's heading so bots spread out. Only near it: straight out is shortest.
          const exit = (isInProtectedZone(here) ? exitAlongBearing(here, bearing, margin + 16) : null) ?? pushClearOfProtection({ x: here.x, z: here.z }, margin + 16);
          if (Math.hypot(exit.x - here.x, exit.z - here.z) < 4) { last = { reached: false, reason: 'no_exit_target' }; break; }
          attempts += 1;
          const target = { x: exit.x, y: Math.round(here.y), z: exit.z };
          log?.info?.('leave_spawn_hop', { attempt: attempts, target });
          const t0 = Date.now();
          const handle = movement.goTo(target, { timeoutMs: Math.min(60_000, deadline - Date.now()), range: 4 });
          last = await awaitHandle(handle, cancel);
          if (!last?.reached) {
            fails += 1;
            if (fails >= 4) break;
            // Never spin: an instant failure gets a beat before the retry.
            if (Date.now() - t0 < 1000) await cancellableSleep(1000, cancel);
          }
        }
      } finally {
        movement.setBootstrapMode?.(false);
      }
      const end = roundPos(bot.entity?.position);
      const clear = !isNearProtectedZone(end, margin);
      const base = { pos: end, clear, dir, attempts, moved: distance(start, end), still_inside: isInProtectedZone(end) };
      if (cancel.cancelled) return interrupted(cancel, base);
      if (clear) {
        if (deps.state) deps.state.clearOfSpawn = end;
        return ok(base);
      }
      return partial(last?.reason ?? 'not_clear', { ...base, around: surroundings(bot, end), hint: 'call leave_spawn again, or goto a point farther in the same direction' });
    },
  };

  const flee = {
    name: 'flee',
    description: 'Run away from a player, mob, or position until you are `distance` blocks from it. Use when a fight is not worth it.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'player or mob name' },
        x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
        distance: { type: 'integer', minimum: 5, maximum: 60, default: 20 },
        timeout_s: { type: 'integer', minimum: 5, maximum: 60, default: 15 },
      },
      additionalProperties: false,
    },
    defaultInterrupts: [],
    async handler(input, { cancel }) {
      let from = null;
      if (input.from) {
        const ent = bot.players?.[input.from]?.entity ?? findMobByName(bot, input.from);
        if (!ent?.position) return fail('target_not_visible', { from: input.from });
        from = ent.position;
      } else if (Number.isFinite(input.x) && Number.isFinite(input.z)) {
        from = { x: input.x, y: input.y ?? bot.entity?.position?.y ?? 64, z: input.z };
      } else return fail('bad_target');
      const handle = movement.flee(from, input.distance ?? 20, { timeoutMs: (input.timeout_s ?? 15) * 1000 });
      const r = await awaitHandle(handle, cancel);
      const end = roundPos(bot.entity?.position);
      const base = { pos: end, distance_now: distance(end, from) };
      if (cancel.cancelled) return interrupted(cancel, base);
      return r?.reached ? ok(base) : partial(r?.reason ?? 'unreached', base);
    },
  };

  return [goto, leaveSpawn, flee];
}

export function findMobByName(bot, name) {
  const me = bot.entity?.position;
  if (!me) return null;
  const want = String(name).toLowerCase().replace(/\s+/g, '');
  let best = null; let bestD = Infinity;
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e?.position || e === bot.entity || e.type === 'player' || e.type === 'object') continue;
    const n = (e.name ?? e.displayName ?? '').toString().toLowerCase().replace(/\s+/g, '');
    if (n !== want) continue;
    const d = distance(me, e.position);
    if (d < bestD) { best = e; bestD = d; }
  }
  return best;
}

export function compass(from, to) { return compassDir(from, to); }
