/**
 * primitives.js — low-level mineflayer operations the agent's tools
 * (agent/tools/gather.js, jobs.js, perceive.js, door.js, …) build on:
 * mining with vein following, crafting and smelting with workstation
 * placement, block placing and digging, equipping, storing, inventory
 * counts, and the safe-search and drowning guards.
 *
 * Each primitive returns a { stop, done } handle; `done` resolves with
 * { success, reason, ...extra } and never rejects. The old stack's
 * blueprint, farm, water and explore primitives were deleted on
 * 2026-09-12; the agent re-implements those in its tools.
 *
 * Primitives are defensive: a mock bot, a missing entity, or an
 * un-loaded chunk should produce a clean `{ success: false, reason }`,
 * never an unhandled rejection. This is what lets us write structural
 * tests without a live server.
 */

import vec3Pkg from 'vec3';
import {
  RECIPES,
  TOOL_REQUIREMENTS,
  SMELTABLE,
  FUEL_VALUES,
} from './minecraft.js';
import {
  isInProtectedZone,
  isNearProtectedZone,
  pushOutsideProtection,
} from './zones.js';
import {
  classifyCell,
  entityInCell,
  placeAndVerify,
} from '../building/placeGuard.js';
import { withTransactionRetry } from './txnRetry.js';

const Vec3 = vec3Pkg.Vec3 ?? vec3Pkg;

// ---------------------------------------------------------------------
// Shared handle utility
// ---------------------------------------------------------------------

const DEFAULT_MAX_MS = 120_000;

function makeHandle(runner, { maxDurationMs = DEFAULT_MAX_MS } = {}) {
  let cancelled = false;
  let settled = false;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const ctl = {
    isCancelled: () => cancelled,
    resolve: (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(safety);
      resolveDone(v);
    },
  };
  const stop = () => {
    if (cancelled) return;
    cancelled = true;
    try { ctl.onCancel?.(); } catch {}
    if (!settled) ctl.resolve({ success: false, reason: 'cancelled' });
  };
  const safety = setTimeout(() => {
    if (settled) return;
    cancelled = true;
    try { ctl.onCancel?.(); } catch {}
    ctl.resolve({ success: false, reason: 'max_duration' });
  }, maxDurationMs);
  if (safety.unref) safety.unref();
  Promise.resolve()
    .then(() => runner(ctl))
    .catch((e) => ctl.resolve({ success: false, reason: 'exception:' + (e?.message ?? 'unknown') }));
  return { stop, done };
}

function syncFail(reason) {
  return {
    stop: () => {},
    done: Promise.resolve({ success: false, reason }),
  };
}

function checkBot(bot) {
  if (!bot) return syncFail('no_bot');
  if (!bot.entity) return syncFail('no_entity');
  return null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------
// Inventory helpers
// ---------------------------------------------------------------------

export function countInventory(bot) {
  const out = {};
  const items = bot?.inventory?.items?.() ?? [];
  for (const it of items) {
    if (!it?.name) continue;
    out[it.name] = (out[it.name] ?? 0) + (it.count ?? 1);
  }
  return out;
}

function findItem(bot, name) {
  const items = bot?.inventory?.items?.() ?? [];
  return items.find((i) => i?.name === name) ?? null;
}

// Inventory has 36 main slots (9 hotbar + 27 main). bot.inventory.items()
// returns only filled slots; each slot can stack the same item up to
// item.stackSize (usually 64). "Full" is the conservative case where
// every slot is filled AND none of them are partially-filled stacks of
// what we're about to pick up.
const TOTAL_INV_SLOTS = 36;
function canFitMoreOf(bot, itemName) {
  const inv = bot.inventory;
  if (!inv?.items) return true;
  const items = inv.items();
  if (items.length < TOTAL_INV_SLOTS) return true;       // empty slot somewhere
  // No empty slots — only fits if a partial stack of the target exists.
  return items.some((it) => {
    if (!it || it.name !== itemName) return false;
    const cap = it.stackSize ?? 64;
    return it.count < cap;
  });
}

// Items the bot is OK tossing on the ground when inventory needs a
// slot during an active mine.
//
// "Junk" = cheap, never load-bearing, easily re-mined. Cobblestone /
// stone / sandstone deliberately NOT here even though they're common
// — every progression goal (CRAFT_BASIC_TOOLS, ESTABLISH_BASE,
// BUILD_INCOME_FARM, GRIND_XP, DEFEND_BASE) burns 3-256 cobble, and
// dropping a hard-mined stack to make room for one extra ore loses
// minutes of travel-back-to-mine work. Mining byproducts like
// andesite/diorite/granite ARE here — they show up in the same
// stone-family scan but are essentially never consumed.
const JUNK_ITEMS = new Set([
  'dirt', 'gravel', 'sand',
  'andesite', 'diorite', 'granite', 'flint', 'rotten_flesh',
  'netherrack', 'cobblestone_wall', 'mossy_cobblestone', 'leaves',
  'oak_leaves', 'spruce_leaves', 'birch_leaves',
]);

// Placeable junk that doubles as emergency-pillar fodder. We keep a small
// reserve of these when dumping so _tryEmergencyPillarUp never strands the
// bot with emergency_pillar_up_no_blocks right after a junk dump.
const PLACEABLE_JUNK = new Set(['dirt', 'gravel', 'sand']);
const PILLAR_RESERVE = 8;

async function dropJunk(bot, preserve, log) {
  const items = bot.inventory?.items?.() ?? [];
  let dropped = 0;
  let reserved = 0;   // placeable blocks held back for pillaring
  for (const it of items) {
    if (!it?.name) continue;
    if (it.name === preserve) continue;
    if (!JUNK_ITEMS.has(it.name)) continue;
    let tossCount = it.count;
    if (PLACEABLE_JUNK.has(it.name) && reserved < PILLAR_RESERVE) {
      const keep = Math.min(it.count, PILLAR_RESERVE - reserved);
      reserved += keep;
      tossCount = it.count - keep;
    }
    if (tossCount <= 0) continue;
    const tres = await withTransactionRetry(bot, async () => {
      await bot.toss(it.type, null, tossCount);
    }, { log, label: 'toss' });
    if (tres.ok) dropped += tossCount;
    else log?.debug?.('drop_junk_err', { name: it.name, msg: tres.reason });
  }
  if (dropped > 0) log?.info?.('mine_dropped_junk', { dropped, preserved: preserve, reserved });
  return dropped;
}

// Quick check: does the bot's inventory cover every ingredient of the
// given recipe? Used by the auto-craft fallback in mineBlock so a
// pickaxe break doesn't strand the bot grinding bare-handed.
function hasAllIngredients(bot, recipe) {
  if (!recipe?.ingredients) return false;
  const inv = countInventory(bot);
  for (const [item, count] of Object.entries(recipe.ingredients)) {
    if ((inv[item] ?? 0) < count) return false;
  }
  return true;
}

/**
 * Try to craft a single instance of `toolName` from the bot's current
 * inventory. Returns true on success, false on any failure (missing
 * ingredients, no recipe, no crafting table reachable, etc.).
 *
 * Used by the mineBlock auto-recovery path: when the active pickaxe
 * breaks mid-grind, this attempts to craft a replacement before the
 * bot starts mining bare-handed (which is 10x slower for stone and
 * drops nothing for ores).
 */
async function attemptToolCraft(bot, toolName, log, opts = {}) {
  const recipe = RECIPES[toolName];
  if (!recipe) return false;
  if (!hasAllIngredients(bot, recipe)) return false;

  let tableBlock = null;
  if (recipe.tool_required === 'crafting_table') {
    tableBlock = safeFindBlock(bot, 'crafting_table', 8, null);
    if (!tableBlock) {
      const tableItem = findItem(bot, 'crafting_table');
      if (!tableItem) return false;
      const placeResult = await placeCraftingTable(bot, log);
      if (!placeResult.success) return false;
      tableBlock = bot.blockAt?.(placeResult.position)
        ?? safeFindBlock(bot, 'crafting_table', 8, null);
      if (!tableBlock) return false;
    }
    if (opts.movement?.goTo) {
      try {
        const h = opts.movement.goTo(
          { x: tableBlock.position.x, y: tableBlock.position.y, z: tableBlock.position.z },
          { timeoutMs: 12_000, range: 2 },
        );
        await h.done;
      } catch (e) {
        log?.debug?.('attempt_tool_craft_pathfind_skipped', { msg: e.message });
      }
    }
  }

  const itemDef = bot.registry?.itemsByName?.[toolName];
  if (!itemDef) return false;

  let recipes;
  try { recipes = bot.recipesFor(itemDef.id, null, 1, tableBlock) ?? []; }
  catch { return false; }
  if (!recipes.length) return false;

  const before = countInventory(bot)[toolName] ?? 0;
  const outPer = RECIPES[toolName]?.output_count > 0 ? RECIPES[toolName].output_count : 1;
  const target = before + outPer;
  const res = await withTransactionRetry(bot, async () => {
    if ((countInventory(bot)[toolName] ?? 0) >= target) return;
    await bot.craft(recipes[0], 1, tableBlock);
  }, {
    verify: () => (countInventory(bot)[toolName] ?? 0) >= target,
    log, label: 'tool_craft',
  });
  if (!res.ok) {
    log?.debug?.('attempt_tool_craft_failed', { tool: toolName, msg: res.reason });
    return false;
  }

  log?.info?.('tool_auto_crafted', { tool: toolName });
  return true;
}

/**
 * Make sure the bot has a usable tool for `blockName`. Returns true if
 * the block is hand-breakable, the bot already owns a suitable tool,
 * or a replacement was successfully crafted from inventory. Returns
 * false only when a specific tool tier is required and no path to
 * obtain one is available right now.
 *
 * Stepping-stone case: stone_pickaxe needs cobblestone, which itself
 * needs a wooden_pickaxe to mine. If cobblestone is unavailable we
 * craft a wooden_pickaxe first, mine 3 cobble with it, then loop back
 * around to craft the stone_pickaxe.
 */
async function ensureToolForBlock(bot, blockName, log, opts = {}) {
  const requiredTool = TOOL_REQUIREMENTS[blockName]?.tool;
  if (!requiredTool) return true;          // hand-breakable
  if (bestToolFor(bot, blockName)) return true;

  const family =
    requiredTool.endsWith('_pickaxe') ? 'pickaxe'
    : requiredTool.endsWith('_axe')   ? 'axe'
    : requiredTool.endsWith('_shovel') ? 'shovel'
    : requiredTool.endsWith('_sword')  ? 'sword'
    : null;

  if (!family) {
    // Non-tiered tool (shears, fishing_rod, …) — direct attempt.
    return await attemptToolCraft(bot, requiredTool, log, opts);
  }

  const TIERS = ['wooden', 'stone', 'iron', 'diamond'];
  const requiredTier = requiredTool.split('_')[0];
  const minIdx = Math.max(0, TIERS.indexOf(requiredTier));

  for (let i = 0; i < TIERS.length; i++) {
    if (i < minIdx) continue;             // weaker tiers can't break this block
    const toolName = `${TIERS[i]}_${family}`;
    const recipe = RECIPES[toolName];
    if (!recipe) continue;
    if (!hasAllIngredients(bot, recipe)) continue;
    if (await attemptToolCraft(bot, toolName, log, opts)) return true;
  }

  // Stepping stone: stone_pickaxe needs cobblestone, but cobblestone
  // requires a wooden_pickaxe to mine. Craft a wooden one, dig some
  // cobble, then upgrade.
  if (requiredTool === 'stone_pickaxe') {
    const inv = countInventory(bot);
    if ((inv.cobblestone ?? 0) < 3
        && hasAllIngredients(bot, RECIPES.wooden_pickaxe)) {
      const okWood = await attemptToolCraft(bot, 'wooden_pickaxe', log, opts);
      if (okWood) {
        try {
          const mineHandle = mineBlock(bot, { blockName: 'stone', count: 3 }, opts);
          await mineHandle.done;
        } catch (e) { log?.debug?.('ensure_tool_mine_cobble_err', { msg: e.message }); }
        if (await attemptToolCraft(bot, 'stone_pickaxe', log, opts)) return true;
      }
    }
  }

  return false;
}

function bestToolFor(bot, blockName) {
  const need = TOOL_REQUIREMENTS[blockName]?.tool ?? null;
  if (!need) return null;
  // Walk diamond → wood; pick the best tier we own.
  const family = need.endsWith('_pickaxe') ? 'pickaxe'
    : need.endsWith('_axe')   ? 'axe'
    : need.endsWith('_shovel') ? 'shovel'
    : need.endsWith('_sword') ? 'sword'
    : null;
  if (!family) return findItem(bot, need);
  for (const tier of ['diamond', 'iron', 'stone', 'wooden']) {
    const it = findItem(bot, `${tier}_${family}`);
    if (it) return it;
  }
  return findItem(bot, need);
}

// ---------------------------------------------------------------------
// 1. mineBlock
// ---------------------------------------------------------------------

// Default wander Y per block family. A bot looking for stone underground
// won't find any at surface level, so the wander step needs to descend
// toward where that block actually exists. Ores live around y=11; bulk
// stone is everywhere underground but y=40 is shallow enough to avoid
// lava and ore-distractions. Logs/dirt stay at surface (null = same-Y).
// Mining depth floor. 1.8's lava flood level is y≤10 — at y=11 the
// bot mines THROUGH lava-lake territory with every horizontal step
// (TestBot22 died in lava at exactly y=10). Diamonds spawn up to
// y=15, so y=12 keeps the loot and skips the swimming.
export const MIN_MINING_Y = 12;

function defaultTargetY(blockName) {
  if (!blockName) return null;
  if (/_ore$/.test(blockName) || blockName === 'ancient_debris') return MIN_MINING_Y;
  if (blockName === 'stone' || blockName === 'cobblestone'
      || blockName === 'andesite' || blockName === 'diorite' || blockName === 'granite') {
    return 40;
  }
  return null;
}

// Lava behind any face of a block floods the cell the instant it's
// dug. The search-time filter (safeFindBlock) catches lava-adjacent
// TARGETS, but blocks dug en route — and targets whose surroundings
// changed since the search — need a check at dig time.
function digWouldFlood(bot, block) {
  const pos = block?.position;
  if (!pos?.offset) return false;
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const nb = bot.blockAt?.(pos.offset(dx, dy, dz));
    if (nb && (nb.name === 'lava' || nb.name === 'flowing_lava')) return true;
  }
  return false;
}

// Reaching a mining target puts the bot NEAR it (collectBlock pathfinds to
// a reachable adjacent cell via GoalLookAtBlock, then digs the visible
// face). The drown livelock (TestBot40) comes from CHOOSING a target whose
// own column is submerged ocean/pool floor — the bot then pathfinds INTO
// the water to reach it, the anti-drown reflex cancels the task, the
// planner re-picks the same wet block, repeat. We reject those at SEARCH
// time so a submerged block is never the nearest legal candidate.
//
// IMPORTANT: this checks ONLY the target's own cell + the cell directly
// above it (its column). It deliberately does NOT look at horizontal
// neighbours — a dry block beside a river / beach pool is a legitimate
// shore mine and MUST stay selectable. A null block (unloaded chunk) is
// treated as NOT water, so we never spuriously reject targets at a chunk
// border (mirrors digWouldFlood's null tolerance).
export function targetSubmerged(bot, pos) {
  if (!pos?.offset || typeof bot.blockAt !== 'function') return false;
  const wet = (b) => !!b && (b.name === 'water' || b.name === 'flowing_water');
  return wet(bot.blockAt(pos)) || wet(bot.blockAt(pos.offset(0, 1, 0)));
}

// Dig-time drown guard. Unlike the search filter (which models the target's
// column), this reads the bot's ACTUAL head cell — "am I standing
// submerged right now?" — the single-source-of-truth condition, identical
// to what mobScanner._handleDrowning keys off (headInWater). Ankle-deep
// mining (feet wet, head DRY) never drowns and stays ALLOWED; only a
// submerged HEAD is skipped. A null head cell counts as not drowning.
export function standingWouldDrown(bot) {
  if (typeof bot.blockAt !== 'function') return false;
  const p = bot.entity?.position;
  if (!p?.offset) return false;
  const head = bot.blockAt(p.offset(0, 1, 0));
  return !!head && (head.name === 'water' || head.name === 'flowing_water');
}

// Two ore blocks belong to the same vein if they're the same block — with
// redstone's lit/unlit states folded together (1.8 toggles redstone_ore ↔
// lit_redstone_ore when stepped on / mined nearby).
export function sameOreFamily(name, target) {
  if (!name || !target) return false;
  if (name === target) return true;
  const norm = (n) => n.replace(/^lit_/, '');
  return norm(name) === norm(target);
}

/**
 * BFS-dig the ore vein connected to `origin` (just-mined). Bounded by `max`
 * blocks and the inventory-fit / lava / drown / protected-zone guards — the
 * same ones the main mine loop applies pre-dig. Returns how many EXTRA blocks
 * were mined (beyond the origin, which the caller already counted).
 */
export async function mineConnectedVein(bot, origin, oreName, { log = null, expectedDrop = null, isCancelled = null, max = 32, minY = MIN_MINING_Y - 1 } = {}) {
  if (!origin || typeof bot.blockAt !== 'function') return 0;
  let extra = 0;
  const seen = new Set();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const queue = [];
  const pushNeighbors = (pos) => {
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const np = { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz };
          // Never follow a vein below the lava floor. The target search
          // already respects MIN_MINING_Y; the vein walk didn't, and chased
          // iron down to y 10 into a lava lake (TestBot44, 2026-09-03).
          if (Number.isFinite(minY) && np.y < minY) continue;
          if (!seen.has(key(np))) queue.push(np);
        }
  };
  seen.add(key(origin));
  pushNeighbors(origin);
  while (queue.length && extra < max) {
    if (isCancelled?.()) break;
    const np = queue.shift();
    const k = key(np);
    if (seen.has(k)) continue;
    seen.add(k);
    const b = bot.blockAt(new Vec3(np.x, np.y, np.z));
    if (!b || !sameOreFamily(b.name, oreName)) continue;
    if (expectedDrop && !canFitMoreOf(bot, expectedDrop)) break;
    if (standingWouldDrown(bot)) break;
    if (digWouldFlood(bot, b)) continue;
    if (isInProtectedZone(b.position)) continue;
    try {
      if (bot.collectBlock?.collect) await bot.collectBlock.collect(b);
      else if (bot.canDigBlock?.(b)) await bot.dig(b);
      else continue;
      extra++;
      pushNeighbors(np);   // expand from the freshly-cleared ore
    } catch (e) {
      log?.debug?.('vein_dig_failed', { msg: e?.message });
    }
  }
  if (extra > 0) log?.info?.('mine_vein_finished', { ore: oreName, extra });
  return extra;
}

export function mineBlock(bot, params = {}, opts = {}) {
  const bad = checkBot(bot); if (bad) return bad;
  const {
    blockName,
    count = 1,
    maxSearchRadius = 64,
    yRange = null,
    targetY: targetYRaw = defaultTargetY(blockName),
    // After digging an ore block, finish the connected vein even past `count`
    // — a real player clears the whole 8-block vein, not just the 3 they
    // "needed". Default on for ore; harmless for non-ore (gated below).
    finishVein = true,
  } = params;
  // Depth floor applies to EXPLICIT targets too — a planner-supplied
  // y=11 is the same lava-lake territory as the old default.
  const targetY = Number.isFinite(targetYRaw)
    ? Math.max(MIN_MINING_Y, targetYRaw)
    : targetYRaw;
  const log = opts.log;
  const movement = opts.movement;
  if (!blockName) return syncFail('no_blockName');

  // Scale the safety timeout to the requested count. ~6 s per block of
  // mining headroom plus a 30 s base for pathfinding + tool equip.
  // Without this, a count=256 GRIND_XP task hit the default 2-minute
  // safety after ~24 blocks and the bot just stopped.
  //
  // Logs get a bigger floor than the generic 60 s. A tree hunt uses
  // 80-block wander steps and up to 6 wanders (vs 48/4 for everything
  // else), so a cold-start hunt can spend ~2 min just travelling between
  // biomes before it even reaches a forest. The old 60 s floor expired
  // mid-travel — the bot timed out EN ROUTE to the trees it was heading
  // for (observed 2026-06-04, TestBot4 CRAFT_BASIC_TOOLS: 3 wander hops
  // burned the full 60 s, max_duration fired before it arrived). 150 s
  // covers all 6 wanders plus arrival + dig.
  const isLogTarget = blockName === 'log' || blockName === 'log2';
  const minBudgetMs = isLogTarget ? 150_000 : 60_000;
  // Deep-target descent budget. Ore lives at y~11; reaching it from the
  // surface needs a CHUNKED dig-descent (see the descent branch below)
  // because the pathfinder can't solve a single 50-block dig goal in
  // its think-timeout. Each ~8-block chunk is a ~15s pathfind, so a
  // surface→y11 descent can take ~100s before mining even starts. Give
  // deep mines that headroom up front; surface blocks get nothing.
  const DESCENT_THRESHOLD = 6;   // only descend if target is >6 below us
  const DESCENT_CHUNK = 8;       // blocks per pathfinder-solvable step
  const MAX_DESCENTS = 12;       // ~96 blocks of descent before giving up
  const startY = bot.entity?.position?.y;
  const descentMs = (typeof targetY === 'number' && Number.isFinite(startY)
    && startY - targetY > DESCENT_THRESHOLD)
    ? Math.min(180_000, Math.round((startY - targetY) * 2500))
    : 0;
  const maxDurationMs = opts.maxDurationMs
    ?? Math.max(minBudgetMs, count * 6000 + 30_000 + descentMs);

  return makeHandle((ctl) => {
    ctl.onCancel = () => {
      try { bot.collectBlock?.cancelTask?.(); } catch {}
      try { movement?.cancel?.(); } catch {}
    };
    (async () => {
      const collected = {};
      let mined = 0;
      let scans = 0;
      let wanders = 0;
      let descents = 0;   // chunked dig-descents toward a deep targetY
      // Bounded perception short-circuit. Perception's nearbyBlocks scan
      // (perception.js) has NO yRange and NO protected-zone filter, while
      // safeFindBlock rejects both. So when the only visible deposit sits
      // inside the spawn safezone (or outside the mining yRange),
      // perception reports it forever, the short-circuit resets scans, and
      // the loop livelocks — wanders never increments (the symptom is a
      // flood of mine_wander_skip_perception at wanderIdx 1). Cap the free
      // retries so we eventually fall through to wander → block_not_found
      // and let the bot relocate / the model re-decide.
      let perceptionSkips = 0;
      const MAX_PERCEPTION_SKIPS = 2;
      const MAX_SCANS_PER_SPOT = 2;
      // Logs are rare in plains/desert/ocean-shore biomes, so a tree
      // hunt can need to walk much farther than ore-spotting. Prefer
      // fewer, longer steps with more candidates per attempt — many
      // small wanders all land inside the same biome and fail
      // identically. Bigger leaps + more directional candidates is
      // more likely to cross a biome boundary.
      const isLog = blockName === 'log' || blockName === 'log2';
      const MAX_WANDERS = isLog ? 6 : 4;
      const WANDER_CANDIDATES = 12;
      const WANDER_STEP = isLog ? 80 : 48;
      const visitedPositions = opts.visitedPositions ?? null;
      const perception = opts.perception ?? null;
      // Executor-owned TTL avoid-set of confirmed drown cells (written by
      // the mobScanner reflex on a real mining-in-water loop). Mining-only.
      const drownSpots = opts.drownSpots ?? null;
      // Best-effort guess at what we'll pick up (used by the
      // inventory-fit check + junk dropper). For ores like 'iron_ore'
      // the drop is the ore item; for 'stone' the drop is cobblestone.
      const expectedDrop = TOOL_REQUIREMENTS[blockName]?.drops ?? blockName;
      while (!ctl.isCancelled() && mined < count) {
        if (!canFitMoreOf(bot, expectedDrop)) {
          // Try to free a slot by tossing junk. If we drop ANY items,
          // re-check; otherwise give up with what we got.
          const dropped = await dropJunk(bot, expectedDrop, log);
          if (dropped === 0 || !canFitMoreOf(bot, expectedDrop)) {
            return ctl.resolve({
              success: mined > 0,
              reason: 'inventory_full',
              collected,
              mined,
            });
          }
        }
        // If our pickaxe broke (or we never had one), try to craft a
        // replacement from inventory before continuing. Otherwise we'd
        // mine bare-handed: 10x slower for stone, zero drops for ores.
        const toolOk = await ensureToolForBlock(bot, blockName, log, opts);
        if (!toolOk) {
          const requiredTool = TOOL_REQUIREMENTS[blockName]?.tool;
          if (requiredTool) {
            return ctl.resolve({
              success: mined > 0,
              reason: mined > 0 ? 'partial' : 'no_tool',
              collected, mined,
            });
          }
          // Hand-breakable — fall through and continue.
        }
        const block = safeFindBlock(bot, blockName, maxSearchRadius, yRange, drownSpots, movement?.getBaseStructureCells?.());
        if (!block) {
          scans++;
          if (scans >= MAX_SCANS_PER_SPOT) {
            // Descent phase. For a deep target (ore at y~11) when we're
            // well above it, dig DOWN in small pathfinder-solvable
            // chunks BEFORE searching horizontally. A single goTo to
            // y=11 from the surface blows the think-timeout ("Took to
            // long to decide path"); ~8-block chunks resolve fine and
            // the pathfinder digs a safe descent (canDig, maxDropDown=3,
            // lava-avoidant). The bot then strip-searches at depth and
            // STAYS there for later ore, so the descent is paid once
            // per trip. Has its own budget so it isn't starved by the
            // horizontal MAX_WANDERS cap.
            const dHere = bot.entity?.position;
            // Snapshot the starting Y as a PRIMITIVE — `dHere` is the
            // live position object, so reading `dHere.y` again after the
            // move would reflect the NEW y and make the progress check
            // always read ~0 (false "stalled" every chunk).
            const beforeY = dHere?.y;
            if (dHere && movement?.goTo
                && typeof targetY === 'number'
                && Number.isFinite(beforeY)
                && beforeY - targetY > DESCENT_THRESHOLD
                && descents < MAX_DESCENTS) {
              const chunkY = Math.max(targetY, Math.round(beforeY - DESCENT_CHUNK));
              // Lava guard: never dig the descent column down toward
              // lava — breaking into a lava pocket dumps it on the bot.
              // Probe this chunk's column; if lava is in it, stop
              // descending and mine best-effort at the current depth.
              let lavaInColumn = false;
              if (typeof bot.blockAt === 'function') {
                const cx = Math.round(dHere.x), cz = Math.round(dHere.z);
                for (let y = Math.floor(beforeY); y >= chunkY - 1; y--) {
                  const cb = bot.blockAt(new Vec3(cx, y, cz));
                  if (cb && (cb.name === 'lava' || cb.name === 'flowing_lava')) {
                    lavaInColumn = true; break;
                  }
                }
              }
              if (lavaInColumn) {
                log?.info?.('mine_descend_lava_abort', {
                  at_y: Math.round(beforeY), targetY,
                });
                descents = MAX_DESCENTS; // stop descending; mine at this depth
                scans = 0;
                continue;
              }
              // Water-in-column guard (symmetric to lava): a bot standing in
              // a surface pool with a deep targetY (cobblestone→40) must NOT
              // dig straight DOWN — that breaches more water into the dig
              // column and worsens the drown. Abort descent so control falls
              // through to the horizontal wander, which relocates the bot to
              // dry ground. Also fires when the bot's own feet/head is wet.
              let waterInColumn = false;
              if (typeof bot.blockAt === 'function') {
                const cx2 = Math.round(dHere.x), cz2 = Math.round(dHere.z);
                const wet = (b) => !!b && (b.name === 'water' || b.name === 'flowing_water');
                const feet = bot.blockAt(new Vec3(cx2, Math.floor(beforeY), cz2));
                const head = bot.blockAt(new Vec3(cx2, Math.floor(beforeY) + 1, cz2));
                if (wet(feet) || wet(head)) waterInColumn = true;
                else {
                  for (let y = Math.floor(beforeY); y >= chunkY - 1; y--) {
                    if (wet(bot.blockAt(new Vec3(cx2, y, cz2)))) { waterInColumn = true; break; }
                  }
                }
              }
              if (waterInColumn) {
                log?.info?.('mine_descend_water_abort', {
                  at_y: Math.round(beforeY), targetY,
                });
                descents = MAX_DESCENTS; // stop descending; fall to wander
                scans = 0;
                continue;
              }
              // Own-structure guard: never dig the descent column through the
              // bot's own floor/walls (it mined a shaft through its hut floor,
              // TestBot44 2026-09-03). The pathfinder's break exclusion covers
              // planned digs, but the goal itself must not sit under the house.
              let ownInColumn = false;
              if (movement?.isOwnBlock) {
                const cx3 = Math.round(dHere.x), cz3 = Math.round(dHere.z);
                for (let y = Math.floor(beforeY) - 1; y >= chunkY - 1; y--) {
                  if (movement.isOwnBlock({ x: cx3, y, z: cz3 })) { ownInColumn = true; break; }
                }
              }
              if (ownInColumn) {
                log?.info?.('mine_descend_own_structure_abort', {
                  at_y: Math.round(beforeY), targetY,
                });
                descents = MAX_DESCENTS; // stop descending; fall to wander
                scans = 0;
                continue;
              }
              const dTarget = { x: Math.round(dHere.x), y: chunkY, z: Math.round(dHere.z) };
              log?.info?.('mine_descend_step', {
                blockName, from_y: Math.round(beforeY), to_y: chunkY,
                targetY, descentIdx: descents + 1,
              });
              try {
                const h = movement.goTo(dTarget, { timeoutMs: 20_000, range: 1 });
                ctl.onCancel = () => {
                  try { h.stop?.(); } catch {}
                  try { bot.collectBlock?.cancelTask?.(); } catch {}
                };
                await h.done;
              } catch (e) { log?.debug?.('mine_descend_err', { msg: e.message }); }
              const afterY = bot.entity?.position?.y ?? beforeY;
              descents++;
              scans = 0;
              // No vertical progress → the way down is blocked
              // (lava/bedrock). Stop descending and mine best-effort at
              // this depth rather than retrying a doomed chunk.
              if (beforeY - afterY < 1) {
                log?.info?.('mine_descend_stalled', {
                  at_y: Math.round(afterY), targetY,
                });
                descents = MAX_DESCENTS;
              }
              continue;
            }
            // Nothing nearby — try walking 32 blocks in a random
            // direction. A bot that just respawned in a cave or in an
            // empty biome will often need to relocate before it finds
            // logs / iron / etc.
            if (wanders >= MAX_WANDERS) {
              return ctl.resolve({
                success: mined > 0,
                reason: mined > 0 ? 'partial' : 'block_not_found',
                collected,
                mined,
              });
            }
            const here = bot.entity?.position;
            if (here && movement?.goTo) {
              // Perception-aware short-circuit: if the tactical
              // perception layer can see the target block within 8
              // blocks, the wander loop is wrong — relocating away
              // would lose ground. Reset the scan counter so
              // safeFindBlock gets another shot before we leave.
              if (perception?.read && perceptionSkips < MAX_PERCEPTION_SKIPS) {
                try {
                  const snap = perception.read();
                  const hits = snap?.nearbyBlocks ?? {};
                  const aliases = NAME_ALIASES[blockName] ?? new Set([blockName]);
                  const visible = [...aliases].some((n) => hits[n]);
                  if (visible) {
                    perceptionSkips++;
                    log?.info?.('mine_wander_skip_perception', {
                      blockName, wanderIdx: wanders + 1,
                      skip: perceptionSkips, maxSkip: MAX_PERCEPTION_SKIPS,
                    });
                    scans = 0;
                    await sleep(500);
                    continue;
                  }
                } catch (e) {
                  log?.debug?.('mine_perception_err', { msg: e.message });
                }
              } else if (perceptionSkips >= MAX_PERCEPTION_SKIPS) {
                // Perception keeps reporting a block safeFindBlock can't
                // mine (safezone / out-of-yRange). Stop trusting it and
                // wander away so the bot stops spinning in place.
                log?.info?.('mine_wander_perception_exhausted', {
                  blockName, skips: perceptionSkips,
                });
              }
              // Generate N candidate directions and pick the one
              // farthest from recent visits. With no visited data we
              // fall back to a single random direction (cold-start
              // parity with the previous behavior).
              //
              // For underground blocks (stone, ores) we step Y down
              // toward `targetY` instead of staying at surface — the
              // old same-Y wander would loop sideways forever for a
              // bot starting at y=64 looking for stone.
              const candidates = [];
              const wanderY = (typeof targetY === 'number')
                ? Math.round(here.y + Math.sign(targetY - here.y) * Math.min(
                    Math.abs(targetY - here.y), WANDER_STEP))
                : Math.round(here.y);
              // Directional probe: ask findBlock once per cardinal
              // direction with a shifted center, see which (if any)
              // turn up the target. The first probe that hits seeds a
              // single biased candidate; misses fall through to the
              // random ring. This is one extra findBlock call per
              // direction at most — cheap relative to the 20s
              // pathfind that follows.
              const biased = probeDirections(bot, blockName, here, WANDER_STEP, wanderY, log);
              for (let i = 0; i < WANDER_CANDIDATES; i++) {
                const angle = Math.random() * Math.PI * 2;
                let cx = Math.round(here.x + Math.cos(angle) * WANDER_STEP);
                let cz = Math.round(here.z + Math.sin(angle) * WANDER_STEP);
                // If a candidate falls inside a protected zone, push
                // it to the zone's edge. Without this, a bot whose
                // home anchored to actualSpawn (inside the world-guard
                // safezone) generates candidates that sit on top of
                // spawn, pathfinds there, then 0-bytes when it tries
                // to dig. Worst case the pushed candidate exits the
                // ring with the same bearing — strictly better than
                // a doomed spawn target.
                if (isInProtectedZone({ x: cx, z: cz })) {
                  const out = pushOutsideProtection({ x: cx, z: cz }, 16);
                  cx = out.x;
                  cz = out.z;
                }
                candidates.push({ x: cx, y: wanderY, z: cz });
              }
              if (biased) candidates.unshift(biased);
              const recent = visitedPositions?.recent
                ? visitedPositions.recent({ sinceMs: 3 * 3600_000, limit: 80 })
                : [];
              const target = biased
                ? biased
                : (visitedPositions?.farthestFrom
                    ? visitedPositions.farthestFrom(candidates, recent, here)
                    : candidates[0]);
              log?.info?.('mine_wander_search', {
                blockName, target, wanderIdx: wanders + 1,
                bias: biased ? 'directional' : (recent.length ? 'visited_aware' : 'random'),
                targetY: typeof targetY === 'number' ? targetY : null,
              });
              try {
                const h = movement.goTo(target, { timeoutMs: 20_000, range: 4 });
                ctl.onCancel = () => {
                  try { h.stop?.(); } catch {}
                  try { bot.collectBlock?.cancelTask?.(); } catch {}
                };
                await h.done;
              } catch (e) { log?.debug?.('mine_wander_err', { msg: e.message }); }
              wanders++;
              scans = 0;
              continue;
            }
            // No movement available — fall through to fail.
            return ctl.resolve({
              success: mined > 0,
              reason: mined > 0 ? 'partial' : 'block_not_found',
              collected,
              mined,
            });
          }
          await sleep(1500);
          continue;
        }
        scans = 0;
        // Equip best tool for the block.
        const tool = bestToolFor(bot, block.name);
        if (tool) {
          const teq = await withTransactionRetry(bot, async () => {
            await bot.equip(tool, 'hand');
          }, { isCancelled: () => ctl.isCancelled(), log, label: 'equip' });
          if (!teq.ok && !teq.cancelled) log?.debug?.('equip_failed', { msg: teq.reason });
        }
        // Dig-time lava check: the world (or our knowledge of it) may
        // have changed since the search filtered this candidate.
        if (digWouldFlood(bot, block)) {
          log?.info?.('mine_skip_lava_adjacent', {
            pos: { x: block.position.x, y: block.position.y, z: block.position.z },
          });
          scans++;          // counts toward the wander/give-up budget
          continue;
        }
        // Dig-time DROWN guard: if the bot's HEAD is currently submerged,
        // don't START a new dig (collectBlock would path us deeper) — wait
        // for the anti-drown reflex to surface/cancel us. This keys off the
        // bot's ACTUAL cell (not the target column), so ankle-deep / shore
        // mining is unaffected (only a submerged head waits). The short
        // sleep makes this a ~2 Hz wait rather than a busy re-search spin
        // (safeFindBlock keeps returning the same nearest block, and the
        // found-block path resets `scans` to 0, so scans++ can't relocate
        // us here — the reflex is what gets us out).
        if (standingWouldDrown(bot)) {
          log?.info?.('mine_skip_submerged', {
            pos: { x: block.position.x, y: block.position.y, z: block.position.z },
          });
          await sleep(500);
          continue;
        }
        // Dig-time protection check: the server denies breaks inside the
        // spawn safezone/warzone. safeFindBlock filters search candidates,
        // but a resite/relocate or a stale candidate can still land here —
        // skip rather than hammer world-guard (TestBot37 dug ~30x denied).
        if (isInProtectedZone(block.position)) {
          log?.info?.('mine_skip_protected', {
            pos: { x: block.position.x, y: block.position.y, z: block.position.z },
          });
          scans++;
          continue;
        }
        // Pathfind near + dig + collect via the collectBlock plugin.
        try {
          if (bot.collectBlock?.collect) {
            await bot.collectBlock.collect(block);
          } else if (bot.canDigBlock?.(block)) {
            await bot.dig(block);
          } else {
            return ctl.resolve({ success: false, reason: 'cant_dig', collected, mined });
          }
          mined++;
          // A successful mine resets the wander counter so the bot
          // doesn't bail mid-grind after 3 ore-poor pockets across an
          // otherwise productive vein run. Reset the perception-skip
          // budget too: a real mine proves the visible deposit IS
          // reachable, so the next pocket deserves a fresh look.
          wanders = 0;
          perceptionSkips = 0;
          // Track drops by reading inventory delta of the expected drop
          // name from TOOL_REQUIREMENTS; default to the block name.
          const dropName = TOOL_REQUIREMENTS[block.name]?.drops ?? block.name;
          collected[dropName] = (collected[dropName] ?? 0) + 1;
          // Vein flood-fill: ore clusters, so finish the connected vein while
          // we're standing here instead of taking the quota and leaving the
          // rest (the "mine 3 of an 8-vein" complaint). Ore-only, bounded,
          // and re-uses the same lava/water/protected/inventory guards. May
          // exceed `count` — that's the intent — which then exits the loop.
          if (finishVein && /_ore$/.test(block.name)) {
            const extra = await mineConnectedVein(bot, block.position, block.name, {
              log, expectedDrop, isCancelled: () => ctl.isCancelled(),
              // The caller's y floor (agent passes 12 for ore) bounds the vein walk too.
              minY: Number.isFinite(yRange?.min) ? yRange.min : MIN_MINING_Y - 1,
            });
            if (extra > 0) {
              mined += extra;
              collected[dropName] = (collected[dropName] ?? 0) + extra;
            }
          }
        } catch (e) {
          const msg = e?.message ?? '';
          // collectBlock tries to DEPOSIT to a chest when the inventory
          // fills mid-collect; with no chestLocations configured it
          // throws "There are no defined chest locations!". Our catch
          // used to just log + retry, which loops forever on the same
          // full inventory (observed 2026-06-04, TestBot4: 155x in
          // 130s). Treat it as a clean inventory_full stop so the
          // planner can drop the task / the bot can go stash or dump
          // junk instead of spinning.
          if (/chest location|inventory is full/i.test(msg)) {
            log?.info?.('mine_inventory_full_no_chest', { mined });
            return ctl.resolve({
              success: mined > 0, reason: 'inventory_full', collected, mined,
            });
          }
          log?.debug?.('mine_step_failed', { msg });
          await sleep(800);
        }
      }
      ctl.resolve({
        success: mined >= count,
        reason: ctl.isCancelled() ? 'cancelled' : 'done',
        collected,
        mined,
      });
    })().catch((e) => ctl.resolve({ success: false, reason: 'exception:' + e.message }));
  }, { maxDurationMs });
}

// 1.8.9 splits trees across two block IDs: vanilla 'log' covers
// oak/spruce/birch/jungle (variants encoded in metadata) while 'log2'
// covers acacia/dark_oak. Treat them as the same target so a bot
// looking for "log" doesn't ignore an acacia stand.
const NAME_ALIASES = {
  log:  new Set(['log', 'log2']),
  log2: new Set(['log', 'log2']),
  // Surface dirt is almost always under a grass block, which drops dirt.
  // Without this alias "mine dirt" on the surface wanders for a minute
  // looking for an exposed dirt face (TestBot44, 2026-09-02: 60 s timeout,
  // 0 mined) while standing on a field of it.
  dirt: new Set(['dirt', 'grass']),
};

export function safeFindBlock(bot, name, maxDistance, yRange, drownSpots = null, baseCells = null) {
  const aliases = NAME_ALIASES[name];
  // Mining a block with lava behind any face floods the freshly-dug
  // cell — the single most common way bots die at diamond level.
  // Filter lava-adjacent candidates out of every block search; only
  // candidates that already passed the name check pay the 6 reads.
  const lavaAdjacent = (pos) => {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const nb = bot.blockAt?.(pos.offset?.(dx, dy, dz));
      if (nb && (nb.name === 'lava' || nb.name === 'flowing_lava')) return true;
    }
    return false;
  };
  try {
    return bot.findBlock?.({
      matching: (b) => {
        if (!b) return false;
        const nameOk = aliases ? aliases.has(b.name) : b.name === name;
        if (!nameOk) return false;
        if (yRange && (b.position.y < yRange.min || b.position.y > yRange.max)) return false;
        // World-guard rejects break/place inside the spawn safezone +
        // warzone. Filter those positions out of every block search so
        // the bot doesn't pathfind to a deposit it can never mine.
        if (isInProtectedZone(b.position)) return false;
        if (lavaAdjacent(b.position)) return false;
        // Reject candidates sitting IN a water column (ocean floor / surface
        // pool): reaching them puts the bot underwater and trips the drown
        // reflex. Column-only — a dry block beside a river stays selectable.
        if (targetSubmerged(bot, b.position)) return false;
        // Reject candidates at/near a cell where we recently confirmed a
        // mining-in-water loop (mobScanner-recorded). Filtering here (not
        // just at dig time) makes the search pick a DIFFERENT dry target
        // and actually relocate, instead of re-finding the same blacklisted
        // block every scan. TTL-bounded, so a drained pool reopens later.
        if (drownSpots?.isNear?.(b.position)) return false;
        // Don't mine the bot's OWN base walls. After completion the
        // during-build material reservation goes silent, so without this the
        // bot will cannibalize its finished shelter for cobble/dirt. Same
        // live Set the pathfinder routes around.
        if (baseCells?.has?.(`${b.position.x},${b.position.y},${b.position.z}`)) return false;
        return true;
      },
      maxDistance,
    }) ?? null;
  } catch { return null; }
}

/**
 * Probe four cardinal directions for the target block. Returns the
 * first cardinal target that has a hit (preferring shorter distances)
 * or null if none. Used to bias mineBlock's wander step away from
 * empty quadrants — random walk in plains/desert biomes can spend
 * 4-5 wanders before stumbling onto a tree, while a quick directional
 * probe finds it in one.
 */
function probeDirections(bot, name, here, step, wanderY, log) {
  if (!bot?.findBlock || !here) return null;
  const aliases = NAME_ALIASES[name];
  // Reject blocks inside protected zones at probe time. Without this
  // a deposit at spawn would always win the "shortest from here"
  // tiebreaker for a bot whose home anchored to the actualSpawn
  // fallback — and the resulting wander would just bounce off
  // world-guard.
  const matcher = (b) => {
    if (!b) return false;
    if (!(aliases ? aliases.has(b.name) : b.name === name)) return false;
    if (isInProtectedZone(b.position)) return false;
    return true;
  };
  // Sample 32 blocks past `here` in each cardinal direction. The
  // findBlock search has its own radius so the probes overlap a bit;
  // we're using them mainly for "is there a hit in this quadrant".
  const probeStep = Math.max(16, Math.round(step * 0.6));
  const probeRadius = probeStep;
  const dirs = [
    { name: 'N', dx:  0, dz: -probeStep },
    { name: 'S', dx:  0, dz:  probeStep },
    { name: 'E', dx:  probeStep, dz: 0 },
    { name: 'W', dx: -probeStep, dz: 0 },
  ];
  let best = null;
  let bestDist = Infinity;
  for (const d of dirs) {
    let hit = null;
    try {
      hit = bot.findBlock({
        matching: matcher,
        maxDistance: probeRadius,
        point: { x: here.x + d.dx, y: wanderY, z: here.z + d.dz },
      });
    } catch { hit = null; }
    if (!hit?.position) continue;
    const dx = hit.position.x - here.x;
    const dz = hit.position.z - here.z;
    const dist = Math.hypot(dx, dz);
    if (dist < bestDist) {
      bestDist = dist;
      best = {
        x: Math.round(hit.position.x),
        y: wanderY,
        z: Math.round(hit.position.z),
        _dir: d.name,
      };
    }
  }
  if (best) {
    log?.info?.('mine_probe_hit', { name, dir: best._dir, dist: Math.round(bestDist) });
    return { x: best.x, y: best.y, z: best.z };
  }
  return null;
}

// ---------------------------------------------------------------------
// Crafting-table placement helper
// ---------------------------------------------------------------------

/**
 * Place a crafting table somewhere adjacent to the bot. Tries each
 * cardinal direction in turn — for each, the candidate is valid when
 * the block one below is solid (we'll place ON TOP of it) and the
 * space at that level is empty.
 *
 * Returns { success: true, position } when a table is verifiably
 * placed, else { success: false, reason } with a descriptive
 * failure tag. Failure paths are logged at WARN so the diagnostic
 * surfaces in production logs (the previous one-line debug log was
 * effectively invisible — any time the single hardcoded offset
 * (bot.x+1, bot.y-1, bot.z) wasn't a solid block, the crafting
 * chain failed silently with reason 'no_crafting_table_placed').
 */
async function placeCraftingTable(bot, log) {
  return placeWorkstation(bot, 'crafting_table', log);
}

/**
 * Place a workstation block (crafting_table, furnace) somewhere
 * adjacent to the bot. Tries each cardinal direction in turn — for
 * each, the candidate is valid when the block one below is solid
 * (we'll place ON TOP of it) and the space at that level is empty.
 *
 * Returns { success: true, position } when verifiably placed, else
 * { success: false, reason } with a descriptive failure tag. The
 * single-offset version this replaced silently failed any time the
 * one hardcoded block wasn't a solid reference (bot on a slab, in
 * a 1-wide tunnel, on a 1-block ledge), and the whole craft/smelt
 * chain would die with `no_crafting_table_placed` /
 * `no_furnace_placed`.
 */
export async function placeWorkstation(bot, itemName, log) {
  const item = findItem(bot, itemName);
  if (!item) return { success: false, reason: `no_${itemName}_in_inventory` };
  const here = bot.entity?.position;
  if (!here) return { success: false, reason: 'no_position' };

  // The 1.8 server SILENTLY rejects block placement inside the spawn
  // safezone — each face then eats a full 5s blockUpdate timeout (~20s
  // dead) before reporting no_<item>_placed (TestBot35: pinned at the
  // box edge (494,177), 0 tables placed in 22 min). Bail FAST when we're
  // in or hugging protection so the protection-aware relocate (_pickUnexplored)
  // moves the bot clear before retrying, instead of burning the loop here.
  if (isNearProtectedZone(here, 8)) {
    log?.info?.('workstation_skip_protection', {
      item: itemName,
      pos: { x: Math.round(here.x), y: Math.round(here.y), z: Math.round(here.z) },
    });
    return { success: false, reason: `${itemName}_in_protection` };
  }

  const candidates = [
    { dx: 1,  dz: 0,  dir: 'E' },
    { dx: -1, dz: 0,  dir: 'W' },
    { dx: 0,  dz: 1,  dir: 'S' },
    { dx: 0,  dz: -1, dir: 'N' },
  ];
  const isSolid = (b) => !!b && b.name !== 'air' && b.boundingBox !== 'empty'
    && b.name !== 'water' && b.name !== 'lava'
    && b.name !== 'flowing_water' && b.name !== 'flowing_lava';
  // boundingBox 'empty' covers air + non-collidable clutter (grass,
  // flowers, snow_layer) — all replaceable, so a clear placement target.
  const isClear = (b) => !b || b.name === 'air' || b.boundingBox === 'empty';

  // Try to place `item` at `cell`, right-clicking the `face` of `ref`.
  // Returns the placed block position or null. Verifies by re-reading the
  // world at the exact target cell (the old 8-block safeFindBlock could
  // false-positive on a PRE-EXISTING table nearby).
  const tryPlace = async (ref, face, cell) => {
    try {
      const weq = await withTransactionRetry(bot, async () => {
        await bot.equip(item, 'hand');
      }, { log, label: 'equip' });
      if (!weq.ok) throw new Error(weq.reason ?? 'equip_failed');
      try { await bot.lookAt(ref.position.offset(0.5, 0.5, 0.5), true); } catch {}
      await bot.placeBlock(ref, face);
    } catch (e) {
      return { ok: false, why: `place_threw:${e.message}` };
    }
    const after = bot.blockAt?.(cell);
    if (after?.name === itemName) return { ok: true, position: after.position };
    return { ok: false, why: 'placed_but_not_seen' };
  };

  const failures = [];

  // Pass 1: place ON TOP of a solid block beside the bot (the common
  // flat-ground case). cell = the cardinal feet-level slot.
  for (const c of candidates) {
    let ref, cell;
    try {
      ref = bot.blockAt(here.offset(c.dx, -1, c.dz));
      cell = bot.blockAt(here.offset(c.dx, 0, c.dz));
    } catch { failures.push(`${c.dir}:blockAt_threw`); continue; }
    if (!isSolid(ref)) { failures.push(`${c.dir}:no_solid_ref`); continue; }
    if (!isClear(cell)) { failures.push(`${c.dir}:obstructed`); continue; }
    const r = await tryPlace(ref, new Vec3(0, 1, 0), here.offset(c.dx, 0, c.dz));
    if (r.ok) return { success: true, position: r.position };
    failures.push(`${c.dir}:${r.why}`);
  }

  // Pass 2: no adjacent floor to build on (bot on a slab / 1-block ledge
  // / pillar / 1-wide spot — the dominant `no_solid_ref` failure). The
  // bot is ALWAYS standing on a solid block, so use THAT as the reference
  // and place the workstation into the empty cardinal floor cell beside
  // it (one below feet, still in reach). This is what lets a bot craft
  // anywhere it can stand instead of dying with no_crafting_table.
  let botFloor;
  try { botFloor = bot.blockAt(here.offset(0, -1, 0)); } catch { botFloor = null; }
  if (isSolid(botFloor)) {
    for (const c of candidates) {
      let floorCell;
      try { floorCell = bot.blockAt(here.offset(c.dx, -1, c.dz)); } catch { continue; }
      if (!isClear(floorCell)) continue; // floor occupied — Pass 1 would've used it
      const r = await tryPlace(botFloor, new Vec3(c.dx, 0, c.dz), here.offset(c.dx, -1, c.dz));
      if (r.ok) return { success: true, position: r.position };
      failures.push(`${c.dir}-floor:${r.why}`);
    }
  }

  log?.warn?.(`${itemName}_place_failed`, { failures });
  return { success: false, reason: 'place_failed' };
}

// ---------------------------------------------------------------------
// 2. craftItem
// ---------------------------------------------------------------------

export function craftItem(bot, params = {}, opts = {}) {
  const bad = checkBot(bot); if (bad) return bad;
  const { recipeName, count = 1 } = params;
  const log = opts.log;
  if (!recipeName) return syncFail('no_recipeName');

  return makeHandle((ctl) => {
    (async () => {
      const recipe = RECIPES[recipeName];
      if (!recipe) return ctl.resolve({ success: false, reason: 'unknown_recipe' });
      const needsTable = recipe.tool_required === 'crafting_table';

      // Locate or place a crafting table if required.
      let tableBlock = null;
      if (needsTable) {
        tableBlock = safeFindBlock(bot, 'crafting_table', 16, null);
        if (!tableBlock) {
          const tableItem = findItem(bot, 'crafting_table');
          if (!tableItem) {
            return ctl.resolve({ success: false, reason: 'no_crafting_table' });
          }
          // Try each cardinal direction for placement. The previous
          // single hardcoded offset (1, -1, 0) failed silently every
          // time that one block wasn't valid — bot on a slab, in a
          // tunnel, on a 1-block ledge — and the whole craft chain
          // would die on `no_crafting_table_placed`.
          const placeResult = await placeCraftingTable(bot, log);
          if (placeResult.success && placeResult.position) {
            tableBlock = bot.blockAt?.(placeResult.position) ?? safeFindBlock(bot, 'crafting_table', 8, null);
          } else {
            tableBlock = safeFindBlock(bot, 'crafting_table', 8, null);
          }
          if (!tableBlock) {
            // Keep the bare 'no_crafting_table_placed' reason so the
            // callers that match the reason exactly still catch it.
            // The detailed failure tags ([N:no_solid_ref, S:obstructed,
            // ...]) come out as a `crafting_table_place_failed` warn
            // log from the placement helper.
            return ctl.resolve({ success: false, reason: 'no_crafting_table_placed' });
          }
        }
        // Pathfind to the table — bot.craft requires interaction
        // range (~4 blocks). The table search above accepts a hit up
        // to 16 blocks away; without this step the craft attempt
        // would fail from out of range.
        if (tableBlock && opts.movement?.goTo) {
          try {
            const h = opts.movement.goTo(
              { x: tableBlock.position.x, y: tableBlock.position.y, z: tableBlock.position.z },
              { timeoutMs: 12_000, range: 2 }
            );
            await h.done;
          } catch (e) { log?.debug?.('craft_pathfind_skipped', { msg: e.message }); }
        }
      }

      // Look up the mineflayer recipe object by item id.
      const itemDef = bot.registry?.itemsByName?.[recipeName];
      if (!itemDef) return ctl.resolve({ success: false, reason: 'unknown_item_def' });
      let recipes;
      try { recipes = bot.recipesFor(itemDef.id, null, 1, tableBlock) ?? []; }
      catch (e) { return ctl.resolve({ success: false, reason: 'recipesFor_error:' + e.message }); }

      // Mixed-plank rescue (TestBot19, 2026-06-10): 1.8 plank recipes
      // are METADATA-strict — a wooden door needs 6 planks of the SAME
      // wood — but callers count `planks` generically, so a bot
      // holding 4 oak + 2 birch planks looped on missing_ingredients
      // seven times in a row. Craft a fresh same-variant batch from
      // any log in inventory and retry once.
      if (!recipes.length && RECIPES[recipeName]?.ingredients?.planks) {
        const hasLog = (bot.inventory?.items?.() ?? [])
          .some((it) => it?.name === 'log' || it?.name === 'log2');
        const planksDef = bot.registry?.itemsByName?.planks;
        if (hasLog && planksDef) {
          const need = RECIPES[recipeName].ingredients.planks;
          const batches = Math.max(1, Math.ceil(need / 4));
          try {
            const planksRecipes = bot.recipesFor(planksDef.id, null, 1, null) ?? [];
            if (planksRecipes.length) {
              const pBefore = countInventory(bot).planks ?? 0;
              const pTarget = pBefore + batches * 4;
              await withTransactionRetry(bot, async () => {
                const have = countInventory(bot).planks ?? 0;
                const remaining = pTarget - have;
                if (remaining <= 0) return;
                const b = Math.max(1, Math.ceil(remaining / 4));
                await bot.craft(planksRecipes[0], b, null);
              }, {
                verify: () => (countInventory(bot).planks ?? 0) >= pTarget,
                isCancelled: () => ctl.isCancelled(),
                log, label: 'craft_plank_rescue',
              });
              log?.info?.('craft_plank_variant_rescue', { recipe: recipeName, batches });
              recipes = bot.recipesFor(itemDef.id, null, 1, tableBlock) ?? [];
            }
          } catch (e) {
            log?.debug?.('craft_plank_rescue_failed', { msg: e.message });
          }
        }
      }

      // Door-variant fallback: `wooden_door` is the OAK door — a bot
      // in a birch/spruce forest can NEVER craft it. Blueprints accept
      // any door variant via substitutions, so craft whichever variant
      // the inventory's planks support.
      if (!recipes.length && recipeName === 'wooden_door') {
        for (const variant of ['spruce_door', 'birch_door', 'jungle_door',
          'acacia_door', 'dark_oak_door']) {
          const vDef = bot.registry?.itemsByName?.[variant];
          if (!vDef) continue;
          let vRecipes = [];
          try { vRecipes = bot.recipesFor(vDef.id, null, 1, tableBlock) ?? []; }
          catch { continue; }
          if (!vRecipes.length) continue;
          const vOutPer = RECIPES[recipeName]?.output_count > 0 ? RECIPES[recipeName].output_count : 1;
          const vBefore = countInventory(bot)[variant] ?? 0;
          const vTarget = vBefore + count * vOutPer;
          const vRes = await withTransactionRetry(bot, async () => {
            const have = countInventory(bot)[variant] ?? 0;
            const remaining = vTarget - have;
            if (remaining <= 0) return;
            const batches = Math.max(1, Math.ceil(remaining / vOutPer));
            await bot.craft(vRecipes[0], batches, tableBlock);
          }, {
            verify: () => (countInventory(bot)[variant] ?? 0) >= vTarget,
            isCancelled: () => ctl.isCancelled(),
            log, label: 'craft_door',
          });
          if (vRes.cancelled) return ctl.resolve({ success: false, reason: 'cancelled' });
          if (vRes.ok) {
            log?.info?.('craft_door_variant', { variant, count });
            return ctl.resolve({
              success: true,
              reason: 'done',
              crafted: { item: variant, count: count * vOutPer },
            });
          }
          log?.debug?.('craft_door_variant_failed', { variant, msg: vRes.reason });
        }
      }

      if (!recipes.length) {
        return ctl.resolve({ success: false, reason: 'missing_ingredients' });
      }
      // 1.8 transaction recovery (the planks slot-0 storm): retry on a
      // server reject, recomputing the shortfall each attempt so a
      // partial-batch throw can't over-craft, and treat the actual
      // produced-item count — not the absence of a throw — as the only
      // success signal. The produced item IS recipeName here (the door
      // VARIANT fallback above handles the spruce/birch-named case).
      const outPer = recipe.output_count > 0 ? recipe.output_count : 1;
      const before = countInventory(bot)[recipeName] ?? 0;
      const target = before + count * outPer;
      const res = await withTransactionRetry(bot, async () => {
        const have = countInventory(bot)[recipeName] ?? 0;
        const remaining = target - have;
        if (remaining <= 0) return;
        const batches = Math.max(1, Math.ceil(remaining / outPer));
        const fresh = bot.recipesFor(itemDef.id, null, 1, tableBlock) ?? [];
        await bot.craft(fresh[0] ?? recipes[0], batches, tableBlock);
      }, {
        verify: () => (countInventory(bot)[recipeName] ?? 0) >= target,
        isCancelled: () => ctl.isCancelled(),
        log, label: 'craft',
      });
      if (res.cancelled) return ctl.resolve({ success: false, reason: 'cancelled' });
      if (!res.ok) return ctl.resolve({ success: false, reason: 'craft_error:' + (res.reason ?? 'unknown') });
      ctl.resolve({
        success: true,
        reason: 'done',
        crafted: { item: recipeName, count: count * outPer },
      });
    })().catch((e) => ctl.resolve({ success: false, reason: 'exception:' + e.message }));
  });
}

// ---------------------------------------------------------------------
// 3. smeltItem
// ---------------------------------------------------------------------

export function smeltItem(bot, params = {}, opts = {}) {
  const bad = checkBot(bot); if (bad) return bad;
  const { inputItem, count = 1 } = params;
  // fuelItem is mutable: when coal isn't available we may fall back
  // to logs at run time, which means recomputing fuelNeeded too.
  let fuelItem = params.fuelItem ?? 'coal';
  const log = opts.log;
  if (!inputItem) return syncFail('no_inputItem');
  const expectedOutput = SMELTABLE[inputItem];
  if (!expectedOutput) return syncFail('not_smeltable');

  return makeHandle((ctl) => {
    (async () => {
      // Find or place a furnace.
      let furnaceBlock = safeFindBlock(bot, 'furnace', 16, null)
        ?? safeFindBlock(bot, 'lit_furnace', 16, null);
      if (!furnaceBlock) {
        const furnaceItem = findItem(bot, 'furnace');
        if (!furnaceItem) return ctl.resolve({ success: false, reason: 'no_furnace' });
        // Try all four cardinal directions for placement. The previous
        // single hardcoded offset (1, -1, 0) silently failed any time
        // that one block wasn't a solid reference — bot on a slab, in
        // a tunnel, on a 1-block ledge — and every smelt would die
        // with `no_furnace_placed`. Mirrors the crafting-table fix.
        const placeResult = await placeWorkstation(bot, 'furnace', log);
        if (placeResult.success && placeResult.position) {
          furnaceBlock = bot.blockAt?.(placeResult.position)
            ?? safeFindBlock(bot, 'furnace', 8, null);
        } else {
          furnaceBlock = safeFindBlock(bot, 'furnace', 8, null);
        }
        if (!furnaceBlock) return ctl.resolve({ success: false, reason: 'no_furnace_placed' });
      }

      // Pathfind to the furnace — bot.openFurnace requires interaction
      // range. The lookup above accepts a hit up to 16 blocks away.
      if (furnaceBlock && opts.movement?.goTo) {
        try {
          const h = opts.movement.goTo(
            { x: furnaceBlock.position.x, y: furnaceBlock.position.y, z: furnaceBlock.position.z },
            { timeoutMs: 12_000, range: 2 }
          );
          await h.done;
        } catch (e) { log?.debug?.('smelt_pathfind_skipped', { msg: e.message }); }
      }

      // Open the furnace.
      let furnace;
      try { furnace = await bot.openFurnace(furnaceBlock); }
      catch (e) { return ctl.resolve({ success: false, reason: 'open_error:' + e.message }); }
      ctl.onCancel = () => { try { furnace.close(); } catch {} };

      try {
        const inputDef = bot.registry?.itemsByName?.[inputItem];
        if (!inputDef) {
          return ctl.resolve({ success: false, reason: 'unknown_item_def' });
        }
        let fuelPerSmelt = FUEL_VALUES[fuelItem] ?? 1;
        let fuelNeeded = Math.ceil(count / fuelPerSmelt);
        const haveInput = (countInventory(bot)[inputItem] ?? 0);
        let haveFuel = (countInventory(bot)[fuelItem] ?? 0);
        if (haveInput < count) return ctl.resolve({ success: false, reason: 'not_enough_input' });
        if (haveFuel < fuelNeeded) {
          // Try to acquire fuel before giving up. Coal lives near iron
          // ore so an in-flight UPGRADE_GEAR run can almost always
          // recover by mining a few blocks. Logs are the fallback —
          // every wood type smelts as fuel.
          let recovered = false;
          if (opts.movement) {
            const coalBlock = safeFindBlock(bot, 'coal_ore', 32, null);
            if (coalBlock) {
              log?.info?.('smelt_auto_mining_fuel', { need: fuelNeeded });
              const mineHandle = mineBlock(bot, {
                blockName: 'coal_ore', count: fuelNeeded,
              }, opts);
              await mineHandle.done;
              haveFuel = (countInventory(bot)[fuelItem] ?? 0);
              if (haveFuel >= fuelNeeded) recovered = true;
            } else {
              const logCount = (countInventory(bot)['log'] ?? 0)
                + (countInventory(bot)['log2'] ?? 0);
              if (logCount >= Math.ceil(count / 1.5)) {
                fuelItem = 'log';
                fuelPerSmelt = 1.5;
                fuelNeeded = Math.ceil(count / 1.5);
                haveFuel = (countInventory(bot)[fuelItem] ?? 0);
                recovered = haveFuel >= fuelNeeded;
              }
            }
          }
          if (!recovered) {
            return ctl.resolve({ success: false, reason: 'not_enough_fuel' });
          }
        }

        const fuelDef = bot.registry?.itemsByName?.[fuelItem];
        if (!fuelDef) {
          return ctl.resolve({ success: false, reason: 'unknown_item_def' });
        }
        await furnace.putFuel(fuelDef.id, null, fuelNeeded);
        await furnace.putInput(inputDef.id, null, count);

        // Wait for output ~ 200 ticks per item plus a small slack.
        const waitMs = count * 10_000 + 2_000;
        const deadline = Date.now() + waitMs;
        let collected = 0;
        while (Date.now() < deadline && collected < count && !ctl.isCancelled()) {
          await sleep(1000);
          try {
            const out = furnace.outputItem();
            if (out && out.count > 0) {
              const taken = await furnace.takeOutput();
              collected += taken?.count ?? 0;
            }
          } catch (e) { log?.debug?.('smelt_take_err', { msg: e.message }); }
        }
        try { furnace.close(); } catch {}
        ctl.resolve({
          success: collected >= count,
          reason: collected >= count ? 'done' : 'partial_smelt',
          smelted: { item: expectedOutput, count: collected },
        });
      } catch (e) {
        try { furnace.close(); } catch {}
        ctl.resolve({ success: false, reason: 'smelt_exception:' + e.message });
      }
    })().catch((e) => ctl.resolve({ success: false, reason: 'exception:' + e.message }));
  }, { maxDurationMs: 300_000 });
}

// ---------------------------------------------------------------------
// 4. placeBlockAt
// ---------------------------------------------------------------------

const FACE_VECTORS = {
  up:    new Vec3(0, 1, 0),
  down:  new Vec3(0, -1, 0),
  north: new Vec3(0, 0, -1),
  south: new Vec3(0, 0, 1),
  east:  new Vec3(1, 0, 0),
  west:  new Vec3(-1, 0, 0),
};

export function placeBlockAt(bot, params = {}, opts = {}) {
  const bad = checkBot(bot); if (bad) return bad;
  const { position, blockName, facing = null } = params;
  const log = opts.log;
  const movement = opts.movement;
  if (!position) return syncFail('no_position');
  if (!blockName) return syncFail('no_blockName');

  return makeHandle((ctl) => {
    ctl.onCancel = () => { try { movement?.cancel?.(); } catch {} };
    (async () => {
      // Need the block in inventory.
      const item = findItem(bot, blockName);
      if (!item) return ctl.resolve({ success: false, reason: 'no_block_in_inventory' });

      const target = new Vec3(position.x, position.y, position.z);

      // Find an adjacent solid reference block we can place against.
      const candidates = facing
        ? [{ face: facing, vec: FACE_VECTORS[facing] }]
        : Object.entries(FACE_VECTORS).map(([face, vec]) => ({ face, vec }));

      // Interactive blocks (doors/chests/tables) activate on right-click
      // instead of accepting a placement — prefer a solid face; fall
      // back to an interactive one with sneak (see blueprintBuilder).
      const INTERACTIVE_REF = /door|chest|crafting_table|furnace|anvil|enchanting_table|bed|button|lever|fence_gate|hopper|dispenser|dropper|brewing_stand/;
      let referenceBlock = null;
      let faceVec = null;
      let refInteractive = false;
      let fallback = null;
      for (const { vec } of candidates) {
        const refPos = target.minus(vec);
        const ref = bot.blockAt?.(refPos);
        if (!ref || ref.name === 'air' || ref.name === 'water' || ref.name === 'lava') continue;
        if (INTERACTIVE_REF.test(ref.name)) {
          fallback ??= { ref, vec };
          continue;
        }
        referenceBlock = ref;
        faceVec = vec;
        break;
      }
      if (!referenceBlock && fallback) {
        referenceBlock = fallback.ref;
        faceVec = fallback.vec;
        refInteractive = true;
      }
      if (!referenceBlock) return ctl.resolve({ success: false, reason: 'no_reference_block' });

      // Pathfind into placement range.
      try {
        const goalPos = target.offset(0, 1, 0);
        const h = movement?.goTo?.(
          { x: goalPos.x, y: goalPos.y, z: goalPos.z },
          { timeoutMs: 12_000, range: 3 },
        );
        if (h) await h.done;
      } catch (e) { log?.debug?.('place_pathfind_skipped', { msg: e.message }); }

      // Pre-flight: a placement into an occupied cell or a cell
      // another living entity stands in is silently ignored by the
      // server — mineflayer then waits out its full 5s blockUpdate
      // timeout. Classify and bail instead.
      const cellState = classifyCell(bot, target);
      if (cellState === 'occupied') {
        return ctl.resolve({
          success: false, reason: 'cell_occupied',
          got: bot.blockAt?.(target)?.name,
        });
      }
      let occupant = entityInCell(bot, target);
      if (occupant === 'self') {
        // The bot's own body is in the target cell (e.g. backfilling
        // a dug-out plot it stands in). Step to an adjacent free cell
        // first; if that doesn't clear it, fall through to a
        // jump-place — placing into your own feet cell is legal
        // mid-jump (same mechanic as pillaring up).
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const fx = Math.floor(target.x) + dx;
          const fy = Math.floor(target.y);
          const fz = Math.floor(target.z) + dz;
          const feet = bot.blockAt?.(new Vec3(fx, fy, fz));
          const head = bot.blockAt?.(new Vec3(fx, fy + 1, fz));
          const ground = bot.blockAt?.(new Vec3(fx, fy - 1, fz));
          if (feet?.name !== 'air' || head?.name !== 'air') continue;
          if (!ground || ground.name === 'air' || ground.boundingBox === 'empty') continue;
          try {
            const h = movement?.goTo?.({ x: fx, y: fy, z: fz }, { timeoutMs: 5_000, range: 0 });
            if (h) await h.done.catch(() => {});
          } catch {}
          break;
        }
        occupant = entityInCell(bot, target);
      }
      if (occupant === 'other') {
        return ctl.resolve({ success: false, reason: 'entity_in_cell' });
      }

      const peq = await withTransactionRetry(bot, async () => {
        await bot.equip(item, 'hand');
      }, { isCancelled: () => ctl.isCancelled(), log, label: 'equip' });
      if (peq.cancelled) return ctl.resolve({ success: false, reason: 'cancelled' });
      if (!peq.ok) return ctl.resolve({ success: false, reason: 'equip_failed:' + (peq.reason ?? 'unknown') });

      // Still in our own cell → jump so the feet clear the cell for
      // the placement tick.
      const jumpPlace = occupant === 'self';
      if (jumpPlace) {
        try { bot.setControlState?.('jump', true); await sleep(150); } catch {}
      }

      // Poll-verified place: succeeds as soon as the block reads back
      // from the world (immune to missed blockUpdate events), fails
      // with a classified reason in 2.5s instead of mineflayer's 5s.
      if (refInteractive) {
        try { bot.setControlState?.('sneak', true); } catch {}
      }
      const placed = await placeAndVerify(bot, referenceBlock, faceVec, target, {
        verify: () => bot.blockAt?.(target)?.name === blockName,
      });
      if (refInteractive) {
        try { bot.setControlState?.('sneak', false); } catch {}
      }
      if (jumpPlace) {
        try { bot.setControlState?.('jump', false); } catch {}
      }
      if (placed.ok) {
        return ctl.resolve({ success: true, reason: 'done', position });
      }
      ctl.resolve({
        success: false,
        reason: placed.reason,
        got: bot.blockAt?.(target)?.name,
        error: placed.error ?? undefined,
      });
    })().catch((e) => ctl.resolve({ success: false, reason: 'exception:' + e.message }));
  }, { maxDurationMs: 30_000 });
}

// ---------------------------------------------------------------------
// 5. digBlockAt
// ---------------------------------------------------------------------

export function digBlockAt(bot, params = {}, opts = {}) {
  const bad = checkBot(bot); if (bad) return bad;
  const { position, expectedBlock = null } = params;
  const log = opts.log;
  const movement = opts.movement;
  if (!position) return syncFail('no_position');

  return makeHandle((ctl) => {
    ctl.onCancel = () => { try { movement?.cancel?.(); } catch {} };
    (async () => {
      const target = new Vec3(position.x, position.y, position.z);
      const block = bot.blockAt?.(target);
      if (!block || block.name === 'air') {
        return ctl.resolve({ success: false, reason: 'block_missing', got: block?.name });
      }
      if (expectedBlock && block.name !== expectedBlock) {
        return ctl.resolve({ success: false, reason: 'block_mismatch', got: block.name });
      }

      // Path within reach.
      try {
        const h = movement?.goTo?.(
          { x: target.x, y: target.y, z: target.z },
          { timeoutMs: 12_000, range: 4 },
        );
        if (h) await h.done;
      } catch (e) { log?.debug?.('dig_pathfind_skipped', { msg: e.message }); }

      // Equip best tool for this block.
      const tool = bestToolFor(bot, block.name);
      if (tool) {
        try { await bot.equip(tool, 'hand'); }
        catch (e) { log?.debug?.('equip_failed', { msg: e.message }); }
      }

      if (digWouldFlood(bot, block)) {
        return ctl.resolve({ success: false, reason: 'lava_adjacent' });
      }
      if (isInProtectedZone(block.position)) {
        return ctl.resolve({ success: false, reason: 'protected' });
      }
      try {
        if (bot.collectBlock?.collect) {
          await bot.collectBlock.collect(block);
        } else if (bot.canDigBlock?.(block)) {
          await bot.dig(block);
        } else {
          return ctl.resolve({ success: false, reason: 'cant_dig' });
        }
      } catch (e) {
        return ctl.resolve({ success: false, reason: 'dig_failed:' + e.message });
      }
      ctl.resolve({
        success: true,
        reason: 'done',
        dropped: TOOL_REQUIREMENTS[block.name]?.drops ?? block.name,
      });
    })().catch((e) => ctl.resolve({ success: false, reason: 'exception:' + e.message }));
  });
}

// ---------------------------------------------------------------------
// 8. equipItem
// ---------------------------------------------------------------------

export function equipItem(bot, params = {}, opts = {}) {
  const bad = checkBot(bot); if (bad) return bad;
  const { itemName, destination = 'hand' } = params;
  if (!itemName) return syncFail('no_itemName');

  return makeHandle((ctl) => {
    (async () => {
      const item = findItem(bot, itemName);
      if (!item) return ctl.resolve({ success: false, reason: 'item_not_in_inventory' });
      // equip is a window-click transaction the 1.8 server can reject
      // (TestBot32 equip_failed slot 12). Retry the reject; keep the
      // existing post-verify to decide done vs done_unverified, so a
      // no-throw-but-unconfirmable equip stays a success (not a retry).
      const eqRes = await withTransactionRetry(bot, async () => {
        const it = findItem(bot, itemName);
        if (!it) throw new Error('item_not_in_inventory');
        await bot.equip(it, destination);
      }, { isCancelled: () => ctl.isCancelled(), log: opts.log, label: 'equip' });
      if (eqRes.cancelled) return ctl.resolve({ success: false, reason: 'cancelled' });
      if (!eqRes.ok) return ctl.resolve({ success: false, reason: 'equip_failed:' + (eqRes.reason ?? 'unknown') });
      // Verify slot.
      const slot = bot.inventory?.slots?.[
        destination === 'head' ? 5
        : destination === 'torso' ? 6
        : destination === 'legs' ? 7
        : destination === 'feet' ? 8
        : null
      ];
      if (slot && slot.name === itemName) {
        return ctl.resolve({ success: true, reason: 'done' });
      }
      // Mainhand check: held-item index reads from the heldItem cache.
      if (destination === 'hand') {
        if (bot.heldItem?.name === itemName) {
          return ctl.resolve({ success: true, reason: 'done' });
        }
      }
      ctl.resolve({ success: true, reason: 'done_unverified' });
    })().catch((e) => ctl.resolve({ success: false, reason: 'exception:' + e.message }));
  }, { maxDurationMs: 5_000 });
}

// ---------------------------------------------------------------------
// 9. storeItems
// ---------------------------------------------------------------------

export function storeItems(bot, params = {}, opts = {}) {
  const bad = checkBot(bot); if (bad) return bad;
  const { items = '*', chestPosition = null } = params;
  const log = opts.log;
  const movement = opts.movement;

  return makeHandle((ctl) => {
    (async () => {
      let chest = null;
      if (chestPosition) {
        const blk = bot.blockAt?.(new Vec3(chestPosition.x, chestPosition.y, chestPosition.z));
        if (blk && (blk.name === 'chest' || blk.name === 'trapped_chest')) chest = blk;
      }
      if (!chest) {
        chest = safeFindBlock(bot, 'chest', 16, null)
          ?? safeFindBlock(bot, 'trapped_chest', 16, null);
      }
      if (!chest) return ctl.resolve({ success: false, reason: 'no_chest' });

      // Walk into reach.
      try {
        const h = movement?.goTo?.(
          { x: chest.position.x, y: chest.position.y, z: chest.position.z },
          { timeoutMs: 15_000, range: 3 },
        );
        if (h) await h.done;
      } catch (e) { log?.debug?.('store_pathfind_skipped', { msg: e.message }); }

      let container;
      try { container = await bot.openContainer(chest); }
      catch (e) { return ctl.resolve({ success: false, reason: 'open_failed:' + e.message }); }
      ctl.onCancel = () => { try { container.close(); } catch {} };

      const deposited = {};
      try {
        const inv = bot.inventory?.items?.() ?? [];
        const filter = items === '*'
          ? () => true
          : (name) => Array.isArray(items) ? items.includes(name) : name in items;
        for (const it of inv) {
          if (!filter(it.name)) continue;
          const want = items === '*' || Array.isArray(items)
            ? it.count
            : Math.min(it.count, items[it.name] ?? 0);
          if (want <= 0) continue;
          const dres = await withTransactionRetry(bot, async () => {
            await container.deposit(it.type, null, want);
          }, { log, label: 'deposit' });
          if (dres.ok) deposited[it.name] = (deposited[it.name] ?? 0) + want;
          else log?.debug?.('deposit_failed', { name: it.name, msg: dres.reason });
        }
      } finally {
        try { container.close(); } catch {}
      }
      ctl.resolve({ success: true, reason: 'done', deposited });
    })().catch((e) => ctl.resolve({ success: false, reason: 'exception:' + e.message }));
  }, { maxDurationMs: 30_000 });
}