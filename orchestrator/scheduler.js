/**
 * Scheduler — decides which bots should be online right now.
 *
 *   const s = new Scheduler({ profiles, target: [6, 12] });
 *   s.evaluate()  → { toSpawn: [...], toKill: [...], keep: [...] }
 *
 * Algorithm (per tick):
 *   1. For each profile, compute a score in [0, 1]:
 *        always_online → 1.0
 *        current hour in primary_hours   →  0.85
 *        current hour in secondary_hours →  0.45
 *        else                            →  0.08
 *      Weekend boost adds +0.15 (Sat/Sun local time) if weekend_boost.
 *      Small random jitter ±0.1 so ties break differently per tick.
 *   2. Already-online bots get a 0.30 persistence bonus so they're not
 *      kicked off on a single unlucky roll.
 *   3. Sort by score desc. Take top N where N = clamp(eligible, min, max).
 *      "Eligible" = anyone with score >= 0.25.
 *   4. Diff against currently-online set → { toSpawn, toKill, keep }.
 *
 * Once spawned a bot stays until either its session budget expires (see
 * Spawner, which enforces session_minutes) or the scheduler decides
 * someone else should take its slot.
 *
 * Hours wrap past midnight: a window like [22, 28] means 22:00–04:00.
 */

const PERSISTENCE_BONUS = 0.30;
const ELIGIBILITY_FLOOR = 0.25;
const JITTER = 0.10;

export class Scheduler {
  constructor({ profiles, target = [6, 12], clock = Date.now, log = null }) {
    if (!Array.isArray(profiles) || profiles.length === 0) {
      throw new Error('Scheduler requires a non-empty profiles array');
    }
    this.profiles = profiles;
    this.min = target[0];
    this.max = target[1];
    this.clock = clock;
    this.log = log;
  }

  evaluate({ onlineSet } = { onlineSet: new Set() }) {
    const now = new Date(this.clock());
    const hour = now.getHours();
    const day = now.getDay();               // 0=Sun … 6=Sat
    const isWeekend = day === 0 || day === 6;

    const scored = this.profiles.map((p) => {
      let score = baseScore(p, hour);
      if (isWeekend && p.schedule?.weekend_boost) score += 0.15;
      score += (Math.random() - 0.5) * 2 * JITTER;
      if (onlineSet.has(p.username)) score += PERSISTENCE_BONUS;
      return { profile: p, username: p.username, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const eligible = scored.filter((s) => s.score >= ELIGIBILITY_FLOOR);
    const wanted = Math.min(this.max, Math.max(this.min, eligible.length));
    const chosen = new Set(scored.slice(0, wanted).map((s) => s.username));

    const toSpawn = [];
    const toKill = [];
    const keep = [];
    for (const p of this.profiles) {
      const shouldBeOn = chosen.has(p.username);
      const isOn = onlineSet.has(p.username);
      if (shouldBeOn && !isOn) toSpawn.push(p);
      else if (!shouldBeOn && isOn) toKill.push(p);
      else if (shouldBeOn && isOn) keep.push(p);
    }

    return { toSpawn, toKill, keep, scored, chosen };
  }
}

function baseScore(p, hour) {
  if (p.schedule?.always_online) return 1.0;
  if (hourInWindow(hour, p.schedule?.primary_hours))   return 0.85;
  if (hourInWindow(hour, p.schedule?.secondary_hours)) return 0.45;
  return 0.08;
}

function hourInWindow(hour, window) {
  if (!Array.isArray(window) || window.length !== 2) return false;
  const [startRaw, endRaw] = window;
  const start = ((startRaw % 24) + 24) % 24;
  // `end` in the profile may be >= 24 to signal a midnight-wrap. Interpret
  // raw end-start to see if we're wrapping.
  const span = endRaw - startRaw;
  if (span <= 0) return false;
  const end = start + span;
  if (end <= 24) return hour >= start && hour < end;
  // wrap: [start..24) ∪ [0..end-24)
  return hour >= start || hour < (end - 24);
}
