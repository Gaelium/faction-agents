/**
 * placement.js — how a blueprint block becomes real when it is NOT a
 * plain "place this item from inventory" block.
 *
 * Farms are the motivating case (TestBot12, 2026-06-05: BUILD_INCOME_FARM
 * looped forever, unbuildable). You can never hold a `farmland` item —
 * it's made by tilling dirt with a hoe. `water` comes from a bucket, and
 * seeds are planted on farmland/sand. The old pipeline treated all three
 * as "gather the named block and place it from inventory", which is
 * impossible, so the gather degenerated to a failed "explore (no source)"
 * and the placement could never find the item.
 *
 * This module is the single source of truth for the placement METHOD and
 * OPTIONALITY of a block name, consumed by:
 *   - blueprintBuilder.js and the agent's build tool — dispatch
 *   - the build tool's material check — translate to gatherable sources
 *
 * The gather SOURCE (e.g. farmland←dirt) also comes from a blueprint's
 * declared `substitutions`; defaultSource() is the fallback when a
 * blueprint doesn't declare one.
 */

// Blocks created by tilling dirt/grass with a hoe.
const TILL_BLOCKS = new Set(['farmland']);

// Liquids placed from a bucket. Best-effort: hydration is a bonus, the
// build must not block on carrying 20 water buckets.
const FLUID_BLOCKS = new Set(['water', 'flowing_water']);

// Crops planted on farmland (or sand, for cane). Best-effort: planted if
// the bot happens to hold seeds, never gathered/blocking.
const SEED_BLOCKS = new Set([
  'wheat_seeds', 'pumpkin_seeds', 'melon_seeds', 'carrots', 'potatoes',
  'beetroot_seeds', 'sugar_cane', 'reeds', 'nether_wart',
]);

/**
 * 'place' (default) | 'till' | 'water' | 'plant'.
 */
export function placementMethod(block) {
  if (TILL_BLOCKS.has(block)) return 'till';
  if (FLUID_BLOCKS.has(block)) return 'water';
  if (SEED_BLOCKS.has(block)) return 'plant';
  return 'place';
}

/**
 * Optional blocks are best-effort: the build attempts them but never
 * fails or stalls on them, and they don't count toward the completion
 * gate. Water + seeds are optional; tilled farmland is REQUIRED (it's the
 * structural point of a farm).
 */
export function isOptionalBlock(block) {
  return FLUID_BLOCKS.has(block) || SEED_BLOCKS.has(block);
}

/**
 * The inventory item that produces this block, when a blueprint doesn't
 * declare a substitution. Farmland is tilled from dirt; everything else
 * is placed as itself.
 */
export function defaultSource(block) {
  if (TILL_BLOCKS.has(block)) return 'dirt';
  return block;
}

/**
 * Translate a blueprint's missing-materials map (keyed by placed-block
 * name, e.g. {farmland:70, torch:4, water:20}) into a GATHERABLE map the
 * gather and craft tools can actually satisfy (e.g.
 * {dirt:70, torch:4, wooden_hoe:1}). Optional blocks (water/seeds) are
 * dropped — they're placed best-effort from whatever's on hand. A hoe is
 * added once if any till-block is needed and none is already held.
 *
 * @param missing       {block: count}
 * @param substitutions blueprint.substitutions ({block: [alt,...]})
 * @param inventory     {item: count} — to skip the hoe if already held
 */
export function gatherablesForMissing(missing = {}, substitutions = {}, inventory = {}) {
  const out = {};
  let needsTill = false;
  let needsWater = false;
  for (const [block, countRaw] of Object.entries(missing)) {
    const count = Number(countRaw) || 0;
    if (count <= 0) continue;
    if (isOptionalBlock(block)) {
      // water/seeds are placed best-effort and not gathered as the block
      // itself — but water DOES need a bucket to place from, so flag it.
      if (placementMethod(block) === 'water') needsWater = true;
      continue;
    }
    const method = placementMethod(block);
    if (method === 'till') needsTill = true;
    // Gather the INTRINSIC source: dirt for farmland, the block itself
    // for everything else. Do NOT use the blueprint's `substitutions` —
    // those are inventory-match ALIASES for canAfford (e.g.
    // fence:['wooden_fence']), not gather recipes. Translating `fence` →
    // `wooden_fence` sent the gather step hunting a non-existent
    // `wooden_fence` recipe → a useless "no source" search (the recipe
    // is keyed `fence`). The caller resolves the real block name.
    const source = defaultSource(block);
    out[source] = (out[source] ?? 0) + count;
  }
  if (needsTill && !hasHoe(inventory)) out.wooden_hoe = 1;
  // ONE empty bucket is enough to hydrate the whole plot: the builder
  // fills it from a nearby water source and refills from each source it
  // places. We gather the empty `bucket` (craftable from iron), not a
  // `water_bucket` (un-craftable — it's a filled bucket).
  if (needsWater && !hasBucket(inventory)) out.bucket = 1;
  return out;
}

export function hasHoe(inventory = {}) {
  return Object.keys(inventory).some((k) => k.endsWith('_hoe') && (inventory[k] ?? 0) > 0);
}

export function hasBucket(inventory = {}) {
  return (inventory.bucket ?? 0) > 0 || (inventory.water_bucket ?? 0) > 0;
}
