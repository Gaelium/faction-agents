/**
 * nerves.js — the nervous system: sensors that queue events, reflexes
 * that take ONE survival action, and interrupts that cancel the running
 * tool. Nothing here ever starts a multi-step behavior. That rule is
 * what lets the agent loop be the only sequencer.
 *
 * Tiers (see AGENT_OVERHAUL.md §3.3):
 *   0 reflex   — lava, drowning, death: one immediate action, then cancel
 *                the running tool so the brain gets the next turn now.
 *   1 deliver  — damage, chat mention/whisper, hostile mob or player
 *                nearby, hunger: queued; also cancels the running tool
 *                when the tool was armed with that kind in `interrupt_on`.
 *   2 summary  — other chat, join/leave: counted, one line per drain.
 *
 * The loop calls `arm({ interruptOn, cancel })` before each actuator tool
 * and `disarm()` after; `drain()` returns the queued events for the next
 * user turn.
 */

import vec3Pkg from 'vec3';
const Vec3 = vec3Pkg.Vec3 ?? vec3Pkg;

export const INTERRUPT_KINDS = Object.freeze([
  'damage', 'chat_mention', 'whisper', 'chat_any', 'mob_near', 'player_near', 'hunger', 'job_done', 'dusk', 'faction_invite', 'faction_member', 'faction_denied',
]);

// Massive Factions invite lines, e.g. "Marla_K invited you to Hearth" /
// "You have been invited to join Hearth".
// Massive prefixes names with a role/relation mark ("**Rook_Vantis", "-Marla_K").
const INVITE_RES = [
  /^[*+\-~]*(\w{2,16}) (?:has )?invited you to (?:join )?(?:the faction )?(\w{2,18})/i,
  /you (?:have been|were) invited to (?:join )?(?:the faction )?(\w{2,18})/i,
];
// Massive Factions refuses a build/use in claimed land with
// "<Faction> does not allow you to build." (recruits cannot build).
const DENY_RE = /^([\w-]{2,18}) does not allow you to ([\w ]+?)\.?$/i;
// "oatmeal_ollie joined your faction." — power just grew; time to claim.
const MEMBER_RES = [
  /^[*+\-~]*(\w{2,16}) (?:successfully )?joined (?:your faction|(\w{2,18}))/i,
];

function dayPhase(t) {
  if (typeof t !== 'number') return null;
  if (t < 12000) return 'day';
  if (t < 13800) return 'dusk';
  if (t < 22200) return 'night';
  return 'dawn';
}

export const HOSTILE = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'cavespider', 'witch', 'slime',
  'magma_cube', 'magmacube', 'lavaslime', 'blaze', 'silverfish', 'enderman', 'endermite',
  'wither_skeleton', 'witherskeleton', 'ghast', 'guardian', 'giant',
]);

const SCAN_INTERVAL_MS = 1000;
const MOB_NEAR_RANGE = 6;
const PLAYER_NEAR_RANGE = 10;
const MOB_REPEAT_MS = 30_000;
const PLAYER_REPEAT_MS = 60_000;
const HUNGER_REPEAT_MS = 60_000;
const DAMAGE_DEDUP_MS = 250;
const LOW_OXYGEN = 8;
const LOW_HP_INTERRUPT = 8;
const CHAT_KEEP = 6;

export class Nerves {
  constructor({ bot, bus = null, log = null, username, now = () => Date.now() }) {
    this.bot = bot;
    this.bus = bus;
    this.log = log;
    this.username = username;
    this.now = now;
    this._queue = [];          // tier-1 events awaiting the next drain
    this._tier2 = { chat: 0, joins: [], leaves: [] };
    this._recentChat = [];     // last CHAT_KEEP lines heard, for look()
    this._armed = null;        // { set: Set<kind>, cancel: CancelToken }
    this._lastHealth = null;
    this._lastDamageAt = 0;
    this._lastDamageSource = null;   // { attacker, weapon, ts } from the bus
    this._seenMobs = new Map();      // entity id -> last emit ts
    this._seenPlayers = new Map();   // name -> last emit ts
    this._lastHungerAt = 0;
    this._scanTimer = null;
    this._reflexBusy = false;
    this._offs = [];
    this.stats = { events: 0, interrupts: 0, reflexes: 0 };
  }

  // ---------- lifecycle ----------

  start() {
    const bot = this.bot;
    const on = (ev, fn) => { bot.on(ev, fn); this._offs.push(() => bot.removeListener(ev, fn)); };

    this._lastHealth = typeof bot.health === 'number' ? bot.health : null;

    // Damage is detected from the HP drop on `health` (reliable on 1.8:
    // update_health drives it). `entityHurt` also fires for hurt
    // animations that cost no HP (blocked hits, full-armor scratches) and
    // interrupted a mine at 20/20 HP (TestBot44, 2026-09-02); it now only
    // primes attribution timing.
    on('health', () => this._onHealth());
    on('entityHurt', (entity) => {
      if (entity && bot.entity && entity.id === bot.entity.id) this._lastHurtAnimAt = this.now();
    });
    on('death', () => {
      const pos = roundPos(bot.entity?.position);
      this._emit('death', { pos, killer: this._lastDamageSource?.attacker ?? null }, { tier: 0, force: true });
    });
    on('chat', (username, message) => this._onChat(username, message, false));
    on('whisper', (username, message) => this._onChat(username, message, true));
    on('messagestr', (msg) => this._onServerMessage(msg));
    on('playerJoined', (p) => { if (p?.username && p.username !== this.username) this._tier2.joins.push(p.username); });
    on('playerLeft', (p) => { if (p?.username && p.username !== this.username) this._tier2.leaves.push(p.username); });

    if (this.bus?.on) {
      this._offs.push(this.bus.on('player_damage', (e) => {
        if (e?.victim !== this.username) return;
        this._lastDamageSource = { attacker: e.attacker ?? null, weapon: e.weapon ?? null, ts: this.now() };
      }));
      this._offs.push(this.bus.on('chat_message', (e) => {
        if (e?.sender && e?.message) this._onChat(e.sender, e.message, false, 'bus');
      }));
    }

    this._scanTimer = setInterval(() => this._scan(), SCAN_INTERVAL_MS);
    this._scanTimer.unref?.();
  }

  stop() {
    if (this._scanTimer) clearInterval(this._scanTimer);
    this._scanTimer = null;
    for (const off of this._offs) { try { off(); } catch {} }
    this._offs = [];
    this._armed = null;
  }

  // ---------- arming ----------

  /** Arm interrupts for a running tool. `interruptOn` is a list of kinds. */
  arm({ interruptOn = [], cancel, uninterruptible = false }) {
    const set = new Set((interruptOn ?? []).filter((k) => INTERRUPT_KINDS.includes(k)));
    this._armed = { set, cancel, uninterruptible };
  }

  disarm() { this._armed = null; }

  /** Tools and jobs report world events through here (e.g. job_done). */
  notify(kind, data = {}, { tier = 1 } = {}) {
    this._emit(kind, data, { tier });
  }

  /** Cancel the running tool from outside (loop shutdown, disconnect). */
  cancelCurrent(reason, detail = null) {
    const armed = this._armed;
    if (!armed?.cancel || armed.cancel.cancelled) return;
    // Escapes (teleport, unstick swim) are shielded from Tier 0 damage: the
    // event is still queued for the brain, the tool just finishes first.
    const u = armed.uninterruptible;
    if (u && reason !== 'death' && reason !== 'shutdown' && reason !== 'hard_timeout'
        && (u === true || (typeof u === 'function' && u(reason, detail)))) {
      this.log?.info?.('nerve_shielded', { reason, cause: detail?.cause ?? null });
      return;
    }
    this.stats.interrupts += 1;
    armed.cancel.cancel(reason, detail);
  }

  // ---------- reading ----------

  /** Pop queued events. Tier-2 counters collapse into one summary line. */
  drain() {
    const events = this._queue;
    this._queue = [];
    const t2 = this._tier2;
    this._tier2 = { chat: 0, joins: [], leaves: [] };
    const summary = [];
    if (t2.chat > 0) summary.push(`${t2.chat} other chat line${t2.chat === 1 ? '' : 's'} (none mention you)`);
    if (t2.joins.length) summary.push(`joined: ${t2.joins.slice(0, 5).join(', ')}`);
    if (t2.leaves.length) summary.push(`left: ${t2.leaves.slice(0, 5).join(', ')}`);
    return { events, summary };
  }

  recentChat(n = 3) {
    return this._recentChat.slice(-n).map((c) => ({
      from: c.from, text: c.text, secs_ago: Math.round((this.now() - c.ts) / 1000),
    }));
  }

  lastDamageSource() { return this._lastDamageSource; }

  // ---------- sensors ----------

  _onHealth() {
    const bot = this.bot;
    const hp = typeof bot.health === 'number' ? bot.health : null;
    if (hp == null) return;
    const prev = this._lastHealth;
    this._lastHealth = hp;
    if (prev != null && hp < prev && hp > 0) this._onHurt('health', prev - hp);
    // Hunger: auto-eat handles food when there is food; the event is for
    // the case where there is none, so the brain can go get some.
    const food = typeof bot.food === 'number' ? bot.food : 20;
    if (food <= 6 && this.now() - this._lastHungerAt > HUNGER_REPEAT_MS) {
      this._lastHungerAt = this.now();
      this._emit('hunger', { food, has_food: this._hasFood() }, { tier: 1 });
    }
  }

  _onHurt(source, amount = null) {
    const t = this.now();
    if (t - this._lastDamageAt < DAMAGE_DEDUP_MS) return;
    this._lastDamageAt = t;
    const bot = this.bot;
    const pos = bot.entity?.position;
    const cause = this._classifyCause();
    const src = this._lastDamageSource && t - this._lastDamageSource.ts < 1500
      ? this._lastDamageSource : null;
    // BotBridge names attackers like "mob:SKELETON" / "player:Marla_K".
    let attacker = src?.attacker ?? cause.attacker ?? null;
    let kind = cause.kind;
    if (typeof attacker === 'string' && /^mob:/i.test(attacker)) { attacker = attacker.slice(4).toLowerCase(); if (kind === 'unknown') kind = 'mob'; }
    else if (typeof attacker === 'string' && /^player:/i.test(attacker)) { attacker = attacker.slice(7); if (kind === 'unknown') kind = 'player'; }
    const data = {
      hp: typeof bot.health === 'number' ? Math.round(bot.health * 10) / 10 : null,
      amount: amount != null ? Math.round(amount * 10) / 10 : null,
      cause: kind,
      attacker,
      weapon: src?.weapon ?? null,
      pos: roundPos(pos),
    };
    // Tier-0 reflexes: one action, then hand back.
    if (data.cause === 'lava') this._reflexLava();
    else if (data.cause === 'drowning') this._reflexDrown();
    // Low HP is Tier 0 no matter what the running tool armed: a bot at
    // 8 HP that keeps mining with interrupt_on [] is how TestBot44 died.
    const lowHp = data.hp != null && data.hp <= LOW_HP_INTERRUPT;
    if (lowHp) data.low_hp = true;
    this._emit('damage', data, { tier: data.cause === 'lava' || data.cause === 'drowning' || lowHp ? 0 : 1 });
  }

  _classifyCause() {
    const bot = this.bot;
    const pos = bot.entity?.position;
    try {
      if (pos && typeof bot.blockAt === 'function') {
        const feet = bot.blockAt(pos);
        const head = bot.blockAt(pos.offset ? pos.offset(0, 1, 0) : new Vec3(pos.x, pos.y + 1, pos.z));
        const isLava = (b) => b && (b.name === 'lava' || b.name === 'flowing_lava');
        if (isLava(feet) || isLava(head)) return { kind: 'lava' };
        const isWater = (b) => b && (b.name === 'water' || b.name === 'flowing_water');
        if (isWater(head) && typeof bot.oxygenLevel === 'number' && bot.oxygenLevel <= 0) return { kind: 'drowning' };
        const below = bot.blockAt(pos.offset ? pos.offset(0, -1, 0) : new Vec3(pos.x, pos.y - 1, pos.z));
        if (below && below.name === 'fire') return { kind: 'fire' };
      }
    } catch {}
    // Nearest hostile mob within reach is the likely attacker.
    const mob = this._nearestHostile(4);
    if (mob) return { kind: 'mob', attacker: mob.name };
    const player = this._nearestPlayer(5);
    if (player) return { kind: 'player', attacker: player.name };
    if (typeof bot.food === 'number' && bot.food <= 0) return { kind: 'starvation' };
    return { kind: 'unknown' };
  }

  _scan() {
    const bot = this.bot;
    if (!bot.entity?.position) return;
    const t = this.now();
    // Day phase transitions: dusk (shelter or sword out) and dawn.
    try {
      const phase = dayPhase(bot.time?.timeOfDay);
      if (phase && this._lastPhase && phase !== this._lastPhase) {
        if (phase === 'dusk') this._emit('dusk', { note: 'night: mobs spawn in the dark', ...this._nightKit() }, { tier: 1 });
        else if (phase === 'dawn') this._emit('dawn', { note: 'sun is up; surface mobs burn' }, { tier: 1 });
      }
      if (phase) this._lastPhase = phase;
    } catch {}
    // Drowning watch (oxygen falls before damage does).
    try {
      if (typeof bot.oxygenLevel === 'number' && bot.oxygenLevel < LOW_OXYGEN && bot.oxygenLevel >= 0) {
        if (!this._lowOxygenEmitted) {
          this._lowOxygenEmitted = true;
          this._reflexDrown();
          this._emit('damage', { hp: bot.health, cause: 'drowning', oxygen: bot.oxygenLevel, pos: roundPos(bot.entity.position) }, { tier: 0 });
        }
      } else {
        this._lowOxygenEmitted = false;
      }
    } catch {}
    // Hostile mobs within range.
    const mob = this._nearestHostile(MOB_NEAR_RANGE);
    if (mob) {
      const last = this._seenMobs.get(mob.id) ?? 0;
      if (t - last > MOB_REPEAT_MS) {
        this._seenMobs.set(mob.id, t);
        this._emit('mob_near', { mob: mob.name, distance: mob.distance, dir: mob.dir }, { tier: 1 });
      }
    }
    // Players within range.
    const player = this._nearestPlayer(PLAYER_NEAR_RANGE);
    if (player) {
      const last = this._seenPlayers.get(player.name) ?? 0;
      if (t - last > PLAYER_REPEAT_MS) {
        this._seenPlayers.set(player.name, t);
        this._emit('player_near', { player: player.name, distance: player.distance, dir: player.dir }, { tier: 1 });
      }
    }
    if (this._seenMobs.size > 64) this._seenMobs.clear();
  }

  _onChat(username, message, isWhisper, source = 'bot') {
    if (!username || !message) return;
    if (username === this.username) return;
    const text = String(message).slice(0, 200);
    const t = this.now();
    // Dedupe: the same line can arrive from mineflayer's parser and the bus.
    const dup = this._recentChat.find((c) => c.from === username && c.text === text && t - c.ts < 2000);
    if (dup) return;
    this._recentChat.push({ from: username, text, ts: t });
    while (this._recentChat.length > CHAT_KEEP) this._recentChat.shift();
    const mentions = isWhisper || new RegExp(`\\b${escapeRe(this.username)}\\b`, 'i').test(text);
    if (isWhisper) this._emit('whisper', { from: username, text }, { tier: 1 });
    else if (mentions) this._emit('chat_mention', { from: username, text }, { tier: 1 });
    else {
      this._tier2.chat += 1;
      // chat_any is opt-in only: it never queues, but it can interrupt an armed tool.
      this._maybeInterrupt('chat_any', { from: username, text });
    }
  }

  _onServerMessage(msg) {
    let s;
    try { s = String(msg ?? '').replace(/§./g, '').trim(); } catch { return; }
    if (!s || /^<\w+>|^\[\w+\] \w+:/.test(s)) return; // player chat is handled elsewhere
    for (const re of INVITE_RES) {
      const m = re.exec(s);
      if (!m) continue;
      const from = m.length > 2 ? m[1] : null;
      const faction = m.length > 2 ? m[2] : m[1];
      const t = this.now();
      if (this._lastInvite && this._lastInvite.faction === faction && t - this._lastInvite.ts < 5000) return;
      this._lastInvite = { faction, ts: t };
      this._emit('faction_invite', { from, faction, text: s.slice(0, 120) }, { tier: 1 });
      return;
    }
    {
      const m = DENY_RE.exec(s);
      if (m) {
        const t = this.now();
        this.lastDenial = { ts: t, faction: m[1], perm: m[2].trim(), text: s.slice(0, 120) };
        // Once per 20 s is enough for the brain; every denial is still recorded for the tools.
        if (!this._lastDenyEmit || t - this._lastDenyEmit > 20_000) {
          this._lastDenyEmit = t;
          this._emit('faction_denied', { faction: m[1], perm: m[2].trim() }, { tier: 1 });
        }
        return;
      }
    }
    for (const re of MEMBER_RES) {
      const m = re.exec(s);
      if (!m) continue;
      const player = m[1];
      if (player === this.username) return;
      const t = this.now();
      if (this._lastMember && this._lastMember.player === player && t - this._lastMember.ts < 5000) return;
      this._lastMember = { player, ts: t };
      this._emit('faction_member', { player, faction: m[2] ?? null, text: s.slice(0, 120) }, { tier: 1 });
      return;
    }
  }

  // ---------- reflexes (one action each) ----------

  _reflexLava() {
    if (this._reflexBusy) return;
    this._reflexBusy = true;
    this.stats.reflexes += 1;
    const bot = this.bot;
    try {
      // One action: jump and push toward the nearest non-lava cardinal.
      const pos = bot.entity.position;
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      let best = null;
      for (const [dx, dz] of dirs) {
        const b = bot.blockAt?.(new Vec3(Math.floor(pos.x + dx * 1.5), Math.floor(pos.y), Math.floor(pos.z + dz * 1.5)));
        const under = bot.blockAt?.(new Vec3(Math.floor(pos.x + dx * 1.5), Math.floor(pos.y - 1), Math.floor(pos.z + dz * 1.5)));
        const safe = b && b.name !== 'lava' && b.name !== 'flowing_lava'
          && under && under.name !== 'lava' && under.name !== 'flowing_lava' && under.name !== 'air';
        if (safe) { best = { dx, dz }; break; }
      }
      if (best && typeof bot.lookAt === 'function') {
        bot.lookAt(new Vec3(pos.x + best.dx * 3, pos.y + 1, pos.z + best.dz * 3), true);
      }
      bot.setControlState?.('jump', true);
      bot.setControlState?.('forward', true);
      setTimeout(() => {
        try { bot.setControlState?.('jump', false); bot.setControlState?.('forward', false); } catch {}
        this._reflexBusy = false;
      }, 1200);
      this.log?.info?.('reflex_lava', { pos: roundPos(pos), dir: best });
    } catch (e) {
      this._reflexBusy = false;
      this.log?.debug?.('reflex_lava_failed', { msg: e.message });
    }
  }

  /** A faction permission denial recorded since `ts`, or null. */
  denialSince(ts) { return this.lastDenial && this.lastDenial.ts >= ts ? this.lastDenial : null; }

  /** What the bot has for a night out: torches and worn armor pieces. */
  _nightKit() {
    const bot = this.bot;
    let torches = 0; let armor = 0; let sword = false;
    try {
      for (const it of bot.inventory?.items?.() ?? []) {
        if (it?.name === 'torch') torches += it.count ?? 0;
        if (/_sword$/.test(it?.name ?? '')) sword = true;
      }
      const slots = bot.inventory?.slots ?? [];
      for (let i = 5; i <= 8; i++) if (slots[i]?.name && /_(helmet|chestplate|leggings|boots)$/.test(slots[i].name)) armor += 1;
    } catch {}
    return { torches, armor, sword };
  }

  _reflexDrown() {
    if (this._reflexBusy) return;
    this._reflexBusy = true;
    this.stats.reflexes += 1;
    const bot = this.bot;
    // Hold jump until the head is out of the water (up to 6 s), not for a
    // fixed 2.5 s: from the sea floor that was never enough.
    const headClear = () => {
      try {
        const p = bot.entity?.position;
        const h = p ? bot.blockAt(p.offset ? p.offset(0, 1, 0) : new Vec3(p.x, p.y + 1, p.z)) : null;
        return !h || !/water/.test(h.name ?? '');
      } catch { return true; }
    };
    const started = Date.now();
    try {
      bot.setControlState?.('jump', true);
      const tick = () => {
        if (headClear() || Date.now() - started > 6000) {
          try { bot.setControlState?.('jump', false); } catch {}
          this._reflexBusy = false;
          return;
        }
        setTimeout(tick, 200);
      };
      setTimeout(tick, 200);
      this.log?.info?.('reflex_drown', { pos: roundPos(bot.entity?.position), oxygen: bot.oxygenLevel ?? null });
    } catch (e) {
      this._reflexBusy = false;
      this.log?.debug?.('reflex_drown_failed', { msg: e.message });
    }
  }

  // ---------- internals ----------

  _emit(kind, data, { tier = 1, force = false } = {}) {
    this.stats.events += 1;
    const ev = { kind, ts: this.now(), tier, ...data };
    this._queue.push(ev);
    if (this._queue.length > 40) this._queue.shift();
    this.log?.debug?.('nerve_event', ev);
    if (tier === 0 || force) {
      // Tier 0 always interrupts: the brain must see it now.
      this.cancelCurrent(kind, data);
      return;
    }
    this._maybeInterrupt(kind, data);
  }

  _maybeInterrupt(kind, data) {
    const armed = this._armed;
    if (!armed) return;
    if (!armed.set.has(kind)) return;
    if (armed.cancel.cancelled) return;
    this.stats.interrupts += 1;
    armed.cancel.cancel(kind, data);
  }

  _nearestHostile(range) {
    const bot = this.bot;
    const me = bot.entity?.position;
    if (!me) return null;
    let best = null;
    for (const e of Object.values(bot.entities ?? {})) {
      if (!e?.position || e === bot.entity) continue;
      if (e.type === 'player' || e.type === 'object') continue;
      const name = (e.name ?? e.displayName ?? '').toString().toLowerCase().replace(/\s+/g, '');
      if (!HOSTILE.has(name)) continue;
      const d = me.distanceTo ? me.distanceTo(e.position) : dist(me, e.position);
      if (d > range) continue;
      if (!best || d < best.distance) best = { id: e.id, name, distance: Math.round(d * 10) / 10, dir: compass(me, e.position) };
    }
    return best;
  }

  _nearestPlayer(range) {
    const bot = this.bot;
    const me = bot.entity?.position;
    if (!me) return null;
    let best = null;
    for (const [name, p] of Object.entries(bot.players ?? {})) {
      if (name === this.username) continue;
      const ent = p?.entity;
      if (!ent?.position) continue;
      const d = me.distanceTo ? me.distanceTo(ent.position) : dist(me, ent.position);
      if (d > range) continue;
      if (!best || d < best.distance) best = { name, distance: Math.round(d * 10) / 10, dir: compass(me, ent.position) };
    }
    return best;
  }

  _hasFood() {
    const foods = this.bot.registry?.foodsByName ?? null;
    const items = this.bot.inventory?.items?.() ?? [];
    return items.some((it) => it?.name && (foods?.[it.name] || /^cooked_|bread|apple|steak|porkchop|carrot|potato|melon|cookie|stew/.test(it.name)));
  }
}

function roundPos(p) {
  if (!p || !Number.isFinite(p.x)) return null;
  return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
}
function dist(a, b) {
  const dx = a.x - b.x; const dy = a.y - b.y; const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
function compass(from, to) {
  const angle = Math.atan2(-(to.z - from.z), to.x - from.x) * 180 / Math.PI;
  const n = (angle + 360) % 360;
  if (n < 22.5 || n >= 337.5) return 'E';
  if (n < 67.5) return 'NE';
  if (n < 112.5) return 'N';
  if (n < 157.5) return 'NW';
  if (n < 202.5) return 'W';
  if (n < 247.5) return 'SW';
  if (n < 292.5) return 'S';
  return 'SE';
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
