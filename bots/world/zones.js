/**
 * zones.js — server-side protected regions the bot must respect.
 *
 * Most factions servers wrap spawn in two concentric zones:
 *   - safezone:  no PvP, no break, no place (the inner shop area)
 *   - warzone:   PvP allowed, no place, no break (the buffer ring)
 *
 * Both reject `dig` / `placeBlock` operations from world-guard, so
 * any mineBlock / blueprint task that lands inside silently 0-bytes
 * and the bot wastes its time.
 *
 * Zone shapes:
 *   circle — { center: {x, z}, radius }            (legacy / manual)
 *   box    — { min: {x, z}, max: {x, z} }          (WorldGuard cuboids)
 *   chunks — { chunks: ['cx,cz', ...] }            (Factions claims)
 *
 * `loadServerZones()` reads the authoritative shapes straight from
 * the server's own files (WorldGuard regions.yml + Factions board
 * JSON) when the bots run on the same machine as the server. The
 * old hand-modeled circle (r=200 around spawn) mismatched the real
 * protection both ways: it pushed bot homes ~200 blocks out past
 * terrain they then couldn't path through, while the REAL region is
 * a cuboid the circle only approximates.
 *
 * Falls back to the manual default circle when the files are
 * missing (bots on a different machine, tests).
 */

import fs from 'node:fs';
import yaml from 'js-yaml';

const DEFAULT_SPAWN_PROTECTION = Object.freeze({
  shape: 'circle',
  type: 'spawn',
  // World-guard center (server-set). Protection is a vertical column.
  center: Object.freeze({ x: 420, z: 220 }),
  radius: 200,
  description:
    'Server spawn safezone + warzone + buffer — bots must base / mine well away from spawn.',
});

let _zones = [DEFAULT_SPAWN_PROTECTION];

function chunkKey(x, z) {
  return `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
}

function normalizeZone(z) {
  if (!z) return null;
  const type = z.type ?? 'protected';
  const description = z.description ?? null;
  if (z.center && typeof z.center.x === 'number' && typeof z.center.z === 'number'
      && typeof z.radius === 'number' && z.radius > 0) {
    return Object.freeze({
      shape: 'circle', type, description,
      center: Object.freeze({ x: z.center.x, z: z.center.z }),
      radius: z.radius,
    });
  }
  if (z.min && z.max
      && typeof z.min.x === 'number' && typeof z.min.z === 'number'
      && typeof z.max.x === 'number' && typeof z.max.z === 'number') {
    return Object.freeze({
      shape: 'box', type, description,
      min: Object.freeze({ x: Math.min(z.min.x, z.max.x), z: Math.min(z.min.z, z.max.z) }),
      max: Object.freeze({ x: Math.max(z.min.x, z.max.x), z: Math.max(z.min.z, z.max.z) }),
    });
  }
  if (Array.isArray(z.chunks) || z.chunks instanceof Set) {
    const chunks = new Set([...z.chunks].map(String));
    if (chunks.size === 0) return null;
    // Centroid (in block coords) — used to push positions out.
    let sx = 0; let sz = 0;
    for (const k of chunks) {
      const [cx, cz] = k.split(',').map(Number);
      sx += cx * 16 + 8; sz += cz * 16 + 8;
    }
    return Object.freeze({
      shape: 'chunks', type, description,
      chunks,
      centroid: Object.freeze({ x: sx / chunks.size, z: sz / chunks.size }),
    });
  }
  return null;
}

/**
 * Replace the global protected-zone list. Pass an empty array to
 * disable all protection awareness (e.g. for tests on a server
 * without world-guard). Accepts any mix of circle / box / chunk
 * shapes (see header).
 */
export function setProtectedZones(zones) {
  if (!Array.isArray(zones)) return;
  _zones = zones.map(normalizeZone).filter(Boolean);
}

export function getProtectedZones() {
  return _zones.slice();
}

/**
 * Horizontal distance from `pos` to the zone's boundary.
 * 0 when inside (or on the boundary).
 */
function distanceToZone(pos, zone) {
  if (zone.shape === 'circle') {
    const d = Math.hypot(pos.x - zone.center.x, pos.z - zone.center.z) - zone.radius;
    return Math.max(0, d);
  }
  if (zone.shape === 'box') {
    const dx = Math.max(zone.min.x - pos.x, 0, pos.x - zone.max.x);
    const dz = Math.max(zone.min.z - pos.z, 0, pos.z - zone.max.z);
    return Math.hypot(dx, dz);
  }
  if (zone.shape === 'chunks') {
    if (zone.chunks.has(chunkKey(pos.x, pos.z))) return 0;
    // Exact distance to nearby member chunks only — claims are
    // contiguous in practice, and "near" checks never need more
    // than a few chunks of context.
    const ccx = Math.floor(pos.x / 16);
    const ccz = Math.floor(pos.z / 16);
    let best = Infinity;
    for (let cx = ccx - 3; cx <= ccx + 3; cx++) {
      for (let cz = ccz - 3; cz <= ccz + 3; cz++) {
        if (!zone.chunks.has(`${cx},${cz}`)) continue;
        const dx = Math.max(cx * 16 - pos.x, 0, pos.x - (cx * 16 + 16));
        const dz = Math.max(cz * 16 - pos.z, 0, pos.z - (cz * 16 + 16));
        best = Math.min(best, Math.hypot(dx, dz));
      }
    }
    return best;
  }
  return Infinity;
}

function insideZone(pos, zone) {
  if (zone.shape === 'circle') {
    const dx = pos.x - zone.center.x;
    const dz = pos.z - zone.center.z;
    return dx * dx + dz * dz <= zone.radius * zone.radius;
  }
  if (zone.shape === 'box') {
    return pos.x >= zone.min.x && pos.x <= zone.max.x
        && pos.z >= zone.min.z && pos.z <= zone.max.z;
  }
  if (zone.shape === 'chunks') {
    return zone.chunks.has(chunkKey(pos.x, pos.z));
  }
  return false;
}

/**
 * True when (x, z) lies within any registered protected zone.
 * y is ignored — server protections are typically vertical columns.
 */
export function isInProtectedZone(pos) {
  if (!pos || typeof pos.x !== 'number' || typeof pos.z !== 'number') return false;
  return _zones.some((z) => insideZone(pos, z));
}

/**
 * True when (x, z) is inside OR within `buffer` blocks of any zone's
 * boundary. Used by movement to suppress dig-paths near protection.
 */
export function isNearProtectedZone(pos, buffer = 0) {
  if (!pos || typeof pos.x !== 'number' || typeof pos.z !== 'number') return false;
  return _zones.some((z) => insideZone(pos, z) || distanceToZone(pos, z) < buffer);
}

/** The zone `pos` is inside, else the nearest zone within `buffer` blocks, else null. */
export function nearestProtectedZone(pos, buffer = 0) {
  if (!pos || typeof pos.x !== 'number' || typeof pos.z !== 'number') return null;
  const inside = _zones.find((z) => insideZone(pos, z));
  if (inside) return inside;
  let best = null;
  for (const z of _zones) { const d = distanceToZone(pos, z); if (d < buffer && (!best || d < best.d)) best = { z, d }; }
  return best?.z ?? null;
}

/** Return the first matching zone or null. */
export function findProtectedZone(pos) {
  if (!pos || typeof pos.x !== 'number' || typeof pos.z !== 'number') return null;
  return _zones.find((z) => insideZone(pos, z)) ?? null;
}

function pushOutOfZone(pos, zone, padding) {
  if (zone.shape === 'circle') {
    const dx = pos.x - zone.center.x;
    const dz = pos.z - zone.center.z;
    const dist = Math.hypot(dx, dz);
    if (dist === 0) {
      return { x: zone.center.x + zone.radius + padding, z: zone.center.z };
    }
    const k = (zone.radius + padding) / dist;
    return {
      x: Math.round(zone.center.x + dx * k),
      z: Math.round(zone.center.z + dz * k),
    };
  }
  if (zone.shape === 'box') {
    // Exit RADIALLY — along the ray from the box center through the
    // position — not through the nearest face. Nearest-face exits
    // collapsed every home whose hashed offset landed inside the box
    // onto the SAME line (x = max.x + padding): TestBots 19/20/21 all
    // ended up basing on the east edge of spawn protection within a
    // few blocks of each other. The radial exit preserves each bot's
    // own direction, spreading bases around the perimeter.
    const cx = (zone.min.x + zone.max.x) / 2;
    const cz = (zone.min.z + zone.max.z) / 2;
    const hx = (zone.max.x - zone.min.x) / 2;
    const hz = (zone.max.z - zone.min.z) / 2;
    let dx = pos.x - cx;
    let dz = pos.z - cz;
    if (dx === 0 && dz === 0) { dx = 1; dz = 0; }   // dead center → east
    const norm = Math.hypot(dx, dz);
    dx /= norm; dz /= norm;
    // Ray exits the box where max(|dx·t|/hx, |dz·t|/hz) = 1.
    const tExit = 1 / Math.max(Math.abs(dx) / hx, Math.abs(dz) / hz);
    const t = tExit + padding;
    return { x: Math.round(cx + dx * t), z: Math.round(cz + dz * t) };
  }
  if (zone.shape === 'chunks') {
    // Step away from the claim centroid, one chunk at a time.
    let dx = pos.x - zone.centroid.x;
    let dz = pos.z - zone.centroid.z;
    const d = Math.hypot(dx, dz);
    if (d === 0) { dx = 1; dz = 0; } else { dx /= d; dz /= d; }
    return {
      x: Math.round(pos.x + dx * (16 + padding)),
      z: Math.round(pos.z + dz * (16 + padding)),
    };
  }
  return { x: pos.x, z: pos.z };
}

/**
 * If `pos` lies inside a protected zone, return a coordinate just
 * outside it (plus `padding`). If already outside or no zone applies,
 * return `pos` unchanged. Iterates because escaping one zone can land
 * inside an overlapping one (warzone wraps safezone).
 */
export function pushOutsideProtection(pos, padding = 8) {
  let cur = { x: pos.x, z: pos.z };
  for (let i = 0; i < 8; i++) {
    const zone = findProtectedZone(cur);
    if (!zone) return cur;
    cur = pushOutOfZone(cur, zone, padding);
  }
  return cur;
}

export function zoneCenter(zone) {
  if (zone.shape === 'circle') return { x: zone.center.x, z: zone.center.z };
  if (zone.shape === 'box') return { x: (zone.min.x + zone.max.x) / 2, z: (zone.min.z + zone.max.z) / 2 };
  if (zone.shape === 'chunks') return { x: zone.centroid.x, z: zone.centroid.z };
  return { x: 0, z: 0 };
}

/**
 * A coordinate at least `buffer` blocks clear of every zone. Unlike
 * pushOutsideProtection this also moves a point that is OUTSIDE a zone
 * but within the buffer — the case the spawn point itself is in on this
 * server (spawn 513,216 sits 20 blocks east of the WorldGuard box), where
 * leave_spawn used to be handed its own position as the exit and spun
 * ~2,900 instant "reached" hops until its timeout (2026-09-04).
 */
export function pushClearOfProtection(pos, buffer = 8) {
  let cur = { x: pos.x, z: pos.z };
  for (let i = 0; i < 16; i++) {
    const inside = findProtectedZone(cur);
    if (inside) { cur = pushOutOfZone(cur, inside, buffer); continue; }
    let near = null;
    for (const z of _zones) {
      const d = distanceToZone(cur, z);
      if (d < buffer && (!near || d < near.d)) near = { zone: z, d };
    }
    if (!near) return cur;
    const c = zoneCenter(near.zone);
    let dx = cur.x - c.x; let dz = cur.z - c.z;
    const n = Math.hypot(dx, dz);
    if (n === 0) { dx = 1; dz = 0; } else { dx /= n; dz /= n; }
    const step = Math.max(8, buffer - near.d + 2);
    cur = { x: Math.round(cur.x + dx * step), z: Math.round(cur.z + dz * step) };
  }
  return cur;
}

/**
 * One-line description for the strategic prompt's "Protected zones"
 * section. Empty string when no zones are set, so callers can append
 * unconditionally.
 */
export function describeProtectedZones() {
  if (!_zones.length) return '';
  return _zones.map((z) => {
    let where;
    if (z.shape === 'circle') {
      where = `center (${z.center.x}, ${z.center.z}), radius ${z.radius}`;
    } else if (z.shape === 'box') {
      where = `box (${z.min.x}, ${z.min.z}) → (${z.max.x}, ${z.max.z})`;
    } else {
      // Approximate claims by their chunk-grid bounding box.
      let minX = Infinity; let minZ = Infinity; let maxX = -Infinity; let maxZ = -Infinity;
      for (const k of z.chunks) {
        const [cx, cz] = k.split(',').map(Number);
        minX = Math.min(minX, cx * 16); minZ = Math.min(minZ, cz * 16);
        maxX = Math.max(maxX, cx * 16 + 16); maxZ = Math.max(maxZ, cz * 16 + 16);
      }
      where = `${z.chunks.size} claimed chunks within (${minX}, ${minZ}) → (${maxX}, ${maxZ})`;
    }
    return `- ${z.type}: ${where}` + (z.description ? ` — ${z.description}` : '');
  }).join('\n');
}

// ---------------------------------------------------------------------
// Server-truth loader
// ---------------------------------------------------------------------

/**
 * Read the ACTUAL protection shapes from the server's own data files
 * and install them as the zone list:
 *
 *   - WorldGuard regions (cuboids) from
 *     <serverDir>/plugins/WorldGuard/worlds/world/regions.yml
 *   - Factions warzone/safezone claims from
 *     <serverDir>/mstore/factions_board/world.json
 *
 * Player-faction claims are EXCLUDED by default (claimTypes) — they
 * are political territory, not server-enforced no-build, and a bot
 * must be able to build on its own faction's land.
 *
 * Returns { zones } with what was installed; on no readable sources,
 * keeps the current zone list and returns { zones: 0 }.
 */
export function loadServerZones({
  serverDir = null,
  regionsPath = null,
  factionsBoardPath = null,
  claimTypes = ['warzone', 'safezone'],
  log = null,
} = {}) {
  const rp = regionsPath
    ?? (serverDir ? `${serverDir}/plugins/WorldGuard/worlds/world/regions.yml` : null);
  const fp = factionsBoardPath
    ?? (serverDir ? `${serverDir}/mstore/factions_board/world.json` : null);
  const zones = [];

  if (rp) {
    try {
      const doc = yaml.load(fs.readFileSync(rp, 'utf8'));
      for (const [name, r] of Object.entries(doc?.regions ?? {})) {
        if (!r?.min || !r?.max) continue;
        zones.push({
          type: `region:${name}`,
          min: { x: Number(r.min.x), z: Number(r.min.z) },
          max: { x: Number(r.max.x), z: Number(r.max.z) },
          description: 'WorldGuard region (server-enforced)',
        });
      }
    } catch (e) {
      log?.debug?.('zones_regions_load_failed', { path: rp, msg: e.message });
    }
  }

  if (fp) {
    try {
      const board = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const byType = new Map();
      for (const [chunk, claim] of Object.entries(board ?? {})) {
        if (!claimTypes.includes(claim)) continue;
        if (!byType.has(claim)) byType.set(claim, []);
        byType.get(claim).push(chunk);
      }
      for (const [claim, chunks] of byType) {
        zones.push({
          type: claim,
          chunks,
          description: 'Factions system claim (no build/break)',
        });
      }
    } catch (e) {
      log?.debug?.('zones_factions_load_failed', { path: fp, msg: e.message });
    }
  }

  if (zones.length === 0) {
    log?.warn?.('zones_server_truth_unavailable', {
      regions: rp, factions: fp,
      kept: _zones.length,
    });
    return { zones: 0 };
  }
  setProtectedZones(zones);
  log?.info?.('zones_loaded_from_server', {
    zones: _zones.length,
    detail: _zones.map((z) => `${z.type}(${z.shape})`),
  });
  return { zones: _zones.length };
}
