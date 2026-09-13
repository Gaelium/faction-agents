/**
 * Rule-based combat layer. No LLM; everything is probabilities + timing.
 *
 * 1.8-specific notes (important — don't port later-version intuitions):
 *   • No attack cooldown. Max effective CPS is capped by the 20Hz tick
 *     (20 CPS wall).
 *   • No shields. The only damage-block is *sword right-click* (~50%
 *     reduction). Axes and other items can't block at all — so an
 *     axe-holding bot simply cannot block-hit while on its preferred
 *     weapon. We treat this as a structural tell, not a config knob.
 *   • No offhand slot.
 *   • No axe-specific crit. Regular jump-crits apply to ALL weapons; we
 *     don't model them currently.
 *   • Axe preference exists for mcMMO reasons: higher base damage (iron
 *     axe 9 vs iron sword 7) and Axes/Armor-Impact breaks opponent armor
 *     durability faster. Downside: no block-hit option while wielded.
 *
 * Skill-tier parameters (read from profile.combat):
 *   reaction_ms_min/max   — delay before first swing after engage
 *   aim_error_deg         — gaussian stddev in degrees added to aim
 *   cps                   — click-per-second cap
 *   block_hit_rate        — prob. of sword-block between swings
 *                           (IGNORED while wielding a non-sword)
 *   pot_success_rate      — prob. of successfully potting when low HP
 *   pot_at_hp             — HP threshold below which to attempt a pot
 *   combo_follow_rate     — prob. of sprint-reset after a hit
 *   flee_at_hp            — HP threshold to disengage
 *   preferred_weapon      — "sword" | "axe"
 *
 * Recommended presets (document-only; not auto-applied):
 *   tier 1 — reaction 500..700, aim 8, cps 4,  block 0.05, pot 0.2, combo 0.30, flee 5
 *   tier 2 — reaction 350..500, aim 5, cps 6,  block 0.20, pot 0.5, combo 0.50, flee 6
 *   tier 3 — reaction 250..400, aim 3, cps 8,  block 0.40, pot 0.7, combo 0.70, flee 7
 *   tier 4 — reaction 180..300, aim 2, cps 10, block 0.60, pot 0.85, combo 0.85, flee 8
 *   tier 5 — reaction 120..220, aim 1, cps 13, block 0.75, pot 0.95, combo 0.95, flee 9
 *
 * Axe-preferring bots should keep block_hit_rate > 0 in their profile —
 * it'll fire on the rare cases they're holding a sword (e.g. their axe
 * broke and they fell back to their kit sword).
 */

const PLAYER_REACH = 3.6;   // vanilla player reach in 1.8
// Movement hysteresis around PLAYER_REACH. Without a deadband the
// forward/sprint controls toggled every 50ms tick whenever the
// bot↔target distance oscillated around 3.4 — looked like jittery
// stutter-stepping (the "hacker feel" players reported). MOVE_IN_AT
// > MOVE_STOP_AT means the bot only starts pushing forward when it
// loses reach, and only stops pushing forward when it has comfortable
// reach. In between, controls hold their previous value.
const MOVE_IN_AT = PLAYER_REACH + 0.2;   // start chasing if dist > 3.8
const MOVE_STOP_AT = PLAYER_REACH - 0.6; // stop chasing if dist < 3.0
// Aim-lag buffer length & per-tier lag table. Humans aim at where
// the target WAS (visual processing + motor delay), not where it IS.
// Without this, the bot's yaw locks to live target coords every 50ms
// → perfect tracking → "aimbot" feel. With this, evasive movement
// from a player produces visible aim drift, the bot misses some
// swings, and high-skill humans can outplay even tier-5 bots.
// Lag values are skill-tier coupled: lower-skill bots track with
// MORE lag.
const AIM_BUFFER_LEN = 8;       // 8 samples × 50ms = 400ms of history
const AIM_LAG_DEFAULT_MS = 180; // tier-2 baseline; profile.combat.aim_lag_ms overrides
// Look-update throttle. Even with aim lag, calling bot.look() every
// 50ms is overkill — vanilla clients send rotation updates roughly
// every physicsTick (50ms) but with their OWN yaw which only changes
// on user input. We re-emit only when the desired yaw drifted enough
// to matter, capped at LOOK_MAX_INTERVAL_MS regardless.
const LOOK_DELTA_DEG = 1.5;
const LOOK_MAX_INTERVAL_MS = 200;
const POT_ITEM_HINTS = ['potion', 'golden_apple', 'splash_potion'];

function now() { return Date.now(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function gauss(stddev) {
  // Box-Muller
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * stddev;
}

function uniform(min, max) { return min + Math.random() * (max - min); }

export class Combat {
  constructor(bot, { profile, log, movement = null, bus = null }) {
    this.bot = bot;
    this.profile = profile;
    this.log = log;
    this.cfg = profile.combat ?? {};
    this.movement = movement;
    this.bus = bus;
    this.target = null;
    this.engaged = false;
    this._lastSwingAt = 0;
    this._lastPotAt = 0;
    this._lastAimNoiseAt = 0;
    this._aimNoise = { yaw: 0, pitch: 0 };
    this._lastSprintResetAt = 0;
    // Aim lag buffer — circular buffer of recent target positions.
    // Each entry is { x, y, z, ts }. Filled in _updateAim each tick.
    this._aimBuffer = new Array(AIM_BUFFER_LEN);
    this._aimBufferIdx = 0;
    this._lastLookAt = 0;
    this._lastLookYaw = 0;
    this._lastLookPitch = 0;
    this._lastMoveCloserState = false;   // for hysteresis
    // Combat ticks on its own setInterval rather than mineflayer's
    // physicsTick. mineflayer silences physicsTick when
    // bot.entity.position has a non-finite axis OR the chunk under
    // the bot is unloaded (see node_modules/mineflayer/lib/plugins/
    // physics.js:79). Both fire routinely during PvP knockback —
    // and when physicsTick is silent, a listener-bound combat._tick
    // never runs, so no swings, no stall detection, no disengage.
    // The bot stands frozen until something external (a /tp, the
    // agent's escape tools) intervenes. Owning the
    // clock here makes combat survive any mineflayer-internal
    // physicsTick pause.
    this._tickInterval = null;
    this._blocking = false;
    this._onDisengage = null;
    this._engagement = null;   // diagnostic snapshot, see _beginEngagement

    // hits_taken comes from the bus's player_damage events. Living-entity
    // health changes don't tell us "an attack landed" cleanly (regen,
    // potions, etc. can confound) — but BotBridge fires once per damage
    // application, so we count those.
    if (this.bus?.on) {
      this.bus.on('player_damage', (e) => {
        if (!this._engagement) return;
        if (e.victim !== this.profile.username) return;
        if (e.attacker !== this._engagement.opponent) return;
        this._engagement.hits_taken += 1;
      });
    }
  }

  /** Register a one-shot callback fired each time the bot disengages. */
  setOnDisengage(cb) { this._onDisengage = typeof cb === 'function' ? cb : null; }

  /** Late-wire hook for a caller that builds Movement after Combat (agent/main.js passes it to the constructor instead). */
  setMovement(movement) { this.movement = movement; }

  /** Begin fighting a target entity. Honors reaction delay. */
  async engage(target) {
    if (!target) return;
    if (this.engaged && this.target === target) return;
    if (this.engaged) this.disengage();

    this.target = target;
    this.engaged = true;
    this.engagedAt = now();
    this.log?.info('engage_begin', { target: target.username ?? target.name });

    // Clear any controls left over from the pathfinder that brought us
    // here. The old stack's hunt path used to call
    // bot.clearControlStates() *before* combat.engage(), which left a
    // ~50ms gap with zero inputs and produced a visible stutter
    // between pathfinder release and combat takeover. Clearing inside
    // engage closes the gap — controls drop and the first combat tick
    // re-asserts them in the same scheduling slot.
    try { this.bot.clearControlStates?.(); } catch {}

    this._beginEngagement(target);

    // Reaction delay before the first swing — this is the headline tell
    // for low skill tiers.
    const reactionMs = uniform(
      this.cfg.reaction_ms_min ?? 350,
      this.cfg.reaction_ms_max ?? 500
    );
    this._firstSwingAllowedAt = now() + reactionMs;
    this._lastHitAt = now();

    // Suspend auto-eat for the duration of combat. Without this,
    // hunger < 15 mid-fight makes mineflayer-auto-eat equip steak
    // (replacing the sword), spam right-click, and eat for ~1.6s
    // while combat keeps swinging with food in hand → no damage
    // dealt. The bot LITERALLY puts down its sword to eat in the
    // middle of a duel. Disable the loop here, restore in disengage.
    // Also cancel any in-progress eat so we get the weapon back
    // immediately rather than waiting for the food bite to finish.
    try { this.bot.autoEat?.disableAuto?.(); } catch {}
    try { this.bot.autoEat?.cancelEat?.(); } catch {}

    // Start the tick loop FIRST so combat starts running immediately
    // with whatever weapon the bot is currently holding. We then equip
    // the preferred weapon in the background — if the server is laggy
    // or rejects the inventory transaction, the bot still swings (with
    // a shovel or fist or whatever it had). Previously we awaited the
    // equip before starting the tick loop, which made the bot frozen
    // for up to 1.5s on every engagement when the equip timed out.
    this._startTickLoop();
    this._equipPreferredWeapon().catch((e) =>
      this.log?.debug?.('background_equip_failed', { msg: e.message })
    );
  }

  // ---------- internal tick loop ----------

  /**
   * Combat owns its own 20Hz tick. Independent of mineflayer's
   * physicsTick so a chunk-unloaded or non-finite-position pause in
   * mineflayer's physics gate doesn't silently freeze combat.
   *
   * 50ms matches mineflayer's physicsTick cadence (the original
   * coupling pre-Phase 14.13) and the Minecraft server tick rate
   * (20Hz). Faster ticks are harmless: `_maybeSwing`'s `_lastSwingAt`
   * gating caps swing rate at the configured CPS, `_updateAim`'s
   * noise refresh is wall-clock gated, `_maybePot` has its own 1500ms
   * cooldown. Tier-5 (CPS 13 ≈ 77ms interval) lands swings every
   * 50-100ms now instead of the 80-160ms jitter that the previous
   * 80ms interval produced — much closer to "swung when intended"
   * for the player's perceived combat feel.
   */
  _startTickLoop() {
    if (this._tickInterval) return;
    this._tickInterval = setInterval(() => this._tick(), 50);
    this._tickInterval.unref?.();
  }

  _stopTickLoop() {
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
  }

  disengage(reason = 'manual') {
    if (!this.engaged) return;
    this.engaged = false;
    this._stopTickLoop();
    this._lastMoveCloserState = false;
    this._aimBuffer = new Array(AIM_BUFFER_LEN);
    this._aimBufferIdx = 0;
    // Re-enable auto-eat now that combat is over and the weapon
    // doesn't matter for survival. Bot will eat between fights /
    // during downtime instead of mid-swing.
    try { this.bot.autoEat?.enableAuto?.(); } catch {}
    this.bot.clearControlStates();
    if (this._blocking) this._releaseBlock();
    this.log?.info('disengage', { reason });
    this._lastDisengageAt = Date.now();
    this._lastDisengageReason = reason;
    this._endEngagement(reason);
    this.target = null;
    if (this._onDisengage) {
      try { this._onDisengage(reason); } catch (e) {
        this.log?.debug?.('on_disengage_threw', { msg: e.message });
      }
    }
  }

  get lastDisengageAt() { return this._lastDisengageAt ?? 0; }
  get lastDisengageReason() { return this._lastDisengageReason ?? null; }

  /** If HP is below flee_at_hp, disengage and walk away from target. */
  fleeIfLow(movement) {
    const mv = movement ?? this.movement;
    const hp = this.bot.health;
    const threshold = this.cfg.flee_at_hp ?? 6;
    if (hp > threshold) return false;
    const t = this.target;
    this.disengage('flee');
    if (t && mv) {
      mv.flee(t.position, 24, { timeoutMs: 10000 });
    }
    return true;
  }

  // ---------- internal tick ----------

  _tick() {
    try {
      this._tickInner();
    } catch (e) {
      // Last-ditch safety: log and disengage rather than letting the
      // throw escape into the setInterval callback chain (an unhandled
      // throw in a Node interval surfaces as an unhandledException at
      // process scope).
      this.log?.warn?.('combat_tick_threw', { msg: e?.message ?? String(e) });
      try { this.disengage('tick_error'); } catch {}
    }
  }

  _tickInner() {
    if (!this.engaged) return;
    // Defensive: if our own position has any non-finite axis (the
    // null x/z corruption we see during PvP), every distanceTo call
    // below returns NaN, _maybeMoveCloser sets controls based on a
    // NaN comparison, and _maybeSwing never lands. Quietly skip the
    // tick until the position is finite again (core/bot.js rewrites
    // null-axis position packets so this should stay rare).
    const me = this.bot.entity?.position;
    if (!me || !Number.isFinite(me.x) || !Number.isFinite(me.y) || !Number.isFinite(me.z)) {
      return;
    }
    const t = this.target;
    if (!t || !t.isValid || t.health === 0) {
      this.disengage('target_gone');
      return;
    }

    // Lost-target timeout: if we haven't landed a swing in STALL_MS,
    // the target is unreachable (behind a wall, on a different
    // y-level, faster than we can pathfind, or just out of range).
    // Give up so a strategic tick or another retaliation can take
    // over. 5s is short enough that the freeze isn't visible-feeling
    // to a human, long enough that brief out-of-range moments don't
    // tear down a winning fight.
    const STALL_MS = 5_000;
    if (this._lastHitAt && (now() - this._lastHitAt) > STALL_MS) {
      this.log?.info?.('combat_stalled', {
        sinceLastHitMs: now() - this._lastHitAt,
        target: t.username ?? t.name,
      });
      this.disengage('stalled');
      return;
    }

    const hp = this.bot.health;
    if (hp <= (this.cfg.flee_at_hp ?? 6)) {
      this.fleeIfLow();
      return;
    }

    // Consider a pot / gapple before continuing.
    if (hp < (this.cfg.pot_at_hp ?? 14)) {
      this._maybePot();
    }

    this._updateAim();
    this._maybeMoveCloser();
    this._maybeSwing();
  }

  _updateAim() {
    const t = this.target;
    if (!t || !t.position) return;
    const ts = now();

    // Record current target position into the lag buffer.
    this._aimBuffer[this._aimBufferIdx % AIM_BUFFER_LEN] = {
      x: t.position.x, y: t.position.y, z: t.position.z, ts,
      h: t.height ?? 1.62,
    };
    this._aimBufferIdx += 1;

    // Pick the buffer entry closest to (now - lagMs). Higher-tier
    // bots (low aim_error_deg) get less lag — they react faster.
    // Lower-tier bots track stale positions, so dodging actually
    // works against them.
    const lagMs = this.cfg.aim_lag_ms ?? AIM_LAG_DEFAULT_MS;
    const wantTs = ts - lagMs;
    let aimSample = null;
    for (let i = 0; i < AIM_BUFFER_LEN; i++) {
      const s = this._aimBuffer[i];
      if (!s) continue;
      if (!aimSample || Math.abs(s.ts - wantTs) < Math.abs(aimSample.ts - wantTs)) {
        aimSample = s;
      }
    }
    if (!aimSample) aimSample = { x: t.position.x, y: t.position.y, z: t.position.z, h: t.height ?? 1.62 };

    // Refresh aim noise on a wall-clock interval so it doesn't track
    // tick rate. 150-400ms feels human; high-skill bots refresh on
    // the lower end (snappier corrections), low-skill on the upper end.
    if (ts - this._lastAimNoiseAt > uniform(150, 400)) {
      const stddev = ((this.cfg.aim_error_deg ?? 3) * Math.PI) / 180;
      this._aimNoise.yaw = gauss(stddev);
      this._aimNoise.pitch = gauss(stddev * 0.6);
      this._lastAimNoiseAt = ts;
    }

    const head = {
      x: aimSample.x,
      y: aimSample.y + aimSample.h * 0.9,
      z: aimSample.z,
    };
    const myPos = this.bot.entity.position;
    const myEye = (this.bot.entity.height ?? 1.62);
    const dx = head.x - myPos.x;
    const dy = head.y - (myPos.y + myEye);
    const dz = head.z - myPos.z;
    const yaw   = Math.atan2(-dx, -dz) + this._aimNoise.yaw;
    const pitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)) + this._aimNoise.pitch;

    // Look-update throttle. Skip the bot.look() call when neither
    // enough time has passed nor the desired yaw moved meaningfully.
    // Cuts roughly 60% of look() calls without affecting tracking.
    const yawDeltaDeg = Math.abs(yaw - this._lastLookYaw) * 180 / Math.PI;
    const pitchDeltaDeg = Math.abs(pitch - this._lastLookPitch) * 180 / Math.PI;
    const elapsed = ts - this._lastLookAt;
    if (elapsed < LOOK_MAX_INTERVAL_MS &&
        yawDeltaDeg < LOOK_DELTA_DEG && pitchDeltaDeg < LOOK_DELTA_DEG) {
      return;
    }
    this._lastLookAt = ts;
    this._lastLookYaw = yaw;
    this._lastLookPitch = pitch;
    // `force=false` so the look interpolates; we want a smooth tracking.
    this.bot.look(yaw, pitch, false).catch(() => {});
  }

  _maybeMoveCloser() {
    // If pathfinder is actively navigating (e.g. _hunt's
    // movement.follow), let it own movement controls. Combat's naive
    // forward+sprint will fight pathfinder's setControlStates and the
    // bot ends up stuttering in place — looks frozen even though both
    // systems are firing. Just aim + swing while pathfinder closes the
    // gap.
    if (this.bot.pathfinder?.isMoving?.()) {
      // Pathfinder owns motion; clear our hysteresis state so the
      // next time pathfinder lets go we re-evaluate from scratch.
      this._lastMoveCloserState = false;
      return;
    }
    const t = this.target;
    const dist = this.bot.entity.position.distanceTo(t.position);
    // Hysteresis: only flip the chase state when crossing the
    // outer/inner thresholds; hold previous state in the deadband.
    let chase = this._lastMoveCloserState;
    if (dist > MOVE_IN_AT) chase = true;
    else if (dist < MOVE_STOP_AT) chase = false;
    if (chase !== this._lastMoveCloserState) {
      this._lastMoveCloserState = chase;
      this.bot.setControlState('forward', chase);
      this.bot.setControlState('sprint', chase);
    }
  }

  _maybeSwing() {
    if (now() < (this._firstSwingAllowedAt ?? 0)) return;
    // Don't swing mid-eat. In 1.8 a left-click attack interrupts the
    // food animation, so a 50ms combat tick that swings while we're
    // 800ms into a 1700ms gapple chew CANCELS the eat — the bot
    // never actually consumes the apple, never heals, and dies
    // staring at full inventory. Pause swings until the eat finishes.
    if (this._eating) return;
    const t = this.target;
    const dist = this.bot.entity.position.distanceTo(t.position);
    if (dist > PLAYER_REACH) return;

    const cps = Math.max(1, this.cfg.cps ?? 8);
    const intervalMs = 1000 / cps;
    const since = now() - this._lastSwingAt;
    if (since < intervalMs) return;

    this.bot.attack(t, true);
    this._lastSwingAt = now();
    this._lastHitAt = now();   // resets the stall watchdog
    if (this._engagement) {
      this._engagement.hits_landed += 1;
      this._engagement.opponent_last_hp = t.health ?? this._engagement.opponent_last_hp;
    }

    // Sprint-reset / w-tap: briefly release sprint on hit for extra KB.
    if (Math.random() < (this.cfg.combo_follow_rate ?? 0.5)) {
      this._sprintReset();
    }

    // Block-hit: only swords can block in 1.8. If the bot's preferred
    // weapon is an axe, it's almost always holding an axe → skip.
    if (this._canBlockHit() &&
        Math.random() < (this.cfg.block_hit_rate ?? 0.2)) {
      this._blockHit();
    }
  }

  _canBlockHit() {
    const held = this.bot.heldItem;
    if (!held) return false;
    return held.name.endsWith('_sword');
  }

  _sprintReset() {
    if (now() - this._lastSprintResetAt < 200) return;
    this._lastSprintResetAt = now();
    this.bot.setControlState('sprint', false);
    setTimeout(() => {
      if (this.engaged) this.bot.setControlState('sprint', true);
    }, 60);
  }

  _blockHit() {
    if (this._blocking) return;
    this._blocking = true;
    try { this.bot.activateItem(); } catch {}
    // Hold for a human-ish 80–180ms.
    const hold = 80 + Math.random() * 100;
    setTimeout(() => this._releaseBlock(), hold);
  }

  _releaseBlock() {
    this._blocking = false;
    try { this.bot.deactivateItem(); } catch {}
  }

  _maybePot() {
    // Already in the middle of eating a gapple — don't fire another
    // pot attempt that would interrupt the eat. The 1500ms cooldown
    // alone is too short: a gapple needs the full 32-tick (1.6s)
    // animation, and the previous attempt's gating only blocks for
    // 1.5s before the next _maybePot tries to equip a different
    // item mid-eat (which cancels the eat with zero consumption).
    if (this._eating) return;
    if (now() - this._lastPotAt < 1500) return;
    if (Math.random() > (this.cfg.pot_success_rate ?? 0.5)) {
      // "Fumble" — don't pot, but set cooldown so we don't retry every tick.
      this._lastPotAt = now() - 500;
      return;
    }
    const item = this._findHealItem();
    if (!item) return;
    const isGapple = item.name.includes('apple');
    // Gapple-eat HP gate. The eat suspends swings for ~1700ms, during
    // which the opponent gets free hits. If our HP is already close to
    // flee_at_hp, we'll die mid-chew and never benefit from the heal.
    // Skip the gapple eat in that case and let the flee gate at the
    // top of _tickInner pull us out instead. Splash potions are
    // instant-drink (200ms hold) so they don't need this gate.
    const fleeHp = this.cfg.flee_at_hp ?? 6;
    if (isGapple && this.bot.health <= fleeHp + 4) {
      this.log?.info?.('pot_skipped_low_hp', {
        hp: this.bot.health, flee_hp: fleeHp, item: item.name,
      });
      this._lastPotAt = now() - 500;
      return;
    }
    this._lastPotAt = now();
    this.log?.info('pot_attempt', { item: item.name });
    // Splash potions are an instant drink (200ms is fine — the
    // packet flushes well within that). Golden apples need the
    // FULL eat animation: 32 ticks = 1.6s of held right-click. If
    // we deactivate before the animation completes, the eat is
    // cancelled and the gapple is NOT consumed — the bot loops
    // pot_attempt → equip → activate → cancel forever, taking
    // damage the whole time. The previous 200ms hard-coded value
    // was the visible bug from the user's log.
    const holdMs = isGapple ? 1700 : 200;
    if (isGapple) {
      this._eating = true;
    }
    this.bot.equip(item, 'hand')
      .then(() => {
        // Look downward for splash pots, forward for gapples.
        const look = isGapple ? this.bot.look(this.bot.entity.yaw, 0, true)
                              : this.bot.look(this.bot.entity.yaw, Math.PI / 2, true);
        return look;
      })
      .then(() => this.bot.activateItem())
      .then(() => sleep(holdMs))
      .then(() => this.bot.deactivateItem())
      .then(() => {
        // Restore aim immediately. Without this, the next 50ms tick
        // sees the bot still pitched 90° down with forward+sprint
        // active — at tier-4/5 CPS that's 1-2 wasted swings into the
        // floor while the target lines up a free hit. Skip for
        // gapples (we already aimed forward, and the eat hasn't
        // disturbed pitch).
        if (isGapple) return;
        const t = this.target;
        if (!t?.position || !this.bot.entity?.position) return;
        try { return this.bot.lookAt(t.position.offset?.(0, t.height ?? 1.5, 0) ?? t.position, true); }
        catch { /* lookAt may throw if entity vanished mid-pot */ }
      })
      .then(() => {
        // Re-equip the sword/axe so the next swing isn't wasted on a
        // fist-bonk with the empty gapple slot or a thrown splash
        // potion. _equipPreferredWeapon picks the best
        // sword/axe in inventory; if the bot already had its weapon
        // out before the pot equip swap, this is a no-op.
        return this._equipPreferredWeapon();
      })
      .catch((e) => this.log?.warn('pot_failed', { msg: e.message }))
      .finally(() => {
        if (isGapple) this._eating = false;
      });
  }

  _findHealItem() {
    for (const slot of this.bot.inventory.items()) {
      const n = slot.name.toLowerCase();
      if (POT_ITEM_HINTS.some((h) => n.includes(h))) return slot;
    }
    return null;
  }

  // ---------- diagnostic engagement tracking ----------

  _beginEngagement(target) {
    const held = this.bot.heldItem;
    this._engagement = {
      startedAt: Date.now(),
      opponent: target.username ?? target.name ?? 'unknown',
      opponent_start_hp: target.health ?? null,
      opponent_last_hp: target.health ?? null,
      weapon: held?.name ?? 'fist',
      hits_landed: 0,
      hits_taken: 0,
    };
  }

  _endEngagement(reason) {
    const eng = this._engagement;
    if (!eng) return;
    this._engagement = null;

    const t = this.target;
    const targetDead = !!t && (t.isValid === false || t.health === 0 || eng.opponent_last_hp === 0);

    let outcome;
    if (reason === 'death') outcome = 'loss';
    else if (reason === 'flee') outcome = 'disengage';
    else if (reason === 'target_gone' && targetDead) outcome = 'win';
    else outcome = 'draw';

    const durationSec = (Date.now() - eng.startedAt) / 1000;
    // One structured line per engagement in the bot log (the old stack
    // appended these to data/diagnostics/combat_events.csv).
    this.log?.info?.('combat_engagement_end', {
      opponent: eng.opponent,
      outcome,
      duration_s: Number(durationSec.toFixed(2)),
      hp_remaining: this.bot?.health ?? null,
      opponent_hp_estimate: eng.opponent_last_hp,
      hits_landed: eng.hits_landed,
      hits_taken: eng.hits_taken,
      weapon: eng.weapon,
    });
  }

  async _equipPreferredWeapon() {
    const pref = (this.cfg.preferred_weapon ?? 'sword').toLowerCase();
    const items = this.bot.inventory.items();
    let candidate = null;
    if (pref === 'axe') {
      candidate = pickBest(items, ['diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe']);
    } else {
      candidate = pickBest(items, ['diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword']);
    }
    // Fall back to whatever weapon is available if preferred isn't in inv.
    if (!candidate) {
      candidate = pickBest(items, [
        'diamond_sword','iron_sword','stone_sword','wooden_sword',
        'diamond_axe','iron_axe','stone_axe','wooden_axe',
      ]);
    }
    if (!candidate) return;
    try {
      await Promise.race([
        this.bot.equip(candidate, 'hand'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('equip_timeout')), 1500)),
      ]);
    } catch (e) { this.log?.warn('equip_failed', { msg: e.message }); }
  }
}

function pickBest(items, orderedNames) {
  for (const n of orderedNames) {
    const hit = items.find((it) => it.name === n);
    if (hit) return hit;
  }
  return null;
}
