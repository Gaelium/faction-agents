/**
 * board.js — perception of the meta-game. `board()` composes the BotBridge
 * queries (balance, baltop, factions, online players, claims around you)
 * into one ≤400-token picture: exactly what a human learns from /balance,
 * /baltop, /f list, /f map and the tab list. Falls back to parsing chat
 * for balance when the bridge is not answering, and says what it could
 * not see rather than guessing.
 */

import { parseEconomyMessage } from '../../social/economyChat.js';
import { ok, fail, roundPos } from './result.js';

const QUERY_TIMEOUT_MS = 4000;

function stripColors(s) { return String(s ?? '').replace(/§./g, '').trim(); }

/** Run a slash command and collect replies for `waitMs` (or until `until` matches). */
export function captureReplies(bot, cmd, { waitMs = 2500, until = null } = {}) {
  return new Promise((resolve) => {
    const replies = [];
    let timer = null;
    const done = () => { try { bot.removeListener('messagestr', onMsg); } catch {} clearTimeout(timer); resolve(replies); };
    const onMsg = (m) => {
      const s = stripColors(m);
      if (!s) return;
      replies.push(s.slice(0, 200));
      if (until && until.test(s)) setTimeout(done, 150);
    };
    bot.on('messagestr', onMsg);
    try { bot.chat(cmd.startsWith('/') ? cmd : `/${cmd}`); }
    catch (e) { replies.push(`chat_failed:${e.message}`); return done(); }
    timer = setTimeout(done, waitMs);
  });
}

/** Balance via the bridge, else via a parsed /balance reply, else null. */
export async function readBalance({ bot, bus, factions, profile, log }) {
  if (bus?.query) {
    try {
      const r = await bus.query('query_balance', { bot: profile.username }, { timeoutMs: QUERY_TIMEOUT_MS });
      if (r && r.type !== 'error' && Number.isFinite(Number(r.balance))) {
        const b = Number(r.balance);
        try { factions?.setBalance?.(b); } catch {}
        return b;
      }
    } catch (e) { log?.debug?.('balance_query_failed', { msg: e.message }); }
  }
  const replies = await captureReplies(bot, '/balance', { waitMs: 2000, until: /\$|balance/i });
  for (const r of replies) {
    const p = parseEconomyMessage(r, { username: profile.username });
    if (p?.kind === 'balance') { try { factions?.setBalance?.(p.amount); } catch {} return p.amount; }
  }
  return null;
}

export function boardTools(deps) {
  const { bot, bus, factions, profile, log, state } = deps;
  const me = profile.username;

  const q = async (type, payload = {}) => {
    if (!bus?.query) return { error: 'no_bridge' };
    try {
      const r = await bus.query(type, { bot: me, ...payload }, { timeoutMs: QUERY_TIMEOUT_MS });
      if (!r || r.type === 'error') return { error: r?.error ?? 'empty' };
      return r;
    } catch (e) { return { error: e.message }; }
  };

  const board = {
    name: 'board',
    description: 'The server board: your balance, your baltop rank and the top players, every faction with power, land, members online, its relation to you and whether it is raidable (more land than power), who is online and where, and land claims around you. What a player learns from /balance, /baltop, /f list, /f map and the tab list. Check it before money or faction decisions; it costs nothing in-game.',
    input_schema: {
      type: 'object',
      properties: {
        claims_radius: { type: 'integer', minimum: 1, maximum: 8, default: 4, description: 'chunks around you to scan for claims' },
        top: { type: 'integer', minimum: 3, maximum: 20, default: 8 },
      },
      additionalProperties: false,
    },
    parallelSafe: true,
    async handler({ claims_radius = 4, top = 8 } = {}) {
      const [bal, baltop, facs, online, claims] = await Promise.all([
        q('query_balance'), q('query_baltop', { limit: top }), q('query_factions'), q('query_online'), q('query_claims', { radius: claims_radius }),
      ]);
      const out = {};
      const unavailable = [];
      if (!bal.error && Number.isFinite(Number(bal.balance))) {
        out.balance = Math.round(Number(bal.balance) * 100) / 100;
        try { factions?.setBalance?.(out.balance); } catch {}
      } else {
        const b = await readBalance(deps);
        if (b != null) out.balance = b; else unavailable.push('balance');
      }
      if (!baltop.error) {
        out.baltop = {
          my_rank: baltop.my_rank > 0 ? baltop.my_rank : null,
          players: baltop.players,
          top: (baltop.top ?? []).map((r) => `${r.name} $${r.balance}`),
        };
      } else unavailable.push('baltop');
      if (!facs.error) {
        out.my_faction = facs.my_faction ?? null;
        if (factions && facs.my_faction && factions.state && factions.state.ourFaction !== facs.my_faction) {
          factions.state.ourFaction = facs.my_faction;
          try { factions._persist?.(); } catch {}
        }
        out.factions = (facs.factions ?? []).slice(0, 12).map((f) => {
          const row = { name: f.name, power: `${f.power}/${f.power_max}`, land: f.land, members: f.members, online: f.online };
          if (f.leader) row.leader = f.leader;
          if (f.relation) row.relation = f.relation;
          if (f.raidable) row.raidable = true;
          return row;
        });
        if (!out.factions.length) out.factions_note = 'no player factions exist yet';
      } else unavailable.push('factions');
      if (!online.error) {
        out.online = (online.players ?? []).filter((p) => p.name !== me)
          .map((p) => `${p.name}${p.faction ? ` [${p.faction}]` : ''}${p.x != null ? ` @${p.x},${p.z}` : ''}`);
      } else unavailable.push('online');
      if (!claims.error) {
        const byFaction = {};
        const me3 = roundPos(bot.entity?.position);
        let nearest = null;
        for (const c of claims.claims ?? []) {
          byFaction[c.faction] = (byFaction[c.faction] ?? 0) + 1;
          if (me3) {
            const d = Math.hypot(c.chunk_x * 16 + 8 - me3.x, c.chunk_z * 16 + 8 - me3.z);
            if (!nearest || d < nearest.distance) nearest = { faction: c.faction, distance: Math.round(d), chunk: [c.chunk_x, c.chunk_z] };
          }
        }
        out.claims_nearby = { radius_chunks: claims.radius, by_faction: byFaction, nearest: nearest ?? undefined };
        if (!Object.keys(byFaction).length) out.claims_nearby.note = 'no claims within range; this land is wilderness';
      } else unavailable.push('claims');
      if (unavailable.length === 5) {
        return fail('bridge_unavailable', { hint: 'BotBridge is not answering (server plugin not updated or Redis down); use the command tool: baltop, f list, f map, balance' });
      }
      if (unavailable.length) out.unavailable = unavailable;
      if (state) state.lastBoardAt = Date.now();
      log?.info?.('agent_board', { balance: out.balance ?? null, rank: out.baltop?.my_rank ?? null, factions: out.factions?.length ?? null, unavailable });
      return ok(out);
    },
  };

  return [board];
}
