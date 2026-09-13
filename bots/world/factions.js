/**
 * Faction state for one bot.
 *
 *   new Factions({ profile, memory, bus, log })
 *   factions.state              — { ourFaction, foundedAt, allies, enemies, memberships, balance }
 *   factions.getBalance() / setBalance(n)
 *   factions._wireBus(bus)      — keep state in step with BotBridge events
 *   factions._persist()         — write state to the bot's SQLite KV
 *
 * The agent loop issues every /f command itself (agent/tools/faction.js)
 * and mutates `state` directly; this class only keeps that state
 * persistent (through `memory.kvGet/Set`, so a restart resumes correctly)
 * and follows the server's `economy_transaction` and `faction_event`
 * bus traffic. The old stack's auto-found/auto-join timers, invite
 * scraping, ally/enemy chat flows and loyalty loop were deleted on
 * 2026-09-12 with the rest of the planner/executor runtime.
 *
 * Faction commands map to **Massive Factions 2.8.5** syntax (not
 * FactionsUUID): `/f create <name>`, `/f invite <player>`, `/f join
 * <faction>`, `/f ally <faction>`, `/f enemy <faction>`, `/f home`,
 * `/f claim`. Massive Factions requires BOTH sides to declare ally for
 * the alliance to take effect.
 */

const STATE_KEY = 'faction_state';
const DEFAULT_STATE = Object.freeze({
  ourFaction: null,        // string | null
  foundedAt: null,         // ms
  allies: [],              // [{ faction, target_player, declared_at }]
  enemies: [],             // same shape
  memberships: {},         // { player_name: faction_name } — cache of "who's in what"
  balance: 0,              // running tally of `economy_transaction` events
                           // that involve us, corrected by every parsed
                           // /balance reply and board query (setBalance).
});

export class Factions {
  constructor({ profile, memory, bus = null, log = null }) {
    if (!profile) throw new Error('Factions requires profile');
    if (!memory)  throw new Error('Factions requires memory');
    this.profile = profile;
    this.memory = memory;
    this.bus = bus;
    this.log = log;
    this.state = { ...DEFAULT_STATE, ...(memory.kvGet(STATE_KEY, {}) ?? {}) };
  }

  /** Nothing to stop: the periodic timers went with the old stack. */
  shutdown() {}

  /** Current money estimate (running tally, corrected by /balance polls). */
  getBalance() { return Number(this.state.balance ?? 0); }

  /**
   * Ground-truth balance from a parsed `/balance` reply (economyChat) or a
   * board query. This OVERRIDES the running tally, which only sees observed
   * /pay /eco /sell events and drifts (misses admin grants, starting
   * balance, etc.).
   */
  setBalance(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return;
    this.state.balance = v;
    this._persist();
    this.log?.info?.('balance_set_from_query', { balance: v });
  }

  // ---------- membership cache ----------

  noteMembership(player, faction) {
    if (!player || !faction) return;
    if (this.state.memberships[player] === faction) return;
    this.state.memberships[player] = faction;
    this._persist();
  }

  // ---------- wiring ----------

  _wireBus(bus) {
    const me = this.profile.username;

    // Track the running balance from /pay and /eco events. BotBridge
    // encodes /pay as { player: <sender>, amount: -X, reason: 'pay:<recipient>' }
    // and /eco as { player: <recipient>, amount: ±X, reason: 'admin:<op>' }.
    bus.on('economy_transaction', (e) => {
      const amount = Number(e?.amount ?? 0);
      if (!Number.isFinite(amount) || amount === 0) return;
      const reason = e?.reason ?? '';
      let delta = 0;
      if (reason.startsWith('pay:')) {
        const recipient = reason.slice(4);
        if (e.player === me) delta = amount;             // we paid (negative)
        else if (recipient === me) delta = -amount;      // someone paid us; flip sign
      } else if (reason.startsWith('admin:')) {
        if (e.player === me) delta = amount;             // /eco give/take on us
      } else if (reason.startsWith('sell:')) {
        // economyChat parses our own `/sell hand` echo into a local event
        // with player=me and a POSITIVE amount. Shop income.
        if (e.player === me) delta = amount;
      }
      if (delta === 0) return;
      this.state.balance = Number((this.state.balance ?? 0) + delta);
      this._persist();
      this.log?.debug?.('balance_updated', {
        delta, balance: this.state.balance, reason,
      });
    });

    bus.on('faction_event', (e) => {
      // Someone else changed our relationships — update cache.
      if (e.type === 'ally' && e.faction && e.other_faction) {
        if (e.faction === this.state.ourFaction || e.other_faction === this.state.ourFaction) {
          const other =
            e.faction === this.state.ourFaction ? e.other_faction : e.faction;
          if (!this.state.allies.some((a) => a.faction === other)) {
            this.state.allies.push({ faction: other, target_player: null, declared_at: Date.now() });
            this._persist();
            this.log?.info('faction_ally_observed', { faction: other });
          }
        }
      }
      if (e.type === 'enemy' && e.faction && e.other_faction) {
        if (e.faction === this.state.ourFaction || e.other_faction === this.state.ourFaction) {
          const other = e.faction === this.state.ourFaction ? e.other_faction : e.faction;
          if (!this.state.enemies.some((x) => x.faction === other)) {
            this.state.enemies.push({ faction: other, target_player: null, declared_at: Date.now() });
            this._persist();
          }
        }
      }
      if (e.type === 'create' && e.actor && e.faction) {
        this.noteMembership(e.actor, e.faction);
        // Confirm our own create: flip state only when the server
        // echoes back (the f tool also does this from the chat reply).
        if (e.actor === this.profile.username && !this.state.ourFaction) {
          this.state.ourFaction = e.faction;
          this.state.foundedAt = Date.now();
          this._persist();
          this.log?.info('faction_create_confirmed', { faction: e.faction });
        }
      }
    });
  }

  _persist() {
    this.memory.kvSet(STATE_KEY, this.state);
  }
}
