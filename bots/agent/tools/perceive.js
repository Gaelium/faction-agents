/**
 * perceive.js — read-only senses. All parallel-safe and instant.
 *
 *   look       the one scene dump (≤ ~300 tokens)
 *   scan       where is block X within radius R
 *   inventory  grouped counts + worn gear + free slots
 *   recipes    what does item X need, and what am I missing
 */

import { RECIPES, TOOL_REQUIREMENTS, SMELTABLE, countIngredient } from '../../world/minecraft.js';
import { countInventory, targetSubmerged } from '../../world/primitives.js';
import { isInProtectedZone, isNearProtectedZone, pushOutsideProtection } from '../../world/zones.js';
import { ok, fail, roundPos, distance, compassDir } from './result.js';

const BLOCK_ALIASES = Object.freeze({
  log: ['log', 'log2'], wood: ['log', 'log2'], tree: ['log', 'log2'], logs: ['log', 'log2'],
  stone: ['stone'], cobble: ['cobblestone'],
  ore: ['coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'redstone_ore', 'lapis_ore', 'emerald_ore'],
  water: ['water', 'flowing_water'], lava: ['lava', 'flowing_lava'],
  crops: ['wheat', 'carrots', 'potatoes', 'reeds', 'cactus', 'pumpkin', 'melon_block'],
  sugar_cane: ['reeds'], sugarcane: ['reeds'],
});

const INTEREST = ['water', 'lava', 'chest', 'crafting_table', 'furnace', 'log', 'log2',
  'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'wheat', 'reeds', 'cactus'];

function isFood(bot, name) {
  if (!name) return false;
  const foods = bot.registry?.foodsByName;
  if (foods?.[name]) return true;
  return /^cooked_|^(bread|apple|steak|porkchop|beef|chicken|mutton|rabbit|carrot|potato|baked_potato|melon|cookie|pumpkin_pie|golden_apple|golden_carrot|mushroom_stew|rabbit_stew|fish|cooked_fish)$/.test(name);
}

export function groupInventory(bot) {
  const counts = countInventory(bot);
  const groups = { tools: {}, weapons: {}, armor: {}, blocks: {}, ores_ingots: {}, food: {}, other: {} };
  for (const [name, n] of Object.entries(counts)) {
    if (/_(pickaxe|shovel|hoe|axe)$/.test(name) && !/_sword$/.test(name)) groups.tools[name] = n;
    else if (/_sword$|^bow$/.test(name)) groups.weapons[name] = n;
    else if (/_(helmet|chestplate|leggings|boots)$/.test(name)) groups.armor[name] = n;
    else if (/_ore$|_ingot$|^(coal|diamond|emerald|redstone|dye|gold_nugget)$/.test(name)) groups.ores_ingots[name] = n;
    else if (isFood(bot, name)) groups.food[name] = n;
    else if (/^(dirt|grass|cobblestone|stone|sand|gravel|planks|log|log2|sandstone|netherrack|wool|glass|torch|ladder|fence|chest|crafting_table|furnace|wooden_door|iron_door|obsidian)$/.test(name) || /_planks$|_log$|_door$/.test(name)) groups.blocks[name] = n;
    else groups.other[name] = n;
  }
  for (const k of Object.keys(groups)) if (!Object.keys(groups[k]).length) delete groups[k];
  return { groups, counts };
}

function wornArmor(bot) {
  const slots = bot.inventory?.slots ?? [];
  const out = [];
  for (const i of [5, 6, 7, 8]) if (slots[i]?.name) out.push(slots[i].name);
  return out;
}

export function statusLine(bot, nerves) {
  const pos = roundPos(bot.entity?.position);
  const hp = typeof bot.health === 'number' ? Math.round(bot.health * 10) / 10 : null;
  const food = typeof bot.food === 'number' ? bot.food : null;
  const t = bot.time?.timeOfDay;
  const tod = typeof t !== 'number' ? 'unknown' : t < 12000 ? 'day' : t < 13800 ? 'dusk' : t < 22200 ? 'night' : 'dawn';
  const parts = [];
  if (pos) parts.push(`pos ${pos.x},${pos.y},${pos.z}`);
  if (hp != null) parts.push(`hp ${hp}/20`);
  if (food != null) parts.push(`food ${food}/20`);
  parts.push(tod);
  if (pos && isInProtectedZone(pos)) parts.push('IN SPAWN PROTECTION');
  return parts.join(' · ');
}

export function perceiveTools(deps) {
  const { bot, nerves, perception } = deps;

  const look = {
    name: 'look',
    description: 'Look around: position, health, food, time of day, spawn-protection status, nearby players and hostile mobs (with distance and compass direction), notable blocks within 8, what you are holding and wearing, and the last few chat lines. Use this when you need the scene; each tool result already carries a one-line status.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    parallelSafe: true,
    async handler() {
      const p = perception?.read?.() ?? {};
      const pos = roundPos(bot.entity?.position);
      const out = {
        pos, hp: p.health, food: p.food, time: p.timeOfDay,
        underground: !!p.isUnderground,
        holding: p.heldItem ?? null,
        wearing: wornArmor(bot),
        players: (p.nearbyPlayers ?? []).map((x) => `${x.name} ${x.distance}b ${x.direction}${x.health != null ? ` hp${x.health}` : ''}`),
        mobs: (p.nearbyMobs ?? []).map((x) => `${x.type}${x.hostile ? '*' : ''} ${x.distance}b ${x.direction}`),
        nearby_blocks: Object.keys(p.nearbyBlocks ?? {}),
        chat: nerves?.recentChat?.(3) ?? [],
      };
      if (typeof bot.oxygenLevel === 'number' && bot.oxygenLevel < 20) out.oxygen = bot.oxygenLevel;
      if (pos) {
        const inside = isInProtectedZone(pos);
        if (inside) {
          const exit = pushOutsideProtection(pos, 16);
          out.spawn_protection = {
            inside: true,
            note: 'cannot break or place blocks here; use leave_spawn',
            nearest_exit: { x: exit.x, z: exit.z, distance: distance(pos, { x: exit.x, y: pos.y, z: exit.z }), dir: compassDir(pos, { x: exit.x, z: exit.z }) },
          };
        } else if (isNearProtectedZone(pos, 24)) {
          out.spawn_protection = { inside: false, note: 'within 24 blocks of protection; digging is suppressed near the edge' };
        }
      }
      if (deps.state?.home) out.home = deps.state.home;
      return ok(out);
    },
  };

  const scan = {
    name: 'scan',
    description: 'Find blocks of a type near you. Returns up to `max` positions sorted by distance, skipping blocks inside spawn protection, under water, or next to lava. Aliases: log/wood/tree, ore, crops, sugar_cane. Radius is capped at 64; the world is only loaded ~8 chunks around you, so nothing farther can be seen without walking.',
    input_schema: {
      type: 'object',
      properties: {
        block: { type: 'string', description: 'block name, e.g. log, stone, iron_ore, coal_ore, dirt, sand, chest, water' },
        radius: { type: 'integer', minimum: 4, maximum: 64, default: 32 },
        max: { type: 'integer', minimum: 1, maximum: 12, default: 6 },
        y_min: { type: 'integer' }, y_max: { type: 'integer' },
      },
      required: ['block'], additionalProperties: false,
    },
    parallelSafe: true,
    async handler({ block, radius = 32, max = 6, y_min, y_max }) {
      const names = BLOCK_ALIASES[block] ?? [block];
      const ids = names.map((n) => bot.registry?.blocksByName?.[n]?.id).filter((x) => x != null);
      if (!ids.length) return fail('unknown_block', { hint: 'use 1.8 names like log, stone, cobblestone, iron_ore, dirt, sand, reeds, chest' });
      const me = bot.entity?.position;
      if (!me || typeof bot.findBlocks !== 'function') return fail('no_world');
      let found;
      try { found = bot.findBlocks({ matching: ids, maxDistance: Math.min(64, radius), count: 200 }); }
      catch (e) { return fail('scan_error', { msg: e.message }); }
      let protectedSkipped = 0; let wetSkipped = 0; let lavaSkipped = 0;
      const rows = [];
      for (const v of found) {
        if (isInProtectedZone(v)) { protectedSkipped++; continue; }
        if (targetSubmerged(bot, v)) { wetSkipped++; continue; }
        if (lavaAdjacent(bot, v)) { lavaSkipped++; continue; }
        if (y_min != null && v.y < y_min) continue;
        if (y_max != null && v.y > y_max) continue;
        const b = bot.blockAt(v);
        rows.push({ x: v.x, y: v.y, z: v.z, name: b?.name ?? block, distance: distance(me, v), dir: compassDir(me, v) });
      }
      rows.sort((a, b) => a.distance - b.distance);
      const out = { block, found: rows.length, positions: rows.slice(0, max) };
      if (protectedSkipped) out.skipped_in_protection = protectedSkipped;
      if (wetSkipped) out.skipped_underwater = wetSkipped;
      if (lavaSkipped) out.skipped_lava_adjacent = lavaSkipped;
      if (!rows.length) out.hint = found.length ? 'all matches were unsafe or protected; walk elsewhere' : 'none loaded nearby; walk 40-80 blocks and scan again';
      return ok(out);
    },
  };

  const inventory = {
    name: 'inventory',
    description: 'Your inventory grouped by kind (tools, weapons, armor, blocks, ores/ingots, food, other), what you are wearing and holding, and free slots.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    parallelSafe: true,
    async handler() {
      const { groups, counts } = groupInventory(bot);
      const used = bot.inventory?.items?.()?.length ?? 0;
      const out = { ...groups, wearing: wornArmor(bot), holding: bot.heldItem?.name ?? null, free_slots: Math.max(0, 36 - used) };
      // What it is all worth at /sell prices, so coal is not turned into
      // torches while a $100 charter is the goal.
      if (deps.prices?.known) {
        const v = deps.prices.inventoryValue(counts);
        out.sell_value = { total: v.total, top: v.items.slice(0, 5).map((i) => `${i.item} ×${i.count} = $${i.value} ($${i.each} each)`) };
      }
      return ok(out);
    },
  };

  const recipes = {
    name: 'recipes',
    description: 'Look up how to make an item (ingredients, whether a crafting table or furnace is needed, output count) and what you are still missing for `count` of it. Also tells you what tool a block needs to mine and what it drops. Ask with the 1.8 item name.',
    input_schema: {
      type: 'object',
      properties: { item: { type: 'string' }, count: { type: 'integer', minimum: 1, default: 1 } },
      required: ['item'], additionalProperties: false,
    },
    parallelSafe: true,
    async handler({ item, count = 1 }) {
      const out = { item };
      const r = RECIPES[item];
      const inv = countInventory(bot);
      if (r) {
        const batches = Math.ceil(count / (r.output_count ?? 1));
        const need = {}; const missing = {};
        for (const [ing, n] of Object.entries(r.ingredients ?? {})) {
          need[ing] = n * batches;
          const have = countIngredient(inv, ing);
          if (have < need[ing]) missing[ing] = need[ing] - have;
        }
        out.recipe = { ingredients_for_count: need, needs: r.tool_required ?? 'hands', makes: r.output_count ?? 1 };
        out.missing = missing;
        out.can_craft_now = Object.keys(missing).length === 0;
      }
      if (SMELTABLE[item]) out.smelt = { input: item, output: SMELTABLE[item] };
      const tr = TOOL_REQUIREMENTS[item];
      if (tr) out.mining = { tool: tr.tool ?? 'hands', drops: tr.drops ?? item };
      if (!r && !SMELTABLE[item] && !tr) {
        const known = Object.keys(RECIPES).filter((k) => k.includes(item) || item.includes(k)).slice(0, 8);
        return fail('unknown_item', { similar: known });
      }
      return ok(out);
    },
  };

  return [look, scan, inventory, recipes];
}

function lavaAdjacent(bot, v) {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const nb = bot.blockAt?.(v.offset ? v.offset(dx, dy, dz) : { x: v.x + dx, y: v.y + dy, z: v.z + dz });
    if (nb && (nb.name === 'lava' || nb.name === 'flowing_lava')) return true;
  }
  return false;
}
