/**
 * blueprintBuilder.js — Block-by-block builder for blueprints.
 *
 * Returns a `{ stop, done }` handle (the same convention as the
 * primitives in world/primitives.js) that the agent's build tool awaits.
 *
 * The builder:
 *   1. Computes the full block list (layers + interior) with rotation
 *      applied around the blueprint's center.
 *   2. Sorts by build_order so the bot doesn't wall itself in.
 *   3. Skips blocks already placed (resume support — partial builds
 *      survive disconnects).
 *   4. For each remaining block:
 *      - Pick an item to place from inventory (matching name or sub).
 *      - Find a standing position adjacent to the target.
 *      - Pathfind via movement.goTo().
 *      - Equip + bot.placeBlock(reference, faceVec).
 *      - Sleep 200-400ms (human cadence; also avoids server anti-spam).
 *   5. Interior pass last so chests/tables/torches go in AFTER the
 *      shell, when the bot can walk in via the door.
 *   6. Persists progress every N blocks via memory KV so a re-init
 *      resumes from the last placed index.
 */

import vec3Pkg from 'vec3';
import { placementMethod, isOptionalBlock } from './placement.js';
import {
  classifyCell,
  entityInCell,
  placeAndVerify,
} from './placeGuard.js';
const Vec3 = vec3Pkg.Vec3 ?? vec3Pkg;

const DEFAULT_BUILD_MAX_MS = 10 * 60_000;       // 10-minute safety on a full build
const PLACE_DELAY_MIN_MS = 120;
const PLACE_DELAY_MAX_MS = 220;
const PATHFIND_TIMEOUT_MS = 10_000;
// Non-solid placeables (boundingBox 'empty'): the default placeAndVerify
// verify checks classifyCell !== 'replaceable', which a torch ALWAYS fails
// even after it lands — so every torch was a permanent placeFailure and any
// blueprint with torches (builder_base_t1: 3) capped at ~98% forever and got
// abandoned. These are verified by block NAME instead (see _placeAgainstRef).
const NON_SOLID_PLACEABLES = new Set([
  'torch', 'redstone_torch', 'unlit_redstone_torch', 'wall_torch', 'redstone_wire',
  'lever', 'stone_button', 'wooden_button', 'tripwire_hook',
  'rail', 'golden_rail', 'detector_rail', 'activator_rail',
  'sapling', 'flower_pot', 'ladder',
]);
// One water source hydrates farmland in a 9×9 (4-block radius), so a
// handful covers any plot. Capping water placements keeps the build from
// needing one bucket-fill round-trip per water cell (20+ on a big farm).
const WATER_SOURCE_CAP = 4;
const DIG_TIMEOUT_MS = 5_000;
const PROGRESS_SAVE_EVERY = 5;
// How often to emit a structured blueprint_progress log line on
// successful placements. Lower = more chatter for healthy builds;
// higher = quieter logs but less visibility into pace. 5 strikes a
// reasonable balance for typical 50-200 block structures.
const BUILD_PROGRESS_EVERY = 5;
// How often to emit a heartbeat log even when nothing's progressing.
// Independent of BUILD_PROGRESS_EVERY — fires on a wallclock cadence
// so a build that's failing every cell (e.g. all `no_standing`) still
// surfaces what's happening within ~15 s instead of going dark for
// minutes.
const BUILD_HEARTBEAT_INTERVAL_MS = 15_000;

const KV_BUILD_PROGRESS = 'build_progress';
const KV_BUILT_BLUEPRINTS = 'built_blueprints';

// Failure reasons that indicate the SITE is unbuildable (server
// refusing placements, cell that won't clear, unmapped protection)
// rather than a transient per-cell problem. A streak of these means
// every further cell will fail the same way — abort the build and
// surface `site_rejected` so the build tool re-sites instead of
// grinding the whole placement list at 2.5s per doomed cell.
const HARD_SITE_REASONS = new Set([
  'server_rejected', 'protected_zone', 'cell_occupied',
  // A site the bot cannot path to fails every cell the same way; 8 in a
  // row means the whole anchor is unreachable, not one awkward cell
  // (Rook_Vantis 2026-09-04: 21 straight pathfind_failed, 0 placed).
  'pathfind_failed',
]);
const SITE_REJECT_AFTER = 8;

// Each entry's `face` is the vector mineflayer's bot.placeBlock(ref, face)
// expects: the direction from the reference block toward the new block.
// The reference itself sits at `target - face` — the inverse direction.
// (An earlier version carried a redundant `dir` field whose sign was
// inverted, so _findReference picked a reference on the wrong side and
// every placeBlock call landed two cells off-target. That broke every
// underground build because the wrong cell was a solid stone neighbor
// the server refused to overwrite.)
// Right-clicking these blocks opens/activates them instead of placing
// against them — placement must either pick another face or sneak.
const INTERACTIVE_REF = /door|chest|crafting_table|furnace|anvil|enchanting_table|bed|button|lever|fence_gate|hopper|dispenser|dropper|brewing_stand/;

const FACE_DIRS = [
  { face: new Vec3(0, 1, 0) },     // ref below target, place on top of ref
  { face: new Vec3(-1, 0, 0) },    // ref east of target, place on west face
  { face: new Vec3(1, 0, 0) },     // ref west of target, place on east face
  { face: new Vec3(0, 0, -1) },    // ref south of target, place on north face
  { face: new Vec3(0, 0, 1) },     // ref north of target, place on south face
  { face: new Vec3(0, -1, 0) },    // ref above target, place on bottom of ref
];

// Cheap, non-gravity blocks used as temporary placement scaffolds (see
// _tryScaffold). Order = preference. Deliberately excludes sand/gravel
// (they fall) — a scaffold is placed, built against, then removed, and the
// dug block returns to inventory so this is roughly inventory-neutral.
const SCAFFOLD_MATERIALS = ['cobblestone', 'dirt', 'netherrack', 'stone', 'cobbled_deepslate'];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitter(min, max) { return Math.floor(min + Math.random() * (max - min)); }

export class BlueprintBuilder {
  constructor({ bot, movement, log = null, profile = null, memory = null, worldModel = null } = {}) {
    if (!bot) throw new Error('BlueprintBuilder requires bot');
    if (!movement) throw new Error('BlueprintBuilder requires movement');
    this.bot = bot;
    this.movement = movement;
    this.log = log;
    this.profile = profile;
    this.memory = memory;
    // Optional worldModel: when present, BlueprintBuilder records the
    // structure in the same SQLite-backed table the JS blueprint
    // system uses. Without this hook, JSON-builder builds never show
    // up in `getStateForPlanner().builtStructures`, so `has_base`
    // stays false and ESTABLISH_BASE keeps re-firing.
    this.worldModel = worldModel;
    this._structureId = null;
  }

  /**
   * Start a build. Returns { stop, done } — same shape as activities.
   * `done` resolves with { placed, skipped, missing, total, reason }.
   */
  build(blueprint, anchor, rotation = 0) {
    let cancelled = false;
    let settled = false;
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const stop = () => { cancelled = true; };
    const safety = setTimeout(() => {
      if (settled) return;
      cancelled = true;
      this._finishBuild({ resolveDone, settled: () => settled = true,
        result: { placed: 0, skipped: 0, missing: {}, total: 0, reason: 'max_duration' } });
    }, DEFAULT_BUILD_MAX_MS);
    if (safety.unref) safety.unref();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(safety);
      resolveDone(result);
    };

    this._run({ blueprint, anchor, rotation, isCancelled: () => cancelled, finish })
      .catch((e) => {
        this.log?.warn?.('blueprint_run_threw', { id: blueprint?.id, msg: e.message });
        finish({ placed: 0, skipped: 0, missing: {}, total: 0, reason: 'error' });
      });

    return { stop, done };
  }

  async _run({ blueprint, anchor, rotation, isCancelled, finish }) {
    this._waterPlaced = 0; // bounded per build — see WATER_SOURCE_CAP
    const placements = this._buildPlacementList(blueprint, anchor, rotation);
    const total = placements.length;
    // Footprint = every SOLID cell the structure will occupy. The bot must
    // build from OUTSIDE this — standing in a to-be-solid cell means it's
    // placing where its own body is, so the server never confirms the
    // placement and bot.placeBlock hangs 5s per cell (TestBot17 stood
    // inside a 3×3×3 dirt_shelter "trying to place dirt but failing").
    this._footprint = new Set();
    for (const p of placements) {
      if (p.blockName !== null) this._footprint.add(`${p.world.x},${p.world.y},${p.world.z}`);
    }
    // If the bot is standing inside the footprint, step out BEFORE the
    // loop — while the cells are still air and it can freely walk out.
    await this._stepOutOfFootprint(isCancelled);
    // Surface builds: clear terrain/vegetation out of the build volume
    // BEFORE placing, so the placement loop runs against air cells.
    // Underground builds skip this — their sort order already
    // excavates the interior first.
    if (blueprint.placement !== 'underground') {
      await this._prepSite(placements, blueprint, isCancelled);
    }
    const startIndex = this._loadResumeIndex(blueprint, anchor);
    // Stamp the original (sorted) index on each placement so progress
    // tracking still corresponds to a "no holes before this index"
    // resume guarantee even after batching reorders iteration.
    for (let i = 0; i < placements.length; i++) {
      placements[i]._originalIndex = i;
    }

    let placed = 0;
    let skipped = 0;
    const missing = {};
    // Tracks the item name in the bot's hand so consecutive placements
    // of the same material can skip bot.equip(). Updated from each
    // _placeOne result. Reset when an attempt fails ambiguously
    // (e.g. equip threw).
    let lastEquippedName = null;

    // Register the structure in worldModel so getStateForPlanner sees
    // it. BlueprintBuilder writes the same SQLite table the JS
    // blueprint primitive does — once we pass `worldModel`, the JSON
    // and JS systems converge on a single source of truth.
    if (this.worldModel?.startStructure && !this._structureId) {
      try {
        this._structureId = this.worldModel.startStructure({
          blueprintId: blueprint.id,
          anchor,
          structureType: blueprint.category ?? 'base',
          blocksTotal: total,
        });
      } catch (e) {
        this.log?.debug?.('worldmodel_start_failed', { msg: e.message });
      }
    }

    this.log?.info?.('blueprint_build_start', {
      id: blueprint.id, total, startIndex, anchor, rotation,
      structureId: this._structureId,
    });

    // Bucket the skipped count so we can tell "build is genuinely
    // complete (everything was already correct)" apart from "bot was
    // nowhere near the anchor and every placement attempt failed".
    // The latter shouldn't mark the structure complete — that
    // poisons project progress + the LLM's "almost done" reasoning.
    let alreadyCorrect = 0;
    let placeAttempts = 0;
    let placeFailures = 0;
    // Consecutive hard (site-level) failures — see HARD_SITE_REASONS.
    let hardFailStreak = 0;
    // Histogram of why cells didn't get placed (no_standing,
    // no_reference, pathfind_failed, place_failed, equip_failed,
    // …). Surfaced in heartbeat logs so the operator can tell a slow
    // build (steady progress) apart from a stuck build (every cell
    // failing for the same reason).
    const skipReasons = {};
    let lastSkipReason = null;
    let lastHeartbeatAt = Date.now();
    const emitHeartbeat = (label = 'blueprint_heartbeat') => {
      this.log?.info?.(label, {
        id: blueprint.id,
        structureId: this._structureId,
        placed, attempts: placeAttempts, failures: placeFailures,
        skipped, missing_keys: Object.keys(missing).length,
        already_correct: alreadyCorrect,
        total,
        pct: total > 0 ? Math.round((placed / total) * 100) : 0,
        last_skip: lastSkipReason,
        skip_reasons: skipReasons,
      });
      lastHeartbeatAt = Date.now();
    };
    // Batch placements by reachable standing position. From a single
    // standing pose, bot.placeBlock can reach every cell within ~4.5
    // blocks — so a 1-pathfind-per-block loop wastes 60-80% of pathfinder
    // calls when adjacent cells share a standing pocket. The greedy
    // bin-packing in _groupByStandingPosition assigns each cell to the
    // standing pose that already has the most assigned blocks.
    const remaining = placements.slice(startIndex);
    const batches = this._groupByStandingPosition(remaining);
    this.log?.info?.('blueprint_batched', {
      id: blueprint.id,
      remaining: remaining.length,
      batches: batches.length,
      avg_batch: batches.length > 0
        ? Math.round((remaining.length / batches.length) * 10) / 10
        : 0,
    });

    // Resume index = lowest originalIndex with no holes before it.
    // Tracks contiguously-processed prefix so a crash/cancellation
    // saves a position past which everything is guaranteed handled.
    const processed = new Set();
    let lowestUnprocessed = startIndex;
    const advanceProcessed = () => {
      while (processed.has(lowestUnprocessed)) {
        processed.delete(lowestUnprocessed);
        lowestUnprocessed++;
      }
    };
    let processCount = 0;

    for (const batch of batches) {
      if (Date.now() - lastHeartbeatAt > BUILD_HEARTBEAT_INTERVAL_MS) {
        emitHeartbeat();
      }
      if (isCancelled()) {
        this._saveProgress(blueprint, anchor, rotation, lowestUnprocessed, total);
        return finish({ placed, skipped, missing, total, reason: 'cancelled' });
      }

      // Pre-check: skip the batch pathfind if every cell is already
      // correct. Saves a 10-second walk for batches that the resume
      // path or a prior run already finished.
      let batchHasWork = false;
      for (const p of batch.blocks) {
        if (!this._isAlreadyCorrect(p, blueprint)) { batchHasWork = true; break; }
      }

      if (batch.standing && batchHasWork) {
        try {
          const handle = this.movement.goTo(batch.standing,
            { timeoutMs: PATHFIND_TIMEOUT_MS, range: 1 });
          await handle.done.catch(() => {});
        } catch (e) {
          this.log?.debug?.('blueprint_batch_pathfind_threw', { msg: e.message });
        }
      }

      for (const p of batch.blocks) {
        if (Date.now() - lastHeartbeatAt > BUILD_HEARTBEAT_INTERVAL_MS) {
          emitHeartbeat();
        }
        if (isCancelled()) {
          this._saveProgress(blueprint, anchor, rotation, lowestUnprocessed, total);
          return finish({ placed, skipped, missing, total, reason: 'cancelled' });
        }

        // Skip if already correct (resume / re-build). Pass the
        // blueprint so substitutions are honored.
        if (this._isAlreadyCorrect(p, blueprint)) {
          skipped++;
          alreadyCorrect++;
        } else if (p.blockName === null) {
          // Air token — dig out any non-air block. _maybeDigAir owns
          // its own pathfind/dig flow and may swap a tool into hand,
          // so invalidate the placement-item dedup.
          await this._maybeDigAir(p, isCancelled);
          lastEquippedName = null;
        } else {
          let item = this._pickItem(p.blockName, blueprint);
          const method = placementMethod(p.blockName);
          // Water cells place from a bucket the builder fills, not from a
          // "water" item — resolve to a water_bucket / empty bucket. Stop
          // once we've placed enough sources to hydrate the plot.
          if (method === 'water') {
            item = this._waterPlaced < WATER_SOURCE_CAP ? this._findBucket() : null;
          }
          // A till cell can proceed with NO dirt item as long as the
          // ground is already dirt/grass (we hoe it in place). Only count
          // it as missing-material when there's neither dirt to lay nor
          // tillable ground.
          const tillInPlace = method === 'till' && !item && this._isTillableGround(p.world);
          if (!item && !tillInPlace) {
            // Optional cells (water/seeds) never block completion — they're
            // a best-effort layer. Required cells with no material surface
            // as missing so the gather re-runs.
            if (!isOptionalBlock(p.blockName)) {
              missing[p.blockName] = (missing[p.blockName] ?? 0) + 1;
            }
            skipped++;
          } else {
            placeAttempts++;
            // Fast path: reuse the batch standing pose. If the bot
            // drifted out of placeBlock reach during the batch,
            // fall back to the original per-block pathfind.
            let result;
            if (batch.standing) {
              result = await this._placeOne(p, item, isCancelled,
                { skipPathfind: true, lastEquipped: lastEquippedName });
              if (!result.ok && result.reason !== 'cancelled') {
                result = await this._placeOne(p, item, isCancelled,
                  { lastEquipped: result.equippedName ?? lastEquippedName });
              }
            } else {
              result = await this._placeOne(p, item, isCancelled,
                { lastEquipped: lastEquippedName });
            }
            // _placeOne returns the held item name (or null when the
            // hand contents are ambiguous after a failed equip). Pass
            // through verbatim so the dedup stays in sync.
            lastEquippedName = result.equippedName ?? null;
            if (result.ok) {
              placed++;
              hardFailStreak = 0;
              if (this._structureId && this.worldModel?.markBlockPlaced) {
                try {
                  this.worldModel.markBlockPlaced(
                    this._structureId, p.order_x, p.order_y, p.order_z, p.blockName,
                  );
                } catch {}
              }
              if (placed % BUILD_PROGRESS_EVERY === 0) {
                this.log?.info?.('blueprint_progress', {
                  id: blueprint.id,
                  structureId: this._structureId,
                  placed, total,
                  pct: total > 0 ? Math.round((placed / total) * 100) : 0,
                  block: p.blockName,
                });
              }
            } else {
              skipped++;
              // Best-effort cells must NOT mark the whole build partial:
              //   - water/seeds (isOptionalBlock)
              //   - non-solid attach-blocks (torches/buttons/levers/etc.) that
              //     need a wall/floor reference — a blueprint may position one
              //     with no valid support (e.g. a torch behind a door, or a
              //     floating interior torch). It's decorative; never let it
              //     block or churn the base (TestBot43: 95% forever, place/break
              //     loop on a door-side torch).
              if (!isOptionalBlock(p.blockName) && !NON_SOLID_PLACEABLES.has(p.blockName)) {
                placeFailures++;
              }
              const reason = result.reason ?? 'unknown';
              skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
              lastSkipReason = reason;
              // A streak of site-level failures means every further
              // cell will fail the same way — stop burning 2.5s per
              // cell and surface the site as unbuildable so the
              // build tool re-sites instead of looping partial builds.
              hardFailStreak = HARD_SITE_REASONS.has(reason)
                ? hardFailStreak + 1 : 0;
              if (hardFailStreak >= SITE_REJECT_AFTER) {
                this._saveProgress(blueprint, anchor, rotation, lowestUnprocessed, total);
                this.log?.warn?.('blueprint_site_rejected', {
                  id: blueprint.id, anchor, placed,
                  attempts: placeAttempts,
                  skip_reasons: skipReasons,
                  structureId: this._structureId,
                });
                const sid = this._structureId;
                this._structureId = null;
                return finish({
                  placed, skipped, missing, total,
                  reason: 'site_rejected', structureId: sid, skip_reasons: { ...skipReasons },
                });
              }
            }
          }
        }

        processed.add(p._originalIndex);
        advanceProcessed();
        processCount++;
        if (processCount % PROGRESS_SAVE_EVERY === 0) {
          this._saveProgress(blueprint, anchor, rotation, lowestUnprocessed, total);
        }
        await sleep(jitter(PLACE_DELAY_MIN_MS, PLACE_DELAY_MAX_MS));
      }
    }

    // No-progress detector. The bot is sometimes asked to build at an
    // anchor it cannot reach — for instance, the walk to the site
    // timed out so we're still hundreds of blocks
    // from the build site, and every _findStanding lookup returns
    // null. The placement loop runs to completion in that case
    // (placeFailures === placeAttempts, placed === 0) and the old
    // code happily marked the structure complete with reason 'done'.
    // The corrected path: surface this as a real failure so the
    // build tool (and the model) sees that nothing was built.
    const noProgress =
      placed === 0 && placeAttempts > 0 && placeFailures === placeAttempts;
    if (noProgress) {
      // Save resume progress at the start index so a subsequent
      // attempt (after the bot actually gets to the anchor) picks
      // up from the same point.
      this._saveProgress(blueprint, anchor, rotation, startIndex, total);
      this.log?.warn?.('blueprint_build_no_progress', {
        id: blueprint.id, total, attempts: placeAttempts,
        skip_reasons: skipReasons,
        last_skip: lastSkipReason,
        structureId: this._structureId,
      });
      const sid = this._structureId;
      this._structureId = null;
      return finish({
        placed, skipped, missing, total,
        reason: 'no_progress', structureId: sid, skip_reasons: { ...skipReasons },
      });
    }

    // Distinguish a fully-finished build from a partially-finished
    // one. The previous version marked the structure complete the
    // instant any block was placed — even when half the cells failed
    // (`placed: 5, skipped: 5, already_correct: 0`) — so the
    // worldModel + KV both reported the base as done. The strategic
    // LLM then read "base built" in its prompt and switched goals,
    // leaving a half-built shell. Only mark done when nothing failed
    // AND no materials are still missing.
    const missingKeyCount = Object.keys(missing).length;
    const fullyComplete = placeFailures === 0 && missingKeyCount === 0;
    if (!fullyComplete) {
      // Save progress at the start index so the next attempt re-runs
      // through the failed cells. _isAlreadyCorrect short-circuits
      // any cells that did succeed, so the retry doesn't redo work.
      this._saveProgress(blueprint, anchor, rotation, startIndex, total);
      this.log?.info?.('blueprint_build_partial', {
        id: blueprint.id, placed, skipped,
        place_failures: placeFailures,
        missing_keys: missingKeyCount,
        already_correct: alreadyCorrect,
        skip_reasons: skipReasons,
        structureId: this._structureId,
      });
      const sid = this._structureId;
      this._structureId = null;
      return finish({
        placed, skipped, missing, total,
        reason: 'partial', structureId: sid, skip_reasons: { ...skipReasons },
      });
    }

    // All placements processed AND we actually built something (or
    // the structure was already correct from a prior session).
    this._clearProgress();
    this._markBuilt(blueprint.id);
    if (this._structureId && this.worldModel?.markStructureComplete) {
      try { this.worldModel.markStructureComplete(this._structureId); } catch {}
    }
    this.log?.info?.('blueprint_build_done', {
      id: blueprint.id, placed, skipped, missing_keys: missingKeyCount,
      already_correct: alreadyCorrect,
      skip_reasons: skipReasons,
      structureId: this._structureId,
    });
    this._structureId = null;
    return finish({ placed, skipped, missing, total, reason: 'done' });
  }

  // ---------- placement list construction ----------

  _buildPlacementList(blueprint, anchor, rotation) {
    const tokens = blueprint.token_map ?? {};
    const dims = blueprint.dimensions ?? {};
    const layers = blueprint.layers ?? [];
    const interior = Array.isArray(blueprint.interior) ? blueprint.interior : [];
    const out = [];

    // Layer cells.
    for (let y = 0; y < layers.length; y++) {
      const layer = layers[y];
      for (let z = 0; z < layer.length; z++) {
        const row = layer[z];
        for (let x = 0; x < row.length; x++) {
          const ch = row[x];
          const blockName = tokens[ch];
          // Note: blockName === null means air. We INCLUDE it in the
          // placement list so the dig-out pass runs; the run loop
          // separates name===null from real placements.
          if (blockName === undefined) continue;
          const r = this._rotate({ x, z }, rotation, dims);
          out.push({
            blockName,
            world: {
              x: anchor.x + r.x,
              y: anchor.y + y,
              z: anchor.z + r.z,
            },
            phase: 'shell',
            order_x: r.x, order_y: y, order_z: r.z,
          });
        }
      }
    }

    // Interior items — placed AFTER the shell so the bot can walk in.
    for (const it of interior) {
      const blockName = it?.token in (blueprint.token_map ?? {})
        ? blueprint.token_map[it.token]
        : it.token;        // interior tokens may be raw block names
      if (!blockName) continue;
      const off = it.offset ?? {};
      const r = this._rotate({ x: Number(off.x ?? 0), z: Number(off.z ?? 0) }, rotation, dims);
      out.push({
        blockName,
        world: {
          x: anchor.x + r.x,
          y: anchor.y + Number(off.y ?? 0),
          z: anchor.z + r.z,
        },
        phase: 'interior',
        order_x: r.x, order_y: Number(off.y ?? 0), order_z: r.z,
      });
    }

    // An interior item (torch, chest, crafting table) sits in a cell the
    // layer map declares as air. Without this dedupe the list carries BOTH
    // an air entry and the item entry for that cell, and every resume pass
    // "clears" the air cell — digging the torch it placed last time — then
    // re-places it in the interior pass (TestBot44, 2026-09-02: torches
    // re-placed on all four cobble_hut passes). The interior entry wins.
    const interiorKeys = new Set(
      out.filter((p) => p.phase === 'interior').map((p) => `${p.world.x},${p.world.y},${p.world.z}`),
    );
    const deduped = interiorKeys.size
      ? out.filter((p) => !(p.blockName === null && interiorKeys.has(`${p.world.x},${p.world.y},${p.world.z}`)))
      : out;

    this._healDoorPairs(deduped);
    return this._sortByBuildOrder(deduped, blueprint, anchor, dims, rotation);
  }

  /**
   * Doors are TWO blocks tall, but every blueprint in the registry
   * models them as one cell — and 8 of them put a solid block in the
   * cell directly above the door. Placing the door auto-creates its
   * top half there; the roof pass then saw "wrong block", pre-dug the
   * top half (destroying the whole door), and placed its solid — so
   * the completion scan permanently reported the door missing.
   * TestBot19 (2026-06-10) rode that loop to an eternal-96% project.
   *
   * Heal the geometry here instead of hand-editing every blueprint:
   * any cell directly above a door cell becomes the door's top half.
   * Once the bottom is placed the top reads already-correct and is
   * never re-placed or dug.
   */
  _healDoorPairs(placements) {
    const byPos = new Map();
    for (const p of placements) {
      byPos.set(`${p.world.x},${p.world.y},${p.world.z}`, p);
    }
    for (const p of placements) {
      if (!p.blockName || !p.blockName.includes('door')) continue;
      // Only BOTTOM halves project upward — a door cell with a door
      // below it is already a top half (explicitly modeled pair);
      // converting the cell above THAT would eat the roof.
      const below = byPos.get(`${p.world.x},${p.world.y - 1},${p.world.z}`);
      if (below && below.blockName === p.blockName) continue;
      const above = byPos.get(`${p.world.x},${p.world.y + 1},${p.world.z}`);
      if (above && above.blockName !== p.blockName) {
        above.blockName = p.blockName;
      }
    }
  }

  /**
   * Rotate around the blueprint's center.
   *   0°:   (x, z) → (x, z)
   *   90°:  (x, z) → (maxZ - z, x)
   *   180°: (x, z) → (maxX - x, maxZ - z)
   *   270°: (x, z) → (z, maxX - x)
   */
  _rotate({ x, z }, rotation, dims) {
    const maxX = (dims.x ?? 1) - 1;
    const maxZ = (dims.z ?? 1) - 1;
    switch (Number(rotation) % 360) {
      case 90:  return { x: maxZ - z, z: x };
      case 180: return { x: maxX - x, z: maxZ - z };
      case 270: return { x: z,        z: maxX - x };
      case 0:
      default:  return { x, z };
    }
  }

  _sortByBuildOrder(items, blueprint, anchor, dims, rotation) {
    const order = blueprint.build_order ?? 'bottom_up';
    const isUnderground = blueprint.placement === 'underground';

    // Always: shell-phase items before interior.
    items.sort((a, b) => {
      if (a.phase !== b.phase) return a.phase === 'shell' ? -1 : 1;
      // Underground builds: excavate the interior air-token cells
      // FIRST so the bot has somewhere to stand for wall/floor/ceiling
      // placements. Without this, _findStanding returns null for every
      // wall cell (everything around y=12 is solid stone), and the
      // build never starts. After the interior is hollowed, the
      // perimeter cobble cells can be placed from inside the cavity.
      if (isUnderground) {
        const aAir = a.blockName === null;
        const bAir = b.blockName === null;
        if (aAir !== bAir) return aAir ? -1 : 1;
      }
      if (order === 'walls_first') {
        // Within a Y layer, perimeter (max-distance from center) first.
        if (a.order_y !== b.order_y) return a.order_y - b.order_y;
        const cx = ((dims.x ?? 1) - 1) / 2;
        const cz = ((dims.z ?? 1) - 1) / 2;
        const da = Math.max(Math.abs(a.order_x - cx), Math.abs(a.order_z - cz));
        const db = Math.max(Math.abs(b.order_x - cx), Math.abs(b.order_z - cz));
        if (da !== db) return db - da;
        return (a.order_z - b.order_z) || (a.order_x - b.order_x);
      }
      if (order === 'inside_out') {
        // Interior offsets (already phase=interior) ran first via the
        // phase split above. Shell-cells just go bottom_up.
        if (a.order_y !== b.order_y) return a.order_y - b.order_y;
        return (a.order_z - b.order_z) || (a.order_x - b.order_x);
      }
      // bottom_up (default): y ASC, then z, then x.
      if (a.order_y !== b.order_y) return a.order_y - b.order_y;
      if (a.order_z !== b.order_z) return a.order_z - b.order_z;
      return a.order_x - b.order_x;
    });

    return items;
  }

  // ---------- ground-truth completion ----------

  /**
   * Re-scan the blueprint's REQUIRED cells (everything except
   * optional water/seed layers) against the live world and report
   * true completion. This is the honest number — placed-counts and
   * resume indexes can both lie (a "74% done" TestBot17 shelter was
   * mostly pre-existing hillside dirt while the door and half the
   * walls were missing).
   *
   * Returns { correct, total, pct, missing, unloaded, reliable }.
   * `reliable` is false when any cell's chunk wasn't loaded — don't
   * make complete/abandon decisions on an unreliable scan.
   */
  scanCompletion(blueprint, anchor, rotation = 0) {
    const placements = this._buildPlacementList(blueprint, anchor, rotation);
    let total = 0;
    let correct = 0;
    let unloaded = 0;
    const missing = {};
    for (const p of placements) {
      // Best-effort cells don't count toward completion: water/seeds AND
      // non-solid attach-blocks (torches/buttons/levers). A torch that can't
      // find a wall/floor to attach to (door-side or floating interior torch)
      // would otherwise hold the base at ~95% forever and never confirm done.
      // They're still gathered + attempted during the place pass — just not
      // REQUIRED for completion, so a placeable wall-torch still lands while an
      // unplaceable one doesn't block the structure.
      if (p.blockName !== null
          && (isOptionalBlock(p.blockName) || NON_SOLID_PLACEABLES.has(p.blockName))) continue;
      total++;
      const block = this.bot.blockAt?.(new Vec3(p.world.x, p.world.y, p.world.z));
      if (!block) { unloaded++; continue; }
      if (this._isAlreadyCorrect(p, blueprint)) {
        correct++;
      } else {
        const key = p.blockName ?? '(excavate)';
        missing[key] = (missing[key] ?? 0) + 1;
      }
    }
    return {
      correct,
      total,
      pct: total > 0 ? Math.round((correct / total) * 100) : 100,
      missing,
      unloaded,
      reliable: unloaded === 0,
    };
  }

  // ---------- per-block placement ----------

  _isAlreadyCorrect(p, blueprint = null) {
    const v = new Vec3(p.world.x, p.world.y, p.world.z);
    const block = this.bot.blockAt?.(v);
    if (!block) return false;
    if (p.blockName === null) {
      return block.name === 'air';
    }
    if (!block.name || block.name === 'air') {
      // A plant cell (seeds) is satisfied once a crop is growing there;
      // an empty (air) crop cell still needs planting.
      return false;
    }
    if (block.name === p.blockName) return true;
    // Farmland (a till block) is correct ONLY when the cell is actually
    // farmland — NOT when it's still the dirt/grass it'll be tilled from.
    // Without this, the farmland:['dirt','grass'] substitution below would
    // mark un-tilled dirt as "done", so the plot never gets hoed and the
    // farm grows nothing. Force the cell through the till step.
    if (placementMethod(p.blockName) === 'till') return false;
    // A plant cell is correct once anything (the crop) occupies it.
    if (placementMethod(p.blockName) === 'plant') return block.name !== 'air';
    // Variant match — narrow, one-directional. The previous loose match
    // (`a.includes(b) || b.includes(a)`) collapsed `stone` into
    // `cobblestone` and `stone_slab` into `stone`, which made the
    // resume path skip cells that had the wrong material.
    //
    // Allow only:
    //   block.name ends with "_<blockName>"          → "oak_planks" satisfies "planks"
    //   blockName === "planks" and block.name ends with "_planks"
    //   blockName === "log"    and block.name is "log" / "log2" / "*_log"
    if (block.name.endsWith('_' + p.blockName)) return true;
    if (p.blockName === 'planks' && block.name.endsWith('_planks')) return true;
    if (p.blockName === 'log' &&
        (block.name === 'log' || block.name === 'log2' || block.name.endsWith('_log'))) {
      return true;
    }
    // Substitution match — if the blueprint declares acceptable
    // substitutes for this block (e.g. underground_vault has
    // `substitutions.cobblestone = ['stone', 'mossy_cobblestone']`),
    // accept any of them. Without this, a resume run after the bot
    // placed `stone` (because cobble was unavailable) will see every
    // wall cell as "wrong", dig out the stone, and try to re-place
    // — wasteful and often pointless because the same shortage
    // repeats.
    const subs = blueprint?.substitutions?.[p.blockName];
    if (Array.isArray(subs) && subs.includes(block.name)) return true;
    return false;
  }

  /**
   * Site preparation: dig out every footprint cell that's currently
   * occupied by the wrong solid block (terrain, vegetation) so the
   * placement loop runs against air. Top-down order so columns don't
   * leave floating debris over cells dug below them. Failures are
   * fine — _placeOne's per-cell pre-dig retries them later.
   *
   * Why a dedicated pass: a build whose footprint intersects terrain
   * (anchor on a slope, bush in the doorway) otherwise interleaves
   * digs with placements cell by cell, and any dig the per-cell path
   * misses turns into a placement the server silently ignores.
   */
  async _prepSite(placements, blueprint, isCancelled) {
    const toClear = placements
      .filter((p) => p.blockName !== null
        && !this._isAlreadyCorrect(p, blueprint)
        && classifyCell(this.bot, p.world) === 'occupied')
      .sort((a, b) => b.world.y - a.world.y);
    if (!toClear.length) return;
    this.log?.info?.('blueprint_site_prep', {
      id: blueprint.id, cells: toClear.length,
    });
    let cleared = 0;
    let failed = 0;
    for (const p of toClear) {
      if (isCancelled()) return;
      await this._maybeDigAir(p, isCancelled);
      if (classifyCell(this.bot, p.world) === 'occupied') failed++;
      else cleared++;
    }
    this.log?.info?.('blueprint_site_prep_done', {
      id: blueprint.id, cleared, failed,
    });
  }

  /** Lava behind any face floods the cell the instant it's dug. */
  _digWouldFlood(v) {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const nb = this.bot.blockAt?.(v.offset(dx, dy, dz));
      if (nb && (nb.name === 'lava' || nb.name === 'flowing_lava')) return true;
    }
    return false;
  }

  async _maybeDigAir(p, isCancelled) {
    if (isCancelled()) return;
    const v = new Vec3(p.world.x, p.world.y, p.world.z);
    const block = this.bot.blockAt?.(v);
    if (!block || block.name === 'air') return;
    // Don't dig containers/valuables/ores/doors — but DO clear natural
    // obstructions like tree logs/leaves so a trunk in a build cell can't
    // deadlock the build (the narrower site-clear protection).
    if (this._isSiteClearProtected(block.name)) return;
    if (this._digWouldFlood(v)) {
      this.log?.info?.('blueprint_dig_skip_lava', { pos: p.world });
      return;
    }
    try {
      const standing = this._findStanding(p.world);
      if (standing) {
        const handle = this.movement.goTo(standing,
          { timeoutMs: PATHFIND_TIMEOUT_MS, range: 1 });
        await handle.done.catch(() => {});
      } else if (!this._isWithinReach(v)) {
        // No standing pocket AND target is out of reach. Skip rather
        // than letting bot.dig fail noisily — the underground excavation
        // pass will try this cell again later, and once a neighbour is
        // hollowed the bot will be close enough to dig.
        this.log?.debug?.('blueprint_dig_unreachable', { pos: p.world });
        return;
      }
      // Swap to the right pickaxe/axe/shovel before digging — without
      // this the bot digs stone with whatever's currently in hand
      // (typically a cobble block from the previous placement),
      // which is bare-handed for tool-speed purposes.
      await this._equipToolForBlock(block);
      const dig = this.bot.dig(block);
      const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('dig_timeout')),
        DIG_TIMEOUT_MS));
      await Promise.race([dig, timer]);
    } catch (e) {
      this.log?.debug?.('blueprint_dig_failed', { pos: p.world, msg: e.message });
    }
  }

  _isProtected(name) {
    if (!name) return false;
    // `door` guards both halves of placed doors — digging the top
    // half destroys the whole door (see _healDoorPairs).
    return /chest|furnace|crafting_table|enchanting_table|anvil|bed|ore|wool|log|door/.test(name);
  }

  /**
   * Narrower protection for SITE CLEARING (pre-dig + _prepSite). Containers,
   * valuables, and doors are never auto-cleared (loot / player-placed), but
   * natural obstructions — logs, leaves, wool, vegetation, terrain — ARE
   * cleared so a tree trunk standing in a build cell can't deadlock the build.
   * (TestBot41: one natural log in a cell → 36 cell_occupied events, 18-min
   * stall, "complete" logged as a timeout.) `_isProtected` still shields
   * logs/wool from incidental digging in non-clearing code paths.
   */
  _isSiteClearProtected(name) {
    if (!name) return false;
    return /chest|furnace|crafting_table|enchanting_table|anvil|bed|ore|door|dispenser|dropper|hopper|brewing_stand|beacon/.test(name);
  }

  /**
   * Equip the best in-inventory tool for digging `block` so the
   * placement-clear and excavation passes don't dig stone with a
   * cobble block in hand. Without this `_placeOne` would dig the
   * existing target block with whatever's currently held — usually
   * the placement item from the previous loop iteration — which is
   * effectively bare-handed: stone takes ~7.5 s vs ~1.25 s with a
   * stone pickaxe, and ore drops nothing without the right tier.
   *
   * Walks tier order diamond → iron → stone → wooden and stops on
   * the first match. Returns true when a tool was equipped, false
   * if no relevant tool is available (digging falls back to whatever
   * is in hand).
   */
  async _equipToolForBlock(block) {
    if (!block?.name) return false;
    const family = _toolFamilyFor(block.name);
    if (!family) return false;
    const items = this.bot.inventory?.items?.() ?? [];
    for (const tier of ['diamond', 'iron', 'stone', 'wooden']) {
      const tool = items.find((it) => it?.name === `${tier}_${family}`);
      if (!tool) continue;
      try {
        await this.bot.equip(tool, 'hand');
        return true;
      } catch (e) {
        this.log?.debug?.('blueprint_tool_equip_failed', {
          block: block.name, tool: tool.name, msg: e.message,
        });
        return false;
      }
    }
    return false;
  }

  _pickItem(blockName, blueprint) {
    if (!blockName) return null;
    const items = this.bot.inventory?.items?.() ?? [];
    // 1. Exact match.
    let found = items.find((it) => it?.name === blockName);
    if (found) return found;
    // 2. Substitutions list from the blueprint.
    const subs = blueprint?.substitutions?.[blockName];
    if (Array.isArray(subs)) {
      // Empty list means "skip — unplaceable" (e.g. water without bucket).
      if (subs.length === 0) return null;
      for (const alt of subs) {
        found = items.find((it) => it?.name === alt);
        if (found) return found;
      }
    }
    // 3. Loose match — any inventory item containing the block name.
    found = items.find((it) => it?.name?.includes(blockName));
    if (found) return found;
    return null;
  }

  /**
   * Returns `{ ok, reason }`. The reason on failure feeds the
   * builder's per-cell skip histogram so heartbeat logs surface
   * "why did 30 cells skip?" without flipping every per-cell debug
   * log to info (which would flood the log).
   */
  async _placeOne(p, item, isCancelled, opts = {}) {
    const skipPathfind = !!opts.skipPathfind;
    const lastEquipped = opts.lastEquipped ?? null;
    const targetVec = new Vec3(p.world.x, p.world.y, p.world.z);

    if (skipPathfind) {
      // Caller (batched flow) already moved the bot to a shared
      // standing pose. Skip the per-block search + pathfind, but
      // still gate on placeBlock's 4.5-block reach so a drifted bot
      // surfaces as out_of_reach and the caller can fall back.
      if (!this._isWithinReach(targetVec)) {
        return { ok: false, reason: 'out_of_reach', equippedName: lastEquipped };
      }
    } else {
      const standing = this._findStanding(p.world);
      // Underground (or any "everything around the target is solid")
      // case: _findStanding finds no clean head+legs+ground candidate
      // because the world is solid stone for many blocks in every
      // direction. If the bot is already within bot.placeBlock's
      // 4.5-block reach (e.g. standing in a pathfinder-dug tunnel
      // adjacent to the structure, or in a previously-excavated
      // interior cell), we can place from where we are without an
      // explicit standing-pocket pathfind. Without this fallback the
      // build never starts: every cell logs `blueprint_no_standing`
      // and the placer immediately returns false.
      if (!standing) {
        if (this._isWithinReach(targetVec)) {
          this.log?.debug?.('blueprint_place_from_current_pos', { pos: p.world });
        } else {
          this.log?.debug?.('blueprint_no_standing', { pos: p.world });
          return { ok: false, reason: 'no_standing', equippedName: lastEquipped };
        }
      }
      if (isCancelled()) return { ok: false, reason: 'cancelled', equippedName: lastEquipped };

      try {
        if (standing) {
          const handle = this.movement.goTo(standing,
            { timeoutMs: PATHFIND_TIMEOUT_MS, range: 1 });
          const r = await handle.done.catch(() => ({ reached: false }));
          if (!r?.reached && !this._isWithinReach(targetVec)) {
            return { ok: false, reason: 'pathfind_failed', equippedName: lastEquipped };
          }
        }
        // No `standing`: bot is already in reach (gated above).
      } catch {
        return { ok: false, reason: 'pathfind_threw', equippedName: lastEquipped };
      }
    }

    if (isCancelled()) return { ok: false, reason: 'cancelled', equippedName: lastEquipped };

    // Non-"place" blocks don't use the placeBlock(ref, face) contract:
    // farmland is hoed from dirt, seeds are right-clicked onto farmland.
    const method = placementMethod(p.blockName);
    if (method === 'till') return this._tillCellAt(p, item, targetVec, lastEquipped);
    if (method === 'plant') return this._plantSeedCell(item, targetVec, lastEquipped);
    if (method === 'water') return this._placeWaterCell(targetVec, lastEquipped);

    let ref = this._findReference(targetVec);
    let scaffold = null;
    if (!ref) {
      // Scaffold the no-reference case: a floating / roof / overhang cell
      // whose six neighbours are all air can't be placed (the server needs
      // a block face to click). Drop a temporary support block against an
      // adjacent air cell that DOES have a reference, place the real block
      // against the scaffold, then remove it. Non-gravity blocks float once
      // placed, so the target stays. This is the core fix for structures
      // that never reach 100% — no_reference cells were skipped forever.
      scaffold = await this._tryScaffold(targetVec, p);
      if (!scaffold) {
        this.log?.debug?.('blueprint_no_reference', { pos: p.world, block: p.blockName });
        return { ok: false, reason: 'no_reference', equippedName: lastEquipped };
      }
      ref = scaffold.ref; // the scaffold block is now the reference
    }

    const result = await this._placeAgainstRef(
      p, item, targetVec, ref,
      scaffold ? scaffold.material : lastEquipped, isCancelled,
    );
    // Always pull the temporary scaffold — success or fail. _removeScaffold's
    // expectedBlock guard means we never dig a real structural neighbour.
    if (scaffold) await this._removeScaffold(scaffold);
    return result;
  }

  /**
   * Place `item` at `targetVec` against an already-resolved reference
   * (`{ block, face, interactive }`). Extracted from _placeOne so the
   * scaffold path runs the identical pre-dig / occupancy / equip /
   * poll-verify flow and can tear the scaffold down on every exit.
   */
  async _placeAgainstRef(p, item, targetVec, ref, lastEquipped, isCancelled) {
    // Clear the target cell FIRST, swapping to a real pickaxe before
    // the dig. Done before equipping the placement item so the dig
    // doesn't run with a cobble block in hand (which is bare-handed
    // for tool-speed purposes — stone takes 7.5 s instead of 1.25 s,
    // ores drop nothing).
    let preDigSwappedTool = false;
    try {
      const existing = this.bot.blockAt(targetVec);
      if (existing && existing.name !== 'air' && !this._isSiteClearProtected(existing.name)
          && !this._digWouldFlood(targetVec)) {
        const swapped = await this._equipToolForBlock(existing);
        if (swapped) preDigSwappedTool = true;
        await this.bot.dig(existing).catch(() => {});
      }
    } catch (e) {
      this.log?.debug?.('blueprint_predig_failed', { pos: p.world, msg: e.message });
      // Don't bail — the placement might still succeed if the cell
      // turns out to be air on re-check.
    }

    // The server silently ignores a placement into a cell that's
    // still solid (pre-dig failed / was rejected) — each attempt
    // would burn placeAndVerify's full timeout. Classify it now and
    // skip the doomed call. (This was TestBot17's dominant failure:
    // build anchored below grade, every wall cell occupied by
    // hillside terrain.)
    if (classifyCell(this.bot, targetVec) === 'occupied') {
      this.log?.debug?.('blueprint_cell_occupied', {
        pos: p.world, block: p.blockName,
        existing: this.bot.blockAt(targetVec)?.name ?? null,
      });
      return { ok: false, reason: 'cell_occupied', equippedName: lastEquipped };
    }

    // Same deal for a living entity in the cell — including the bot
    // itself. Step aside when it's us; bail when it's a mob/player
    // (transient — the cell retries on the next pass).
    let occupant = entityInCell(this.bot, targetVec);
    if (occupant === 'self') {
      await this._stepAsideFrom(p.world, isCancelled);
      occupant = entityInCell(this.bot, targetVec);
    }
    if (occupant) {
      this.log?.debug?.('blueprint_entity_in_cell', { pos: p.world, who: occupant });
      return {
        ok: false,
        reason: occupant === 'self' ? 'self_collision' : 'entity_in_cell',
        equippedName: lastEquipped,
      };
    }

    // Skip the equip when consecutive placements share a material AND
    // pre-dig didn't swap a tool into the hand. bot.equip walks the
    // hotbar + window-click protocol; reusing the held slot saves
    // ~50-100ms per identical-material block.
    if (!preDigSwappedTool && item.name === lastEquipped) {
      // Same material as last placement — skip equip
    } else {
      try {
        await this.bot.equip(item, 'hand');
      } catch (e) {
        this.log?.debug?.('blueprint_equip_failed', { item: item?.name, msg: e.message });
        // Hand contents now ambiguous — invalidate the caller's dedup.
        return { ok: false, reason: 'equip_failed', equippedName: null };
      }
    }

    // Poll-verified placement: succeeds as soon as the block reads
    // back from the world, even when the blockUpdate event mineflayer
    // waits on is missed/late (observed on the 1.8 server — "failed"
    // placements that had actually landed). On failure, the reason is
    // classified (cell_occupied / self_collision / out_of_reach /
    // protected_zone / server_rejected) so the run loop can detect an
    // unbuildable site instead of grinding generic place_faileds.
    //
    // Interactive reference (door/chest/table — no solid alternative
    // face): sneak through the placement so the click places instead
    // of activating, exactly like a player shift-clicking.
    if (ref.interactive) {
      try { this.bot.setControlState?.('sneak', true); } catch {}
    }
    // Non-solid blocks (torches) read back as 'replaceable' to the default
    // verify, so it never confirms them — verify by NAME instead. (Solid
    // blocks keep the cheaper occupancy verify, which works for them.)
    const verifyOpts = NON_SOLID_PLACEABLES.has(p.blockName)
      ? {
          verify: () => {
            const b = this.bot.blockAt?.(targetVec);
            if (!b || b.name === 'air') return false;
            return b.name === p.blockName
              || b.name.endsWith('_' + p.blockName)
              || p.blockName.endsWith('_' + b.name);
          },
        }
      : {};
    const placedResult = await placeAndVerify(
      this.bot, ref.block, ref.face, targetVec, verifyOpts,
    );
    if (ref.interactive) {
      try { this.bot.setControlState?.('sneak', false); } catch {}
    }
    if (placedResult.ok) {
      // Shield this freshly-placed structure cell from the self-extraction
      // digger so a stuck bot mid-build can't dig out a wall/floor it just
      // placed under its own feet (TTL-bounded; self-heals).
      try { this.movement?.notePlacement?.(targetVec); } catch {}
      return { ok: true, reason: 'placed', equippedName: item.name };
    }
    this.log?.debug?.('blueprint_place_failed', {
      pos: p.world, block: p.blockName,
      reason: placedResult.reason, msg: placedResult.error,
    });
    return { ok: false, reason: placedResult.reason, equippedName: item.name };
  }

  // ==================================================================
  // Scaffolding — let a no-reference (floating) cell be placed by
  // dropping a temporary support block against it.
  // ==================================================================

  /**
   * Plan a scaffold for a target cell that has no solid neighbour to
   * place against. Looks for an adjacent EMPTY cell (a face of the
   * target) that ITSELF has a solid, non-interactive reference — drop a
   * scaffold there, then the target can be placed against the scaffold.
   * Pure (read-only): returns { supportPos, scaffoldRef, targetFace } or
   * null. `targetFace` is the placeBlock face from the scaffold to the
   * target (it equals the face direction, since supportPos = target-face).
   */
  _planScaffold(targetVec) {
    for (const { face } of FACE_DIRS) {
      const supportPos = targetVec.minus(face);
      // Only scaffold INTO an empty cell (not terrain / a placed block /
      // an unloaded chunk). If a neighbour were solid, _findReference
      // would already have used it and we wouldn't be here.
      const cell = classifyCell(this.bot, supportPos);
      if (cell !== 'air' && cell !== 'replaceable') continue;
      // The support cell needs its own solid, non-interactive face to
      // place the scaffold against.
      const scaffoldRef = this._findReference(supportPos);
      if (!scaffoldRef || scaffoldRef.interactive) continue;
      return { supportPos, scaffoldRef, targetFace: face };
    }
    return null;
  }

  /** First cheap, non-gravity block in inventory usable as a scaffold. */
  _findScaffoldMaterial() {
    for (const name of SCAFFOLD_MATERIALS) {
      const item = this._findItemByName(name);
      if (item) return item;
    }
    return null;
  }

  /**
   * Place a temporary scaffold for a no-reference target. Returns
   * { pos, material, ref } on success (ref = the new scaffold block as a
   * placement reference for the target), or null if no scaffold could be
   * planned / no material / the scaffold itself failed to land.
   */
  async _tryScaffold(targetVec, p) {
    const plan = this._planScaffold(targetVec);
    if (!plan) return null;
    const mat = this._findScaffoldMaterial();
    if (!mat) {
      this.log?.debug?.('blueprint_scaffold_no_material', { pos: p.world });
      return null;
    }
    try {
      await this.bot.equip(mat, 'hand');
    } catch (e) {
      this.log?.debug?.('blueprint_scaffold_equip_failed', { msg: e.message });
      return null;
    }
    const placed = await placeAndVerify(
      this.bot, plan.scaffoldRef.block, plan.scaffoldRef.face, plan.supportPos,
      { verify: () => this.bot.blockAt(plan.supportPos)?.name === mat.name },
    );
    if (!placed.ok) {
      this.log?.debug?.('blueprint_scaffold_place_failed', {
        pos: p.world, support: plan.supportPos, reason: placed.reason,
      });
      return null;
    }
    this.log?.info?.('blueprint_scaffold_placed', {
      target: p.world, support: plan.supportPos, material: mat.name,
    });
    // The scaffold is exactly what the bot stands on — shield it so the
    // self-extraction digger never drops the bot by removing it.
    try { this.movement?.notePlacement?.(plan.supportPos); } catch {}
    return {
      pos: plan.supportPos,
      material: mat.name,
      ref: { block: this.bot.blockAt(plan.supportPos), face: plan.targetFace, interactive: false },
    };
  }

  /**
   * Remove a temporary scaffold. The expectedBlock guard (name match)
   * means a missed/already-gone scaffold, or a cell that turned out to
   * hold a real structural block, is left alone.
   */
  async _removeScaffold(scaffold) {
    try {
      const block = this.bot.blockAt(scaffold.pos);
      if (!block || block.name !== scaffold.material) return; // not ours / gone
      if (this._digWouldFlood(scaffold.pos)) return;          // never open a fluid
      await this._equipToolForBlock(block);
      await this.bot.dig(block).catch(() => {});
      this.log?.debug?.('blueprint_scaffold_removed', {
        pos: scaffold.pos, material: scaffold.material,
      });
    } catch (e) {
      this.log?.debug?.('blueprint_scaffold_remove_failed', { msg: e.message });
    }
  }

  /**
   * The bot's own body occupies the cell it's trying to fill — move
   * to the nearest valid standing pose that doesn't intersect the
   * target. Returns true when the bot is clear of the cell.
   */
  async _stepAsideFrom(targetWorld, isCancelled) {
    if (isCancelled?.()) return false;
    const tx = Math.floor(targetWorld.x);
    const ty = Math.floor(targetWorld.y);
    const tz = Math.floor(targetWorld.z);
    for (const pose of this._findAllStanding(targetWorld)) {
      // A pose's feet occupy pose.y and head pose.y+1 — skip poses
      // whose body would still intersect the target cell.
      if (Math.floor(pose.x) === tx && Math.floor(pose.z) === tz
          && (Math.floor(pose.y) === ty || Math.floor(pose.y) + 1 === ty)) continue;
      try {
        const h = this.movement.goTo(pose, { timeoutMs: PATHFIND_TIMEOUT_MS, range: 0 });
        await h.done.catch(() => {});
      } catch (e) {
        this.log?.debug?.('blueprint_step_aside_err', { msg: e.message });
      }
      if (entityInCell(this.bot, targetWorld) !== 'self') {
        this.log?.debug?.('blueprint_stepped_aside', { from: targetWorld, to: pose });
        return true;
      }
      if (isCancelled?.()) return false;
    }
    return entityInCell(this.bot, targetWorld) !== 'self';
  }

  _isTillable(block) {
    return !!block
      && (block.name === 'dirt' || block.name === 'grass' || block.name === 'grass_block');
  }

  // True when the cell at world-pos `w` is already dirt/grass — i.e. we
  // can hoe it into farmland without first laying a dirt block.
  _isTillableGround(w) {
    return this._isTillable(this.bot.blockAt?.(new Vec3(w.x, w.y, w.z)));
  }

  _findHoe() {
    return (this.bot.inventory?.items?.() ?? []).find((it) => it?.name?.endsWith?.('_hoe')) ?? null;
  }

  // Hoe the cell into farmland. If the ground isn't already dirt/grass,
  // lay a dirt block first (needs the dirt `item` the farmland
  // substitution resolved). Requires a hoe in inventory.
  async _tillCellAt(p, item, targetVec, lastEquipped) {
    let ground = this.bot.blockAt(targetVec);
    if (!this._isTillable(ground)) {
      if (!item) return { ok: false, reason: 'no_dirt', equippedName: lastEquipped };
      const ref = this._findReference(targetVec);
      if (!ref) return { ok: false, reason: 'no_reference', equippedName: lastEquipped };
      try {
        if (ground && ground.name !== 'air' && !this._isProtected(ground.name)) {
          await this._equipToolForBlock(ground);
          await this.bot.dig(ground).catch(() => {});
        }
      } catch (e) { this.log?.debug?.('till_predig_failed', { msg: e.message }); }
      try { await this.bot.equip(item, 'hand'); }
      catch { return { ok: false, reason: 'equip_failed', equippedName: null }; }
      try { await this.bot.placeBlock(ref.block, ref.face); }
      catch (e) {
        this.log?.debug?.('till_lay_dirt_failed', { pos: p.world, msg: e.message });
        return { ok: false, reason: 'place_failed', equippedName: item.name };
      }
      ground = this.bot.blockAt(targetVec);
      if (!this._isTillable(ground)) {
        return { ok: false, reason: 'till_ground_unready', equippedName: item.name };
      }
    }
    const hoe = this._findHoe();
    if (!hoe) return { ok: false, reason: 'no_hoe', equippedName: lastEquipped };
    try {
      await this.bot.equip(hoe, 'hand');
      if (this.bot.lookAt) await this.bot.lookAt(targetVec.offset(0.5, 1, 0.5), true);
      await this.bot.activateBlock(ground);
    } catch (e) {
      this.log?.debug?.('till_failed', { pos: p.world, msg: e.message });
      return { ok: false, reason: 'till_failed', equippedName: hoe.name };
    }
    // The server's block change arrives a few ticks after the click; reading
    // the cell immediately reported till_unverified for cells that WERE
    // tilled (TestBot44, 2026-09-04: 13 "failures" per pass that the next
    // pass found already correct). Give it up to 1.5 s.
    let after = this.bot.blockAt(targetVec);
    const until = Date.now() + 1500;
    while (after?.name !== 'farmland' && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      after = this.bot.blockAt(targetVec);
    }
    return after?.name === 'farmland'
      ? { ok: true, reason: 'tilled', equippedName: hoe.name }
      : { ok: false, reason: 'till_unverified', equippedName: hoe.name };
  }

  _findItemByName(name) {
    return (this.bot.inventory?.items?.() ?? []).find((it) => it?.name === name) ?? null;
  }

  // A filled water_bucket if we have one, else an empty bucket to fill.
  _findBucket() {
    return this._findItemByName('water_bucket') ?? this._findItemByName('bucket');
  }

  // Nearest water SOURCE within reach (a bucket only fills from a source,
  // metadata 0); flowing water is a last resort. Null when none.
  _findNearbyWater() {
    try {
      const find = (pred) => this.bot.findBlock?.({ matching: (b) => !!b && pred(b), maxDistance: 16, count: 1 });
      return find((b) => b.name === 'water' && (b.metadata ?? 0) === 0)
        ?? find((b) => b.name === 'water')
        ?? find((b) => b.name === 'flowing_water')
        ?? null;
    } catch { return null; }
  }

  // A dry cell next to `water` to stand on while filling: solid below, two
  // passable cells, not water. Standing IN the pond drowns the bot
  // (TestBot44, 2026-09-06: fill failed while it was under water).
  _standCellNear(water) {
    const p = water.position;
    const solid = (b) => !!b && b.name !== 'air' && b.boundingBox === 'block';
    const passable = (b) => !b || b.name === 'air' || (b.boundingBox === 'empty' && !/water|lava/.test(b.name ?? ''));
    for (const dy of [0, 1, -1]) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const x = p.x + dx; const y = p.y + dy; const z = p.z + dz;
        try {
          if (solid(this.bot.blockAt(new Vec3(x, y - 1, z))) && passable(this.bot.blockAt(new Vec3(x, y, z))) && passable(this.bot.blockAt(new Vec3(x, y + 1, z)))) return { x, y, z };
        } catch {}
      }
    }
    return null;
  }

  // Fill an empty bucket from `water`: stand on land beside it, look at it,
  // use the bucket, and wait for the server's inventory update (up to
  // 1.5 s, one retry). Returns the water_bucket item or null.
  async _fillBucketAt(water, empty) {
    const stand = this._standCellNear(water);
    try {
      const h = stand
        ? this.movement.goTo(stand, { timeoutMs: PATHFIND_TIMEOUT_MS, range: 0 })
        : this.movement.goTo({ x: water.position.x, y: water.position.y, z: water.position.z }, { timeoutMs: PATHFIND_TIMEOUT_MS, range: 2 });
      await h.done.catch(() => {});
    } catch (e) { this.log?.debug?.('water_fill_pathfind_threw', { msg: e.message }); }
    // The use-item packet must follow the look packet, which goes out on the
    // next physics tick; firing it in the same tick made the server ray-trace
    // with the old heading and miss the water (oatmeal_ollie, 2026-09-07).
    const aims = [0.9, 0.5, 0.15];
    for (let attempt = 0; attempt < aims.length; attempt++) {
      try {
        await this.bot.equip(empty, 'hand');
        await sleep(120);
        if (this.bot.heldItem && this.bot.heldItem.name !== 'bucket') { await this.bot.equip(empty, 'hand'); await sleep(120); }
        if (this.bot.lookAt) await this.bot.lookAt(water.position.offset(0.5, aims[attempt], 0.5), true);
        await sleep(160);
        this.bot.activateItem?.();
        await sleep(150);
        this.bot.deactivateItem?.();
      } catch (e) {
        this.log?.debug?.('water_fill_failed', { msg: e.message });
        return null;
      }
      const until = Date.now() + 1500;
      while (Date.now() < until) {
        const wb = this._findItemByName('water_bucket');
        if (wb) return wb;
        await sleep(100);
      }
    }
    return null;
  }

  // Place a water source at the cell, best-effort. If we only hold an
  // empty bucket, fill it from a nearby water source first. Mirrors the
  // fillWaterBucket + placeWater primitives. Bounded by WATER_SOURCE_CAP
  // (one source hydrates a 9×9), and never blocks the build (water is an
  // optional cell). LIMITATION: filling needs a water source within ~16
  // blocks of the build; a plot far from any water stays dry.
  async _placeWaterCell(targetVec, lastEquipped) {
    if (this._waterPlaced >= WATER_SOURCE_CAP) {
      return { ok: false, reason: 'water_cap_reached', equippedName: lastEquipped };
    }
    let wb = this._findItemByName('water_bucket');
    if (!wb) {
      const empty = this._findItemByName('bucket');
      if (!empty) return { ok: false, reason: 'no_bucket', equippedName: lastEquipped };
      const water = this._findNearbyWater();
      if (!water) return { ok: false, reason: 'no_water_source', equippedName: lastEquipped };
      wb = await this._fillBucketAt(water, empty);
      if (!wb) return { ok: false, reason: 'fill_unverified', equippedName: lastEquipped };
      // Filling moved us; the placement below walks back within reach.
      try {
        const h = this.movement.goTo({ x: targetVec.x, y: targetVec.y, z: targetVec.z }, { timeoutMs: PATHFIND_TIMEOUT_MS, range: 3 });
        await h.done.catch(() => {});
      } catch {}
    }
    // Pour against the floor below the target. In 1.8 the server pours where
    // the player's LOOK RAY hits, so the aim must land on the reference's top
    // face (a side hit puts the water beside it), and the use packet must
    // follow the look packet by a tick. Then wait for the block update.
    const ref = this.bot.blockAt(targetVec.offset(0, -1, 0));
    if (!ref || ref.name === 'air') {
      return { ok: false, reason: 'no_reference', equippedName: lastEquipped };
    }
    const isWet = () => { const b = this.bot.blockAt(targetVec); return b?.name === 'water' || b?.name === 'flowing_water'; };
    for (let attempt = 0; attempt < 2 && !isWet(); attempt++) {
      try {
        await this.bot.equip(wb, 'hand');
        await sleep(100);
        if (this.bot.lookAt) await this.bot.lookAt(ref.position.offset(0.5, 0.98, 0.5), true);
        await sleep(160);
        await this.bot.activateBlock(ref, new Vec3(0, 1, 0), new Vec3(0.5, 1, 0.5));
      } catch (e) {
        this.log?.debug?.('water_place_failed', { msg: e.message });
        return { ok: false, reason: 'water_place_failed', equippedName: wb.name };
      }
      const until = Date.now() + 1500;
      while (Date.now() < until && !isWet()) await sleep(100);
    }
    if (isWet()) {
      this._waterPlaced++;
      return { ok: true, reason: 'watered', equippedName: 'bucket' };
    }
    return { ok: false, reason: 'water_unverified', equippedName: 'bucket' };
  }

  // Plant a seed onto the farmland/sand directly below the crop cell.
  // Best-effort: only reached when a seed item is in hand.
  async _plantSeedCell(item, targetVec, lastEquipped) {
    if (!item) return { ok: false, reason: 'no_seed', equippedName: lastEquipped };
    const ground = this.bot.blockAt(targetVec.offset(0, -1, 0));
    if (!ground || ground.name === 'air') {
      return { ok: false, reason: 'no_ground', equippedName: lastEquipped };
    }
    try {
      await this.bot.equip(item, 'hand');
      if (this.bot.lookAt) await this.bot.lookAt(ground.position.offset(0.5, 1, 0.5), true);
      await this.bot.activateBlock(ground);
    } catch (e) {
      return { ok: false, reason: 'plant_failed', equippedName: item.name };
    }
    return { ok: true, reason: 'planted', equippedName: item.name };
  }

  _isWithinReach(v) {
    const me = this.bot.entity?.position;
    if (!me) return false;
    // Use raw Pythagoras instead of Vec3#distanceTo so a plain
    // {x,y,z} target works the same as a Vec3 — and so test mocks
    // that pass plain-object positions don't throw a TypeError.
    const dx = (me.x ?? 0) - (v?.x ?? 0);
    const dy = (me.y ?? 0) - (v?.y ?? 0);
    const dz = (me.z ?? 0) - (v?.z ?? 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz) <= 4.5;
  }

  /**
   * Find the existing solid block adjacent to `v` to use as the
   * reference for bot.placeBlock(). Returns { block, face, interactive }
   * where `face` is the unit vector from the reference toward `v`.
   *
   * INTERACTIVE references (doors, chests, crafting tables, …) are
   * avoided when any solid alternative exists: right-clicking them
   * ACTIVATES instead of placing — TestBot21 (2026-06-10) repeatedly
   * toggled its own front door trying to place the roof row above it,
   * and "placed" a chest into the crafting table's GUI. When only an
   * interactive face exists, return it flagged so the caller
   * sneak-places (sneak suppresses the activation, like a player).
   */
  _findReference(v) {
    let interactive = null;
    for (const { face } of FACE_DIRS) {
      // refPos = target - face: putting the new block at ref + face
      // (mineflayer's placeBlock contract) lands it exactly at target.
      const refPos = v.minus(face);
      const block = this.bot.blockAt(refPos);
      if (!block || block.name === 'air' || block.boundingBox === 'empty') continue;
      if (INTERACTIVE_REF.test(block.name)) {
        interactive ??= { block, face, interactive: true };
        continue;
      }
      return { block, face, interactive: false };
    }
    return interactive;
  }

  /**
   * Find an air block near `target` where the bot can stand (solid
   * support below, head clearance above). Same-y neighbors first,
   * then y±1 / +2. Candidates are sorted by distance from the bot's
   * current position so building snakes naturally instead of always
   * crossing back to the west side of every row.
   *
   * Also includes (dx=0, dz=0) at non-zero dy: the bot can stand
   * directly above the target (dy=+1, place downward) or below
   * (dy=-1, place upward). Skipping these previously made some
   * vertical fills impossible.
   */
  _findStanding(target) {
    const all = this._findAllStanding(target);
    return all.length > 0 ? all[0] : null;
  }

  /**
   * Same head/legs/ground checks as _findStanding, but returns every
   * valid standing pocket sorted by distance from the bot. Used by
   * _groupByStandingPosition to enumerate the candidate poses for
   * each placement so the bin-packing layer can pick a shared one.
   */
  _inFootprint(x, y, z) {
    return this._footprint?.has(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`) ?? false;
  }

  // Move the bot to a valid standing pose OUTSIDE the structure footprint.
  // Called once at build start: while the cells are still air the bot can
  // walk out freely; once it's boxed in by placed blocks it can't. No-op
  // if the bot is already standing clear of the footprint.
  async _stepOutOfFootprint(isCancelled) {
    const here = this.bot.entity?.position;
    if (!here || !this._footprint?.size) return;
    const fx = Math.floor(here.x), fy = Math.floor(here.y), fz = Math.floor(here.z);
    if (!this._inFootprint(fx, fy, fz) && !this._inFootprint(fx, fy - 1, fz)) return; // already clear
    for (let r = 1; r <= 6; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring perimeter
          for (let dy = 1; dy >= -2; dy--) {
            const x = fx + dx, y = fy + dy, z = fz + dz;
            // Feet+head must be clear of the footprint AND actually empty,
            // with solid ground below — a real spot to stand outside.
            if (this._inFootprint(x, y, z) || this._inFootprint(x, y + 1, z)) continue;
            const feet = this.bot.blockAt(new Vec3(x, y, z));
            const head = this.bot.blockAt(new Vec3(x, y + 1, z));
            const ground = this.bot.blockAt(new Vec3(x, y - 1, z));
            if (feet?.name !== 'air' || head?.name !== 'air') continue;
            if (!ground || ground.name === 'air' || ground.boundingBox === 'empty') continue;
            try {
              const h = this.movement.goTo({ x, y, z }, { timeoutMs: PATHFIND_TIMEOUT_MS, range: 0 });
              await h.done.catch(() => {});
            } catch (e) { this.log?.debug?.('step_out_pathfind_err', { msg: e.message }); }
            this.log?.info?.('blueprint_stepped_out_of_footprint', { to: { x, y, z } });
            return;
          }
        }
      }
    }
    this.log?.warn?.('blueprint_step_out_failed', { pos: { x: fx, y: fy, z: fz } });
  }

  _findAllStanding(target) {
    const candidates = [];
    for (const dy of [0, 1, -1, 2]) {
      for (const dx of [-1, 0, 1]) {
        for (const dz of [-1, 0, 1]) {
          if (dx === 0 && dz === 0 && dy === 0) continue;
          candidates.push({ x: target.x + dx, y: target.y + dy, z: target.z + dz });
        }
      }
    }
    const here = this.bot.entity?.position;
    if (here) {
      candidates.sort((a, b) => {
        const da = (a.x - here.x) ** 2 + (a.y - here.y) ** 2 + (a.z - here.z) ** 2;
        const db = (b.x - here.x) ** 2 + (b.y - here.y) ** 2 + (b.z - here.z) ** 2;
        return da - db;
      });
    }
    const valid = [];
    for (const c of candidates) {
      // Never stand where a structure block will go — the bot would be
      // placing into its own body (the build then hangs on placeBlock).
      // c.y is head, c.y-1 is legs (the standing cell).
      if (this._inFootprint(c.x, c.y, c.z) || this._inFootprint(c.x, c.y - 1, c.z)) continue;
      const head = this.bot.blockAt(new Vec3(c.x, c.y, c.z));
      const legs = this.bot.blockAt(new Vec3(c.x, c.y - 1, c.z));
      const ground = this.bot.blockAt(new Vec3(c.x, c.y - 2, c.z));
      if (!head || !legs || !ground) continue;
      if (head.name !== 'air') continue;
      if (legs.name !== 'air') continue;
      if (ground.name === 'air' || ground.boundingBox === 'empty') continue;
      valid.push({ x: c.x, y: c.y - 1, z: c.z });
    }
    return valid;
  }

  /**
   * Group placements into batches keyed by a shared standing pose.
   * From a single pose the bot can place every cell within ~4.5
   * blocks (Mineflayer's bot.placeBlock reach), so per-block pathfind
   * calls are wasted when adjacent cells share a standing pocket.
   *
   * Greedy bin-packing: for each placement, prefer to extend the
   * existing batch whose standing pose can reach this cell AND has
   * the most assigned blocks (4.0 conservative under the 4.5 limit).
   * Only fall back to a fresh standing search when no existing pose
   * reaches the cell.
   *
   * Air-token cells and cells with no standing pocket get their own
   * solo batches — they go through the per-block dig / in-reach path
   * anyway, so batching them adds no value.
   *
   * Final pass: nearest-neighbor reorder across batches so the bot
   * walks toward the next batch instead of zig-zagging the build.
   */
  _groupByStandingPosition(placements) {
    const batches = new Map();
    let soloCounter = 0;

    for (const p of placements) {
      if (p.blockName === null) {
        // Air token — handled by _maybeDigAir, not the place flow.
        batches.set(`solo:air:${soloCounter++}`,
          { standing: null, blocks: [p], airOnly: true });
        continue;
      }

      // Greedy: existing standing pose with the most assigned blocks
      // that's within 4.0 blocks of this cell wins.
      let bestKey = null;
      let bestCount = -1;
      for (const [key, batch] of batches) {
        if (!batch.standing) continue;
        const dx = batch.standing.x - p.world.x;
        const dy = batch.standing.y - p.world.y;
        const dz = batch.standing.z - p.world.z;
        if (Math.hypot(dx, dy, dz) > 4.0) continue;
        if (batch.blocks.length > bestCount) {
          bestKey = key;
          bestCount = batch.blocks.length;
        }
      }
      if (bestKey) {
        batches.get(bestKey).blocks.push(p);
        continue;
      }

      // No reusable standing — search for one near this cell.
      const candidates = this._findAllStanding(p.world);
      if (candidates.length === 0) {
        // Per-block fallback (in-reach check inside _placeOne) handles it.
        batches.set(`solo:nostand:${soloCounter++}`,
          { standing: null, blocks: [p] });
        continue;
      }
      const s = candidates[0];
      const k = `${s.x},${s.y},${s.z}`;
      // If this exact key is already taken (rare collision with a
      // solo-nostand entry can't happen since prefixes differ; with a
      // real entry it means the bin-packing loop above missed it,
      // which shouldn't occur), still merge into the existing batch
      // rather than overwrite.
      const existing = batches.get(k);
      if (existing && existing.standing) {
        existing.blocks.push(p);
      } else {
        batches.set(k, { standing: s, blocks: [p] });
      }
    }

    // Nearest-neighbor batch ordering from the bot's current pos so
    // the build walks contiguously instead of teleporting between
    // distant batches each iteration.
    const ordered = [];
    const remaining = [...batches.values()];
    const here = this.bot.entity?.position;
    let cursor = (here && Number.isFinite(here.x))
      ? { x: here.x, y: here.y, z: here.z }
      : null;

    while (remaining.length > 0) {
      let bestIdx = 0;
      if (cursor) {
        let bestD = Infinity;
        for (let i = 0; i < remaining.length; i++) {
          const ref = remaining[i].standing ?? remaining[i].blocks[0]?.world;
          if (!ref) continue;
          const d = (ref.x - cursor.x) ** 2
                  + (ref.y - cursor.y) ** 2
                  + (ref.z - cursor.z) ** 2;
          if (d < bestD) { bestD = d; bestIdx = i; }
        }
      }
      const next = remaining.splice(bestIdx, 1)[0];
      ordered.push(next);
      const cur = next.standing ?? next.blocks[0]?.world;
      if (cur) cursor = { x: cur.x, y: cur.y, z: cur.z };
    }
    return ordered;
  }

  // ---------- progress persistence ----------

  _saveProgress(blueprint, anchor, rotation, lastIndex, total) {
    if (!this.memory?.kvSet) return;
    try {
      this.memory.kvSet(KV_BUILD_PROGRESS, {
        blueprintId: blueprint.id,
        anchor, rotation,
        lastPlacedIndex: lastIndex,
        totalBlocks: total,
        startedAt: Date.now(),
      });
    } catch (e) {
      this.log?.debug?.('blueprint_save_progress_failed', { msg: e.message });
    }
  }

  _loadResumeIndex(blueprint, anchor) {
    if (!this.memory?.kvGet) return 0;
    const cur = this.memory.kvGet(KV_BUILD_PROGRESS, null);
    if (!cur) return 0;
    if (cur.blueprintId !== blueprint.id) return 0;
    if (!cur.anchor || cur.anchor.x !== anchor.x
        || cur.anchor.y !== anchor.y || cur.anchor.z !== anchor.z) return 0;
    return Math.max(0, Number(cur.lastPlacedIndex ?? 0));
  }

  _clearProgress() {
    if (!this.memory?.kvSet) return;
    try { this.memory.kvSet(KV_BUILD_PROGRESS, null); } catch {}
  }

  _markBuilt(id) {
    if (!this.memory?.kvGet || !this.memory?.kvSet) return;
    try {
      const cur = this.memory.kvGet(KV_BUILT_BLUEPRINTS, []) ?? [];
      const list = Array.isArray(cur) ? cur : [];
      if (!list.includes(id)) {
        list.push(id);
        this.memory.kvSet(KV_BUILT_BLUEPRINTS, list);
      }
    } catch (e) {
      this.log?.debug?.('blueprint_mark_built_failed', { msg: e.message });
    }
  }
}

/**
 * Map a block name to the tool family the bot should equip before
 * digging it. Returns null when the block is hand-breakable (we
 * don't bother swapping items) or when we don't know — let the
 * default in-hand item dig at whatever speed it manages.
 */
function _toolFamilyFor(name) {
  if (!name) return null;
  // Pickaxe family: stone, cobble, ore, mining byproducts, sandstone,
  // bricks, terracotta, obsidian, netherrack — anything with hardness
  // requiring a pickaxe.
  if (/(?:stone|cobblestone|sandstone|brick|terracotta|hardened_clay|obsidian|netherrack|granite|diorite|andesite|ore$)/.test(name)) {
    return 'pickaxe';
  }
  // Axe family: logs, planks, wooden things.
  if (/log|planks|fence|wood/.test(name)) return 'axe';
  // Shovel family: dirt-tier soft surfaces.
  if (/^(?:dirt|grass|sand|gravel|clay|mycelium|podzol|snow)$/.test(name)) return 'shovel';
  return null;
}
