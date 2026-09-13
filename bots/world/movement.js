import pathfinderPkg from 'mineflayer-pathfinder';
import { isInProtectedZone, isNearProtectedZone } from './zones.js';
const { Movements, goals } = pathfinderPkg;

// Margin past a zone's boundary where we still suppress canDig.
// Pathfinder may plan a multi-block dig that crosses the boundary;
// padding keeps us off those paths. Was 50 when zones were a crude
// circle approximation; now that zones load the server's EXACT
// shapes (WorldGuard cuboids + claim chunks), a thin margin is
// enough. The huge buffer was actively harmful: it created a wide
// no-dig band around spawn where a bot in a self-dug mining pit had
// ZERO legal pathfinder moves (canDig=false + allow1by1towers=false)
// — every goTo returned noPath instantly and the bot was entombed
// (TestBot18, 2026-06-10, trapped at y≈55 in its first cobble hole).
const PROTECTION_DIG_BUFFER = 8;

// Weight pathfinder adds to a candidate move; >100 makes pathfinder
// discard the move entirely.
const LAVA_EXCLUSION_WEIGHT = 200;
// Beside lava (same level or pool rim): heavily penalized but not
// outright banned. 1.8 movement overshoots — corner-cutting, sprint
// momentum, knockback — so walking the EDGE of a pool is how bots
// "bridge over it and jump in". A sub-100 weight makes the pathfinder
// take any reasonable detour while still allowing a last-resort
// squeeze past lava in a 1-wide corridor (a hard ban would noPath the
// bot into the lockout escape).
const LAVA_NEAR_WEIGHT = 80;

// KV key holding the bot's own solid wall/roof/floor cells, persisted so
// wall-protection re-arms after a reconnect. Survives buildProject._clearAll
// (which only nulls the three build KVs).
const KV_BASE_STRUCTURE_CELLS = 'base_structure_cells';
// How long a freshly-placed block (pillar / scaffold / structure cell) is
// shielded from the self-extraction digger. Long enough to outlast a stuck
// episode (so the bot can't dig out the very block it just placed under its
// feet), short enough to self-heal if the bot legitimately needs that cell
// back later (TestBot40-era pillar↔dig-escape oscillation).
const RECENT_PLACEMENT_TTL_MS = 120_000;

const _isLava = (b) => b != null && (b.name === 'lava' || b.name === 'flowing_lava');

const _cellKey = (p) => `${p.x},${p.y},${p.z}`;

const CARDINALS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAGONALS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * Build a pathfinder break-exclusion that forbids breaking the bot's OWN
 * base walls, so the planner routes AROUND them (and uses the door, which
 * is in blocksCantBreak + openable) instead of tunneling straight through.
 *
 * `getCells` is a zero-arg getter returning the live Set of "x,y,z" keys —
 * passed as a getter (not the Set by value) so reassigning the Set takes
 * effect without rebuilding Movements. Returns >=100 for an in-set block,
 * which makes Movements.safeToBreak() reject it. The size===0 fast path
 * means a bot with no base yet pays nothing.
 *
 * Exported for direct unit testing — the closure is the whole behavior.
 */
export function makeBaseStructureExclusion(getCells) {
  return (block) => {
    if (!block?.position) return 0;
    const cells = getCells?.();
    if (!cells || cells.size === 0) return 0;   // fast path: no base yet
    return cells.has(_cellKey(block.position)) ? 100 : 0;
  };
}

/**
 * Build a pathfinder exclusion-area function that forbids any step or
 * scaffold placement landing ON or directly OVER lava, and heavily
 * penalizes cells BESIDE lava.
 *
 * pathfinder's getMoveForward treats a lava floor the same as air —
 * lava's bounding box is empty, so the floor block's `.physical` is
 * false — and will plan "place ONE scaffold over the lava, then step
 * onto it". In 1.8 that placement is unreliable (lava is a poor
 * placement reference, and the bot's forward momentum carries it past
 * the edge before the block settles), so the bot slips in and dies.
 * Returning >100 makes pathfinder discard the move, so it routes AROUND
 * the lava instead of bridging across it. Cells adjacent to lava get
 * LAVA_NEAR_WEIGHT — see above.
 *
 * Exported for direct unit testing — the closure is the whole behavior.
 */
export function makeLavaExclusion(bot) {
  return (block) => {
    if (!block?.position) return 0;
    try {
      if (_isLava(block)) return LAVA_EXCLUSION_WEIGHT;
      const p = block.position;
      if (_isLava(bot.blockAt(p.offset(0, -1, 0)))) return LAVA_EXCLUSION_WEIGHT;
      // Beside lava at foot level (cardinal + diagonal — corner cuts
      // clip diagonals) or standing on a pool's rim block.
      for (const [dx, dz] of CARDINALS) {
        if (_isLava(bot.blockAt(p.offset(dx, 0, dz)))) return LAVA_NEAR_WEIGHT;
      }
      for (const [dx, dz] of DIAGONALS) {
        if (_isLava(bot.blockAt(p.offset(dx, 0, dz)))) return LAVA_NEAR_WEIGHT;
      }
      for (const [dx, dz] of CARDINALS) {
        if (_isLava(bot.blockAt(p.offset(dx, -1, dz)))) return LAVA_NEAR_WEIGHT;
      }
    } catch { /* world not loaded here — treat as passable */ }
    return 0;
  };
}

const DEEP_WATER_WEIGHT = 100;      // forbid stepping into water that has water under it
const DEEP_WATER_SWIM_WEIGHT = 20;  // already swimming: allowed, but get out fast

/**
 * Step-exclusion for deep water. 1.8 mineflayer sinks whenever the
 * pathfinder drives (it clears jump every tick), so a route across a lake
 * drowns the bot (oatmeal_ollie, 2026-09-04: goto into the sea, sank to
 * y 48). One-deep water is wadeable and costs nothing extra; water over
 * water is forbidden when the bot starts on land and merely expensive when
 * it is already in the water, so escapes can still path out.
 */
export function makeDeepWaterExclusion(bot) {
  const isWater = (b) => b != null && (b.name === 'water' || b.name === 'flowing_water');
  return (block) => {
    if (!block?.position || !isWater(block)) return 0;
    try {
      const below = bot.blockAt(block.position.offset(0, -1, 0));
      if (!isWater(below)) return 0;
      const me = bot.entity?.position;
      const feet = me && typeof me.floored === 'function' ? bot.blockAt(me.floored()) : null;
      return isWater(feet) ? DEEP_WATER_SWIM_WEIGHT : DEEP_WATER_WEIGHT;
    } catch { return 0; }
  };
}

/**
 * High-level movement helpers. pathfinder is assumed to be already loaded
 * on the bot (core/bot.js does this).
 *
 *   goTo(pos)         — path to an exact block position
 *   follow(entity, d) — continuously track an entity at range d
 *   flee(from, dist)  — path away from a point to at least `dist` blocks
 *
 * Every call returns { stop, done }. stop() cancels; done is a promise
 * that resolves with { reached: bool, reason?: string }.
 */
export class Movement {
  constructor(bot, { memory = null } = {}) {
    this.bot = bot;
    this.memory = memory;
    this._activeStop = null;
    // ── Own-structure registry (the "don't break my own blocks" guard).
    // Two populations, both keyed "x,y,z":
    //  • _baseStructureCells: the completed base's solid walls/roof/floor
    //    (persistent, ground-truth-confirmed). The pathfinder refuses to
    //    BREAK these → routes around to the door; safeFindBlock won't mine
    //    them either. Reassigned wholesale by setBaseStructureCells; read
    //    live by the break-exclusion closure via a getter. Hydrated from KV
    //    on first _buildMovements so it re-arms after a reconnect.
    //  • _recentPlacements: cells the bot JUST placed (pillar / scaffold /
    //    structure-in-progress), with a TTL. _digToEscape consults these so
    //    it never digs out the block it just placed under its own feet
    //    (the pillar↔drop oscillation). Not yet in _baseStructureCells
    //    because the build isn't complete.
    this._baseStructureCells = new Set();
    this._baseCellsLoaded = false;          // per-INSTANCE guard (restart re-reads)
    this._baseExclusionSuppressed = false;  // entombment safety valve
    this._recentPlacements = new Map();     // key -> expiry ts
    // Consecutive goTo/flee results of `noPath` WITHOUT the bot moving
    // in between — the signature of a bot the pathfinder cannot move
    // AT ALL (entombed in a pit with digging suppressed, sealed in,
    // etc.). StuckRecovery reads this to trigger a physical escape;
    // 3+ instant noPaths from one spot means no amount of re-planning
    // will help. Reset on any reached goal or on bodily movement.
    this.consecutiveNoPath = 0;
    this._noPathAnchor = null;
    // When true, _buildMovements allows a survivable drop + parkour so a
    // fresh bot can jump off the spawn platform to leave the protected
    // ring (agent/tools/move.js toggles this; normal play keeps it off).
    this._bootstrapMode = false;
  }

  /**
   * Bootstrap travel mode: allow a survivable drop off the spawn platform
   * + parkour so a fresh bot can leave the protected ring (the pathfinder
   * won't take a >2 drop otherwise, so it circles the edge instead of
   * jumping off). agent/tools/move.js turns it on for the initial walk-out
   * and off after; the next goTo rebuilds the normal config.
   * Nulls the dig-suppression cache so the next goTo rebuilds Movements
   * with the new drop policy.
   */
  setBootstrapMode(on) {
    this._bootstrapMode = !!on;
    this._lastDigSuppressed = null;
  }

  /**
   * Replace the live set of protected base cells AND persist it. Accepts an
   * iterable of "x,y,z" strings or {x,y,z} objects. Overwrite, not merge —
   * the newest completed structure wins (re-site / remodel heals itself).
   * Clears the entombment suppression (a fresh, verified base re-arms the
   * wall protection).
   */
  setBaseStructureCells(cells) {
    const set = new Set();
    if (cells) {
      for (const c of cells) {
        if (typeof c === 'string') set.add(c);
        else if (c && Number.isFinite(c.x)) set.add(_cellKey(c));
      }
    }
    this._baseStructureCells = set;   // reassign — closure getter sees it live
    this._baseCellsLoaded = true;
    this.setBaseExclusionSuppressed(false);
    try { this.memory?.kvSet?.(KV_BASE_STRUCTURE_CELLS, [...set]); } catch {}
  }

  /** Live set of protected base cells (hydrated from KV on first read). */
  getBaseStructureCells() {
    this._ensureBaseCellsLoaded();
    return this._baseStructureCells;
  }

  /** Hydrate the base-cell set from KV once per instance (a fresh process re-reads). */
  _ensureBaseCellsLoaded() {
    if (this._baseCellsLoaded) return;
    this._baseCellsLoaded = true;
    try {
      const arr = this.memory?.kvGet?.(KV_BASE_STRUCTURE_CELLS, null);
      if (Array.isArray(arr) && arr.length) this._baseStructureCells = new Set(arr);
    } catch {}
  }

  /**
   * SAFETY VALVE. Temporarily disarm wall-protection for the next pathfind
   * so a bot whose only pathfinder exit (the doorway) is missing/obstructed
   * can break out of its own shell. The base exclusion is ADVISORY: stuck
   * recovery flips this when repeated noPath + goal-outside-footprint
   * signals entombment-by-exclusion. Re-armed by the next
   * setBaseStructureCells (a verified completion) or an explicit false.
   */
  setBaseExclusionSuppressed(on) {
    const next = !!on;
    if (next === this._baseExclusionSuppressed) return;
    this._baseExclusionSuppressed = next;
    this._lastDigSuppressed = null;   // force a Movements rebuild next goTo
  }

  /**
   * Record a cell the bot just placed (pillar / scaffold / structure), with
   * a TTL. _digToEscape reads this so it never digs out the block it just
   * placed under its own feet. Cheap; prunes opportunistically.
   */
  notePlacement(pos) {
    if (!pos || !Number.isFinite(pos.x)) return;
    const now = Date.now();
    this._pruneRecentPlacements(now);
    this._recentPlacements.set(
      _cellKey({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }),
      now + RECENT_PLACEMENT_TTL_MS,
    );
  }

  /** True if {x,y,z} was placed by the bot within the TTL window. */
  isRecentlyPlaced(pos) {
    if (!pos) return false;
    const now = Date.now();
    this._pruneRecentPlacements(now);
    const exp = this._recentPlacements.get(
      _cellKey({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }),
    );
    return exp != null && exp > now;
  }

  /** True if {x,y,z} is a completed base wall OR a fresh placement. */
  isOwnBlock(pos) {
    if (!pos) return false;
    const key = _cellKey({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) });
    if (this.getBaseStructureCells().has(key)) return true;
    return this.isRecentlyPlaced(pos);
  }

  _pruneRecentPlacements(now) {
    if (this._recentPlacements.size === 0) return;
    for (const [k, exp] of this._recentPlacements) {
      if (exp <= now) this._recentPlacements.delete(k);
    }
  }

  _recordGoalResult(result) {
    if (result?.reached) {
      this.consecutiveNoPath = 0;
      this._noPathAnchor = null;
      // Reached a goal → the entombment escape (if any) worked; re-arm the
      // wall protection so the bot stops being allowed to dig its own walls.
      if (this._baseExclusionSuppressed) this.setBaseExclusionSuppressed(false);
      return;
    }
    if (result?.reason !== 'noPath') return; // timeout/cancel ≠ lockout
    const p = this.bot?.entity?.position;
    const moved = this._noPathAnchor && p
      && Math.hypot(p.x - this._noPathAnchor.x, p.z - this._noPathAnchor.z) > 2;
    if (moved) {
      // The bot relocated since the streak began — different situation,
      // restart the count from here.
      this.consecutiveNoPath = 1;
      this._noPathAnchor = { x: p.x, z: p.z };
    } else {
      this.consecutiveNoPath++;
      if (!this._noPathAnchor && p) this._noPathAnchor = { x: p.x, z: p.z };
    }
  }

  _buildMovements(canDig) {
    this._ensureBaseCellsLoaded();   // hydrate own-wall set from KV on first build
    const mv = new Movements(this.bot);
    mv.canDig = canDig;            // unblocks paths through populated terrain
    // Never let the PATHFINDER dig a block inside a server-protected zone.
    // canDig + updateDigPermission only gate by the bot's BODY position
    // (buffer 8) at goTo-start, so a route toward an east-of-spawn target
    // tunnels straight THROUGH the spawn box and spams ~30 "you can't break
    // that block here" denials, then strands the bot underground in the
    // no-build zone (TestBot37). A per-block break exclusion makes protected
    // columns un-breakable for path planning, so the route goes AROUND them
    // (the server forbids the break anyway — this just stops the wasted digs
    // and keeps the bot out of the protected column). exclusionAreasBreak
    // sums to a cost; >=100 makes Movements.safeToBreak() return false.
    if (Array.isArray(mv.exclusionAreasBreak)) {
      mv.exclusionAreasBreak.push((block) => (
        block?.position && isInProtectedZone({ x: block.position.x, z: block.position.z }) ? 100 : 0
      ));
      // Don't tunnel through the bot's OWN completed base walls — route
      // around to the door (which is in blocksCantBreak + openable). The
      // getter keeps the reference live across setBaseStructureCells
      // reassignment. Suppressed only by the entombment safety valve. Only
      // breaking is forbidden (NOT step/place) so floors stay walkable.
      if (!this._baseExclusionSuppressed) {
        mv.exclusionAreasBreak.push(
          makeBaseStructureExclusion(() => this._baseStructureCells),
        );
      }
    }
    // Bootstrap mode (see setBootstrapMode): a fresh bot must get OFF the
    // spawn platform to leave the protected ring, but the pathfinder won't
    // take a >2 drop, so it circles the edge instead of jumping off. Allow
    // parkour + a survivable drop during bootstrap ONLY.
    mv.allowParkour = !!this._bootstrapMode; // 1.8 parkour unreliable otherwise
    mv.allow1by1towers = false;    // no pillaring — looks non-human, griefs claims
    mv.digCost = 10;               // heavy penalty — prefer going around
    mv.maxDropDown = this._bootstrapMode ? 16 : 2; // normal: short hops only —
                                   // a 3-drop near a pool can carry past the
                                   // exclusion cell into lava (1.8 momentum)
    const registry = this.bot.registry;
    if (registry?.blocksByName) {
      const dontBreak = [
        'chest', 'trapped_chest', 'ender_chest', 'furnace', 'crafting_table',
        'enchanting_table', 'anvil', 'bed', 'bed_block',
        'diamond_ore', 'diamond_block', 'gold_ore', 'iron_ore', 'redstone_ore',
        'emerald_ore', 'lapis_ore',
        'wool',                    // faction markers
        'log', 'log2',             // don't grief tree farms
        // Doors — including the bot's OWN base door. The post-build
        // wander used to path straight through the doorway and DIG the
        // freshly placed door instead of opening it (TestBot19,
        // 2026-06-10: build verified 96% forever because the door kept
        // vanishing). Doors are opened (openable set below), never
        // broken.
        'wooden_door', 'spruce_door', 'birch_door', 'jungle_door',
        'acacia_door', 'dark_oak_door', 'iron_door', 'trapdoor',
      ];
      for (const name of dontBreak) {
        const b = registry.blocksByName[name];
        if (b) mv.blocksCantBreak.add(b.id);
      }
      // Walk through wooden doors by opening them (Paper 1.8 server —
      // the pathfinder's door support works there). Iron doors stay
      // un-openable (they need redstone).
      for (const name of [
        'wooden_door', 'spruce_door', 'birch_door', 'jungle_door',
        'acacia_door', 'dark_oak_door',
      ]) {
        const b = registry.blocksByName[name];
        if (b && mv.openable instanceof Set) mv.openable.add(b.id);
      }
      mv.canOpenDoors = true;
      // Don't scaffold with cobblestone — leaves visible litter.
      const cobble = registry.itemsByName?.cobblestone?.id;
      if (cobble != null && Array.isArray(mv.scafoldingBlocks)) {
        mv.scafoldingBlocks = mv.scafoldingBlocks.filter((id) => id !== cobble);
      }
    }

    // Lava-bridging guard — forbid stepping/placing onto or over lava so
    // the pathfinder routes around it instead of bridging across (which
    // kills the bot every time in 1.8). See makeLavaExclusion above.
    const lavaWeight = makeLavaExclusion(this.bot);
    if (Array.isArray(mv.exclusionAreasStep)) mv.exclusionAreasStep.push(lavaWeight);
    if (Array.isArray(mv.exclusionAreasPlace)) mv.exclusionAreasPlace.push(lavaWeight);
    // Deep water: route along the shore instead of through the lake.
    if (Array.isArray(mv.exclusionAreasStep)) mv.exclusionAreasStep.push(makeDeepWaterExclusion(this.bot));

    return mv;
  }

  _ensureMovements() {
    if (this._movementsConfigured) return;
    const mv = this._buildMovements(true);
    this.bot.pathfinder.setMovements(mv);
    this._movementsConfigured = true;
    this._lastDigSuppressed = false;
  }

  /**
   * Toggle pathfinder's canDig based on proximity to protected zones.
   *
   * Inside a zone (or within PROTECTION_DIG_BUFFER blocks of its
   * radius), set canDig=false so the planner stops proposing dig
   * paths that world-guard will reject at execute time. When the bot
   * walks back out, the next call restores the dig-capable config.
   *
   * Cheap to call on every pathfind kickoff — only rebuilds Movements
   * when the suppression state actually changes.
   */
  updateDigPermission(botPosition) {
    if (!botPosition || typeof botPosition.x !== 'number'
        || typeof botPosition.z !== 'number') return;
    const inOrNearProtected = isInProtectedZone(botPosition)
      || isNearProtectedZone(botPosition, PROTECTION_DIG_BUFFER);
    if (inOrNearProtected !== this._lastDigSuppressed) {
      this._lastDigSuppressed = inOrNearProtected;
      const mv = this._buildMovements(!inOrNearProtected);
      try { this.bot.pathfinder.setMovements(mv); } catch {}
    }
  }

  cancel() {
    if (this._activeStop) { this._activeStop(); this._activeStop = null; }
    try { this.bot.pathfinder.setGoal(null); } catch {}
  }

  goTo(pos, { timeoutMs = 30000, range = 0 } = {}) {
    this.cancel();
    this._ensureMovements();
    this.updateDigPermission(this.bot.entity?.position);
    const goal = range > 0
      ? new goals.GoalNear(pos.x, pos.y, pos.z, range)
      : new goals.GoalBlock(Math.round(pos.x), Math.round(pos.y), Math.round(pos.z));
    return this._runGoal(goal, timeoutMs);
  }

  follow(entity, distance = 3, { timeoutMs = 0 } = {}) {
    this.cancel();
    this._ensureMovements();
    this.updateDigPermission(this.bot.entity?.position);
    const goal = new goals.GoalFollow(entity, distance);
    // follow is dynamic: pathfinder keeps re-planning. We still honor
    // timeout if set; 0 means "follow forever".
    return this._runGoal(goal, timeoutMs, { dynamic: true });
  }

  flee(from, distance = 20, { timeoutMs = 15000 } = {}) {
    this.cancel();
    this._ensureMovements();
    this.updateDigPermission(this.bot.entity?.position);
    const goal = new goals.GoalInvert(
      new goals.GoalNear(from.x, from.y, from.z, distance)
    );
    return this._runGoal(goal, timeoutMs);
  }

  _runGoal(goal, timeoutMs, { dynamic = false } = {}) {
    const bot = this.bot;
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    let timer = null;
    const onReached = () => finish({ reached: true });
    const onUpdate = (r) => {
      if (r.status === 'noPath') finish({ reached: false, reason: 'noPath' });
    };
    const finish = (result) => {
      bot.removeListener('goal_reached', onReached);
      bot.removeListener('path_update', onUpdate);
      if (timer) clearTimeout(timer);
      try { bot.pathfinder.setGoal(null); } catch {}
      this._activeStop = null;
      this._recordGoalResult(result);
      resolveDone(result);
    };
    bot.on('goal_reached', onReached);
    bot.on('path_update', onUpdate);
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish({ reached: false, reason: 'timeout' }), timeoutMs);
    }
    try { bot.pathfinder.setGoal(goal, dynamic); }
    catch (e) { finish({ reached: false, reason: 'set_goal_error:' + e.message }); }
    const stop = () => finish({ reached: false, reason: 'cancelled' });
    this._activeStop = stop;
    return { stop, done };
  }
}
