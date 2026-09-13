/**
 * factionRules.js — the server's Factions numbers, read from the Massive
 * Factions config so the brain plans with the real power economy instead
 * of guessing. Rook_Vantis (2026-09-04) founded a faction and then hit
 * "You don't have enough power to claim that land": players start at 0
 * power and gain 2 per hour online, so a solo founder cannot claim for
 * ~30 minutes. That is a rule, not a bug, and the bot should know it.
 *
 * Source: <server>/mstore/factions_mconf/instance.json. When that file
 * cannot be read (the repo ships without server state, or MC_SERVER_DIR
 * points elsewhere) the numbers come from factionRules.defaults.json next
 * to this file — a copy of the tracked instance.json values — and the
 * boot log says `faction_rules_default`; `rules.source` tells which.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULTS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'factionRules.defaults.json');

export const FACTION_CREATE_COST = 100;
const CHUNK_POWER_COST = 1;

export class FactionRules {
  constructor(cfg = {}, { known = false, source = known ? 'server' : 'none' } = {}) {
    this.known = known;       // true when the numbers come from a file (server or shipped defaults)
    this.source = source;     // 'server' | 'defaults' | 'none'
    this.defaultPlayerPower = num(cfg.defaultPlayerPower, 0);
    this.powerPerHour = num(cfg.powerPerHour, 2);
    this.powerMax = num(cfg.powerMax, 10);
    this.powerPerDeath = num(cfg.powerPerDeath, -2);
    this.claimsMustBeConnected = cfg.claimsMustBeConnected !== false;
    this.homesMustBeInClaimedTerritory = cfg.homesMustBeInClaimedTerritory !== false;
    this.factionMemberLimit = num(cfg.factionMemberLimit, 0);
    this.createCost = FACTION_CREATE_COST;
  }

  /** Minutes a fresh player must be online before one chunk is affordable. */
  minutesToFirstClaim() {
    const need = CHUNK_POWER_COST - this.defaultPlayerPower;
    if (need <= 0) return 0;
    if (this.powerPerHour <= 0) return Infinity;
    return Math.ceil((need / this.powerPerHour) * 60);
  }

  /** Minutes until `power` reaches `target` at the regen rate. */
  minutesUntil(power, target = CHUNK_POWER_COST) {
    if (power >= target) return 0;
    if (this.powerPerHour <= 0) return Infinity;
    return Math.ceil(((target - power) / this.powerPerHour) * 60);
  }

  /** One paragraph for the system prompt. */
  summary() {
    const first = this.minutesToFirstClaim();
    const parts = [
      `Founding a faction costs $${this.createCost}.`,
      `Each chunk claim costs ${CHUNK_POWER_COST} faction power.`,
      `Players start at ${fmt(this.defaultPlayerPower)} power and gain ${fmt(this.powerPerHour)} per hour while online (max ${fmt(this.powerMax)}); dying costs ${fmt(Math.abs(this.powerPerDeath))}.`,
      'Faction power is the sum of its members\' power, so every recruit adds theirs',
    ];
    if (Number.isFinite(first) && first > 0) parts[3] += `, and a solo founder can claim the first chunk about ${first} min after first login`;
    parts[3] += '.';
    if (this.claimsMustBeConnected) parts.push('Claims must touch each other.');
    if (this.homesMustBeInClaimedTerritory) parts.push('f sethome only works inside your claim.');
    if (this.factionMemberLimit > 0) parts.push(`Factions hold at most ${this.factionMemberLimit} members.`);
    return parts.join(' ');
  }

  /** Short hint for a failed claim. */
  claimHint() {
    const first = this.minutesToFirstClaim();
    const wait = Number.isFinite(first) && first > 0 ? ` (a fresh player needs ~${first} min online for the first chunk)` : '';
    return `each chunk costs ${CHUNK_POWER_COST} power; you gain ${fmt(this.powerPerHour)}/hour online, lose ${fmt(Math.abs(this.powerPerDeath))} per death, and members' power adds up${wait}. Recruit (f invite) or wait, and check board for your faction's power${this.claimsMustBeConnected ? '; later claims must touch the first' : ''}`;
  }
}

export function loadFactionRules({ serverDir, file, log, defaultsFile = DEFAULTS_FILE } = {}) {
  const p = file ?? (serverDir ? path.join(serverDir, 'mstore', 'factions_mconf', 'instance.json') : null);
  if (p) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      const rules = new FactionRules(cfg, { known: true, source: 'server' });
      log?.info?.('faction_rules_loaded', { file: p, powerPerHour: rules.powerPerHour, powerMax: rules.powerMax, defaultPlayerPower: rules.defaultPlayerPower });
      return rules;
    } catch (e) {
      log?.info?.('faction_rules_unavailable', { file: p, msg: e.message });
    }
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(defaultsFile, 'utf8'));
    const rules = new FactionRules(cfg, { known: true, source: 'defaults' });
    log?.info?.('faction_rules_default', { file: defaultsFile, powerPerHour: rules.powerPerHour, powerMax: rules.powerMax, defaultPlayerPower: rules.defaultPlayerPower });
    return rules;
  } catch (e) {
    log?.warn?.('faction_rules_defaults_unreadable', { file: defaultsFile, msg: e.message });
    return new FactionRules({});
  }
}

function num(v, d) { return Number.isFinite(v) ? v : d; }
function fmt(n) { return Number.isInteger(n) ? String(n) : n.toFixed(1); }
