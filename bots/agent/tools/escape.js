/**
 * escape.js — unstick and teleport. The old stack ran these as watchdog
 * reflexes that fired on their own; here they are explicit tools the
 * brain calls after reading a failed goto or an interrupt. Ported from
 * executor._digToEscape / _tryEmergencyPillarUp / _returnToSurface /
 * teleportHome / teleportSpawn with the same safety rules: never dig into
 * lava, never drop more than one block, never break bedrock or protected
 * blocks, never dig the bot's own wall when a clean exit exists.
 */

import vec3Pkg from 'vec3';
import { isInProtectedZone } from '../../world/zones.js';
import { cancellableSleep } from '../cancel.js';
import { isInsideHome } from './door.js';
import { ok, fail, partial, interrupted, roundPos, distance } from './result.js';

const Vec3 = vec3Pkg.Vec3 ?? vec3Pkg;

const PILLAR_PREFERENCE = ['dirt', 'gravel', 'sand', 'netherrack', 'andesite', 'diorite', 'granite',
  'sandstone', 'cobblestone', 'stone', 'grass'];
const SURFACE_DEFAULT_Y = 63;
const DEEP_DEPTH = 6;

const isFluid = (b) => !!b && /^(flowing_)?(water|lava)$/.test(b.name);
const isLava = (b) => !!b && (b.name === 'lava' || b.name === 'flowing_lava');
const isAirish = (b) => !b || b.name === 'air' || b.boundingBox === 'empty';
const isSolid = (b) => !!b && b.name !== 'air' && b.boundingBox !== 'empty' && !isFluid(b);

function at(bot, x, y, z) { try { return bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))); } catch { return null; } }

function lavaAdjacent(bot, x, y, z) {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    if (isLava(at(bot, x + dx, y + dy, z + dz))) return true;
  }
  return false;
}

/** All four cardinal steps blocked at feet or head level. */
export function isConfined(bot) {
  const p = bot.entity?.position;
  if (!p || typeof bot.blockAt !== 'function') return false;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (isAirish(at(bot, p.x + dx, p.y, p.z + dz)) && isAirish(at(bot, p.x + dx, p.y + 1, p.z + dz))) return false;
  }
  return true;
}

const CANOPY = /leaves|^log|_log$|log2|^wood$|vine|sapling/;

/** Solid roof (not a tree canopy) somewhere in the 48 blocks above → underground. */
export function isUnderground(bot) {
  const p = bot.entity?.position;
  if (!p || typeof bot.blockAt !== 'function') return false;
  for (let y = Math.floor(p.y) + 2; y <= Math.floor(p.y) + 48; y++) {
    const b = at(bot, p.x, y, p.z);
    if (b && b.name !== 'air' && b.boundingBox === 'block' && !CANOPY.test(b.name)) return true;
  }
  return false;
}

export function pickPillarItem(bot) {
  const items = bot.inventory?.items?.() ?? [];
  for (const name of PILLAR_PREFERENCE) {
    const it = items.find((i) => i?.name === name);
    if (it) return it;
  }
  return null;
}

function diggable(bot, b, movement, allowOwn) {
  if (!isSolid(b) || b.name === 'bedrock') return false;
  if (bot.canDigBlock && bot.canDigBlock(b) === false) return false;
  if (isInProtectedZone({ x: b.position.x, z: b.position.z })) return false;
  if (lavaAdjacent(bot, b.position.x, b.position.y, b.position.z)) return false;
  if (!allowOwn && movement?.isOwnBlock?.(b.position)) return false;
  return true;
}

/** Open one cardinal step (dig feet/head), prefer not touching own blocks; else drop exactly one block. */
export async function sidestep(bot, movement, cancel, log, { allowOwn = false } = {}) {
  const p = bot.entity?.position;
  if (!p) return { dug: 0, moved: false, reason: 'no_position' };
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
  // Own walls are only dug when the caller passed force: a bot inside its
  // house is not stuck, it has a door (Rook_Vantis, 2026-09-04).
  for (const own of allowOwn ? [false, true] : [false]) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (cancel?.cancelled) return { dug: 0, moved: false, reason: 'cancelled' };
      const feet = at(bot, bx + dx, by, bz + dz);
      const head = at(bot, bx + dx, by + 1, bz + dz);
      const floor = at(bot, bx + dx, by - 1, bz + dz);
      if (!isSolid(floor)) continue;
      const toDig = [];
      if (isSolid(feet)) { if (!diggable(bot, feet, movement, own)) continue; toDig.push(feet); }
      if (isSolid(head)) { if (!diggable(bot, head, movement, own)) continue; toDig.push(head); }
      if (!toDig.length) continue;
      let dug = 0;
      for (const b of toDig) { try { await bot.dig(b); dug++; } catch (e) { log?.debug?.('unstick_dig_err', { msg: e.message }); } }
      try { await bot.lookAt(new Vec3(bx + dx + 0.5, by, bz + dz + 0.5)); } catch {}
      try { bot.setControlState('forward', true); } catch {}
      await cancellableSleep(700, cancel);
      try { bot.setControlState('forward', false); } catch {}
      const q = bot.entity?.position;
      const moved = !!q && (Math.floor(q.x) !== bx || Math.floor(q.z) !== bz);
      log?.info?.('unstick_sidestep', { dir: { dx, dz }, dug, own, moved });
      return { dug, moved, dir: { dx, dz }, own };
    }
  }
  if (!allowOwn && movement?.isOwnBlock) {
    const ownBlocked = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => movement.isOwnBlock({ x: bx + dx, y: by, z: bz + dz }) || movement.isOwnBlock({ x: bx + dx, y: by + 1, z: bz + dz }));
    if (ownBlocked) return { dug: 0, moved: false, reason: 'own_walls', hint: 'your own walls are all around: goto walks out through the door; pass force to dig through anyway' };
  }
  const support = at(bot, bx, by - 1, bz);
  const landing = at(bot, bx, by - 2, bz);
  if (diggable(bot, support, movement, false) && isSolid(landing) && !isLava(landing)) {
    try { await bot.dig(support); log?.info?.('unstick_drop', { pos: { x: bx, y: by, z: bz } }); return { dug: 1, moved: true, dir: 'down' }; }
    catch (e) { return { dug: 0, moved: false, reason: 'drop_failed:' + e.message }; }
  }
  return { dug: 0, moved: false, reason: 'no_safe_exit' };
}

/** Jump-and-place straight up, breaking the ceiling as needed. */
export async function climb(bot, movement, cancel, log, { goalY, maxSteps = 96, stopWithHeadroomAfter = null }) {
  const item = pickPillarItem(bot);
  if (!item) return { placed: 0, dug: 0, reason: 'no_blocks' };
  const start = bot.entity.position.y;
  let placed = 0; let dug = 0; let lastY = start; let noProgress = 0; let reason = 'done';
  try { bot.pathfinder?.setGoal?.(null); } catch {}
  try { bot.clearControlStates?.(); } catch {}
  try {
    for (let i = 0; i < maxSteps; i++) {
      if (cancel?.cancelled) { reason = 'cancelled'; break; }
      const pos = bot.entity.position;
      if (Number.isFinite(goalY) && pos.y >= goalY - 1) break;
      if (isInProtectedZone({ x: pos.x, z: pos.z })) { reason = 'protected'; break; }
      const ceiling = at(bot, pos.x, pos.y + 2, pos.z);
      const over = at(bot, pos.x, pos.y + 3, pos.z);
      if (isLava(ceiling) || isLava(over)) { reason = 'lava_above'; break; }
      if (isSolid(ceiling)) {
        if (bot.canDigBlock && bot.canDigBlock(ceiling) === false) { reason = 'ceiling_unbreakable'; break; }
        try {
          if (bot.collectBlock?.collect) await bot.collectBlock.collect(ceiling); else await bot.dig(ceiling);
          dug++;
        } catch (e) { log?.debug?.('climb_dig_err', { msg: e.message }); reason = 'ceiling_dig_failed'; break; }
      }
      try { await bot.equip(item, 'hand'); } catch {}
      const below = at(bot, pos.x, pos.y - 1, pos.z);
      if (!isSolid(below)) { reason = 'no_floor'; break; }
      try { await bot.lookAt(new Vec3(pos.x, pos.y - 1, pos.z), true); } catch {}
      try { bot.setControlState('jump', true); } catch {}
      await cancellableSleep(280, cancel);
      try {
        await bot.placeBlock(below, new Vec3(0, 1, 0));
        placed++;
        try { movement?.notePlacement?.({ x: below.position.x, y: below.position.y + 1, z: below.position.z }); } catch {}
      } catch (e) { log?.debug?.('climb_place_err', { msg: e.message }); }
      try { bot.setControlState('jump', false); } catch {}
      await cancellableSleep(220, cancel);
      const y = bot.entity.position.y;
      if (y - lastY < 0.5) { if (++noProgress >= 3) { reason = 'no_progress'; break; } }
      else { noProgress = 0; lastY = y; }
      if (stopWithHeadroomAfter != null && placed >= stopWithHeadroomAfter
          && isAirish(at(bot, bot.entity.position.x, bot.entity.position.y + 2, bot.entity.position.z))) break;
    }
  } finally {
    try { bot.setControlState('jump', false); } catch {}
  }
  return { placed, dug, reason, from_y: Math.round(start), to_y: Math.round(bot.entity?.position?.y ?? start) };
}

const isWaterBlock = (b) => !!b && (b.name === 'water' || b.name === 'flowing_water');
const isFenceLike = (b) => !!b && /fence|_wall$|cobblestone_wall/.test(b.name ?? '');

/**
 * Standing on top of a fence, wall or gate (they are 1.5 blocks tall, so
 * the bot rides half a block above the cell): the pathfinder has no move
 * from there and every goto times out (oatmeal_ollie on her farm fence,
 * 2026-09-07). Detected by the block under the feet.
 */
export function onFence(bot) {
  const p = bot.entity?.position;
  if (!p) return false;
  return isFenceLike(at(bot, p.x, Math.floor(p.y) - 1, p.z));
}

/** Walk off the fence onto a neighbouring cell with air to stand in; the drop is harmless. */
export async function stepOffFence(bot, cancel, log) {
  const p = bot.entity?.position;
  if (!p) return { moved: false, reason: 'no_position' };
  const bx = Math.floor(p.x); const by = Math.floor(p.y); const bz = Math.floor(p.z);
  const start = { x: bx, z: bz };
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = bx + dx; const nz = bz + dz;
    // The cell beside the fence at the fence's own level and the one above must be free.
    if (!isAirish(at(bot, nx, by - 1, nz)) || !isAirish(at(bot, nx, by, nz)) || isFluid(at(bot, nx, by - 1, nz))) continue;
    if (isLava(at(bot, nx, by - 2, nz))) continue;
    try { await bot.lookAt(new Vec3(nx + 0.5, by + 0.6, nz + 0.5), true); } catch {}
    try { bot.setControlState('forward', true); } catch {}
    const deadline = Date.now() + 1500;
    let moved = false;
    while (Date.now() < deadline && !cancel?.cancelled) {
      await cancellableSleep(100, cancel);
      const q = bot.entity?.position;
      if (q && (Math.floor(q.x) !== start.x || Math.floor(q.z) !== start.z) && !onFence(bot)) { moved = true; break; }
    }
    try { bot.setControlState('forward', false); } catch {}
    if (moved) { log?.info?.('unstick_off_fence', { from: { x: bx, y: by, z: bz }, dir: { dx, dz } }); return { moved: true, dir: { dx, dz } }; }
  }
  return { moved: false, reason: 'no_way_down' };
}

/** Feet or head in water. */
export function inWater(bot) {
  const p = bot.entity?.position;
  if (!p) return false;
  return isWaterBlock(at(bot, p.x, p.y, p.z)) || isWaterBlock(at(bot, p.x, p.y + 1, p.z));
}

function headInWater(bot) {
  const p = bot.entity?.position;
  return !!p && isWaterBlock(at(bot, p.x, p.y + 1, p.z));
}

/**
 * Nearest standable land cell near the water surface within `radius`
 * (solid block with two non-water, non-solid cells above it).
 */
export function findShore(bot, radius = 24) {
  const p = bot.entity?.position;
  if (!p) return null;
  const bx = Math.floor(p.x); const bz = Math.floor(p.z);
  let surfaceY = Math.floor(p.y);
  for (let i = 0; i < 24 && isWaterBlock(at(bot, bx, surfaceY + 1, bz)); i++) surfaceY++;
  const clear = (b) => isAirish(b) && !isFluid(b);
  let best = null;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const d = Math.hypot(dx, dz);
      if (d < 1 || (best && d >= best.d)) continue;
      for (let y = surfaceY + 3; y >= surfaceY - 2; y--) {
        const g = at(bot, bx + dx, y, bz + dz);
        if (!g || g.name === 'air' || isFluid(g)) continue;
        if (g.boundingBox !== 'block') break;
        if (clear(at(bot, bx + dx, y + 1, bz + dz)) && clear(at(bot, bx + dx, y + 2, bz + dz))) best = { x: bx + dx, y: y + 1, z: bz + dz, d };
        break;
      }
    }
  }
  return best;
}

/**
 * Get out of deep water: hold jump until the head is clear, then swim
 * (forward + jump) straight at the nearest shore. In 1.8 mineflayer sinks
 * whenever the pathfinder drives (it clears jump every tick), which is
 * how oatmeal_ollie drowned to the sea floor at y 48 (2026-09-04).
 */
export async function swimToShore(bot, movement, cancel, log, { maxMs = 30_000 } = {}) {
  const start = roundPos(bot.entity?.position);
  const shore = findShore(bot, 24);
  const deadline = Date.now() + maxMs;
  try { movement?.cancel?.(); bot.clearControlStates?.(); } catch {}
  let surfaced = !headInWater(bot);
  try {
    bot.setControlState?.('jump', true);
    while (!surfaced && Date.now() < deadline && !cancel?.cancelled) {
      await cancellableSleep(150, cancel);
      surfaced = !headInWater(bot);
    }
    if (!shore) return { surfaced, landed: false, reason: 'no_shore_found', from: start };
    let landed = false;
    const aim = () => bot.lookAt?.(new Vec3(shore.x + 0.5, (bot.entity?.position?.y ?? shore.y) + 1.2, shore.z + 0.5), true);
    try { await aim(); } catch {}
    bot.setControlState?.('forward', true);
    while (Date.now() < deadline && !cancel?.cancelled) {
      await cancellableSleep(200, cancel);
      bot.setControlState?.('jump', true);
      try { await aim(); } catch {}
      const p = bot.entity?.position;
      if (!p) break;
      if (!inWater(bot) && (bot.entity?.onGround ?? true)) { landed = true; break; }
      if (Math.hypot(p.x - (shore.x + 0.5), p.z - (shore.z + 0.5)) < 0.7 && !isWaterBlock(at(bot, p.x, p.y, p.z))) { landed = true; break; }
    }
    log?.info?.('unstick_swim', { from: start, shore, surfaced, landed });
    return { surfaced, landed, shore, reason: landed ? 'landed' : (surfaced ? 'still_swimming' : 'still_under'), from: start };
  } finally {
    try { bot.setControlState?.('forward', false); bot.setControlState?.('jump', false); } catch {}
  }
}

export function escapeTools(deps) {
  const { bot, movement, log, state } = deps;

  const unstick = {
    name: 'unstick',
    description: 'Get out of a stuck spot. auto: standing on a fence, step off it; in deep water, swim to the nearest shore; if boxed in, dig one safe step sideways (or drop one block); if deep underground with a roof overhead, climb straight up placing blocks until the surface. Also: swim, sidestep, pillar (a short emergency pillar for headroom), surface (climb to target_y, default your home or y 63). Never digs into lava, bedrock, protection, or your own walls (inside your house you are not stuck: goto walks out through the door; force digs your walls anyway). Use after goto fails with noPath or when a tool reports you are wedged.',
    input_schema: {
      type: 'object',
      properties: {
        strategy: { type: 'string', enum: ['auto', 'swim', 'sidestep', 'pillar', 'surface'], default: 'auto' },
        target_y: { type: 'integer', minimum: 1, maximum: 120 },
        force: { type: 'boolean', default: false, description: 'allow digging your own walls (only when the doorway itself is blocked)' },
      },
      additionalProperties: false,
    },
    defaultInterrupts: ['damage'],
    // The drowning reflex fires damage(cause: drowning) at Tier 0; that must
    // not cancel the very tool that swims you out.
    uninterruptible: (kind, data) => kind === 'damage' && data?.cause === 'drowning',
    async handler({ strategy = 'auto', target_y, force = false }, { cancel }) {
      const start = roundPos(bot.entity?.position);
      if (!start) return fail('no_position');
      const goalY = Number.isFinite(target_y) ? target_y : (state?.home?.y ?? state?.spawn?.y ?? SURFACE_DEFAULT_Y);
      const before = { confined: isConfined(bot), underground: isUnderground(bot), depth: Math.max(0, goalY - start.y), in_water: inWater(bot), inside_home: isInsideHome(bot, state?.home), on_fence: onFence(bot) };
      if (before.on_fence && strategy === 'auto') {
        try { movement?.cancel?.(); } catch {}
        const r0 = await stepOffFence(bot, cancel, log);
        const end0 = roundPos(bot.entity?.position);
        const base0 = { strategy: 'off_fence', from: start, to: end0, moved: distance(start, end0), before, ...r0 };
        if (cancel.cancelled) return interrupted(cancel, base0);
        return r0.moved ? ok(base0) : fail(r0.reason ?? 'no_progress', { ...base0, hint: 'you are standing on a fence; dig it (force if it is yours) or teleport' });
      }
      if (before.inside_home && !force && strategy !== 'swim') {
        return ok({ stuck: false, inside_home: true, pos: start, hint: 'you are inside your house, not stuck: goto any outside point (or mine/build/store elsewhere) walks out through the door. Pass force only if the doorway itself is blocked' });
      }
      let used = strategy; let r = null;
      try { movement?.cancel?.(); } catch {}
      if (strategy === 'auto') {
        if (before.in_water) {
          used = 'swim'; r = await swimToShore(bot, movement, cancel, log);
        } else if (before.confined) {
          used = 'sidestep'; r = await sidestep(bot, movement, cancel, log, { allowOwn: !!force });
          if (!cancel.cancelled && isConfined(bot) && r?.reason !== 'own_walls') { used = 'sidestep+pillar'; r = { ...r, pillar: await climb(bot, movement, cancel, log, { goalY: start.y + 4, maxSteps: 6, stopWithHeadroomAfter: 3 }) }; }
        } else if (before.underground && before.depth > DEEP_DEPTH) {
          used = 'surface'; r = await climb(bot, movement, cancel, log, { goalY });
        } else {
          return ok({ stuck: false, pos: start, ...before, hint: 'not boxed in, not deep, not swimming; try goto to a nearer waypoint, a different y, or dig/place your own way' });
        }
      } else if (strategy === 'swim') r = await swimToShore(bot, movement, cancel, log);
      else if (strategy === 'sidestep') r = await sidestep(bot, movement, cancel, log, { allowOwn: !!force });
      else if (strategy === 'pillar') r = await climb(bot, movement, cancel, log, { goalY: start.y + 4, maxSteps: 6, stopWithHeadroomAfter: 3 });
      else r = await climb(bot, movement, cancel, log, { goalY });
      const end = roundPos(bot.entity?.position);
      const after = { confined: isConfined(bot), underground: isUnderground(bot), in_water: inWater(bot) };
      const base = { strategy: used, from: start, to: end, moved: distance(start, end), before, after, ...r };
      if (cancel.cancelled) return interrupted(cancel, base);
      if (used === 'swim') {
        if (r?.landed) return ok(base);
        if (r?.surfaced) return partial(r?.reason ?? 'still_swimming', { ...base, hint: 'head is above water; call unstick swim again, or teleport home/spawn' });
        return fail(r?.reason ?? 'no_progress', { ...base, hint: 'could not reach air; teleport home or spawn now' });
      }
      if (r?.reason === 'own_walls') return fail('own_walls', { ...base, hint: r.hint });
      const progressed = (base.moved ?? 0) >= 1 || (before.confined && !after.confined);
      if (used.startsWith('surface') || used === 'pillar') {
        if (end.y >= goalY - 1 || (used === 'pillar' && (r?.placed ?? 0) > 0)) return ok(base);
        const tp = state?.home ? 'teleport home' : 'teleport spawn (then leave_spawn)';
        return progressed
          ? partial(r?.reason ?? 'partial', { ...base, hint: `call unstick again to keep climbing, or ${tp}; a cave exit by goto may be cheaper than pillaring` })
          : fail(r?.reason ?? 'no_progress', { ...base, hint: `placing blocks here keeps failing; ${tp}, or goto a nearby cave opening` });
      }
      return progressed ? ok(base) : fail(r?.reason ?? 'no_progress', { ...base, hint: 'try unstick with strategy pillar, or teleport' });
    },
  };

  const teleport = {
    name: 'teleport',
    description: 'Use the server teleport commands: home (/home, needs a set home) or spawn (/spawn). Stands still through the warm-up and verifies you arrived. The cheap way back to the surface after deep mining, and the way home from far away. Spawn is inside protection: leave_spawn afterwards.',
    input_schema: {
      type: 'object',
      properties: { to: { type: 'string', enum: ['home', 'spawn'] }, timeout_s: { type: 'integer', minimum: 5, maximum: 30, default: 12 } },
      required: ['to'], additionalProperties: false,
    },
    defaultInterrupts: [],
    // An escape must finish: drowning/lava damage during the warm-up used to
    // cancel it 16 ms in (oatmeal_ollie, 2026-09-04). Only death/shutdown stop it.
    uninterruptible: true,
    async handler({ to, timeout_s = 12 }, { cancel }) {
      const start = roundPos(bot.entity?.position);
      if (!start) return fail('no_position');
      const expected = to === 'home' ? (state?.home?.inside ?? state?.home ?? null) : (state?.spawn ?? null);
      const near = (p, q, r) => !!p && !!q && Math.hypot(p.x - q.x, p.z - q.z) <= r && Math.abs(p.y - q.y) <= 6;
      if (expected && near(start, expected, 6)) return ok({ already_there: true, pos: start });
      try { movement?.cancel?.(); } catch {}
      try { bot.pathfinder?.setGoal?.(null); } catch {}
      try { bot.clearControlStates?.(); } catch {}
      const replies = [];
      const onMsg = (m) => { const s = String(m ?? '').trim(); if (s) replies.push(s.slice(0, 160)); };
      bot.on('messagestr', onMsg);
      try { bot.chat(to === 'home' ? '/home' : '/spawn'); } catch (e) { bot.removeListener('messagestr', onMsg); return fail('chat_failed', { msg: e.message }); }
      const deadline = Date.now() + timeout_s * 1000;
      let arrived = false; let denied = false;
      try {
        while (Date.now() < deadline && !cancel.cancelled) {
          await cancellableSleep(500, cancel);
          try { bot.clearControlStates?.(); } catch {}
          const p = bot.entity?.position;
          denied = replies.some((r) => /do not have access|no permission|have not set|no home|unknown command|cooldown|wait/i.test(r));
          if (expected ? near(p, expected, 8) : distance(start, roundPos(p)) > 24) { arrived = true; break; }
          if (denied) break;
        }
      } finally { bot.removeListener('messagestr', onMsg); }
      const end = roundPos(bot.entity?.position);
      const base = { to, from: start, pos: end, moved: distance(start, end), replies: replies.slice(0, 4) };
      if (cancel.cancelled) return interrupted(cancel, base);
      if (arrived) { log?.info?.('agent_teleport', base); return ok(base); }
      if (denied) return fail('denied', { ...base, hint: to === 'home' ? 'set a home first with command sethome (stand where you want it)' : 'spawn teleport refused; walk instead' });
      return (base.moved ?? 0) > 24 ? ok({ ...base, note: 'moved far; assuming the teleport landed' }) : fail('no_teleport', { ...base, hint: 'no position change; the server may have a warm-up you interrupted, or the command is unavailable' });
    },
  };

  return [unstick, teleport];
}
