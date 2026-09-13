/**
 * placeGuard.js — shared pre-flight checks + verified placement for
 * every code path that calls bot.placeBlock (blueprintBuilder,
 * buildWallLoop, placeBlockAt).
 *
 * Why this exists (TestBot17, 2026-06-06): a 42-minute run logged 80
 * placement failures, every one a generic "blockUpdate did not fire
 * within 5000ms". The proximate causes were all *diagnosable before
 * the call*: the target cell was still occupied by terrain (build
 * anchored below grade into a hillside), or the bot's own body stood
 * in the cell — both of which the server silently ignores, so
 * mineflayer waits out its full 5-second timeout per attempt. The bot
 * burned ~7 minutes of the run waiting on placements that could never
 * land, and no layer above could tell WHY they failed.
 *
 * The guard turns that into:
 *   - cheap pre-classification (occupied cell / entity in cell /
 *     out of reach) that skips the doomed bot.placeBlock call entirely;
 *   - a poll-verified placement that succeeds as soon as the block
 *     appears in the world (a placement whose blockUpdate event is
 *     missed/late no longer counts as a failure — TestBot17's
 *     already_correct count rising across heartbeats showed "failed"
 *     placements that had actually landed);
 *   - a structured failure reason so upper layers can react (re-site
 *     the build, step aside, re-approach) instead of looping.
 */

import vec3Pkg from 'vec3';
import { isInProtectedZone } from '../world/zones.js';

const Vec3 = vec3Pkg.Vec3 ?? vec3Pkg;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Blocks the server replaces in-place on placement — no dig needed.
// (1.8 block names.) Anything with an empty bounding box is also
// treated as replaceable (covers flowers/saplings/snow variants).
export const REPLACEABLE_BLOCKS = new Set([
  'air', 'tallgrass', 'double_plant', 'deadbush', 'snow_layer',
  'red_flower', 'yellow_flower', 'vine', 'fire', 'waterlily',
  'water', 'flowing_water', 'lava', 'flowing_lava',
]);

// How long placeAndVerify waits for the block to appear before
// classifying the attempt as failed. Well under mineflayer's internal
// 5s blockUpdate timeout — a genuine server rejection costs 2.5s
// instead of 5s, and a successful place typically verifies in <300ms.
const PLACE_VERIFY_TIMEOUT_MS = 2_500;
const PLACE_VERIFY_POLL_MS = 150;

// bot.placeBlock reach (server-enforced ~4.5 from eyes; we measure
// feet→cell-center to stay consistent with the builder's checks).
const PLACE_REACH = 4.5;

/**
 * What currently occupies the target cell?
 *   'air' | 'replaceable' | 'occupied' | 'unloaded'
 */
export function classifyCell(bot, target) {
  const block = bot.blockAt?.(new Vec3(target.x, target.y, target.z));
  if (!block) return 'unloaded';
  if (block.name === 'air') return 'air';
  if (REPLACEABLE_BLOCKS.has(block.name) || block.boundingBox === 'empty') {
    return 'replaceable';
  }
  return 'occupied';
}

/**
 * Is a living entity's bounding box intersecting the target cell?
 * The server rejects placements into cells occupied by players or
 * mobs — including the placing bot itself — and the rejection is
 * silent (no blockUpdate ever fires).
 *
 * Returns 'self' | 'other' | null.
 */
export function entityInCell(bot, target) {
  const minX = Math.floor(target.x);
  const minY = Math.floor(target.y);
  const minZ = Math.floor(target.z);
  // Player/mob hitbox: 0.6 wide (±0.3 around position), ~1.8 tall.
  const intersects = (e, halfW = 0.3, height = 1.8) => {
    const p = e?.position;
    if (!p || !Number.isFinite(p.x)) return false;
    return p.x + halfW > minX && p.x - halfW < minX + 1
        && p.y + height > minY && p.y < minY + 1
        && p.z + halfW > minZ && p.z - halfW < minZ + 1;
  };
  if (intersects(bot.entity)) return 'self';
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e || e === bot.entity) continue;
    if (e.type !== 'player' && e.type !== 'mob') continue;
    if (intersects(e)) return 'other';
  }
  return null;
}

export function withinPlaceReach(bot, target) {
  const me = bot.entity?.position;
  if (!me) return false;
  const dx = me.x - (Math.floor(target.x) + 0.5);
  const dy = me.y - (Math.floor(target.y) + 0.5);
  const dz = me.z - (Math.floor(target.z) + 0.5);
  return Math.sqrt(dx * dx + dy * dy + dz * dz) <= PLACE_REACH;
}

/**
 * Why did (or would) a placement at `target` fail? Checked in order
 * of diagnostic specificity. `errMsg` is the placeBlock exception
 * message when one exists (carried through for the log line).
 */
export function classifyPlaceFailure(bot, target, errMsg = null) {
  const occupant = entityInCell(bot, target);
  if (occupant === 'self') return 'self_collision';
  if (occupant === 'other') return 'entity_in_cell';
  if (classifyCell(bot, target) === 'occupied') return 'cell_occupied';
  if (!withinPlaceReach(bot, target)) return 'out_of_reach';
  if (isInProtectedZone({ x: target.x, z: target.z })) return 'protected_zone';
  // Preconditions all look fine but the server never confirmed —
  // claim protection, anti-cheat, or a region the zone model doesn't
  // know about. The caller should treat a streak of these as "this
  // site is unbuildable" rather than retrying per-cell.
  return errMsg ? 'server_rejected' : 'unverified';
}

/**
 * Place a block and verify it landed by polling the world, instead of
 * trusting mineflayer's blockUpdate event (which can be missed under
 * 1.8 multi-block-change packets, turning a SUCCESSFUL placement into
 * a 5-second wait + false failure).
 *
 *   verify() — zero-arg callback returning true once the cell reads
 *              correct. Defaults to "cell is no longer air/replaceable".
 *
 * Returns { ok: true } or { ok: false, reason, error } where reason is
 * one of: self_collision, entity_in_cell, cell_occupied, out_of_reach,
 * protected_zone, server_rejected, unverified.
 */
export async function placeAndVerify(bot, refBlock, faceVec, target, opts = {}) {
  const {
    verify = null,
    timeoutMs = PLACE_VERIFY_TIMEOUT_MS,
    pollMs = PLACE_VERIFY_POLL_MS,
  } = opts;
  const targetVec = new Vec3(target.x, target.y, target.z);
  const isVerified = verify ?? (() => {
    const c = classifyCell(bot, targetVec);
    return c !== 'air' && c !== 'replaceable' && c !== 'unloaded';
  });

  let placeErr = null;
  let placeSettled = false;
  let placePromise;
  try {
    placePromise = bot.placeBlock(refBlock, faceVec);
  } catch (e) {
    // Synchronous throw (bad ref/face) — classify immediately.
    return { ok: false, reason: classifyPlaceFailure(bot, targetVec, e.message), error: e.message };
  }
  // Swallow the eventual rejection so an abandoned 5s mineflayer
  // timeout can't surface as an unhandled rejection after we've
  // already returned.
  placePromise.then(
    () => { placeSettled = true; },
    (e) => { placeErr = e; placeSettled = true; },
  );

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isVerified()) return { ok: true, reason: 'placed' };
    // placeBlock rejected AND the world still doesn't verify — no
    // point waiting out the rest of our window.
    if (placeSettled && placeErr) break;
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }
  if (isVerified()) return { ok: true, reason: 'placed' };
  return {
    ok: false,
    reason: classifyPlaceFailure(bot, targetVec, placeErr?.message ?? 'verify_timeout'),
    error: placeErr?.message ?? null,
  };
}
