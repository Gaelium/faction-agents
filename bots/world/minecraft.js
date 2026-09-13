/**
 * minecraft.js — pure-data knowledge module for Minecraft 1.8.9.
 *
 * No game logic, no mineflayer references. Just constants the agent's
 * tools (gather, craft, build, perceive) read. All maps are frozen
 * so callers cannot accidentally mutate shared state.
 *
 * Item / block names follow mineflayer/Minecraft 1.8.9 conventions
 * (snake_case, singular: "stick" not "sticks", "plank" -> "planks" since
 * the in-game ID is itself plural for that one).
 */

// ---------------------------------------------------------------------
// RECIPES
// ---------------------------------------------------------------------
//
// Shape: item_name -> {
//   ingredients: { input_item: count, ... },
//   tool_required: 'crafting_table' | 'furnace' | null,
//   output_count: number,
//   smelt_time_ticks?: number,   // furnace recipes only (1 op = 200t)
// }
//
// Furnace recipes are also mirrored in SMELTABLE for quick lookup.

// Items that are interchangeable as a crafting INGREDIENT. 1.8 splits
// trees across `log` (oak/spruce/birch/jungle) and `log2` (acacia/
// dark_oak); the planks recipe accepts EITHER, and mineflayer resolves
// the variant at craft time. Keyed by the canonical ingredient name a
// recipe references. Without this, a bot holding 42 acacia logs (log2)
// reads as "0 log" and mines for oak forever — even underground where no
// tree exists (TestBot14, 2026-06-06).
export const INGREDIENT_ALIASES = Object.freeze({
  log: ['log', 'log2'],
});

// How much of `item` an inventory effectively has, summing interchangeable
// aliases (so `log` includes `log2`). `inventory` is a {name: count} map.
export function countIngredient(inventory, item) {
  const names = INGREDIENT_ALIASES[item] ?? [item];
  let n = 0;
  for (const name of names) n += inventory?.[name] ?? 0;
  return n;
}

// Fold alias items into their canonical ingredient name in a COPY of the
// inventory, so downstream `inv[item]` checks/decrements see the combined
// pool (e.g. log2 counted as log). Returns the folded copy.
export function foldIngredientAliases(inventory = {}) {
  const out = { ...inventory };
  for (const [canonical, names] of Object.entries(INGREDIENT_ALIASES)) {
    for (const name of names) {
      if (name === canonical) continue;
      if (out[name]) {
        out[canonical] = (out[canonical] ?? 0) + out[name];
        out[name] = 0;
      }
    }
  }
  return out;
}

export const RECIPES = Object.freeze({
  // ---- basic wood tier (no table needed for these four) ---------------
  planks: {
    ingredients: { log: 1 },
    tool_required: null,
    output_count: 4,
  },
  stick: {
    ingredients: { planks: 2 },
    tool_required: null,
    output_count: 4,
  },
  crafting_table: {
    ingredients: { planks: 4 },
    tool_required: null,
    output_count: 1,
  },
  torch: {
    ingredients: { coal: 1, stick: 1 },
    tool_required: null,
    output_count: 4,
  },

  // ---- workstations / containers --------------------------------------
  furnace: {
    ingredients: { cobblestone: 8 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  chest: {
    ingredients: { planks: 8 },
    tool_required: 'crafting_table',
    output_count: 1,
  },

  // ---- wooden tools ---------------------------------------------------
  wooden_pickaxe: {
    ingredients: { planks: 3, stick: 2 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  wooden_axe: {
    ingredients: { planks: 3, stick: 2 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  wooden_shovel: {
    ingredients: { planks: 1, stick: 2 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  wooden_sword: {
    ingredients: { planks: 2, stick: 1 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  // Needed to till dirt into farmland for farm blueprints. 1.8 recipe:
  // 2 planks + 2 sticks over a crafting table.
  wooden_hoe: {
    ingredients: { planks: 2, stick: 2 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  stone_hoe: {
    ingredients: { cobblestone: 2, stick: 2 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  iron_hoe: {
    ingredients: { iron_ingot: 2, stick: 2 },
    tool_required: 'crafting_table',
    output_count: 1,
  },

  // ---- stone tools ----------------------------------------------------
  stone_pickaxe: {
    ingredients: { cobblestone: 3, stick: 2 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  stone_axe: {
    ingredients: { cobblestone: 3, stick: 2 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  stone_shovel: {
    ingredients: { cobblestone: 1, stick: 2 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  stone_sword: {
    ingredients: { cobblestone: 2, stick: 1 },
    tool_required: 'crafting_table',
    output_count: 1,
  },

  // ---- iron tools -----------------------------------------------------
  iron_pickaxe: {
    ingredients: { iron_ingot: 3, stick: 2 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  iron_axe: {
    ingredients: { iron_ingot: 3, stick: 2 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  iron_shovel: {
    ingredients: { iron_ingot: 1, stick: 2 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  iron_sword: {
    ingredients: { iron_ingot: 2, stick: 1 },
    tool_required: 'crafting_table',
    output_count: 1,
  },

  // ---- diamond tools --------------------------------------------------
  diamond_pickaxe: {
    ingredients: { diamond: 3, stick: 2 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  diamond_axe: {
    ingredients: { diamond: 3, stick: 2 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  diamond_shovel: {
    ingredients: { diamond: 1, stick: 2 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  diamond_sword: {
    ingredients: { diamond: 2, stick: 1 },
    tool_required: 'crafting_table',
    output_count: 1,
  },

  // ---- iron armor -----------------------------------------------------
  iron_helmet: {
    ingredients: { iron_ingot: 5 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  iron_chestplate: {
    ingredients: { iron_ingot: 8 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  iron_leggings: {
    ingredients: { iron_ingot: 7 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  iron_boots: {
    ingredients: { iron_ingot: 4 },
    tool_required: 'crafting_table',
    output_count: 1,
  },

  // ---- diamond armor --------------------------------------------------
  diamond_helmet: {
    ingredients: { diamond: 5 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  diamond_chestplate: {
    ingredients: { diamond: 8 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  diamond_leggings: {
    ingredients: { diamond: 7 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  diamond_boots: {
    ingredients: { diamond: 4 },
    tool_required: 'crafting_table',
    output_count: 1,
  },

  // ---- utilities / misc ----------------------------------------------
  bucket: {
    ingredients: { iron_ingot: 3 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  iron_door: {
    ingredients: { iron_ingot: 6 },
    tool_required: 'crafting_table',
    output_count: 3,
  },
  wooden_door: {
    ingredients: { planks: 6 },
    tool_required: 'crafting_table',
    output_count: 3,
  },
  cobblestone_wall: {
    ingredients: { cobblestone: 6 },
    tool_required: 'crafting_table',
    output_count: 6,
  },
  fence_gate: {
    ingredients: { stick: 4, planks: 2 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  fence: {
    ingredients: { planks: 4, stick: 2 },
    tool_required: 'crafting_table',
    output_count: 2,
  },
  ladder: {
    ingredients: { stick: 7 },
    tool_required: 'crafting_table',
    output_count: 3,
  },
  sign: {
    ingredients: { planks: 6, stick: 1 },
    tool_required: 'crafting_table',
    output_count: 3,
  },

  // ---- redstone / farm utility ----------------------------------------
  redstone_torch: {
    ingredients: { stick: 1, redstone: 1 },
    tool_required: null,
    output_count: 1,
  },
  piston: {
    ingredients: { planks: 3, cobblestone: 4, iron_ingot: 1, redstone: 1 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  sticky_piston: {
    ingredients: { piston: 1, slimeball: 1 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  repeater: {
    ingredients: { stone: 3, redstone_torch: 2, redstone: 1 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  comparator: {
    // 1.8 added comparators. Note: 1.8.9 has comparators; "observer"
    // does NOT exist until 1.11, so it is intentionally omitted here.
    ingredients: { stone: 3, redstone_torch: 4, nether_quartz: 1 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  hopper: {
    ingredients: { iron_ingot: 5, chest: 1 },
    tool_required: 'crafting_table',
    output_count: 1,
  },

  // ---- food / consumables --------------------------------------------
  bread: {
    ingredients: { wheat: 3 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  golden_apple: {
    // 1.8 "normal" gapple — 8 gold_ingot + 1 apple. Notch apple is
    // 8 gold_block + 1 apple; we model only the regular variant.
    ingredients: { gold_ingot: 8, apple: 1 },
    tool_required: 'crafting_table',
    output_count: 1,
  },
  paper: {
    ingredients: { sugar_cane: 3 },
    tool_required: 'crafting_table',
    output_count: 3,
  },
  sugar: {
    ingredients: { sugar_cane: 1 },
    tool_required: null,
    output_count: 1,
  },

  // ---- smelting recipes (furnace) -------------------------------------
  iron_ingot: {
    ingredients: { iron_ore: 1 },
    tool_required: 'furnace',
    output_count: 1,
    smelt_time_ticks: 200,
  },
  gold_ingot: {
    ingredients: { gold_ore: 1 },
    tool_required: 'furnace',
    output_count: 1,
    smelt_time_ticks: 200,
  },
  glass: {
    ingredients: { sand: 1 },
    tool_required: 'furnace',
    output_count: 1,
    smelt_time_ticks: 200,
  },
  stone: {
    ingredients: { cobblestone: 1 },
    tool_required: 'furnace',
    output_count: 1,
    smelt_time_ticks: 200,
  },
});

// ---------------------------------------------------------------------
// TOOL_REQUIREMENTS
// ---------------------------------------------------------------------
//
// block_name -> {
//   tool: <minimum tool name> | null,   // null = breakable by hand
//   drops: <item name dropped on break>,
//   multipliers?: { tool_name: speed_factor }   // > 1.0 means faster
// }
//
// Speed factors are relative to the minimum tool (1.0). Vanilla 1.8
// pickaxe progression: wood 2x, stone 4x, iron 6x, diamond 8x baseline
// over bare-hand mining; the multipliers below normalize so the
// minimum-tool entry is implicitly 1.0.

export const TOOL_REQUIREMENTS = Object.freeze({
  // hand-breakable
  dirt: { tool: null, drops: 'dirt' },
  sand: { tool: null, drops: 'sand' },
  gravel: { tool: null, drops: 'gravel' },
  log: { tool: null, drops: 'log' },
  oak_leaves: { tool: null, drops: 'oak_leaves' },
  planks: { tool: null, drops: 'planks' },
  glass: { tool: null, drops: null },        // shatters without silk

  // wooden pickaxe tier
  stone: {
    tool: 'wooden_pickaxe',
    drops: 'cobblestone',
    multipliers: { stone_pickaxe: 2.0, iron_pickaxe: 3.0, diamond_pickaxe: 4.0 },
  },
  cobblestone: {
    tool: 'wooden_pickaxe',
    drops: 'cobblestone',
    multipliers: { stone_pickaxe: 2.0, iron_pickaxe: 3.0, diamond_pickaxe: 4.0 },
  },
  coal_ore: {
    tool: 'wooden_pickaxe',
    drops: 'coal',
    multipliers: { stone_pickaxe: 2.0, iron_pickaxe: 3.0, diamond_pickaxe: 4.0 },
  },

  // stone pickaxe tier
  iron_ore: {
    tool: 'stone_pickaxe',
    drops: 'iron_ore',
    multipliers: { iron_pickaxe: 1.5, diamond_pickaxe: 2.0 },
  },
  nether_quartz_ore: {
    tool: 'stone_pickaxe',
    drops: 'nether_quartz',
    multipliers: { iron_pickaxe: 1.5, diamond_pickaxe: 2.0 },
  },

  // iron pickaxe tier
  gold_ore: {
    tool: 'iron_pickaxe',
    drops: 'gold_ore',
    multipliers: { diamond_pickaxe: 1.33 },
  },
  diamond_ore: {
    tool: 'iron_pickaxe',
    drops: 'diamond',
    multipliers: { diamond_pickaxe: 1.33 },
  },
  redstone_ore: {
    tool: 'iron_pickaxe',
    drops: 'redstone',
    multipliers: { diamond_pickaxe: 1.33 },
  },
  emerald_ore: {
    tool: 'iron_pickaxe',
    drops: 'emerald',
    multipliers: { diamond_pickaxe: 1.33 },
  },

  // diamond pickaxe tier
  obsidian: {
    tool: 'diamond_pickaxe',
    drops: 'obsidian',
  },
});

// ---------------------------------------------------------------------
// BLOCK_HARDNESS
// ---------------------------------------------------------------------
//
// Vanilla 1.8.9 hardness values (from the wiki). Mining time in seconds
// is roughly hardness * 1.5 (proper tool) or hardness * 5 (wrong tool /
// hand). Planner uses these for duration estimation only.

export const BLOCK_HARDNESS = Object.freeze({
  dirt: 0.5,
  grass_block: 0.6,
  sand: 0.5,
  gravel: 0.6,
  log: 2.0,
  planks: 2.0,
  oak_leaves: 0.2,
  wool: 0.8,
  glass: 0.3,
  stone: 1.5,
  cobblestone: 2.0,
  coal_ore: 3.0,
  iron_ore: 3.0,
  gold_ore: 3.0,
  redstone_ore: 3.0,
  diamond_ore: 3.0,
  emerald_ore: 3.0,
  nether_quartz_ore: 3.0,
  end_stone: 3.0,
  netherrack: 0.4,
  obsidian: 50.0,
  bedrock: -1.0,                  // unbreakable in survival
});

// ---------------------------------------------------------------------
// SMELTABLE
// ---------------------------------------------------------------------
//
// input_item -> output_item. Any input here is a furnace recipe.
// Mirrors the furnace entries in RECIPES for fast lookup.

export const SMELTABLE = Object.freeze({
  iron_ore: 'iron_ingot',
  gold_ore: 'gold_ingot',
  sand: 'glass',
  cobblestone: 'stone',
  raw_beef: 'cooked_beef',
  raw_porkchop: 'cooked_porkchop',
  raw_chicken: 'cooked_chicken',
  raw_fish: 'cooked_fish',
  potato: 'baked_potato',
  cactus: 'green_dye',
  log: 'charcoal',
  clay: 'brick',
  netherrack: 'nether_brick_item',
});

// ---------------------------------------------------------------------
// FUEL_VALUES
// ---------------------------------------------------------------------
//
// fuel_item -> number of items it can smelt. (One smelt = 200 ticks /
// 10s.) Fractional values (1.5) mean the fuel burns long enough for
// one smelt with leftover heat.

export const FUEL_VALUES = Object.freeze({
  lava_bucket: 100,
  coal_block: 80,
  blaze_rod: 12,
  coal: 8,
  charcoal: 8,
  log: 1.5,
  planks: 1.5,
  wooden_pickaxe: 1,
  wooden_axe: 1,
  wooden_shovel: 1,
  wooden_sword: 1,
  crafting_table: 1.5,
  chest: 1.5,
  fence: 1.5,
  ladder: 1.5,
  bowl: 1,
  stick: 0.5,
  sapling: 0.5,
});

// ---------------------------------------------------------------------
// FARMABLE_CROPS
// ---------------------------------------------------------------------
//
// crop_name -> {
//   block_name,           // the placed/growing block id
//   seed_item,            // what you plant
//   growth_stages,        // 0..N (harvestable at last stage)
//   harvest_drop,         // primary drop on harvest
//   seed_drop_on_harvest, // null if harvest doesn't return seeds
//   needs_water,          // adjacency requirement
//   needs_light,          // light-level >= 9 to grow
//   ticks_to_grow_avg,    // wall-clock ticks (20/sec) — average, not exact
// }

export const FARMABLE_CROPS = Object.freeze({
  wheat: {
    block_name: 'wheat',
    seed_item: 'wheat_seeds',
    growth_stages: 8,
    harvest_drop: 'wheat',
    seed_drop_on_harvest: 'wheat_seeds',
    needs_water: true,
    needs_light: true,
    ticks_to_grow_avg: 24000,
  },
  carrots: {
    block_name: 'carrots',
    seed_item: 'carrot',
    growth_stages: 8,
    harvest_drop: 'carrot',
    seed_drop_on_harvest: 'carrot',
    needs_water: true,
    needs_light: true,
    ticks_to_grow_avg: 24000,
  },
  potatoes: {
    block_name: 'potatoes',
    seed_item: 'potato',
    growth_stages: 8,
    harvest_drop: 'potato',
    seed_drop_on_harvest: 'potato',
    needs_water: true,
    needs_light: true,
    ticks_to_grow_avg: 24000,
  },
  pumpkin: {
    // pumpkin/melon: stem grows; fruit spawns adjacent. Harvest the
    // fruit block, leave the stem to regrow.
    block_name: 'pumpkin',
    seed_item: 'pumpkin_seeds',
    growth_stages: 8,
    harvest_drop: 'pumpkin',
    seed_drop_on_harvest: null,
    needs_water: true,
    needs_light: true,
    ticks_to_grow_avg: 36000,
  },
  melon: {
    block_name: 'melon_block',
    seed_item: 'melon_seeds',
    growth_stages: 8,
    harvest_drop: 'melon',
    seed_drop_on_harvest: null,
    needs_water: true,
    needs_light: true,
    ticks_to_grow_avg: 36000,
  },
  sugar_cane: {
    block_name: 'reeds',
    seed_item: 'sugar_cane',
    growth_stages: 16,
    harvest_drop: 'sugar_cane',
    seed_drop_on_harvest: null,
    needs_water: true,           // adjacent water at base
    needs_light: false,
    ticks_to_grow_avg: 18000,
  },
  cactus: {
    block_name: 'cactus',
    seed_item: 'cactus',
    growth_stages: 16,
    harvest_drop: 'cactus',
    seed_drop_on_harvest: null,
    needs_water: false,          // must NOT have water adjacent
    needs_light: false,
    ticks_to_grow_avg: 18000,
  },
  nether_wart: {
    block_name: 'nether_wart',
    seed_item: 'nether_wart',
    growth_stages: 4,
    harvest_drop: 'nether_wart',
    seed_drop_on_harvest: 'nether_wart',
    needs_water: false,          // soul_sand only
    needs_light: false,
    ticks_to_grow_avg: 12000,
  },
});

// ---------------------------------------------------------------------
// WILD_CROP_SOURCE
// ---------------------------------------------------------------------
//
// Where to ACQUIRE a seed/crop item from the WILD before you have a farm
// (farms place these best-effort, but the bot starts with none). Break the
// `block` repeatedly and collect drops until you have enough.
//   wheat_seeds — drop from breaking tallgrass (~1/8 each; break many)
//   sugar_cane  — drop 1:1 from breaking wild reeds (cane) near water
// Modest amounts bootstrap a starter plot; wheat then self-seeds on harvest.
export const WILD_CROP_SOURCE = Object.freeze({
  wheat_seeds: { block: 'tallgrass', yieldPer: 0.125 },
  sugar_cane:  { block: 'reeds',     yieldPer: 1 },
});

// ---------------------------------------------------------------------
// GEAR_TIERS
// ---------------------------------------------------------------------
//
// Ordered worst -> best. Total armor points (sum of pieces) increases
// monotonically:  leather 7 < gold 11 < chainmail 12 < iron 15 < diamond 20.
//
// Per-piece values follow vanilla 1.8.9. Sword damage is total melee
// damage including the 1.0 base.

export const GEAR_TIERS = Object.freeze([
  Object.freeze({
    name: 'leather',
    armor: { helmet: 1, chestplate: 3, leggings: 2, boots: 1 },
    armor_total: 7,
    sword_damage: 4,
    durability: { helmet: 56, chestplate: 81, leggings: 76, boots: 66, sword: 60 },
  }),
  Object.freeze({
    name: 'gold',
    armor: { helmet: 2, chestplate: 5, leggings: 3, boots: 1 },
    armor_total: 11,
    sword_damage: 4,
    durability: { helmet: 78, chestplate: 113, leggings: 106, boots: 92, sword: 33 },
  }),
  Object.freeze({
    name: 'chainmail',
    armor: { helmet: 2, chestplate: 5, leggings: 4, boots: 1 },
    armor_total: 12,
    sword_damage: null,            // no chainmail sword in vanilla
    durability: { helmet: 166, chestplate: 241, leggings: 226, boots: 196, sword: null },
  }),
  Object.freeze({
    name: 'iron',
    armor: { helmet: 2, chestplate: 6, leggings: 5, boots: 2 },
    armor_total: 15,
    sword_damage: 6,
    durability: { helmet: 166, chestplate: 241, leggings: 226, boots: 196, sword: 251 },
  }),
  Object.freeze({
    name: 'diamond',
    armor: { helmet: 3, chestplate: 8, leggings: 6, boots: 3 },
    armor_total: 20,
    sword_damage: 7,
    durability: { helmet: 364, chestplate: 529, leggings: 496, boots: 430, sword: 1562 },
  }),
]);

// ---------------------------------------------------------------------
// SPECIAL_BLOCKS
// ---------------------------------------------------------------------
//
// Items / blocks that aren't craftable and aren't farmed. The tools
// use this to know "you can't make X — you have to obtain it via Y".
// Includes a few canonical mob drops the recipe graph references.

export const SPECIAL_BLOCKS = Object.freeze({
  obsidian: {
    source: 'flowing_water_meets_lava_source',
    tool_required: 'diamond_pickaxe',
    notes:
      'Pour water on a lava source block. Mine with a diamond pickaxe ' +
      '(takes ~9.4s). Cannot be crafted. Hardness 50.',
  },
  bedrock: {
    source: 'world_generation',
    tool_required: null,
    notes: 'Unbreakable in survival; bottom of overworld + nether ceiling.',
  },
  // Mob / world drops that show up as recipe ingredients:
  apple: {
    source: 'oak_leaves_decay_drop',
    tool_required: null,
    notes: 'Rare drop (~1/200) when oak_leaves decay or are broken.',
  },
  slimeball: {
    source: 'slime_mob_drop',
    tool_required: null,
    notes: 'Drops from slimes in swamp biome at night, or slime chunks below Y=40.',
  },
  raw_beef: { source: 'cow_mob_drop', tool_required: null },
  raw_porkchop: { source: 'pig_mob_drop', tool_required: null },
  raw_chicken: { source: 'chicken_mob_drop', tool_required: null },
  raw_fish: { source: 'fishing_rod', tool_required: 'fishing_rod' },
  emerald: {
    source: 'emerald_ore_or_villager_trade',
    tool_required: 'iron_pickaxe',
    notes: 'Found only in extreme hills biomes; primary use is villager trading.',
  },
});
