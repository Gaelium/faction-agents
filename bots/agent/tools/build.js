/**
 * build.js — blueprints, survey_site, build. Wraps building/* (registry,
 * site survey, blueprint builder). `build` is the chunkiest tool in the
 * library: one call places a whole structure and reports per-cell failure
 * classes, so the brain fixes causes instead of restarting builds.
 */

import { surveySite } from '../../building/siteSurvey.js';
import { countInventory } from '../../world/primitives.js';
import { isNearProtectedZone } from '../../world/zones.js';
import { placementMethod, hasHoe, hasBucket } from '../../building/placement.js';

// Why cells fail, in words the brain can act on.
const CELL_HINTS = Object.freeze({
  no_hoe: 'farmland needs a hoe: craft wooden_hoe (2 planks + 2 sticks) or stone_hoe, then build again',
  pathfind_failed: 'you cannot reach the site from here: goto the anchor first, or survey_site somewhere flatter and closer',
  no_standing: 'no place to stand next to those cells: clear terrain around the site or pick a flatter anchor',
  server_rejected: 'the server refused placements: you are probably inside or beside a protected zone, or another faction\'s claim',
  cell_occupied: 'something solid is in those cells (log, ore, chest): dig it out, then build again',
  no_reference: 'nothing to place against: build up from ground level or place a support block first',
  equip_failed: 'could not equip the material: check inventory',
  no_bucket: 'water cells need a bucket (3 iron ingots) and a water source nearby',
});
import { awaitHandle } from '../cancel.js';
import { INTERRUPT_SCHEMA } from './move.js';
import { ok, fail, partial, interrupted, roundPos, distance, toVec3 } from './result.js';

export function rotationTowardSpawn(anchor, spawn) {
  const dx = (spawn?.x ?? 0) - anchor.x;
  const dz = (spawn?.z ?? 0) - anchor.z;
  const angle = Math.atan2(dz, dx) * 180 / Math.PI;
  const norm = (angle + 360) % 360;
  if (norm < 45 || norm >= 315) return 0;
  if (norm < 135) return 90;
  if (norm < 225) return 180;
  return 270;
}

/** Tools a blueprint needs beyond its materials (hoe for farmland, bucket for water). */
export function toolsNeeded(bp, inv = {}) {
  const mats = Object.keys(bp?.materials ?? {});
  const needs = [];
  if (mats.some((m) => placementMethod(m) === 'till')) needs.push({ tool: 'hoe', have: hasHoe(inv) });
  if (mats.some((m) => placementMethod(m) === 'water')) needs.push({ tool: 'bucket', have: hasBucket(inv) });
  return needs;
}

function summarize(bp, registry, inv) {
  const { affordable, missing } = registry.canAfford(bp, inv);
  const needs = toolsNeeded(bp, inv);
  return {
    id: bp.id, name: bp.name, category: bp.category, tier: bp.tier_min,
    size: `${bp.dimensions?.x}x${bp.dimensions?.y}x${bp.dimensions?.z}`,
    materials: bp.materials, affordable, missing,
    needs_tools: needs.length ? needs.map((n) => `${n.tool}${n.have ? '' : ' (missing)'}`) : undefined,
    placement: bp.placement,
  };
}

export function buildTools(deps) {
  const { bot, registry, builder, log, state } = deps;

  const blueprints = {
    name: 'blueprints',
    description: 'List the structures you know how to build, with materials and what you are missing for each. Categories: base, farm, storage, defense, trap. Start with dirt_shelter or cobble_hut.',
    input_schema: {
      type: 'object',
      properties: { category: { type: 'string' }, id: { type: 'string', description: 'one blueprint for full details' } },
      additionalProperties: false,
    },
    parallelSafe: true,
    async handler({ category, id }) {
      if (!registry) return fail('no_registry');
      const inv = countInventory(bot);
      if (id) {
        const bp = registry.get(id);
        if (!bp) return fail('unknown_blueprint', { known: registry.all().map((b) => b.id) });
        return ok({ ...summarize(bp, registry, inv), description: bp.description, substitutions: bp.substitutions ?? {} });
      }
      const list = registry.query(category ? { category } : {}).map((bp) => summarize(bp, registry, inv));
      return ok({ count: list.length, blueprints: list.map(({ id, category, tier, size, affordable, missing }) => ({ id, category, tier, size, affordable, missing })) });
    },
  };

  const surveyTool = {
    name: 'survey_site',
    description: 'Find flat, unprotected ground for a blueprint near a spot (default: where you stand). Returns the anchor to pass to `build`, plus earthwork/vegetation to clear and what materials you still lack.',
    input_schema: {
      type: 'object',
      properties: {
        blueprint: { type: 'string' }, x: { type: 'number' }, z: { type: 'number' },
        radius: { type: 'integer', minimum: 6, maximum: 40, default: 18 },
      },
      required: ['blueprint'], additionalProperties: false,
    },
    parallelSafe: true,
    async handler({ blueprint, x, z, radius = 18 }) {
      const bp = registry?.get(blueprint);
      if (!bp) return fail('unknown_blueprint', { known: registry?.all().map((b) => b.id) ?? [] });
      const me = bot.entity?.position;
      const preferred = { x: Number.isFinite(x) ? x : me?.x, y: me?.y, z: Number.isFinite(z) ? z : me?.z };
      if (!Number.isFinite(preferred.x)) return fail('no_position');
      if (isNearProtectedZone(preferred, 16)) return fail('too_close_to_spawn_protection', { hint: 'move at least 48 blocks farther from spawn first' });
      const site = surveySite({ bot, dims: bp.dimensions, preferred, searchRadius: radius, protectionMargin: 16, log });
      if (!site) return fail('no_flat_site', { hint: 'walk somewhere flatter or open, then survey again' });
      const { affordable, missing } = registry.canAfford(bp, countInventory(bot));
      return ok({ blueprint: bp.id, anchor: site.anchor, earthwork: site.earthwork, vegetation: site.vegetation, distance: distance(roundPos(me), site.anchor), affordable, missing });
    },
  };

  const build = {
    name: 'build',
    description: 'Build a blueprint at an anchor (from survey_site; omit to resume the last build or auto-survey here). Clears the site, places blocks in order, and reports placed/failed counts, failure reasons, and what materials are still missing. Refuses to start without the materials. Chunky: one call is the whole structure; call again to resume after gathering more.',
    input_schema: {
      type: 'object',
      properties: {
        blueprint: { type: 'string' },
        x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' },
        max_minutes: { type: 'integer', minimum: 1, maximum: 15, default: 6 },
        allow_dry: { type: 'boolean', default: false, description: 'build a farm without a bucket (the farmland will dry out until you place water)' },
        interrupt_on: INTERRUPT_SCHEMA,
      },
      required: ['blueprint'], additionalProperties: false,
    },
    defaultInterrupts: ['damage'],
    async handler({ blueprint, x, y, z, max_minutes = 6, allow_dry = false }, { cancel }) {
      if (!registry || !builder) return fail('no_builder');
      const bp = registry.get(blueprint);
      if (!bp) return fail('unknown_blueprint', { known: registry.all().map((b) => b.id) });
      const inv = countInventory(bot);
      const { affordable, missing } = registry.canAfford(bp, inv);
      let anchor = [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
      const last = state?.lastBuild;
      if (!anchor && last?.blueprint === bp.id) anchor = last.anchor;
      if (!anchor) {
        const me = bot.entity?.position;
        if (isNearProtectedZone(me, 16)) return fail('too_close_to_spawn_protection', { hint: 'move at least 48 blocks farther from spawn first' });
        const site = surveySite({ bot, dims: bp.dimensions, preferred: me, searchRadius: 18, protectionMargin: 16, log });
        if (!site) return fail('no_flat_site', { hint: 'use survey_site elsewhere, or move to open ground' });
        anchor = site.anchor;
      }
      if (!affordable) {
        // Allow resuming a partially-built structure: what is already placed
        // does not need to be carried. Otherwise refuse before walking.
        const scan = safeScan(builder, bp, anchor, state);
        if (!scan || scan.pct < 5) return fail('missing_materials', { missing, anchor, hint: 'gather these, then build again with the same anchor' });
      }
      // Farms till dirt into farmland; that needs a hoe in inventory before
      // any of it can happen (TestBot44: 24 no_hoe cells per pass, 16% forever).
      const needsHoe = Object.keys(bp.materials ?? {}).some((m) => placementMethod(m) === 'till');
      if (needsHoe && !hasHoe(inv)) return fail('need_hoe', { anchor, hint: CELL_HINTS.no_hoe });
      // Water cells are best-effort in the builder, so a farm "finishes" bone
      // dry without a bucket and the farmland reverts to dirt (TestBot44,
      // 2026-09-05). Refuse up front unless the caller accepts a dry plot.
      const needsWater = Object.keys(bp.materials ?? {}).some((m) => placementMethod(m) === 'water');
      if (needsWater && !hasBucket(inv) && !allow_dry) {
        return fail('need_bucket', { anchor, hint: 'this plot needs water within 4 blocks or the farmland dries out: craft a bucket (3 iron_ingot), then build again (it fills the bucket at nearby water and lays the channel). Pass allow_dry to build now and place water later' });
      }
      // Get to the site first. A site you cannot reach fails every cell
      // with pathfind_failed and wastes the whole time budget (Rook: 0 of
      // 75 blocks in 4 minutes at a hilltop anchor 10 blocks up).
      const here = roundPos(bot.entity?.position);
      if (here && deps.movement?.goTo && distance(here, anchor) > 8) {
        const h = deps.movement.goTo({ x: anchor.x, y: anchor.y, z: anchor.z }, { timeoutMs: 60_000, range: 5 });
        await awaitHandle(h, cancel);
        const now = roundPos(bot.entity?.position);
        if (cancel.cancelled) return interrupted(cancel, { anchor, pos: now });
        if (distance(now, anchor) > 12) {
          return fail('site_unreachable', { anchor, pos: now, distance: distance(now, anchor), hint: 'could not walk to the anchor; unstick or teleport if you are underground, or survey_site near where you stand' });
        }
      }
      const rotation = last?.blueprint === bp.id && last.anchor && sameAnchor(last.anchor, anchor)
        ? last.rotation : rotationTowardSpawn(anchor, state?.spawn);
      if (state) state.lastBuild = { blueprint: bp.id, anchor, rotation };
      const buildStartedAt = Date.now();
      const handle = builder.build(bp, anchor, rotation);
      const timer = setTimeout(() => { try { handle.stop(); } catch {} }, max_minutes * 60_000);
      let r;
      try { r = await awaitHandle(handle, cancel); }
      finally { clearTimeout(timer); }
      const scan = safeScan(builder, bp, anchor, state, rotation);
      const base = {
        blueprint: bp.id, anchor, rotation,
        placed: r?.placed ?? 0, skipped: r?.skipped ?? 0, total: r?.total ?? 0,
        still_missing: r?.missing ?? {},
        completion_pct: scan?.pct ?? null,
        pos: roundPos(bot.entity?.position),
      };
      // Water is optional to the builder; say plainly whether the plot got any.
      if (needsWater) {
        try {
          const cells = builder._buildPlacementList(bp, anchor, rotation).filter((p) => placementMethod(p.blockName ?? '') === 'water');
          const wet = cells.filter((p) => /water/.test(bot.blockAt?.(toVec3(p.world))?.name ?? '')).length;
          base.water = { placed: wet, cells: cells.length };
          if (cells.length && !wet) base.water_hint = hasBucket(inv) ? 'no water was placed (no water source within 16 blocks to fill the bucket?): fill the bucket at a lake and place water next to the farmland' : 'no water placed: the farmland will dry out; craft a bucket (3 iron_ingot) and place water within 4 blocks of the plot';
        } catch {}
      }
      // Factions refused the placements: say so instead of "some cells failed".
      const denial = deps.nerves?.denialSince?.(buildStartedAt);
      if (denial && (r?.placed ?? 0) === 0) {
        return fail('faction_perm_denied', { ...base, faction: denial.faction, perm: denial.perm, hint: `${denial.faction} does not allow you to ${denial.perm} here: you are a recruit on faction land. Ask the leader to run f rank <you> member, or build outside the claim` });
      }
      const skipReasons = r?.skip_reasons && Object.keys(r.skip_reasons).length ? r.skip_reasons : null;
      if (skipReasons) {
        base.failed_cells = skipReasons;
        const top = Object.entries(skipReasons).sort((a, b) => b[1] - a[1])[0]?.[0];
        if (top && CELL_HINTS[top]) base.fix = CELL_HINTS[top];
      }
      if (cancel.cancelled) return interrupted(cancel, base);
      const reason = r?.reason ?? 'unknown';
      if (reason === 'done' || (scan?.reliable && scan.pct >= 100)) {
        let door = null; let inside = null; let chest = null; let stations = {}; let interior = null;
        try {
          const placements = builder._buildPlacementList(bp, anchor, rotation);
          ({ door, inside, chest, stations, interior } = homeCells(placements, anchor, bp.dimensions));
        } catch (e) { log?.debug?.('home_cells_failed', { msg: e.message }); }
        const reg = registerBaseCells({ bot, builder, movement: deps.movement, blueprint: bp, anchor, rotation, log });
        if (state && bp.category === 'base') {
          state.home = { ...anchor, door, inside, chest, stations, interior, blueprint: bp.id, rotation };
          try { deps.memory?.kvSet?.('agent_home', state.home); } catch {}
        }
        if (state) state.lastBuild = null;
        return ok({
          ...base, reason: 'done',
          home_set: bp.category === 'base', door, inside, chest, walls_protected: reg.registered,
          hint: inside ? 'you are standing outside; goto named home walks in through the door, and any goto from inside walks out through it. Step inside before placing a furnace or table here if you want it indoors' : undefined,
        });
      }
      if (reason === 'partial') return partial('partial', { ...base, hint: base.fix ?? (Object.keys(base.still_missing).length ? 'gather the missing materials and call build again (same anchor)' : 'some cells failed; call build again, or clear the obstruction with dig') });
      if (reason === 'no_progress' || reason === 'site_rejected') return fail(reason, { ...base, hint: base.fix ?? 'nothing could be placed here: check you are near the anchor and out of protection; try survey_site elsewhere' });
      if (reason === 'max_duration') return partial('time_budget', { ...base, hint: 'call build again to continue' });
      return partial(reason, base);
    },
  };

  return [blueprints, surveyTool, build];
}

function sameAnchor(a, b) { return a && b && a.x === b.x && a.y === b.y && a.z === b.z; }

const cellKey = (p) => `${p.x},${p.y},${p.z}`;

/**
 * Where the door is and where to stand inside. The door is the lowest
 * door cell in the placement list; "inside" is the air cell at feet level
 * (anchor.y + 1) adjacent to the door on the interior side, falling back
 * to the interior cell nearest the footprint center. Interior items
 * (chest, table, torches) are never candidates because the placement list
 * carries them as real blocks, not air.
 */
export function homeCells(placements, anchor, dims = {}) {
  let door = null; let chest = null; const stations = {};
  for (const p of placements) {
    if (p.blockName && p.blockName.includes('door')) {
      if (!door || p.world.y < door.y) door = { ...p.world };
    }
    if (p.blockName === 'chest' && !chest) chest = { ...p.world };
    if ((p.blockName === 'crafting_table' || p.blockName === 'furnace') && !stations[p.blockName]) stations[p.blockName] = { ...p.world };
  }
  const extras = { chest, stations };
  const air = new Set(placements.filter((p) => p.blockName === null).map((p) => cellKey(p.world)));
  const feetY = anchor.y + 1;
  const cands = placements
    .filter((p) => p.blockName === null && p.world.y === feetY && air.has(cellKey({ ...p.world, y: feetY + 1 })))
    .map((p) => ({ ...p.world }));
  if (!cands.length) return { door, inside: null, interior: null, ...extras };
  // The interior floor as a box at feet level: door.js uses it to tell
  // "standing inside" from "standing outside" so goto uses the door.
  const interior = {
    min: { x: Math.min(...cands.map((c) => c.x)), z: Math.min(...cands.map((c) => c.z)) },
    max: { x: Math.max(...cands.map((c) => c.x)), z: Math.max(...cands.map((c) => c.z)) },
    y: feetY,
  };
  if (door) {
    const adj = cands.find((c) => c.y === door.y && Math.abs(c.x - door.x) + Math.abs(c.z - door.z) === 1);
    if (adj) return { door, inside: adj, interior, ...extras };
  }
  const cx = anchor.x + ((dims.x ?? 1) - 1) / 2;
  const cz = anchor.z + ((dims.z ?? 1) - 1) / 2;
  cands.sort((a, b) => (Math.abs(a.x - cx) + Math.abs(a.z - cz)) - (Math.abs(b.x - cx) + Math.abs(b.z - cz)));
  return { door, inside: cands[0], interior, ...extras };
}

/**
 * Fill in door/inside/chest/interior for a home saved by an earlier
 * version (or with a wiped registry). Returns the merged home or null.
 */
export function refreshHomeCells({ builder, registry, home, spawn }) {
  if (!home?.blueprint || !builder?._buildPlacementList || !registry?.get) return null;
  const bp = registry.get(home.blueprint);
  if (!bp) return null;
  const rotation = Number.isFinite(home.rotation) ? home.rotation : rotationTowardSpawn(home, spawn);
  const anchor = { x: home.x, y: home.y, z: home.z };
  const cells = homeCells(builder._buildPlacementList(bp, anchor, rotation), anchor, bp.dimensions);
  return {
    ...home, rotation,
    door: home.door ?? cells.door, inside: home.inside ?? cells.inside,
    chest: home.chest ?? cells.chest, stations: home.stations ?? cells.stations,
    interior: cells.interior,
  };
}

/**
 * After a verified completion, hand the structure's solid cells to
 * Movement so the pathfinder routes through the door instead of tunneling
 * a wall, and `mine` never harvests the house. Ported from the old
 * executor: ground-truth only (a cell must hold the expected block right
 * now), doors and optional blocks excluded, and skipped entirely unless
 * every door cell reads as a door (no verified exit → no wall lock).
 */
export function registerBaseCells({ bot, builder, movement, blueprint, anchor, rotation, log }) {
  if (!builder?._buildPlacementList || !movement?.setBaseStructureCells) return { registered: 0, reason: 'unsupported' };
  let placements;
  try { placements = builder._buildPlacementList(blueprint, anchor, rotation); } catch (e) { return { registered: 0, reason: 'list_failed:' + e.message }; }
  for (const p of placements) {
    if (!p.blockName || !p.blockName.includes('door')) continue;
    const wb = bot.blockAt?.(toVec3(p.world));
    if (!wb?.name?.includes('door')) {
      log?.info?.('base_cells_skip_no_door', { at: p.world });
      return { registered: 0, reason: 'door_missing' };
    }
  }
  const cells = [];
  for (const p of placements) {
    const name = p.blockName;
    if (!name || name.includes('door') || name.includes('gate')) continue;
    if (/water|lava|seeds|wheat|carrot|potato|reeds|sapling/.test(name)) continue;
    let ok = false;
    try { ok = builder._isAlreadyCorrect ? builder._isAlreadyCorrect(p, blueprint) : false; } catch { ok = false; }
    if (ok) cells.push(cellKey(p.world));
  }
  try { movement.setBaseStructureCells(cells); }
  catch (e) { return { registered: 0, reason: 'set_failed:' + e.message }; }
  log?.info?.('base_cells_registered', { count: cells.length, blueprint: blueprint?.id ?? null });
  return { registered: cells.length };
}

function safeScan(builder, bp, anchor, state, rotation = null) {
  try {
    const rot = rotation ?? (state?.lastBuild?.rotation ?? rotationTowardSpawn(anchor, state?.spawn));
    return builder.scanCompletion?.(bp, anchor, rot) ?? null;
  } catch { return null; }
}
