/**
 * doorPhysics.js — make open doors and gates passable for mineflayer on 1.8.
 *
 * prismarine-block's collision table for 1.8 gives every door state the
 * same hitbox: a 3/16 panel on the west face of the cell, open or closed.
 * mineflayer's physics (and the pathfinder) read blocks through
 * bot.blockAt, so a bot walking east or west through an OPEN door stops
 * dead at that phantom panel, while one walking north or south squeezes
 * past if centred. Verified with prismarine-physics in test_agent.js:
 * oatmeal_ollie and TestBot44 (east-facing doors) never got in or out;
 * Rook_Vantis (north-facing) did. TestBot44 died at its own doorway three
 * times in one night because of it (2026-09-06).
 *
 * The server DOES reset a player who walks into a door panel, so the
 * client is told the exact panel box for the door's current state (see
 * doorPanel) and the door macro walks down the free lane beside it.
 */

const OPEN_BIT = 0x4;    // 1.8 metadata: doors (lower half) and fence gates
const UPPER_BIT = 0x8;   // 1.8 door metadata: this is the upper half
const DOOR_RE = /(^|_)door$/;
const GATE_RE = /fence_gate$/;

const isDoor = (b) => !!b && DOOR_RE.test(b.name ?? '') && !/trapdoor|iron_door/.test(b.name ?? '');
const isGate = (b) => !!b && GATE_RE.test(b.name ?? '');

/** True when this door/gate block is open (an upper half asks the block below it). */
export function doorIsOpen(block, blockBelow = null) {
  if (!block) return false;
  const meta = block.metadata ?? 0;
  if (isGate(block)) return (meta & OPEN_BIT) !== 0;
  if (!isDoor(block)) return false;
  if (meta & UPPER_BIT) return !!blockBelow && isDoor(blockBelow) && ((blockBelow.metadata ?? 0) & OPEN_BIT) !== 0;
  return (meta & OPEN_BIT) !== 0;
}

const F = 0.1875;   // door thickness

/**
 * Where a door's panel sits in its cell on a 1.8 server, closed or open,
 * from the lower half's facing (bits 0-1) and open bit (0x4) and the upper
 * half's hinge bit (0x1). Returns { x1, z1, x2, z2 } in cell units.
 * Mirrors BlockDoor.setDoorRotation in 1.8. Validated live for facing 0
 * (both hinges) on 2026-09-07.
 */
export function doorPanel(lowerMeta, upperMeta) {
  const j = (lowerMeta ?? 0) & 3;
  const open = ((lowerMeta ?? 0) & OPEN_BIT) !== 0;
  const hingeRight = ((upperMeta ?? 0) & 1) !== 0;
  const box = (x1, z1, x2, z2) => ({ x1, z1, x2, z2 });
  if (j === 0) return open ? (hingeRight ? box(0, 1 - F, 1, 1) : box(0, 0, 1, F)) : box(0, 0, F, 1);
  if (j === 1) return open ? (hingeRight ? box(0, 0, F, 1) : box(1 - F, 0, 1, 1)) : box(0, 0, 1, F);
  if (j === 2) return open ? (hingeRight ? box(0, 0, 1, F) : box(0, 1 - F, 1, 1)) : box(1 - F, 0, 1, 1);
  return open ? (hingeRight ? box(1 - F, 0, 1, 1) : box(0, 0, F, 1)) : box(0, 1 - F, 1, 1);
}

/** Kept for callers that only care about open doors. */
export function openDoorPanel(lowerMeta, upperMeta) {
  return ((lowerMeta ?? 0) & OPEN_BIT) ? doorPanel(lowerMeta, upperMeta) : null;
}

/**
 * For a bot walking along `axis` ('x' or 'z') through the door cell: is
 * the panel across the doorway (blocked), and if not, the sideways offset
 * from the cell centre that runs down the middle of the free lane. A door
 * placed with its hinge sideways to the wall is passable when "closed"
 * and blocked when "open" (Rook's, 2026-09-07), so this reasons about
 * the panel, not the open bit.
 */
export function doorState(lowerMeta, upperMeta, axis) {
  const p = doorPanel(lowerMeta, upperMeta);
  const lenX = p.x2 - p.x1; const lenZ = p.z2 - p.z1;
  const walkLen = axis === 'x' ? lenX : lenZ;      // panel extent along the walk
  const sideLen = axis === 'x' ? lenZ : lenX;      // panel extent across it
  if (walkLen < 0.5 && sideLen > 0.5) return { blocked: true, offset: 0, panel: p };       // a wall across the doorway
  if (sideLen < 0.5) {                                                                        // a rail along one side
    const min = axis === 'x' ? p.z1 : p.x1;
    return { blocked: false, offset: min < 0.5 ? +0.09 : -0.09, panel: p };
  }
  return { blocked: false, offset: 0, panel: p };
}

/** Sideways offset for an open door only (older callers). */
export function doorGapOffset(lowerMeta, upperMeta, axis) {
  if (!((lowerMeta ?? 0) & OPEN_BIT)) return 0;
  const st = doorState(lowerMeta, upperMeta, axis);
  return st.blocked ? 0 : st.offset;
}

/**
 * Wrap bot.blockAt so open doors and gates come back with no collision
 * shape and an empty bounding box. Idempotent. Returns the bot.
 *
 * mineflayer defines bot.blockAt one tick AFTER createBot returns (its
 * plugins inject on 'inject_allowed'), so this defers itself when called
 * too early; the first install ran before that and did nothing (2026-09-07).
 */
export function installDoorPhysics(bot, { log = null } = {}) {
  if (!bot || bot._doorPhysics) return bot;
  if (typeof bot.blockAt !== 'function') {
    if (!bot._doorPhysicsPending && typeof bot.once === 'function') {
      bot._doorPhysicsPending = true;
      const retry = () => setImmediate(() => { bot._doorPhysicsPending = false; installDoorPhysics(bot, { log }); });
      bot.once('inject_allowed', retry);
      bot.once('login', retry);
    }
    return bot;
  }
  const orig = bot.blockAt.bind(bot);
  bot.blockAt = function blockAtWithOpenDoors(pos, extraInfos) {
    const b = orig(pos, extraInfos);
    if (!b || !(isDoor(b) || isGate(b))) return b;
    if (isGate(b)) {
      if (doorIsOpen(b)) { b.shapes = []; b.boundingBox = 'empty'; }
      return b;
    }
    // Doors: give the client the exact panel the server uses, in either
    // state, so physics never disagrees with the server about a doorway.
    // The bounding box stays 'block' so the pathfinder routes to the door
    // and the door macro does the walking.
    const meta = b.metadata ?? 0;
    let lower = b; let upper = null;
    try {
      if (meta & UPPER_BIT) { lower = orig(pos.offset ? pos.offset(0, -1, 0) : { x: pos.x, y: pos.y - 1, z: pos.z }, false); upper = b; }
      else upper = orig(pos.offset ? pos.offset(0, 1, 0) : { x: pos.x, y: pos.y + 1, z: pos.z }, false);
    } catch { /* partial info is fine */ }
    if (lower && isDoor(lower)) {
      const p = doorPanel(lower.metadata ?? 0, upper && isDoor(upper) ? (upper.metadata ?? 0) : 0);
      b.shapes = [[p.x1, 0, p.z1, p.x2, 1, p.z2]];
    }
    return b;
  };
  bot._doorPhysics = true;
  log?.info?.('door_physics_installed');
  return bot;
}
