/**
 * Economy config — what the bot is willing to sell via `/sell hand`, and how
 * much of each item it keeps in reserve.
 *
 * Policy (user decision): always sell farmed crops and bulk mined blocks; for
 * ores/ingots keep a generous reserve (so gear/builds aren't starved) and sell
 * only the surplus above it; NEVER sell diamonds. Items NOT listed here are
 * never auto-sold — this is an allowlist, so tools, armor, food, building
 * blocks like planks, etc. are safe.
 *
 * `/sell hand` works anywhere on this server, so selling is opportunistic
 * (at base, after farming, after mining) rather than a trip to spawn.
 */

const NEVER_SELL = Infinity;

// have - reserve == sellable surplus. Reserve 0 → sell everything of it.
export const RESERVES = Object.freeze({
  // Crops — sell all. Seeds (wheat_seeds, pumpkin_seeds, …) are separate
  // item names and intentionally absent → never sold (kept for replanting).
  wheat: 0, carrot: 0, potato: 0, pumpkin: 0, melon: 0, cactus: 0, sugar_cane: 0,

  // Bulk blocks — keep a building reserve, sell the rest.
  cobblestone: 64, dirt: 16, sand: 16, gravel: 16, flint: 0,
  andesite: 0, diorite: 0, granite: 0, netherrack: 0,

  // Ores / ingots — keep a generous reserve for gear/builds, sell surplus.
  iron_ingot: 64, gold_ingot: 32, coal: 64, redstone: 64, lapis_lazuli: 64,
  iron_ore: 0, gold_ore: 0, emerald: 0,

  // Never sell — load-bearing / high value.
  diamond: NEVER_SELL,
});

// Don't bother selling fewer than this many of an item (one /sell hand call
// per stack-type has overhead; tiny dribbles aren't worth it).
export const MIN_SELL_STACK = 16;

// Building materials — kept ENTIRELY while a build is in progress, even if the
// inventory is above their normal reserve. Selling the cobblestone you're
// mid-way through walling with would stall the build (user: "bulk blocks
// shouldn't be sold if they're part of a building project").
export const BUILD_MATERIALS = new Set([
  'cobblestone', 'dirt', 'sand', 'gravel', 'stone', 'cobblestone_wall',
  'andesite', 'diorite', 'granite', 'glass', 'glass_pane',
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
  'acacia_planks', 'dark_oak_planks', 'planks',
  'oak_log', 'log', 'log2', 'oak_wood',
]);

/**
 * Given an inventory map { itemName: count }, return the stacks worth selling
 * as [{ item, count }], where count is the surplus above the item's reserve.
 * Only items on the RESERVES allowlist with surplus >= MIN_SELL_STACK qualify.
 *
 * Options:
 *   buildActive — a build project is in progress; building materials are not
 *     sold at all (keep everything you might wall/floor/roof with).
 *   buildNeeds  — optional { item: count } of materials a build still needs;
 *     raises the effective reserve so those specific stacks are kept.
 */
export function computeSellable(inventory = {}, { buildActive = false, buildNeeds = null } = {}) {
  const out = [];
  for (const [item, reserve] of Object.entries(RESERVES)) {
    if (!Number.isFinite(reserve)) continue;            // NEVER_SELL
    if (buildActive && BUILD_MATERIALS.has(item)) continue;  // keep build mats
    let effReserve = reserve;
    const need = Number(buildNeeds?.[item] ?? 0);
    if (need > 0) effReserve = Math.max(effReserve, need);
    const have = Number(inventory[item] ?? 0);
    const surplus = have - effReserve;
    if (surplus >= MIN_SELL_STACK) out.push({ item, count: surplus });
  }
  return out;
}

/** Total count of sellable surplus across all allowlisted items. */
export function totalSellableSurplus(inventory = {}, opts = {}) {
  return computeSellable(inventory, opts).reduce((acc, g) => acc + g.count, 0);
}
