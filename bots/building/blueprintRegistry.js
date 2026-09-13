/**
 * blueprintRegistry.js — Loads, validates, and indexes blueprint JSON
 * files from `bots/building/blueprints/`. The registry is built once
 * at startup; query / canAfford / materialsNeeded read from the
 * in-memory index.
 *
 * Validation is lenient: a malformed blueprint logs a warning and is
 * skipped — it does not abort the whole load. The bot continues with
 * whatever blueprints did parse cleanly.
 *
 * Each loaded blueprint gets two synthetic fields:
 *   _file        : absolute path it was loaded from
 *   _totalBlocks : sum of non-null cells across layers + interior
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOptionalBlock, placementMethod, defaultSource } from './placement.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLUEPRINTS_DIR = path.join(__dirname, 'blueprints');

const KNOWN_CATEGORIES = new Set([
  'base', 'farm', 'trap', 'storage', 'wall', 'tower',
]);
const KNOWN_PLACEMENTS = new Set([
  'surface', 'underground', 'sky', 'any',
]);
const KNOWN_BUILD_ORDERS = new Set([
  'bottom_up', 'walls_first', 'inside_out',
]);

export class BlueprintRegistry {
  constructor({ dir = BLUEPRINTS_DIR, log = null } = {}) {
    this.dir = dir;
    this.log = log;
    this._byId = new Map();
    this._load();
  }

  _load() {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); }
    catch (e) {
      this.log?.warn?.('blueprint_dir_missing', { dir: this.dir, msg: e.message });
      return;
    }
    for (const f of files) {
      const full = path.join(this.dir, f);
      try {
        const raw = fs.readFileSync(full, 'utf8');
        const bp = JSON.parse(raw);
        const validated = this._validate(bp, full);
        if (!validated) continue;
        this._byId.set(validated.id, validated);
      } catch (e) {
        this.log?.warn?.('blueprint_parse_failed', { file: f, msg: e.message });
      }
    }
    this.log?.info?.('blueprints_loaded', { count: this._byId.size });
  }

  _validate(bp, filePath) {
    const id = bp.id;
    if (typeof id !== 'string' || !id.length) {
      this.log?.warn?.('blueprint_invalid', { file: filePath, msg: 'missing id' });
      return null;
    }

    if (!KNOWN_CATEGORIES.has(bp.category)) {
      this.log?.warn?.('blueprint_invalid_category', { id, category: bp.category });
      return null;
    }
    if (bp.placement && !KNOWN_PLACEMENTS.has(bp.placement)) {
      this.log?.warn?.('blueprint_invalid_placement', { id, placement: bp.placement });
      return null;
    }
    const buildOrder = bp.build_order ?? 'bottom_up';
    if (!KNOWN_BUILD_ORDERS.has(buildOrder)) {
      this.log?.warn?.('blueprint_invalid_build_order', { id, buildOrder });
      return null;
    }

    const tierMin = Number(bp.tier_min ?? 1);
    const tierMax = Number(bp.tier_max ?? tierMin);
    if (!(tierMin <= tierMax)) {
      this.log?.warn?.('blueprint_tier_range_inverted', { id, tierMin, tierMax });
      return null;
    }

    const dims = bp.dimensions ?? {};
    const dx = Number(dims.x);
    const dy = Number(dims.y);
    const dz = Number(dims.z);
    if (!(dx > 0 && dy > 0 && dz > 0)) {
      this.log?.warn?.('blueprint_invalid_dimensions', { id, dims });
      return null;
    }

    const layers = bp.layers;
    if (!Array.isArray(layers) || layers.length !== dy) {
      this.log?.warn?.('blueprint_layers_y_mismatch', {
        id, expected: dy, actual: Array.isArray(layers) ? layers.length : null,
      });
      return null;
    }
    for (let y = 0; y < layers.length; y++) {
      const layer = layers[y];
      if (!Array.isArray(layer) || layer.length !== dz) {
        this.log?.warn?.('blueprint_layer_z_mismatch', {
          id, y, expected: dz, actual: Array.isArray(layer) ? layer.length : null,
        });
        return null;
      }
      for (let z = 0; z < layer.length; z++) {
        const row = layer[z];
        if (typeof row !== 'string' || row.length !== dx) {
          this.log?.warn?.('blueprint_row_x_mismatch', {
            id, y, z, expected: dx, actual: typeof row === 'string' ? row.length : null,
          });
          return null;
        }
      }
    }

    const tokenMap = bp.token_map ?? {};
    if (typeof tokenMap !== 'object') {
      this.log?.warn?.('blueprint_invalid_token_map', { id });
      return null;
    }
    // Verify every token used in layers is mapped.
    const usedTokens = new Set();
    for (const layer of layers) for (const row of layer) {
      for (const ch of row) usedTokens.add(ch);
    }
    for (const tok of usedTokens) {
      if (!(tok in tokenMap)) {
        this.log?.warn?.('blueprint_token_unmapped', { id, token: tok });
        return null;
      }
    }

    // Compute total non-null cells from layers + interior.
    let layerBlocks = 0;
    for (const layer of layers) for (const row of layer) {
      for (const ch of row) {
        if (tokenMap[ch] != null) layerBlocks++;
      }
    }
    const interior = Array.isArray(bp.interior) ? bp.interior : [];
    const totalBlocks = layerBlocks + interior.length;

    // Soft-warn if materials count differs from layer cell count.
    const matSum = Object.values(bp.materials ?? {})
      .reduce((s, v) => s + (Number(v) || 0), 0);
    if (matSum && matSum !== totalBlocks) {
      this.log?.debug?.('blueprint_materials_mismatch', {
        id, layerBlocks, interiorBlocks: interior.length, totalBlocks, matSum,
      });
    }

    return {
      ...bp,
      build_order: buildOrder,
      placement: bp.placement ?? 'surface',
      anchor_y_offset: Number(bp.anchor_y_offset ?? 0),
      tier_min: tierMin,
      tier_max: tierMax,
      _file: filePath,
      _totalBlocks: totalBlocks,
      _layerBlocks: layerBlocks,
    };
  }

  all() {
    return [...this._byId.values()];
  }

  get(id) {
    return this._byId.get(id) ?? null;
  }

  /**
   * Filter + sort blueprints. Returns a new array sorted by total block
   * count ascending — so the cheapest valid pick comes first when the
   * caller doesn't override the sort.
   */
  query({ category = null, archetype = null, tier = null, placement = null } = {}) {
    const out = [];
    for (const bp of this._byId.values()) {
      if (category && bp.category !== category) continue;
      if (placement && placement !== 'any' && bp.placement !== placement
          && bp.placement !== 'any') continue;
      if (archetype && Array.isArray(bp.archetypes) && !bp.archetypes.includes(archetype)) continue;
      if (tier != null) {
        // A bot can build anything its skill reaches: keep the tier_min
        // FLOOR (don't attempt a build too advanced) but DROP the
        // tier_max ceiling. cobble_hut / dirt_shelter are tier 1-2, so a
        // tier-3 bot was locked out of every cheap starter and forced
        // into obsidian/diamond bases. "Cheap first, upgrade later" is
        // enforced by the selector's _score, not by hiding cheap builds.
        if (Number(tier) < bp.tier_min) continue;
      }
      out.push(bp);
    }
    out.sort((a, b) => a._totalBlocks - b._totalBlocks);
    return out;
  }

  /**
   * Check whether the given inventory satisfies the blueprint's
   * material list, considering substitutions. Returns:
   *   { affordable: bool, missing: { name: count } }
   * `missing` lists every material the bot can't satisfy even with
   * substitutions, with the count still needed.
   */
  canAfford(blueprint, inventory) {
    const inv = { ...inventory };
    const missing = {};
    const materials = blueprint?.materials ?? {};
    const subs = blueprint?.substitutions ?? {};

    for (const [name, neededRaw] of Object.entries(materials)) {
      let needed = Number(neededRaw) || 0;
      if (needed <= 0) continue;
      // Optional blocks (water, all seeds/crops) are placed BEST-EFFORT at
      // build time from whatever's on hand — gatherablesForMissing strips
      // them, the completion gate ignores them, so they must NOT block
      // affordability here either. Without this, EVERY farm stays
      // "unaffordable" on water/seeds after a perfect gather and loops in
      // the gather phase forever (TestBot39 sugarcane_row: missing reeds).
      if (isOptionalBlock(name)) continue;
      // Till-blocks (farmland) are MADE at build time by hoeing their
      // source (dirt), never held as the literal block — satisfy against
      // the source so a bot holding enough dirt counts as affordable, but
      // still report any shortfall under the blueprint name so the gather
      // pipeline maps it back to dirt + a hoe.
      const matchName = placementMethod(name) === 'till' ? defaultSource(name) : name;
      // Direct match (against the source for till-blocks).
      if ((inv[matchName] ?? 0) > 0) {
        const take = Math.min(needed, inv[matchName]);
        inv[matchName] -= take;
        needed -= take;
      }
      // Substitutions.
      const subList = Array.isArray(subs[name]) ? subs[name] : [];
      for (const alt of subList) {
        if (needed <= 0) break;
        if ((inv[alt] ?? 0) > 0) {
          const take = Math.min(needed, inv[alt]);
          inv[alt] -= take;
          needed -= take;
        }
      }
      // Loose match: inventory items whose name *contains* the
      // material name (e.g. "oak_planks" satisfies "planks"). Helps
      // when 1.8 minecraft-data uses generic names but inventory
      // surfaces variants.
      if (needed > 0) {
        for (const invName of Object.keys(inv)) {
          if (needed <= 0) break;
          if (inv[invName] > 0 && invName !== name && invName.includes(name)) {
            const take = Math.min(needed, inv[invName]);
            inv[invName] -= take;
            needed -= take;
          }
        }
      }
      if (needed > 0) {
        // Substitution list of [] means "skip — unplaceable" (e.g.
        // water without bucket). Don't count as missing.
        if (subList.length === 0 && Array.isArray(subs[name])) continue;
        missing[name] = needed;
      }
    }
    return { affordable: Object.keys(missing).length === 0, missing };
  }

  /** Delegate so the build tool and the prompt can ask "what do you still need". */
  materialsNeeded(blueprint, inventory) {
    return this.canAfford(blueprint, inventory).missing;
  }
}
