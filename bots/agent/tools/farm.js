/**
 * farm.js — plant, harvest and tend crops.
 *
 * The blueprint builder lays the plot (fences, farmland, water) but nothing
 * ever sowed it: the old farmWheatLoop was never ported, so TestBot44's
 * 98%-built farm stood empty and dry (2026-09-05). This is the working half
 * of a farm: seeds onto farmland, mature crops out, replant, and a plain
 * report of what the plot still lacks (seeds, water).
 */

import vec3Pkg from 'vec3';
import { countInventory } from '../../world/primitives.js';
import { awaitHandle, cancellableSleep } from '../cancel.js';
import { INTERRUPT_SCHEMA } from './move.js';
import { sweepDrops, diffCounts } from './gather.js';
import { ok, fail, partial, interrupted, roundPos, distance, toVec3 } from './result.js';

const Vec3 = vec3Pkg.Vec3 ?? vec3Pkg;

// 1.8 crop blocks: metadata 7 = mature. Seeds are right-clicked onto farmland.
export const CROPS = Object.freeze({
  wheat: { seed: 'wheat_seeds', mature: 7 },
  carrots: { seed: 'carrot', mature: 7 },
  potatoes: { seed: 'potato', mature: 7 },
});
const SEED_ITEMS = Object.freeze(Object.values(CROPS).map((c) => c.seed));
const HYDRATION_RADIUS = 4;

const isWater = (b) => !!b && (b.name === 'water' || b.name === 'flowing_water');

function blockAt(bot, x, y, z) { try { return bot.blockAt(new Vec3(x, y, z)); } catch { return null; } }

function findBlocks(bot, pred, radius, count = 128) {
  if (typeof bot.findBlocks !== 'function') return [];
  let found = [];
  try { found = bot.findBlocks({ matching: (b) => !!b && pred(b), maxDistance: radius, count }) ?? []; } catch { return []; }
  return found.map((p) => blockAt(bot, p.x, p.y, p.z)).filter(Boolean);
}

/** Farmland cells with nothing growing on them. */
export function emptyFarmland(bot, radius) {
  return findBlocks(bot, (b) => b.name === 'farmland', radius).filter((b) => {
    const above = blockAt(bot, b.position.x, b.position.y + 1, b.position.z);
    return !above || above.name === 'air';
  });
}

/** Crops at full growth. */
export function matureCrops(bot, radius) {
  return findBlocks(bot, (b) => CROPS[b.name] && (b.metadata ?? 0) >= CROPS[b.name].mature, radius);
}

/** Farmland with no water within 4 blocks (it will revert to dirt). */
export function dryFarmland(bot, cells) {
  const dry = [];
  for (const c of cells) {
    let wet = false;
    for (let dx = -HYDRATION_RADIUS; dx <= HYDRATION_RADIUS && !wet; dx++) {
      for (let dz = -HYDRATION_RADIUS; dz <= HYDRATION_RADIUS && !wet; dz++) {
        if (isWater(blockAt(bot, c.position.x + dx, c.position.y, c.position.z + dz)) || isWater(blockAt(bot, c.position.x + dx, c.position.y + 1, c.position.z + dz))) wet = true;
      }
    }
    if (!wet) dry.push(c);
  }
  return dry;
}

function seedItem(bot, crop) {
  const items = bot.inventory?.items?.() ?? [];
  if (crop && CROPS[crop]) return items.find((i) => i?.name === CROPS[crop].seed) ?? null;
  for (const name of SEED_ITEMS) { const it = items.find((i) => i?.name === name); if (it) return it; }
  return null;
}

async function approach(bot, movement, pos, cancel, range = 2) {
  const me = bot.entity?.position;
  if (me && Math.hypot(me.x - (pos.x + 0.5), me.z - (pos.z + 0.5)) <= range + 0.5 && Math.abs(me.y - pos.y) <= 2) return true;
  if (!movement?.goTo) return false;
  await awaitHandle(movement.goTo({ x: pos.x, y: pos.y + 1, z: pos.z }, { timeoutMs: 15_000, range }), cancel);
  const p = bot.entity?.position;
  return !!p && Math.hypot(p.x - (pos.x + 0.5), p.z - (pos.z + 0.5)) <= range + 1.5;
}

async function sow(bot, farmland, seed, cancel) {
  try {
    await bot.equip(seed, 'hand');
    if (bot.lookAt) await bot.lookAt(farmland.position.offset(0.5, 1, 0.5), true);
    await bot.activateBlock(farmland);
  } catch { return false; }
  const until = Date.now() + 800;
  while (Date.now() < until && !cancel?.cancelled) {
    const above = blockAt(bot, farmland.position.x, farmland.position.y + 1, farmland.position.z);
    if (above && CROPS[above.name]) return true;
    await cancellableSleep(100, cancel);
  }
  const above = blockAt(bot, farmland.position.x, farmland.position.y + 1, farmland.position.z);
  return !!above && !!CROPS[above.name];
}

export function farmTools(deps) {
  const { bot, movement, log } = deps;

  const farm = {
    name: 'farm',
    description: 'Work a farm plot. plant: sow seeds on every empty farmland cell within radius; harvest: break mature crops within radius, pick up the drops and replant; tend: harvest then plant. Reports empty and dry farmland left so you know what to fetch (seeds: mine wheat_seeds breaks tall grass; water: place water within 4 blocks of the plot, which needs a bucket). Crops grow by torchlight at night.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['plant', 'harvest', 'tend'], default: 'tend' },
        crop: { type: 'string', enum: ['wheat', 'carrots', 'potatoes'], description: 'which seeds to sow; default: whatever seeds you carry' },
        radius: { type: 'integer', minimum: 4, maximum: 32, default: 12 },
        timeout_s: { type: 'integer', minimum: 15, maximum: 600, default: 180 },
        interrupt_on: INTERRUPT_SCHEMA,
      },
      additionalProperties: false,
    },
    defaultInterrupts: ['damage'],
    async handler({ action = 'tend', crop, radius = 12, timeout_s = 180 }, { cancel }) {
      const start = roundPos(bot.entity?.position);
      if (!start) return fail('no_position');
      const deadline = Date.now() + timeout_s * 1000;
      const before = countInventory(bot);
      let harvested = 0; let planted = 0; let replanted = 0; let failedSow = 0;

      if (action === 'harvest' || action === 'tend') {
        const ripe = matureCrops(bot, radius).sort((a, b) => distance(start, a.position) - distance(start, b.position));
        for (const b of ripe) {
          if (cancel.cancelled || Date.now() > deadline) break;
          if (!await approach(bot, movement, b.position, cancel, 3)) continue;
          try { await bot.dig(b); harvested += 1; } catch (e) { log?.debug?.('farm_harvest_failed', { msg: e.message }); continue; }
          await sweepDrops(bot, movement, 3, cancel, 3000);
          const under = blockAt(bot, b.position.x, b.position.y - 1, b.position.z);
          const seed = seedItem(bot, crop ?? b.name);
          if (under?.name === 'farmland' && seed && !cancel.cancelled) {
            if (await sow(bot, under, seed, cancel)) replanted += 1;
          }
        }
      }

      let empty = [];
      if (action === 'plant' || action === 'tend') {
        empty = emptyFarmland(bot, radius).sort((a, b) => distance(start, a.position) - distance(start, b.position));
        for (const b of empty) {
          if (cancel.cancelled || Date.now() > deadline) break;
          const seed = seedItem(bot, crop);
          if (!seed) break;
          if (!await approach(bot, movement, b.position, cancel, 3)) { failedSow += 1; continue; }
          if (await sow(bot, b, seed, cancel)) planted += 1; else failedSow += 1;
        }
      }

      const gained = diffCounts(before, countInventory(bot));
      const emptyLeft = emptyFarmland(bot, radius);
      const dry = dryFarmland(bot, findBlocks(bot, (b) => b.name === 'farmland', radius));
      const seedsLeft = SEED_ITEMS.reduce((n, name) => n + (countInventory(bot)[name] ?? 0), 0);
      const base = {
        action, harvested, planted, replanted, gained,
        empty_farmland_left: emptyLeft.length, mature_left: matureCrops(bot, radius).length,
        dry_farmland: dry.length, seeds_left: seedsLeft, pos: roundPos(bot.entity?.position),
      };
      if (cancel.cancelled) return interrupted(cancel, base);
      const hints = [];
      if (emptyLeft.length && !seedsLeft) hints.push('no seeds left: mine wheat_seeds (breaks tall grass, ~1 seed per 8) or harvest more');
      if (dry.length) hints.push(`${dry.length} farmland cells have no water within 4 blocks and will turn back to dirt: place water next to the plot (place block water at x,y,z; needs a bucket, 3 iron ingots)`);
      if (base.mature_left) hints.push('mature crops remain: call farm harvest again');
      if (hints.length) base.hint = hints.join('. ');
      if (harvested + planted + replanted > 0) return ok(base);
      if (!emptyLeft.length && !base.mature_left) {
        const anyFarmland = findBlocks(bot, (b) => b.name === 'farmland', radius).length;
        return anyFarmland ? ok({ ...base, note: 'nothing to do: crops are growing' }) : fail('no_farmland', { ...base, hint: 'no farmland within radius: build a wheat_farm_small (needs a hoe and a bucket) first' });
      }
      return partial(seedsLeft ? 'no_progress' : 'no_seeds', base);
    },
  };

  return [farm];
}
