/**
 * door.js — walking through the bot's own front door.
 *
 * mineflayer-pathfinder 2.4.5 cannot pass a two-block door. Its door
 * support (`openable`) only covers the feet cell, which is right for a
 * fence gate; the upper half of a door is a solid, unbreakable block to
 * it, so a finished house is a sealed box. Rook_Vantis (2026-09-04) got
 * noPath from inside and dug through his own wall with unstick.
 *
 * This wraps Movement.goTo: a target outside while standing inside walks
 * out through the door first; a target inside while standing outside
 * walks to the cell in front of the door, opens it, steps in. The door is
 * closed behind the bot. Every tool that moves gets it for free.
 */

import vec3Pkg from 'vec3';
import { CancelToken, awaitHandle, cancellableSleep } from '../cancel.js';
import { doorState } from '../../core/doorPhysics.js';

const Vec3 = vec3Pkg.Vec3 ?? vec3Pkg;

const DOOR_OPEN_BIT = 0x4;   // 1.8 lower-half metadata: bit 2 = open
const APPROACH_MS = 20_000;
const WALK_MS = 4_000;

/** Door geometry from a saved home: the door cell, the cell inside it, the cell outside it. */
export function doorInfo(home) {
  if (!home?.door || !home?.inside) return null;
  const { door, inside } = home;
  const dx = door.x - inside.x; const dz = door.z - inside.z;
  if (Math.abs(dx) + Math.abs(dz) !== 1 || door.y !== inside.y) return null;
  return {
    door: { x: door.x, y: door.y, z: door.z },
    inside: { x: inside.x, y: inside.y, z: inside.z },
    outside: { x: door.x + dx, y: door.y, z: door.z + dz },
    dir: { dx, dz },
  };
}

function interiorBox(home) {
  if (home?.interior?.min && home?.interior?.max) return home.interior;
  if (!home?.inside) return null;
  return { min: { x: home.inside.x, z: home.inside.z }, max: { x: home.inside.x, z: home.inside.z }, y: home.inside.y };
}

/** True when `pos` is on the house's interior floor (feet level ±1). */
export function cellInsideHome(pos, home) {
  const box = interiorBox(home);
  if (!box || !pos || !Number.isFinite(pos.x)) return false;
  const x = Math.floor(pos.x); const z = Math.floor(pos.z); const y = Math.floor(pos.y);
  return x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z && y >= box.y - 1 && y <= box.y + 1;
}

export function isInsideHome(bot, home) { return cellInsideHome(bot?.entity?.position, home); }

const sameCell = (p, c) => !!p && !!c && Math.floor(p.x) === c.x && Math.floor(p.z) === c.z && Math.abs(p.y - c.y) < 1.5;
const sameColumn = (p, c) => !!p && !!c && Math.floor(p.x) === c.x && Math.floor(p.z) === c.z;
const isDoor = (b) => !!b && /door/.test(b.name ?? '') && !/trapdoor/.test(b.name ?? '');
const isFluid = (b) => !!b && /^(flowing_)?(water|lava)$/.test(b.name ?? '');
const isSolid = (b) => !!b && b.name !== 'air' && b.boundingBox === 'block' && !isFluid(b);
const passable = (b) => !b || b.name === 'air' || (b.boundingBox === 'empty' && !isFluid(b)) || isDoor(b);
const STEP_ITEMS = ['dirt', 'cobblestone', 'gravel', 'sand', 'stone', 'planks', 'netherrack', 'andesite', 'diorite', 'granite', 'sandstone'];

export function doorOpen(b) {
  if (!b) return false;
  try {
    const props = typeof b.getProperties === 'function' ? b.getProperties() : null;
    if (props && typeof props.open === 'boolean') return props.open;
    if (props && (props.open === 'true' || props.open === 'false')) return props.open === 'true';
  } catch {}
  return ((b.metadata ?? 0) & DOOR_OPEN_BIT) !== 0;
}

function blockAt(bot, x, y, z) { try { return bot.blockAt(new Vec3(x, y, z)); } catch { return null; } }

/**
 * Feet level a bot can stand at in column (x,z) near `aroundY`: solid
 * block below, two passable cells above. Rook's door sits two blocks above
 * the beach in front of it (2026-09-05), so the cell "in front of the door"
 * is air with nothing to stand on.
 */
export function standableY(bot, x, z, aroundY, { up = 1, down = 3 } = {}) {
  for (let y = aroundY + up; y >= aroundY - down; y--) {
    const below = blockAt(bot, x, y - 1, z);
    if (!isSolid(below)) continue;
    if (passable(blockAt(bot, x, y, z)) && passable(blockAt(bot, x, y + 1, z))) return y;
  }
  return null;
}

function pickStepItem(bot) {
  const items = bot.inventory?.items?.() ?? [];
  for (const name of STEP_ITEMS) { const it = items.find((i) => i?.name === name); if (it) return it; }
  return null;
}

/** Walk in a straight line to `to` using the controls; nudges sideways when a door panel blocks the centre line. */
async function walkStraight(bot, to, cancel, maxMs, tolerance = 0.45, { nudge = null, first = 0 } = {}) {
  const cx = to.x + 0.5; const cz = to.z + 0.5;
  const start = bot.entity?.position;
  const startY = start ? Math.floor(start.y) : to.y;
  // Through a doorway the free gap beside the open panel is 13/16 wide, so
  // the line must be within ~0.1 of the gap's centre: try the geometry's
  // guess first, then the other side, then dead centre. The server, not the
  // client, is the judge (it resets a player who walks into the panel), so a
  // wrong guess just stalls for a second and the next offset is tried.
  const mags = first ? [first, -first, 0] : [0, 0.09, -0.09];
  const offsets = nudge ? mags.map((m) => ({ dx: nudge.dx * m, dz: nudge.dz * m })) : [{ dx: 0, dz: 0 }];
  const deadline = Date.now() + maxMs;
  let ok = false;
  try {
    for (const off of offsets) {
      if (ok || cancel?.cancelled || Date.now() >= deadline) break;
      const ax = cx + off.dx; const az = cz + off.dz;
      const aim = () => bot.lookAt?.(new Vec3(ax, to.y + 1.6, az), true);
      try { await aim(); } catch {}
      try { bot.setControlState?.('sprint', false); bot.setControlState?.('forward', true); } catch {}
      if (to.y > startY) { try { bot.setControlState?.('jump', true); } catch {} }
      const legEnd = Math.min(deadline, Date.now() + Math.max(900, maxMs / offsets.length));
      let last = null; let stalled = 0;
      while (Date.now() < legEnd && !cancel?.cancelled) {
        await cancellableSleep(100, cancel);
        const p = bot.entity?.position;
        if (!p) break;
        const d = Math.hypot(p.x - cx, p.z - cz);
        if (d <= tolerance) { ok = true; break; }
        if (to.y > startY && Math.floor(p.y) >= to.y) { try { bot.setControlState?.('jump', false); } catch {} }
        stalled = last != null && Math.abs(last - d) < 0.02 ? stalled + 1 : 0;
        last = d;
        if (stalled >= 4) break;   // not moving: try the next offset
        try { await aim(); } catch {}
      }
      try { bot.setControlState?.('jump', false); } catch {}
    }
  } finally {
    try { bot.setControlState?.('forward', false); bot.setControlState?.('jump', false); } catch {}
  }
  return ok;
}

/** Build a one- or two-block step so the cell in front of the door is level with its floor. */
async function ensureDoorStep(bot, movement, info, feetY, cancel, log) {
  const placed = [];
  // Tests inject a placer through the movement; live code uses the primitive.
  const placeBlockAt = movement?._placeBlockAt ?? (await import('../../world/primitives.js')).placeBlockAt;
  for (let y = feetY; y < info.door.y; y++) {
    const cell = blockAt(bot, info.outside.x, y, info.outside.z);
    if (isSolid(cell)) continue;
    const item = pickStepItem(bot);
    if (!item) return { ok: false, reason: 'no_step_block', placed };
    // Never place where we stand: step back one cell first.
    const p = bot.entity?.position;
    if (p && sameColumn(p, info.outside)) {
      const back = { x: info.outside.x + info.dir.dx, y: Math.floor(p.y), z: info.outside.z + info.dir.dz };
      const by = standableY(bot, back.x, back.z, back.y, { up: 1, down: 3 });
      if (by != null) await awaitHandle(movement._rawGoTo({ x: back.x, y: by, z: back.z }, { timeoutMs: 8000, range: 0 }), cancel);
    }
    if (cancel?.cancelled) return { ok: false, reason: 'cancelled', placed };
    let r = null;
    try { r = await awaitHandle(placeBlockAt(bot, { position: { x: info.outside.x, y, z: info.outside.z }, blockName: item.name }, { movement, log }), cancel); }
    catch (e) { r = { success: false, reason: e.message }; }
    if (!r?.success && !isSolid(blockAt(bot, info.outside.x, y, info.outside.z))) return { ok: false, reason: 'step_place_failed:' + (r?.reason ?? 'unknown'), placed };
    placed.push({ x: info.outside.x, y, z: info.outside.z, block: item.name });
    try { movement?.notePlacement?.({ x: info.outside.x, y, z: info.outside.z }); } catch {}
  }
  return { ok: true, placed };
}

/**
 * Pass through the home door. direction 'out': inside → outside;
 * 'in': outside → inside. Returns { ok, reason?, opened, closed, step? }.
 */
export async function passDoor(bot, movement, home, direction, cancel, log) {
  const info = doorInfo(home);
  if (!info) return { ok: false, reason: 'no_door_info' };
  const rawGoTo = movement?._rawGoTo ?? movement?.goTo?.bind(movement);
  if (!rawGoTo) return { ok: false, reason: 'no_movement' };
  const doorBlock = () => blockAt(bot, info.door.x, info.door.y, info.door.z);
  if (!isDoor(doorBlock())) return { ok: false, reason: 'door_missing', at: info.door };
  // The cell behind the door must be free (a furnace dropped there seals the house).
  if (!passable(blockAt(bot, info.inside.x, info.inside.y, info.inside.z)) || !passable(blockAt(bot, info.inside.x, info.inside.y + 1, info.inside.z))) {
    return { ok: false, reason: 'inside_blocked', at: info.inside, hint: 'the cell behind your door holds a block: dig it (force) so you can pass' };
  }
  const nudge = { dx: info.dir.dz, dz: info.dir.dx };   // perpendicular to the walk axis
  let step = null;
  let from; let to;
  if (direction === 'out') {
    from = info.inside; to = info.outside;
  } else {
    // Where can we actually stand in front of the door?
    let feetY = standableY(bot, info.outside.x, info.outside.z, info.door.y, { up: 1, down: 3 });
    if (feetY == null) return { ok: false, reason: 'outside_unreachable', at: info.outside, hint: 'nothing to stand on in front of your door (water or a hole): teleport home, or place blocks there' };
    if (info.door.y - feetY >= 2) {
      // Two or more blocks below the floor: build a step (Rook: beach at y 62, door at y 64).
      const st = await ensureDoorStep(bot, movement, info, feetY, cancel, log);
      step = st;
      if (!st.ok) return { ok: false, reason: st.reason, step: st, hint: 'the doorway is too high to walk into: place dirt or cobblestone in front of the door (place), or teleport home' };
      feetY = info.door.y;
    }
    from = { x: info.outside.x, y: feetY, z: info.outside.z }; to = info.inside;
  }

  // 1. Stand on the cell next to the door, then centre on it so the
  //    straight walk clears the one-wide doorway.
  if (!sameCell(bot.entity?.position, from)) {
    const r = await awaitHandle(rawGoTo(from, { timeoutMs: APPROACH_MS, range: 0 }), cancel);
    if (cancel?.cancelled) return { ok: false, reason: 'cancelled' };
    if (!sameCell(bot.entity?.position, from)) return { ok: false, reason: 'approach_failed', detail: r?.reason ?? null, from };
  }
  await walkStraight(bot, from, cancel, 1500, 0.12);
  if (cancel?.cancelled) return { ok: false, reason: 'cancelled' };

  // 2. Read where the panel is. A right-click toggles it; we want the state
  //    whose panel is a rail along the doorway, not across it. (A door hung
  //    sideways to its wall is passable when "closed": Rook's.)
  const axis = info.dir.dx !== 0 ? 'x' : 'z';
  const readState = () => { const lower = doorBlock(); const upper = blockAt(bot, info.door.x, info.door.y + 1, info.door.z); return { ...doorState(lower?.metadata ?? 0, upper?.metadata ?? 0, axis), lower: lower?.metadata ?? null, upper: upper?.metadata ?? null }; };
  const toggle = async () => { try { await bot.activateBlock(doorBlock()); } catch (e) { log?.debug?.('door_activate_failed', { msg: e.message }); return false; } await cancellableSleep(300, cancel); return true; };
  let st = readState();
  let toggles = 0;
  if (st.blocked) { if (await toggle()) toggles += 1; st = readState(); }
  log?.info?.('agent_door_geometry', { lower: st.lower, upper: st.upper, axis, blocked: st.blocked, offset: st.offset, toggles });
  if (st.blocked) return { ok: false, reason: 'door_stuck', at: info.door, toggles };

  // 3. Down the free lane through the doorway, then onto `to`. If the walk
  //    stalls anyway, the geometry guess was wrong for this door: toggle
  //    once and try the other way round.
  const doorCell = { x: info.door.x, y: info.door.y, z: info.door.z };
  const tryWalk = async (first) => {
    let ok = await walkStraight(bot, doorCell, cancel, WALK_MS, 0.4, { nudge, first });
    if (ok && !cancel?.cancelled) ok = await walkStraight(bot, to, cancel, WALK_MS, 0.45, { nudge, first });
    return ok;
  };
  let arrived = await tryWalk(st.offset);
  if (!arrived && !cancel?.cancelled && !sameCell(bot.entity?.position, info.door)) {
    if (await toggle()) { toggles += 1; const st2 = readState(); log?.info?.('agent_door_retry', { lower: st2.lower, upper: st2.upper, blocked: st2.blocked, offset: st2.offset }); arrived = await tryWalk(st2.offset); }
  }
  if (cancel?.cancelled) return { ok: false, reason: 'cancelled', toggles };
  if (!arrived) {
    const p = bot.entity?.position;
    // Never leave the doorway open on a failed pass: TestBot44 died in its
    // own doorway that way. "Open" here means passable, whatever the bit says.
    if (p && !sameCell(p, info.door) && !readState().blocked) { if (await toggle()) toggles += 1; }
    return { ok: false, reason: 'walk_failed', pos: p ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null, toggles, closed: readState().blocked, step };
  }

  // 4. Put the panel back across the doorway: mobs wander in otherwise.
  if (!readState().blocked) { if (await toggle()) toggles += 1; }
  return { ok: true, direction, toggles, opened: toggles > 0, closed: readState().blocked, step };
}

/**
 * Make `movement.goTo` door-aware. Idempotent. The original is kept as
 * `movement._rawGoTo` for the door macro and for callers that must not
 * recurse. The returned handle keeps the { stop, done } contract.
 */
export function wrapMovementWithDoor(movement, { bot, state, log } = {}) {
  if (!movement || typeof movement.goTo !== 'function' || movement._rawGoTo) return movement;
  const raw = movement.goTo.bind(movement);
  movement._rawGoTo = raw;
  movement.goTo = (pos, opts = {}) => {
    const home = state?.home;
    const info = doorInfo(home);
    if (!info || !pos) return raw(pos, opts);
    const insideNow = isInsideHome(bot, home);
    const targetInside = cellInsideHome(pos, home);
    if (insideNow === targetInside) return raw(pos, opts);

    let inner = null; let stopped = false;
    const cancel = new CancelToken();
    const stop = () => { stopped = true; cancel.cancel('cancelled'); try { inner?.stop?.(); } catch {} };
    const done = (async () => {
      const dir = insideNow ? 'out' : 'in';
      if (dir === 'in' && !sameColumn(bot.entity?.position, info.outside)) {
        // Walk to wherever one can stand in front of the door (it may be a
        // block or two below the floor); passDoor builds the step from there.
        const feetY = standableY(bot, info.outside.x, info.outside.z, info.door.y, { up: 1, down: 3 });
        const approach = { x: info.outside.x, y: feetY ?? info.outside.y, z: info.outside.z };
        inner = raw(approach, { timeoutMs: opts.timeoutMs ?? 30_000, range: feetY == null ? 2 : 0 });
        const r = await inner.done; inner = null;
        if (stopped) return { reached: false, reason: 'cancelled' };
        const p = bot.entity?.position;
        if (!p || Math.hypot(p.x - (approach.x + 0.5), p.z - (approach.z + 0.5)) > 2.5) {
          log?.info?.('agent_door_pass', { dir, ok: false, reason: 'approach_failed', detail: r?.reason ?? null });
          return { reached: false, reason: r?.reason ?? 'noPath', door: 'approach_failed' };
        }
      }
      const d = await passDoor(bot, movement, home, dir, cancel, log);
      log?.info?.('agent_door_pass', { dir, ...d });
      if (stopped) return { reached: false, reason: 'cancelled' };
      if (!d.ok) {
        // Last resort: the plain pathfinder (it will answer noPath fast if the door is the only way).
        inner = raw(pos, opts);
        const r = await inner.done;
        return { ...r, door: d.reason };
      }
      const p = bot.entity?.position;
      const range = Math.max(opts.range ?? 0, 0);
      const left = p ? Math.hypot(p.x - (pos.x + 0.5), p.z - (pos.z + 0.5)) : Infinity;
      if (sameCell(p, pos) || (range > 0 && left <= range + 0.5)) return { reached: true, door: dir };
      inner = raw(pos, opts);
      const r2 = await inner.done;
      return { ...r2, door: dir };
    })();
    return { stop, done };
  };
  return movement;
}
