/**
 * gather.js — mine, craft, smelt, place, dig, equip, wear_armor, eat,
 * store, collect_drops. Thin wrappers over tactical/primitives.js; the
 * primitives already carry the 1.8 quirks (transaction retries, crafting
 * table placement, vein following, lava/water guards).
 */

import {
  mineBlock, craftItem, smeltItem, placeBlockAt, digBlockAt, equipItem, storeItems, countInventory, safeFindBlock,
} from '../../world/primitives.js';
import { RECIPES, TOOL_REQUIREMENTS, countIngredient } from '../../world/minecraft.js';
import { awaitHandle, cancellableSleep } from '../cancel.js';
import { INTERRUPT_SCHEMA } from './move.js';
import { ok, fail, partial, interrupted, fromPrimitive, roundPos, distance, toVec3 } from './result.js';

export const MINE_ALIASES = Object.freeze({
  wood: 'log', tree: 'log', logs: 'log', cobble: 'cobblestone', sugarcane: 'reeds', sugar_cane: 'reeds',
  // Seeds come from breaking tall grass (~1 in 8); the model asks for the item.
  wheat_seeds: 'tallgrass', seeds: 'tallgrass', tall_grass: 'tallgrass', grass_seeds: 'tallgrass',
});
// What breaking a block actually yields when it is not the block itself.
export const MINE_DROPS = Object.freeze({ tallgrass: 'wheat_seeds' });

export function gatherTools(deps) {
  const { bot, movement, log, perception } = deps;
  const prim = () => ({ log, movement, perception });

  const mine = {
    name: 'mine',
    description: 'Mine `count` of a block type: finds the nearest safe one, walks there, equips the right tool, digs, collects the drops, and repeats. With vein=true (default) it clears the whole connected ore vein. Wanders to find the block if none is loaded nearby. Chunky: prefer count 8-32 over 1. Returns what was collected. Mining "stone" yields cobblestone.',
    input_schema: {
      type: 'object',
      properties: {
        block: { type: 'string', description: 'log, stone, cobblestone, dirt, sand, gravel, coal_ore, iron_ore, gold_ore, diamond_ore, reeds, wheat_seeds (sweeps tall grass in reach; count = seeds wanted), …' },
        count: { type: 'integer', minimum: 1, maximum: 64, default: 8 },
        vein: { type: 'boolean', default: true },
        radius: { type: 'integer', minimum: 8, maximum: 96, default: 48 },
        timeout_s: { type: 'integer', minimum: 15, maximum: 600 },
        interrupt_on: INTERRUPT_SCHEMA,
      },
      required: ['block'], additionalProperties: false,
    },
    defaultInterrupts: ['damage'],
    async handler(input, { cancel }) {
      const blockName = MINE_ALIASES[input.block] ?? input.block;
      if (!bot.registry?.blocksByName?.[blockName]) return fail('unknown_block', { block: input.block });
      // Ore and stone mines descend toward y 12-40 from where you stand.
      // Starting on or inside your own house means digging a shaft through
      // its floor (TestBot44, 2026-09-03). Refuse and say where to go.
      const descends = /_ore$|^(stone|cobblestone|andesite|diorite|granite)$/.test(blockName);
      const me = bot.entity?.position;
      const home = deps.state?.home;
      if (descends && me) {
        const onOwn = movement?.isOwnBlock?.({ x: me.x, y: me.y - 1, z: me.z });
        const nearHome = home ? distance(roundPos(me), home.inside ?? home) : null;
        if (onOwn || (nearHome != null && nearHome < 12)) {
          return fail('too_close_to_home', {
            distance_to_home: nearHome, hint: 'mining ore or stone digs down from where you stand; walk at least 20 blocks away from your house first (goto), then mine',
          });
        }
      }
      const before = countInventory(bot);
      const opts = prim();
      if (input.timeout_s) opts.maxDurationMs = input.timeout_s * 1000;
      // Tall grass is not ore: it breaks instantly and drops a seed one time
      // in eight. Pathing to each blade one by one cost Ollie 111 s for a
      // single seed (2026-09-07). Sweep every blade in reach from one spot,
      // pick up the drops, step to the next patch; `count` means seeds.
      if (blockName === 'tallgrass') {
        const startedAt = Date.now();
        const r = await harvestGrass(bot, movement, input.count ?? 8, { radius: input.radius ?? 48, deadline: startedAt + (input.timeout_s ? input.timeout_s * 1000 : 180_000), log }, cancel);
        const gained = diffCounts(before, countInventory(bot));
        const seeds = Math.max(0, gained.wheat_seeds ?? 0);
        const base = { block: 'tallgrass', wanted: input.count ?? 8, grass_broken: r.broken, gained, pos: roundPos(bot.entity?.position), elapsed_s: Math.round((Date.now() - startedAt) / 100) / 10 };
        if (cancel.cancelled) return interrupted(cancel, base);
        if (seeds >= (input.count ?? 8)) return ok({ reason: 'done', ...base });
        if (seeds > 0) return partial(r.reason ?? 'partial', { ...base, hint: r.reason === 'no_grass' ? 'no more tall grass nearby: walk to a grassy area (plains) and mine wheat_seeds again' : 'call again for more' });
        return fail(r.reason ?? 'no_seeds', { ...base, hint: r.broken ? 'no seed dropped yet (1 in 8 per blade): call again' : 'no tall grass within reach: walk to a plains or grassy field first (scan tallgrass)' });
      }
      const before_ts = Date.now();
      const params = { blockName, count: input.count ?? 8, finishVein: input.vein !== false, maxSearchRadius: input.radius ?? 48 };
      // Lava floor: never target a block below y 12 (1.8 lava lakes sit at y ≤ 10).
      if (descends) params.yRange = { min: 12, max: 255 };
      // Plain stone is on every hillside and cave wall; the old default dug a
      // shaft toward y 40 for it (Ollie: 280 s underground for 28 cobble).
      // Only ores are worth descending for.
      if (/^(stone|cobblestone|andesite|diorite|granite)$/.test(blockName)) params.targetY = null;
      const handle = mineBlock(bot, params, opts);
      // Underground the pathfinder can fail the same target for minutes
      // ("took too long to decide path"); Rook burned two full 5-minute
      // budgets for 9 coal (2026-09-06). Stop when nothing has come in for a
      // while and say so, instead of standing still until the timeout.
      const { result: r, stalled, stalled_after_s } = await withStallWatchdog(handle, cancel, {
        progress: () => Object.values(countInventory(bot)).reduce((a, b) => a + b, 0),
        stallMs: MINE_STALL_MS,
      });
      const after = countInventory(bot);
      const gained = diffCounts(before, after);
      const denied = factionDenial(deps, before_ts);
      if (denied && !cancel.cancelled && Object.keys(gained).length === 0) return { ...denied, block: blockName, pos: roundPos(bot.entity?.position) };
      if (stalled && !cancel.cancelled) {
        const got0 = Math.max(0, gained[MINE_DROPS[blockName] ?? TOOL_REQUIREMENTS[blockName]?.drops ?? blockName] ?? 0);
        return { ...(got0 > 0 ? partial('no_progress', {}) : fail('no_progress', {})), block: blockName, mined: r?.mined ?? 0, gained, stalled_after_s, pos: roundPos(bot.entity?.position), hint: 'nothing came in for a while: the pathfinder keeps failing here. Move 20+ blocks (goto), dig a fresh tunnel at another y, or scan for a different deposit' };
      }
      // Judge progress by what actually landed in the inventory, not only by
      // the primitive's dig counter: pathfinding digs and vein follow-ups
      // deliver drops the counter never sees (TestBot44: "failed, mined 0"
      // with +10 dirt in the bag).
      const drop = MINE_DROPS[blockName] ?? TOOL_REQUIREMENTS[blockName]?.drops ?? blockName;
      const got = Math.max(0, gained[drop] ?? 0);
      const want = input.count ?? 8;
      let res = fromPrimitive(r, cancel, { progressed: (r?.mined ?? 0) > 0 || got > 0 });
      if (!cancel.cancelled && res.status !== 'ok' && got >= want) res = ok({ reason: 'done', ...r, success: undefined });
      return { ...res, block: blockName, mined: r?.mined ?? 0, gained, pos: roundPos(bot.entity?.position) };
    },
  };

  const craft = {
    name: 'craft',
    description: 'Craft at least `count` ITEMS (not batches; recipes that make 4 per batch round up). If the recipe needs a crafting table and none is within 16 blocks, one is placed from inventory next to where you stand (fine in the field; near home, step inside first if you want it indoors). Use `recipes` first if unsure what is needed. Names: planks, stick, crafting_table, wooden_pickaxe, stone_pickaxe, stone_axe, stone_sword, furnace, chest, torch, wooden_door, iron_pickaxe, bread, …',
    input_schema: {
      type: 'object',
      properties: { item: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 64, default: 1 } },
      required: ['item'], additionalProperties: false,
    },
    defaultInterrupts: [],
    async handler({ item, count = 1 }, { cancel }) {
      if (!RECIPES[item]) {
        const similar = Object.keys(RECIPES).filter((k) => k.includes(item) || item.includes(k)).slice(0, 6);
        return fail('unknown_recipe', { item, similar });
      }
      const before = countInventory(bot);
      // The primitive's `count` is crafting BATCHES; the tool's is ITEMS.
      // planks make 4 per batch, sticks 4, torches 4, fences 2, doors 1.
      const per = RECIPES[item].output_count > 0 ? RECIPES[item].output_count : 1;
      const batches = Math.max(1, Math.ceil(count / per));
      // Hands-only intermediates (logs → planks → sticks) are made on the
      // way, like a player would, instead of costing a failed turn each.
      const prepared = await ensureIntermediates(bot, item, batches, prim(), cancel);
      const handle = craftItem(bot, { recipeName: item, count: batches }, prim());
      const r = await awaitHandle(handle, cancel);
      // A table the primitive placed for this craft comes back with us
      // (4 planks and a turn per craft otherwise), and anything a rejected
      // 1.8 transaction dropped on the floor gets picked up.
      const retrieved = await retrievePlacedTable(bot, movement, before, cancel, log);
      const swept = await sweepDrops(bot, movement, 4, cancel, 6000);
      const after = countInventory(bot);
      const have = after[item] ?? 0;
      const made = have - (before[item] ?? 0);
      let res = fromPrimitive(r, cancel, { progressed: made > 0 });
      if (!cancel.cancelled && res.status !== 'ok' && made >= count) res = ok({ reason: 'done' });
      const out = { ...res, item, requested: count, made, have_now: have, gained: diffCounts(before, after) };
      if (prepared.length) out.prepared = prepared;
      if (retrieved) out.table_retrieved = true;
      if (Object.keys(swept).length) out.picked_up = swept;
      Object.assign(out, workstationNote(bot, before, 'crafting_table', deps.state));
      if (res.status === 'failed' && /missing|ingredient/.test(res.reason ?? '')) out.hint = 'call recipes to see what is missing';
      if (res.status === 'failed' && res.reason === 'no_crafting_table_placed') out.hint = 'you have a table but it could not be placed here (uneven or occupied ground): move 2-3 blocks onto open flat ground and craft again, or place crafting_table on an air cell above solid ground';
      else if (res.status === 'failed' && /no_crafting_table/.test(res.reason ?? '')) out.hint = 'craft a crafting_table (4 planks) first, or stand next to one';
      return out;
    },
  };

  const smelt = {
    name: 'smelt',
    description: 'Smelt `count` of an item in a furnace. Finds one within 16 blocks, otherwise places one from inventory next to where you stand (a field furnace is fine when you are away; near home, step inside first if you want it indoors). Uses coal, or logs/planks as fuel. Blocks until done: 10 s per item. iron_ore → iron_ingot, raw food → cooked, sand → glass, cobblestone → stone.',
    input_schema: {
      type: 'object',
      properties: {
        item: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 64, default: 1 },
        fuel: { type: 'string', description: 'coal (default), log, planks' },
      },
      required: ['item'], additionalProperties: false,
    },
    defaultInterrupts: ['damage'],
    async handler({ item, count = 1, fuel }, { cancel }) {
      const params = { inputItem: item, count };
      if (fuel) params.fuelItem = fuel;
      const before = countInventory(bot);
      const handle = smeltItem(bot, params, prim());
      const r = await awaitHandle(handle, cancel);
      const res = fromPrimitive(r, cancel, { progressed: (r?.smelted?.count ?? 0) > 0 });
      const out = { ...res, item, smelted: r?.smelted ?? null };
      Object.assign(out, workstationNote(bot, before, 'furnace', deps.state));
      return out;
    },
  };

  const place = {
    name: 'place',
    description: 'Place one block from inventory at x,y,z (needs a solid neighbor to place against; walks into range). block "water" pours a water bucket there (an empty bucket is filled at water within 16 blocks first): one source hydrates farmland within 4 blocks. For structures use `build` instead.',
    input_schema: {
      type: 'object',
      properties: { block: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' } },
      required: ['block', 'x', 'y', 'z'], additionalProperties: false,
    },
    defaultInterrupts: [],
    async handler({ block, x, y, z }, { cancel }) {
      if (block === 'water' || block === 'water_bucket') {
        const builder = deps.builder;
        if (!builder?._placeWaterCell) return fail('unsupported', { hint: 'no builder available for water' });
        builder._waterPlaced = 0;
        const target = toVec3({ x, y, z });
        const here = bot.blockAt?.(target);
        if (here && here.name !== 'air' && !/water/.test(here.name)) return fail('cell_occupied', { block: 'water', at: { x, y, z }, block_now: here.name, hint: 'water goes into an air cell (dig it first)' });
        if (movement?.goTo) await awaitHandle(movement.goTo({ x, y, z }, { timeoutMs: 20_000, range: 3 }), cancel);
        if (cancel.cancelled) return interrupted(cancel, { block: 'water', at: { x, y, z } });
        let r;
        try { r = await builder._placeWaterCell(target, null); } catch (e) { r = { ok: false, reason: 'exception:' + e.message }; }
        const now = bot.blockAt?.(target)?.name ?? null;
        if (r?.ok || /water/.test(now ?? '')) return ok({ reason: 'done', block: 'water', at: { x, y, z }, block_now: now });
        const HINTS = {
          no_bucket: 'you need a bucket: craft one from 3 iron_ingot',
          no_water_source: 'no water within 16 blocks to fill the bucket: walk to a lake or river and place water there first to fill it, or carry a water_bucket',
          fill_failed: 'could not fill the bucket; stand next to the water, look at it, and try again',
          no_reference: 'water needs a solid block under the target cell',
        };
        return fail(r?.reason ?? 'water_failed', { block: 'water', at: { x, y, z }, block_now: now, hint: HINTS[r?.reason] });
      }
      const t0 = Date.now();
      const handle = placeBlockAt(bot, { position: { x, y, z }, blockName: block }, prim());
      const r = await awaitHandle(handle, cancel);
      const now = bot.blockAt?.(toVec3({ x, y, z }))?.name ?? null;
      const denied = factionDenial(deps, t0);
      if (denied && now !== block) return { ...denied, block, at: { x, y, z }, block_now: now };
      return { ...fromPrimitive(r, cancel), block, at: { x, y, z }, block_now: now };
    },
  };

  const dig = {
    name: 'dig',
    description: 'Break one specific block at x,y,z (walks into range, equips the right tool, collects the drop). Refuses lava-adjacent and protected blocks, and refuses your own house walls unless force=true. For bulk gathering use `mine`.',
    input_schema: {
      type: 'object',
      properties: { x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' }, force: { type: 'boolean', default: false } },
      required: ['x', 'y', 'z'], additionalProperties: false,
    },
    defaultInterrupts: [],
    async handler({ x, y, z, force = false }, { cancel }) {
      const was = bot.blockAt?.(toVec3({ x, y, z }))?.name ?? null;
      if (!force && movement?.isOwnBlock?.({ x, y, z })) {
        return fail('own_structure', { at: { x, y, z }, was, hint: 'that block is part of your own house; pass force=true if you really mean it' });
      }
      if (!force && /chest|furnace|crafting_table/.test(was ?? '')) {
        return fail('workstation', { at: { x, y, z }, was, hint: `that is a ${was}; open it instead (smelt_collect / withdraw), or pass force=true to break it` });
      }
      const t0 = Date.now();
      const handle = digBlockAt(bot, { position: { x, y, z } }, prim());
      const r = await awaitHandle(handle, cancel);
      const now = bot.blockAt?.(toVec3({ x, y, z }))?.name ?? null;
      const denied = factionDenial(deps, t0);
      if (denied && now && now !== 'air') return { ...denied, at: { x, y, z }, was, block_now: now };
      return { ...fromPrimitive(r, cancel), at: { x, y, z }, was, block_now: now };
    },
  };

  const equip = {
    name: 'equip',
    description: 'Hold an item (slot hand) or wear armor (head/torso/legs/feet). Tools are auto-equipped by mine/dig; use this for weapons or specific items.',
    input_schema: {
      type: 'object',
      properties: { item: { type: 'string' }, slot: { type: 'string', enum: ['hand', 'head', 'torso', 'legs', 'feet'], default: 'hand' } },
      required: ['item'], additionalProperties: false,
    },
    defaultInterrupts: [],
    async handler({ item, slot = 'hand' }, { cancel }) {
      const handle = equipItem(bot, { itemName: item, destination: slot }, { log });
      const r = await awaitHandle(handle, cancel);
      return { ...fromPrimitive(r, cancel), item, slot, holding: bot.heldItem?.name ?? null };
    },
  };

  const wearArmor = {
    name: 'wear_armor',
    description: 'Put on the best armor you are carrying, piece by piece (upgrades worse worn pieces).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    defaultInterrupts: [],
    async handler() {
      const order = ['diamond', 'iron', 'chainmail', 'gold', 'leather'];
      const rank = (n) => { const i = order.findIndex((t) => String(n ?? '').startsWith(t)); return i < 0 ? 99 : i; };
      const slots = [[5, 'head', /_helmet$/], [6, 'torso', /_chestplate$/], [7, 'legs', /_leggings$/], [8, 'feet', /_boots$/]];
      const worn = []; const changed = [];
      for (const [slot, dest, re] of slots) {
        const cands = (bot.inventory?.items?.() ?? []).filter((it) => re.test(it.name)).sort((a, b) => rank(a.name) - rank(b.name));
        const cur = bot.inventory?.slots?.[slot];
        if (cands.length && (!cur || rank(cur.name) > rank(cands[0].name))) {
          try { await bot.equip(cands[0], dest); changed.push(`${dest}: ${cands[0].name}`); }
          catch (e) { log?.debug?.('wear_armor_failed', { dest, msg: e.message }); }
        }
        const now = bot.inventory?.slots?.[slot];
        if (now?.name) worn.push(now.name);
      }
      return ok({ changed, wearing: worn });
    },
  };

  const eat = {
    name: 'eat',
    description: 'Eat the best food you carry. Auto-eat already handles hunger in the background; call this to top up before a fight or when the harness reports hunger with food in inventory.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    defaultInterrupts: [],
    async handler() {
      const foods = bot.registry?.foodsByName ?? {};
      const items = (bot.inventory?.items?.() ?? []).filter((it) => foods[it.name] || /^cooked_|bread|apple|steak|porkchop|melon|cookie|stew/.test(it.name));
      if (typeof bot.food === 'number' && bot.food >= 20) return ok({ ate: null, food_now: bot.food, note: 'not hungry; auto-eat keeps you fed when you carry food', have_food: items.map((i) => i.name) });
      if (!items.length) return fail('no_food');
      items.sort((a, b) => (foods[b.name]?.foodPoints ?? 3) - (foods[a.name]?.foodPoints ?? 3));
      const before = bot.food;
      try {
        await bot.equip(items[0], 'hand');
        await bot.consume();
      } catch (e) { return fail('eat_failed', { msg: e.message, food: bot.food }); }
      return ok({ ate: items[0].name, food_before: before, food_now: bot.food });
    },
  };

  const KEEP_ON_STORE_ALL = /_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$|^(bow|torch|bread|cooked_|apple|steak|porkchop|crafting_table|furnace|bucket|water_bucket)/;

  const resolveChest = ({ x, y, z, named }) => {
    if ([x, y, z].every(Number.isFinite)) return { x, y, z };
    if (named === 'home') return deps.state?.home?.chest ?? null;
    return null;
  };

  const store = {
    name: 'store',
    description: 'Put items into a chest: named home (the chest in your house), the one at x,y,z, or the nearest within 16. items: "*" for everything except tools, weapons, armor, food, torches and workstations, or a list of item names. Walks there first.',
    input_schema: {
      type: 'object',
      properties: {
        items: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], default: '*' },
        named: { type: 'string', enum: ['home'] },
        x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' },
      },
      additionalProperties: false,
    },
    defaultInterrupts: ['damage'],
    async handler({ items = '*', named, x, y, z }, { cancel }) {
      if (Array.isArray(items) && !items.length) items = '*';
      const chest = resolveChest({ x, y, z, named });
      if (named === 'home' && !chest) return fail('no_home_chest', { hint: 'build a base with a chest, or give the chest position' });
      let list = items;
      if (items === '*') {
        list = (bot.inventory?.items?.() ?? []).map((it) => it.name).filter((n) => n && !KEEP_ON_STORE_ALL.test(n));
        list = [...new Set(list)];
        if (!list.length) return ok({ deposited: {}, note: 'nothing worth storing' });
      }
      const params = { items: list };
      if (chest) params.chestPosition = chest;
      const handle = storeItems(bot, params, prim());
      const r = await awaitHandle(handle, cancel);
      const res = fromPrimitive(r, cancel, { progressed: Object.keys(r?.deposited ?? {}).length > 0 });
      if (res.status === 'failed' && res.reason === 'no_chest') res.hint = 'no chest within 16 blocks; craft one (8 planks) and place it, or store named home';
      return { ...res, deposited: r?.deposited ?? null, chest: chest ?? undefined };
    },
  };

  const withdraw = {
    name: 'withdraw',
    description: 'Take items out of a chest: named home, the one at x,y,z, or the nearest within 16. items: "*" for everything, or a list of item names; count caps each item.',
    input_schema: {
      type: 'object',
      properties: {
        items: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], default: '*' },
        count: { type: 'integer', minimum: 0, maximum: 64, description: 'cap per item; 0 or omitted = all' },
        named: { type: 'string', enum: ['home'] },
        x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' },
      },
      additionalProperties: false,
    },
    defaultInterrupts: ['damage'],
    async handler({ items = '*', count, named, x, y, z }, { cancel }) {
      if (Array.isArray(items) && !items.length) items = '*';
      if (!(count > 0)) count = undefined;
      const want = resolveChest({ x, y, z, named });
      if (named === 'home' && !want) return fail('no_home_chest');
      let chest = want ? bot.blockAt?.(toVec3(want)) : null;
      if (!chest || !/chest/.test(chest.name ?? '')) {
        chest = safeFindBlock(bot, 'chest', 16, null) ?? safeFindBlock(bot, 'trapped_chest', 16, null);
      }
      if (!chest) return fail('no_chest');
      const h = movement?.goTo?.(chest.position, { timeoutMs: 15_000, range: 3 });
      if (h) await awaitHandle(h, cancel);
      if (cancel.cancelled) return interrupted(cancel, {});
      let win;
      try { win = await bot.openContainer(chest); } catch (e) { return fail('open_failed', { msg: e.message }); }
      const off = cancel.onCancel(() => { try { win.close(); } catch {} });
      const taken = {};
      try {
        const inside = typeof win.containerItems === 'function' ? win.containerItems() : [];
        const filter = items === '*' ? () => true : (n) => items.includes(n);
        for (const it of inside) {
          if (cancel.cancelled) break;
          if (!it?.name || !filter(it.name)) continue;
          const n = Math.min(it.count, count ?? it.count);
          if (n <= 0) continue;
          try { await win.withdraw(it.type, null, n); taken[it.name] = (taken[it.name] ?? 0) + n; }
          catch (e) { log?.debug?.('withdraw_failed', { name: it.name, msg: e.message }); }
        }
      } finally { try { win.close(); } catch {} off(); }
      const base = { taken, chest: roundPos(chest.position) };
      if (cancel.cancelled) return interrupted(cancel, base);
      return Object.keys(taken).length ? ok(base) : fail('nothing_taken', { ...base, hint: 'chest had none of those items' });
    },
  };

  const lightArea = {
    name: 'light_area',
    description: 'Place up to `max` torches on dark floor spots within `radius` so mobs stop spawning around you (tunnels, your base at night). Needs torches in inventory.',
    input_schema: {
      type: 'object',
      properties: { radius: { type: 'integer', minimum: 2, maximum: 12, default: 6 }, max: { type: 'integer', minimum: 1, maximum: 8, default: 4 } },
      additionalProperties: false,
    },
    defaultInterrupts: ['damage'],
    async handler({ radius = 6, max = 4 }, { cancel }) {
      const torches = countInventory(bot).torch ?? 0;
      if (!torches) return fail('no_torches', { hint: 'craft torches (1 coal + 1 stick makes 4)' });
      const me = bot.entity?.position;
      if (!me || typeof bot.blockAt !== 'function') return fail('no_position');
      const mx = Math.floor(me.x), my = Math.floor(me.y), mz = Math.floor(me.z);
      const airish = (b) => !b || b.name === 'air' || b.boundingBox === 'empty';
      const solid = (b) => !!b && b.name !== 'air' && b.boundingBox === 'block';
      const cands = [];
      for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let dy = -1; dy <= 1; dy++) {
        const x = mx + dx, y = my + dy, z = mz + dz;
        const feet = bot.blockAt(toVec3({ x, y, z })); const head = bot.blockAt(toVec3({ x, y: y + 1, z })); const floor = bot.blockAt(toVec3({ x, y: y - 1, z }));
        if (!airish(feet) || !airish(head) || !solid(floor)) continue;
        const light = typeof feet?.light === 'number' ? feet.light : 15;
        if (light >= 8) continue;
        cands.push({ x, y, z, light, d: Math.abs(dx) + Math.abs(dz) });
      }
      cands.sort((a, b) => a.light - b.light || a.d - b.d);
      const chosen = [];
      for (const c of cands) {
        if (chosen.length >= Math.min(max, torches)) break;
        if (chosen.some((o) => Math.abs(o.x - c.x) + Math.abs(o.z - c.z) < 5)) continue;
        chosen.push(c);
      }
      if (!chosen.length) return ok({ placed: 0, note: 'no dark floor spots within radius' });
      const placedAt = [];
      for (const c of chosen) {
        if (cancel.cancelled) break;
        const h = placeBlockAt(bot, { position: { x: c.x, y: c.y, z: c.z }, blockName: 'torch' }, prim());
        const r = await awaitHandle(h, cancel);
        if (r?.success) placedAt.push({ x: c.x, y: c.y, z: c.z });
      }
      const base = { placed: placedAt.length, positions: placedAt, candidates: cands.length };
      if (cancel.cancelled) return interrupted(cancel, base);
      return placedAt.length ? ok(base) : fail('place_failed', base);
    },
  };

  const collectDrops = {
    name: 'collect_drops',
    description: 'Walk over dropped items lying on the ground within `radius` and pick them up (e.g. after mining or a fight).',
    input_schema: {
      type: 'object',
      properties: { radius: { type: 'integer', minimum: 2, maximum: 24, default: 8 } },
      additionalProperties: false,
    },
    defaultInterrupts: ['damage'],
    async handler({ radius = 8 }, { cancel }) {
      const me = bot.entity?.position;
      if (!me) return fail('no_position');
      if (!dropsWithin(bot, radius).length) return ok({ picked_up: {}, note: 'no drops in range' });
      const gained = await sweepDrops(bot, movement, radius, cancel, 25_000);
      const base = { picked_up: gained };
      if (cancel.cancelled) return interrupted(cancel, base);
      return Object.keys(gained).length ? ok(base) : partial('nothing_picked_up', base);
    },
  };

  return [mine, craft, smelt, place, dig, equip, wearArmor, eat, store, withdraw, collectDrops, lightArea];
}

const NEAR_HOME_BLOCKS = 30;
const HANDS_ONLY = new Set(['planks', 'stick']);
const MINE_STALL_MS = 90_000;
const GRASS_REACH = 4.3;

/** If Factions refused a build/use during a call that started at `since`, the honest failure. */
export function factionDenial(deps, since) {
  const d = deps?.nerves?.denialSince?.(since);
  if (!d) return null;
  return fail('faction_perm_denied', { faction: d.faction, perm: d.perm, hint: `${d.faction} does not allow you to ${d.perm} here: you are a recruit on faction land. Ask the leader (say) to run f rank <you> member, and work elsewhere until then; retrying does nothing` });
}

/**
 * Sweep tall grass for wheat seeds: stand in a patch, break every blade
 * within reach without pathing, pick up the drops, move to the next patch.
 * Returns { broken, reason }.
 */
export async function harvestGrass(bot, movement, wantSeeds, { radius = 48, deadline = Date.now() + 180_000, log = null } = {}, cancel) {
  const ids = ['tallgrass', 'double_plant'].map((n) => bot.registry?.blocksByName?.[n]?.id).filter((v) => v != null);
  if (!ids.length) return { broken: 0, reason: 'unknown_block' };
  const seeds = () => countInventory(bot).wheat_seeds ?? 0;
  const start = seeds();
  let broken = 0; let emptyScans = 0;
  const isGrass = (b) => !!b && (b.name === 'tallgrass' || (b.name === 'double_plant' && ((b.metadata ?? 0) & 8) === 0));
  while (!cancel?.cancelled && Date.now() < deadline && seeds() - start < wantSeeds) {
    const me = bot.entity?.position;
    if (!me) break;
    let found = [];
    try { found = bot.findBlocks({ matching: ids, maxDistance: Math.min(64, radius), count: 200 }) ?? []; } catch { found = []; }
    const blades = found.map((p) => bot.blockAt(toVec3(p))).filter(isGrass);
    if (!blades.length) { if (++emptyScans >= 2) return { broken, reason: 'no_grass' }; await cancellableSleep(300, cancel); continue; }
    emptyScans = 0;
    // The blade with the most neighbours within reach is the best place to stand.
    let best = null; let bestN = -1;
    for (const b of blades.slice(0, 60)) {
      const n = blades.filter((o) => distance(b.position, o.position) <= GRASS_REACH).length;
      if (n > bestN) { best = b; bestN = n; }
    }
    if (distance(me, best.position) > GRASS_REACH - 1 && movement?.goTo) {
      await awaitHandle(movement.goTo({ x: best.position.x, y: best.position.y, z: best.position.z }, { timeoutMs: 15_000, range: 2 }), cancel);
      if (cancel?.cancelled) break;
    }
    const here = bot.entity?.position;
    const inReach = blades.filter((b) => distance(here, b.position) <= GRASS_REACH);
    if (!inReach.length) { if (++emptyScans >= 3) return { broken, reason: 'unreachable' }; continue; }
    for (const b of inReach) {
      if (cancel?.cancelled || Date.now() > deadline) break;
      try { await bot.dig(b); broken += 1; } catch (e) { log?.debug?.('grass_dig_failed', { msg: e.message }); }
      if (seeds() - start >= wantSeeds) break;
    }
    await sweepDrops(bot, movement, 5, cancel, 4000);
  }
  return { broken, reason: cancel?.cancelled ? 'cancelled' : seeds() - start >= wantSeeds ? 'done' : Date.now() >= deadline ? 'timeout' : 'partial' };
}

/**
 * Await a primitive handle, but stop it when `progress()` has not changed
 * for `stallMs`. Returns { result, stalled, stalled_after_s }.
 */
export async function withStallWatchdog(handle, cancel, { progress, stallMs = MINE_STALL_MS, checkMs = 5_000 } = {}) {
  let stalled = false; let stalledAfter = null;
  const started = Date.now();
  let last = progress(); let lastChange = started;
  const timer = setInterval(() => {
    let now;
    try { now = progress(); } catch { now = last; }
    if (now !== last) { last = now; lastChange = Date.now(); return; }
    if (Date.now() - lastChange >= stallMs) {
      stalled = true; stalledAfter = Math.round((Date.now() - started) / 1000);
      clearInterval(timer);
      try { handle.stop?.(); } catch {}
    }
  }, checkMs);
  try {
    const result = await awaitHandle(handle, cancel);
    return { result, stalled, stalled_after_s: stalledAfter };
  } finally { clearInterval(timer); }
}

/** Item entities on the ground within `radius`, nearest first. */
export function dropsWithin(bot, radius) {
  const me = bot.entity?.position;
  if (!me) return [];
  return Object.values(bot.entities ?? {})
    .filter((e) => e?.position && e.type === 'object' && (e.name === 'item' || e.name === 'Item' || e.name === 'item_stack' || e.displayName === 'Item'))
    .map((e) => ({ e, d: distance(me, e.position) }))
    .filter((x) => x.d <= radius)
    .sort((a, b) => a.d - b.d)
    .slice(0, 12);
}

/** Walk over nearby drops for up to `maxMs`; returns what was gained. */
export async function sweepDrops(bot, movement, radius, cancel, maxMs = 8000) {
  const before = countInventory(bot);
  const drops = dropsWithin(bot, radius);
  if (!drops.length || !movement?.goTo) return {};
  const deadline = Date.now() + maxMs;
  for (const { e } of drops) {
    if (cancel?.cancelled || Date.now() > deadline) break;
    if (e.isValid === false) continue;
    const h = movement.goTo(e.position, { timeoutMs: Math.min(6000, Math.max(1000, deadline - Date.now())), range: 0 });
    await awaitHandle(h, cancel);
  }
  return diffCounts(before, countInventory(bot));
}

/**
 * Make the hands-only ingredients (planks from logs, sticks from planks)
 * that `item` × `batches` still lacks. Returns what was prepared.
 */
export async function ensureIntermediates(bot, item, batches, opts, cancel, depth = 0) {
  const recipe = RECIPES[item];
  const prepared = [];
  if (!recipe || depth > 2) return prepared;
  for (const [ing, perBatch] of Object.entries(recipe.ingredients ?? {})) {
    if (!HANDS_ONLY.has(ing)) continue;
    const need = perBatch * batches;
    const have = countIngredient(countInventory(bot), ing);
    if (have >= need) continue;
    const sub = RECIPES[ing];
    const subPer = sub?.output_count > 0 ? sub.output_count : 1;
    const subBatches = Math.ceil((need - have) / subPer);
    // Recurse first: sticks need planks, planks need logs.
    prepared.push(...await ensureIntermediates(bot, ing, subBatches, opts, cancel, depth + 1));
    if (cancel?.cancelled) break;
    const canMake = Object.entries(sub?.ingredients ?? {}).every(([i2, n2]) => countIngredient(countInventory(bot), i2) >= n2 * subBatches);
    if (!canMake) continue;
    const r = await awaitHandle(craftItem(bot, { recipeName: ing, count: subBatches }, opts), cancel);
    if (r?.success) prepared.push({ item: ing, made: subBatches * subPer });
  }
  return prepared;
}

/** If this craft consumed a crafting_table item (the primitive placed one), dig it back up. */
export async function retrievePlacedTable(bot, movement, before, cancel, log) {
  const nowHave = countInventory(bot).crafting_table ?? 0;
  if ((before.crafting_table ?? 0) <= nowHave) return false;
  const table = safeFindBlock(bot, 'crafting_table', 6, null);
  if (!table || cancel?.cancelled) return false;
  const r = await awaitHandle(digBlockAt(bot, { position: table.position }, { movement, log }), cancel);
  if (r?.success) await sweepDrops(bot, movement, 3, cancel, 4000);
  return (countInventory(bot).crafting_table ?? 0) >= nowHave + 1;
}

/**
 * When a craft/smelt consumed a workstation item, it was placed next to
 * the bot. Report where that landed relative to home so the model can tell
 * a field furnace (fine) from one dropped outside its own front door.
 */
export function workstationNote(bot, before, item, state) {
  const after = countInventory(bot);
  if ((after[item] ?? 0) >= (before?.[item] ?? 0)) return {};
  const here = bot.entity?.position;
  const home = state?.home;
  const note = { placed_workstation: item };
  if (home && here) {
    const d = distance(here, home.inside ?? home);
    note.home_distance = d;
    if (d != null && d <= NEAR_HOME_BLOCKS) {
      note.note = `placed ${item} ${d} blocks from home, outside the house`;
    }
  }
  return note;
}

export function diffCounts(before, after) {
  const out = {};
  const names = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const n of names) {
    const d = (after?.[n] ?? 0) - (before?.[n] ?? 0);
    if (d !== 0) out[n] = d;
  }
  return out;
}
