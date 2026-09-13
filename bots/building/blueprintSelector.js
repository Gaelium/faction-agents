/**
 * blueprintSelector.js — Picks a blueprint for a given strategic goal.
 *
 * select({ profile, inventory, terrain, memory, anchor, category })
 *   → { blueprint, anchor, rotation, affordable, missing } | null
 *
 *   profile     — bot profile (archetype, skill_tier, username)
 *   inventory   — { item_name: count } map
 *   terrain     — optional { ground_y } from the caller; if absent,
 *                 the selector uses anchor.y as-is (caller resolved it)
 *   anchor      — { x, y, z } where the structure should be placed
 *   category    — 'base' | 'farm' | 'trap' | 'storage' | 'wall' | 'tower'
 *
 * Returns null only when NO blueprint matches the archetype + tier +
 * category filter. When matches exist but nothing is affordable,
 * returns the cheapest *obtainable* blueprint — i.e. one whose
 * missing materials the gather and craft tools can obtain. A blueprint
 * needing items with no source (e.g. `reeds` blocks
 * for sugarcane_row, with no recipe or natural mine path) gets
 * deprioritized so the bot doesn't loop selecting it forever.
 */

import {
  RECIPES,
  TOOL_REQUIREMENTS,
  FARMABLE_CROPS,
} from '../world/minecraft.js';

const KV_BUILT_KEY = 'built_blueprints';
const KV_CURRENT_BUILD_KEY = 'current_build';
// How long an abandoned blueprint stays off the menu. Long enough to
// break re-pick loops; short enough that a biome change (bot moved,
// reeds found) gets a retry within the session.
const BLUEPRINT_BLACKLIST_MS = 30 * 60_000;
const SPAWN_REF = { x: 0, z: 0 };  // used to point doors roughly toward spawn

// Items / blocks the bot can always produce or pick up trivially.
// (Water is "minable" with a bucket from any river; the wandering
// path doesn't model that, but practically every farm spec has water
// and we don't want it counted as unobtainable.)
const TRIVIAL_MATERIALS = new Set([
  'water', 'air', 'cobblestone', 'dirt', 'grass', 'sand', 'gravel',
]);

// FARMABLE_CROPS lists harvest-drop ITEMS (sugar_cane, wheat, etc).
// Those are reachable via the farming activity. The placed BLOCKS
// (reeds, wheat as a block) are NOT obtainable — the material check
// only knows RECIPES + TOOL_REQUIREMENTS, so asking for "reeds blocks"
// degenerates to a failed search. Track only the harvest-drop items
// here so the selector matches what the tools can actually get.
const FARMABLE_DROPS = new Set();
for (const v of Object.values(FARMABLE_CROPS)) {
  if (v?.harvest_drop) FARMABLE_DROPS.add(v.harvest_drop);
}

// Block-name forms of farmables — what JSON blueprints actually list
// in their materials when they reference the placed block, not the
// harvested item. Without this set, blueprints that ask for `reeds`
// (the sugar-cane block) get marked infeasible because `reeds` isn't
// in RECIPES, TOOL_REQUIREMENTS, or FARMABLE_DROPS — even though the
// farming activity can supply sugar_cane which the build then places.
const FARMABLE_BLOCKS = new Set();
for (const v of Object.values(FARMABLE_CROPS)) {
  if (v?.block_name) FARMABLE_BLOCKS.add(v.block_name);
}

// Placeable blocks with no explicit recipe / mine
// path for, but that the build pipeline produces as a side effect of
// other actions. `farmland` is created by hoeing dirt — the farming
// activity handles that automatically when seeds are planted, so a
// blueprint requesting farmland shouldn't be marked infeasible.
const PRODUCIBLE_BLOCKS = new Set([
  'farmland',
]);

/**
 * True when the tools can obtain `material`:
 * recipe output, mineable block (in TOOL_REQUIREMENTS), trivially-
 * attainable terrain block, or a farmable harvest-drop. Used to
 * de-prefer blueprints that name a missing material with no path.
 */
export function isMaterialObtainable(material) {
  if (!material) return true;
  if (TRIVIAL_MATERIALS.has(material)) return true;
  if (RECIPES[material]) return true;
  if (TOOL_REQUIREMENTS[material]) return true;
  if (FARMABLE_DROPS.has(material)) return true;
  if (FARMABLE_BLOCKS.has(material)) return true;
  if (PRODUCIBLE_BLOCKS.has(material)) return true;
  return false;
}

export class BlueprintSelector {
  constructor({ registry, memory = null, log = null, spawn = null } = {}) {
    if (!registry) throw new Error('BlueprintSelector requires registry');
    this.registry = registry;
    this.memory = memory;
    this.log = log;
    this.spawnRef = spawn ?? SPAWN_REF;
  }

  select({ profile, inventory = {}, anchor, category, terrain = null } = {}) {
    if (!profile || !category || !anchor) return null;

    const archetype = profile.archetype ?? 'generic';
    const tier = Number(profile.skill_tier ?? 1);

    // 1. Resume in-progress build first if we have one for this category.
    const resume = this._resumableForCategory(category, archetype);
    if (resume) {
      const aff = this.registry.canAfford(resume.blueprint, inventory);
      return {
        blueprint: resume.blueprint,
        anchor: resume.anchor,
        rotation: resume.rotation,
        affordable: aff.affordable,
        missing: aff.missing,
        resumed: true,
      };
    }

    // 2. Filter by category + archetype + tier.
    let candidates = this.registry.query({ category, archetype, tier });
    if (!candidates.length) {
      this.log?.debug?.('blueprint_no_match', { category, archetype, tier });
      return null;
    }

    // Skip recently-failed blueprints. The caller blacklists a
    // blueprint when a build exhausts the attempt caps
    // (e.g. sugarcane_row in a reed-less biome — TestBot23 re-picked
    // it for 11 straight goal cycles). Never empty the pool entirely:
    // if EVERYTHING is blacklisted, the cooldown clearly isn't the
    // binding constraint.
    const blacklist = this.memory?.kvGet?.('blueprint_blacklist', {}) ?? {};
    const now = Date.now();
    const blacklisted = (bp) =>
      (now - (Number(blacklist[bp.id]) || 0)) < BLUEPRINT_BLACKLIST_MS;
    const open = candidates.filter((bp) => !blacklisted(bp));
    if (open.length && open.length < candidates.length) {
      this.log?.debug?.('blueprint_blacklist_filtered', {
        skipped: candidates.filter(blacklisted).map((bp) => bp.id),
      });
    }
    if (open.length) candidates = open;

    // 3. Split into affordable, feasible-but-missing, and infeasible.
    //    A blueprint is "infeasible" when at least one missing material
    //    has no known source (no recipe, not mineable, not farmable).
    //    Sorted bias: not-yet-built > higher tier > random; random
    //    breaks ties so multiple bots don't all pick the same one.
    const built = this._builtSet();
    const affordable = [];
    const cheapestMissing = [];
    const infeasibleMissing = [];
    for (const bp of candidates) {
      const aff = this.registry.canAfford(bp, inventory);
      const score = this._score(bp, built);
      if (aff.affordable) {
        affordable.push({ bp, score, aff });
      } else {
        const unobtainable = Object.keys(aff.missing ?? {})
          .filter((m) => !isMaterialObtainable(m));
        if (unobtainable.length > 0) {
          this.log?.debug?.('blueprint_infeasible', {
            id: bp.id, unobtainable, missing: aff.missing,
          });
          infeasibleMissing.push({ bp, score, aff, unobtainable });
        } else {
          cheapestMissing.push({ bp, score, aff });
        }
      }
    }
    affordable.sort((a, b) => b.score - a.score);
    // When nothing's affordable, prefer an UNBUILT base, then the
    // LOWEST-tier one — its materials are cheaper to gather (cobble/dirt
    // vs obsidian/diamond), which a raw `_totalBlocks` sort misses (a
    // 20-block obsidian vault has fewer blocks than a 64-block cobble hut
    // but is far costlier). Unbuilt-first gives the same "cheap now,
    // upgrade later" as the affordable path: once the starter is built,
    // the next-cheapest UNBUILT (a higher tier) is chosen. Block count
    // breaks remaining ties.
    const byCheapest = (a, b) =>
      (Number(built.has(a.bp.id)) - Number(built.has(b.bp.id)))
      // Surface before underground — same reasoning as _score.
      || (Number(a.bp.placement === 'underground') - Number(b.bp.placement === 'underground'))
      || (a.bp.tier_min - b.bp.tier_min)
      || (a.bp._totalBlocks - b.bp._totalBlocks);
    cheapestMissing.sort(byCheapest);
    infeasibleMissing.sort(byCheapest);

    let pick;
    if (affordable.length) {
      // Random pick from the top scorers (those tied for highest score)
      // so multiple bots don't all pick the same one.
      const top = affordable[0].score;
      const tied = affordable.filter((a) => a.score >= top - 0.01);
      pick = tied[Math.floor(Math.random() * tied.length)];
    } else if (cheapestMissing.length) {
      // Prefer a blueprint whose every missing material has a known
      // gather path. Without this filter the selector would happily
      // pick the cheapest-by-block-count blueprint even when one of
      // its materials (e.g. `reeds` for sugarcane_row) has no recipe
      // and no minable form, sending the bot into a forever-loop of
      // explore/farm tasks that fail with reason='done'.
      pick = cheapestMissing[0];
    } else if (infeasibleMissing.length) {
      // Fallback: every option needs something we don't know how to
      // make. Pick the cheapest so the caller still gets *some*
      // selection, with `affordable=false`. Caller logs the
      // selection; the cascade brake will eventually abandon it and
      // the model picks a different blueprint.
      pick = infeasibleMissing[0];
    } else {
      return null;
    }

    const blueprint = pick.bp;
    const finalAnchor = this._finalAnchor(blueprint, anchor);
    const rotation = this._rotation(finalAnchor);

    // Persist selection so cancel/reconnect resumes the same build.
    this._saveCurrentBuild({ blueprint, anchor: finalAnchor, rotation });

    return {
      blueprint,
      anchor: finalAnchor,
      rotation,
      affordable: pick.aff.affordable,
      missing: pick.aff.missing,
      resumed: false,
    };
  }

  _score(bp, builtSet) {
    let s = 0;
    // "Cheap first, upgrade later." A not-yet-built blueprint is strongly
    // preferred; among unbuilt, the CHEAPEST (lowest tier, then fewest
    // blocks) wins. So a fresh bot builds the cobble hut now; once that's
    // in `built`, the next-cheapest unbuilt (a higher tier) becomes the
    // pick — an organic upgrade path, even for skilled bots. (The old
    // `tier_max * 0.5` did the opposite: it pushed everyone straight to
    // the fanciest base they could query, which then needed
    // obsidian/diamond and cascade-failed the gather.)
    if (!builtSet.has(bp.id)) s += 100;          // unbuilt: dominant
    s -= (bp.tier_min ?? 1) * 5;                  // lower tier = cheaper = preferred
    s -= (bp._totalBlocks ?? 0) * 0.05;           // smaller breaks tier ties
    // Underground builds skip the site survey (their anchor is forced
    // to a deep fixed Y) and need long excavation chains the placement
    // loop hasn't proven out — TestBot20 burned five place attempts on
    // generic_base_t1 at y=12 without ever clearing a cell. Strongly
    // prefer surface builds until the underground path earns trust.
    if (bp.placement === 'underground') s -= 40;
    s += Math.random() * 0.5;                     // tiny jitter so bots vary
    return s;
  }

  _finalAnchor(blueprint, baseAnchor) {
    const offset = Number(blueprint.anchor_y_offset ?? 0);
    let y = Number(baseAnchor.y ?? 64);
    // Underground placements: drop to a fixed deep Y unless caller
    // already provided an underground-y anchor (y < 30).
    if (blueprint.placement === 'underground' && y > 30) {
      y = 12;
    }
    return {
      x: Math.round(baseAnchor.x),
      y: Math.round(y + offset),
      z: Math.round(baseAnchor.z),
    };
  }

  _rotation(anchor) {
    // Pick the 90° rotation whose "south" (door direction) points
    // roughly toward spawn, so doors face into the world rather than
    // away from it.
    const dx = (this.spawnRef.x ?? 0) - anchor.x;
    const dz = (this.spawnRef.z ?? 0) - anchor.z;
    const angle = Math.atan2(dz, dx) * 180 / Math.PI;
    // Bucket angle into 4 cardinal directions:
    //   E (-45..45)  → 0
    //   S (45..135)  → 90
    //   W (135..225) → 180
    //   N (225..315) → 270
    const norm = (angle + 360) % 360;
    if (norm < 45 || norm >= 315) return 0;
    if (norm < 135) return 90;
    if (norm < 225) return 180;
    return 270;
  }

  _builtSet() {
    const list = this.memory?.kvGet?.(KV_BUILT_KEY, []) ?? [];
    return new Set(Array.isArray(list) ? list : []);
  }

  _saveCurrentBuild({ blueprint, anchor, rotation }) {
    if (!this.memory?.kvSet) return;
    try {
      this.memory.kvSet(KV_CURRENT_BUILD_KEY, {
        blueprintId: blueprint.id,
        anchor,
        rotation,
        startedAt: Date.now(),
        totalBlocks: blueprint._totalBlocks,
      });
    } catch (e) { this.log?.debug?.('current_build_save_failed', { msg: e.message }); }
  }

  /** Look up whether there's an in-progress build for this category. */
  _resumableForCategory(category, archetype) {
    if (!this.memory?.kvGet) return null;
    const cur = this.memory.kvGet('build_progress', null);
    if (!cur?.blueprintId || !cur?.anchor) return null;
    const bp = this.registry.get(cur.blueprintId);
    if (!bp) return null;
    if (bp.category !== category) return null;
    if (Array.isArray(bp.archetypes) && !bp.archetypes.includes(archetype)) return null;
    return { blueprint: bp, anchor: cur.anchor, rotation: Number(cur.rotation ?? 0) };
  }
}
