/**
 * result.js — the uniform tool-result shape the brain reads.
 *
 *   { status: 'ok' | 'partial' | 'failed' | 'interrupted' | 'unsupported',
 *     reason?: stable machine token,
 *     by?: interrupt reason (only for 'interrupted'),
 *     detail?: interrupt detail,
 *     elapsed_s: number,
 *     ...tool-specific fields }
 *
 * Tools never throw to the loop; every exception becomes a 'failed'
 * result with reason 'exception:<msg>' so the transcript always has a
 * truthful record and the model always gets its turn back.
 */

export function ok(fields = {}) {
  return { status: 'ok', ...fields };
}

export function partial(reason, fields = {}) {
  return { status: 'partial', reason, ...fields };
}

export function fail(reason, fields = {}) {
  return { status: 'failed', reason, ...fields };
}

export function unsupported(reason, fields = {}) {
  return { status: 'unsupported', reason, ...fields };
}

export function interrupted(cancel, fields = {}) {
  const out = { status: 'interrupted', by: cancel?.reason ?? 'cancelled', ...fields };
  if (cancel?.detail != null) out.detail = cancel.detail;
  return out;
}

/**
 * Map a primitive's `{ success, reason, ...rest }` result to the tool
 * shape. A cancelled token wins over whatever the primitive said, so the
 * brain learns it was interrupted rather than "failed: cancelled".
 * `progressed` lets a caller declare that something useful happened even
 * though the primitive reported failure (e.g. mined 5 of 16).
 */
export function fromPrimitive(raw, cancel, { progressed = null } = {}) {
  const { success, reason, ...rest } = raw ?? {};
  if (cancel?.cancelled) return interrupted(cancel, { reason: reason ?? undefined, ...rest });
  if (success) return ok({ reason: reason ?? 'done', ...rest });
  const didProgress = progressed ?? false;
  if (didProgress) return partial(reason ?? 'partial', rest);
  return fail(reason ?? 'failed', rest);
}

import vec3Pkg from 'vec3';
const Vec3 = vec3Pkg.Vec3 ?? vec3Pkg;

/** mineflayer's blockAt needs a Vec3 (it calls pos.floored()); accept plain {x,y,z} everywhere and convert here. */
export function toVec3(p) {
  if (!p || !Number.isFinite(p.x)) return null;
  if (typeof p.floored === 'function') return p;
  return new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
}

export function roundPos(p) {
  if (!p || !Number.isFinite(p.x)) return null;
  return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
}

export function distance(a, b) {
  if (!a || !b) return null;
  const dx = a.x - b.x; const dy = (a.y ?? 0) - (b.y ?? 0); const dz = a.z - b.z;
  return Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 10) / 10;
}

export function compassDir(from, to) {
  if (!from || !to) return null;
  const angle = Math.atan2(-(to.z - from.z), to.x - from.x) * 180 / Math.PI;
  const norm = (angle + 360) % 360;
  if (norm < 22.5 || norm >= 337.5) return 'E';
  if (norm < 67.5) return 'NE';
  if (norm < 112.5) return 'N';
  if (norm < 157.5) return 'NW';
  if (norm < 202.5) return 'W';
  if (norm < 247.5) return 'SW';
  if (norm < 292.5) return 'S';
  return 'SE';
}
