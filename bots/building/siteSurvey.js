/**
 * siteSurvey.js — pick a buildable spot for a structure footprint.
 *
 * Why this exists (TestBot17, 2026-06-06): the build anchor was never
 * *chosen* — it was whatever the home-validation fallback chain gave
 * up at. The bot got pinned at y=63, below grade, and tried to build
 * a shelter into the side of a hill: every wall cell was occupied by
 * terrain, every placement silently rejected. There was no code
 * anywhere that asked "is this spot actually flat, clear, and
 * buildable?" — the thing a human player does instinctively before
 * placing the first block.
 *
 * surveySite() scans candidate anchors in rings around a preferred
 * spot, grades each footprint on flatness / fluids / vegetation /
 * protection, and returns the cheapest one with the anchor Y set to
 * ground+1 — ON the surface, never embedded in it.
 *
 * Pure world-reading (bot.blockAt only) — no movement, no placement —
 * so it's fast and trivially testable against a mock world.
 */

import vec3Pkg from 'vec3';
import { isNearProtectedZone } from '../world/zones.js';

const Vec3 = vec3Pkg.Vec3 ?? vec3Pkg;

// Vegetation: skipped when finding ground level, cheap to clear.
// Includes tree blocks — a footprint over a tree is buildable, it
// just costs the chopping.
const VEGETATION = new Set([
  'leaves', 'leaves2', 'log', 'log2',
  'tallgrass', 'double_plant', 'deadbush', 'snow_layer',
  'red_flower', 'yellow_flower', 'vine', 'waterlily',
  'brown_mushroom', 'red_mushroom', 'sapling', 'cactus', 'reeds',
]);

const FLUIDS = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);

// How far the surface scan looks above/below the hint Y for ground.
const SCAN_UP = 10;
const SCAN_DOWN = 12;

/**
 * Find the terrain surface in column (x, z) near hintY.
 * Returns { ground, vegetation } — ground is the Y of the topmost
 * solid terrain block, vegetation the count of plant/tree cells
 * sitting on it — or a string reject reason:
 *   'unloaded' | 'fluid' | 'no_ground'
 */
function columnGround(bot, x, z, hintY) {
  let y = hintY + SCAN_UP;
  let top = bot.blockAt?.(new Vec3(x, y, z));
  if (!top) return 'unloaded';

  const solidTerrain = (b) =>
    b && b.name !== 'air' && b.boundingBox !== 'empty'
    && !VEGETATION.has(b.name) && !FLUIDS.has(b.name);

  // Started inside terrain (hill/mountain rises above the hint) —
  // walk up to open air first so the downward scan starts above the
  // surface.
  if (solidTerrain(top)) {
    const ceiling = hintY + SCAN_UP * 3;
    while (y < ceiling) {
      y++;
      top = bot.blockAt?.(new Vec3(x, y, z));
      if (!top) return 'unloaded';
      if (!solidTerrain(top)) break;
    }
    if (solidTerrain(top)) return 'no_ground'; // sheer cliff face
  }

  // Scan down for the surface, counting vegetation on the way.
  let vegetation = 0;
  const floor = hintY - SCAN_DOWN;
  while (y >= floor) {
    const b = bot.blockAt?.(new Vec3(x, y, z));
    if (!b) return 'unloaded';
    if (FLUIDS.has(b.name)) return 'fluid';
    if (solidTerrain(b)) return { ground: y, vegetation };
    if (b.name !== 'air') vegetation++;
    y--;
  }
  return 'no_ground'; // ravine / cave mouth deeper than the scan
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Survey for the best anchor near `preferred` for a footprint of
 * `dims` ({ x, z } in blocks, already rotation-adjusted by the
 * caller).
 *
 * Options:
 *   searchRadius   — how far out to scan (default 18)
 *   step           — candidate grid pitch (default 3)
 *   maxHeightDelta — max ground variance across the footprint
 *   avoid          — [{ x, z, radius }] sites to skip (e.g. spots the
 *                    server already rejected placements at)
 *   protectionMargin — min distance from any protected-zone boundary
 *                    (building AT the edge gets placements rejected
 *                    and digging suppressed — TestBot20 lost 11 min
 *                    to a site 16 blocks from the spawn region)
 *
 * Returns { anchor, ground, earthwork, vegetation, cost, scanned }
 * or null when nothing within the radius is buildable. anchor.y is
 * ground + 1 — the structure's floor sits ON the surface.
 */
export function surveySite({
  bot,
  dims,
  preferred,
  searchRadius = 18,
  step = 3,
  maxHeightDelta = 2,
  avoid = [],
  protectionMargin = 16,
  log = null,
} = {}) {
  if (!bot?.blockAt || !dims || !preferred) return null;
  const fx = Math.max(1, Math.round(dims.x ?? 1));
  const fz = Math.max(1, Math.round(dims.z ?? 1));
  const px = Math.round(preferred.x);
  const py = Math.round(preferred.y ?? bot.entity?.position?.y ?? 64);
  const pz = Math.round(preferred.z);

  // Column results are shared across overlapping candidate footprints
  // — cache them so the scan is O(unique columns), not O(candidates ×
  // footprint).
  const colCache = new Map();
  const colAt = (x, z) => {
    const k = `${x},${z}`;
    if (!colCache.has(k)) colCache.set(k, columnGround(bot, x, z, py));
    return colCache.get(k);
  };

  const avoided = (x, z) => avoid.some((a) => {
    const r = a.radius ?? 16;
    const dx = x - a.x; const dz = z - a.z;
    return dx * dx + dz * dz <= r * r;
  });

  let best = null;
  let scanned = 0;

  const evaluate = (ax, az) => {
    scanned++;
    if (avoided(ax, az)) return null;
    // Protection check on all four footprint corners — with margin.
    // A footprint that merely TOUCHES the boundary gets placements
    // rejected and digging suppressed.
    for (const [cx, cz] of [[ax, az], [ax + fx - 1, az], [ax, az + fz - 1], [ax + fx - 1, az + fz - 1]]) {
      if (isNearProtectedZone({ x: cx, z: cz }, protectionMargin)) return null;
    }
    const grounds = [];
    let vegetation = 0;
    for (let x = ax; x < ax + fx; x++) {
      for (let z = az; z < az + fz; z++) {
        const col = colAt(x, z);
        if (typeof col === 'string') return null; // unloaded / fluid / no_ground
        grounds.push(col.ground);
        vegetation += col.vegetation;
      }
    }
    const base = median(grounds);
    let earthwork = 0;
    for (const g of grounds) {
      const d = Math.abs(g - base);
      if (d > maxHeightDelta) return null;
      earthwork += d;
    }
    const dist = Math.hypot(ax - px, az - pz);
    const cost = earthwork * 1.0 + vegetation * 0.5 + dist * 0.15;
    return { anchor: { x: ax, y: base + 1, z: az }, ground: base, earthwork, vegetation, cost };
  };

  // Ring scan outward from the preferred spot; within each ring,
  // candidates on a `step` grid. Stop early once a ring closes with a
  // zero-earthwork site in hand — farther rings can only win on
  // distance, which they lose by construction.
  for (let r = 0; r <= searchRadius; r += step) {
    for (let dx = -r; dx <= r; dx += step) {
      for (let dz = -r; dz <= r; dz += step) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring perimeter only
        const c = evaluate(px + dx, pz + dz);
        if (c && (!best || c.cost < best.cost)) best = c;
      }
    }
    if (best && best.earthwork === 0 && best.vegetation === 0) break;
  }

  if (log) {
    if (best) {
      log.debug?.('site_survey_result', {
        preferred: { x: px, y: py, z: pz },
        anchor: best.anchor,
        earthwork: best.earthwork,
        vegetation: best.vegetation,
        cost: Math.round(best.cost * 100) / 100,
        scanned,
      });
    } else {
      log.debug?.('site_survey_empty', {
        preferred: { x: px, y: py, z: pz }, searchRadius, scanned,
      });
    }
  }
  return best ? { ...best, scanned } : null;
}
