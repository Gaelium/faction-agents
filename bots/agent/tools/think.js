/**
 * think.js — the strategist. One slow turn on a strong model over the
 * bot's own notes, the board, and a question; returns a memo into the
 * fast loop's context. It never touches actuators: two speeds of
 * thinking, one pair of hands.
 */

import fs from 'node:fs';
import { boardTools } from './board.js';
import { readJournal } from './mind.js';
import { ok, fail } from './result.js';

const MAX_NOTES_CHARS = 6000;

function strategistSystem(profile) {
  return `You are the strategic mind of ${profile.username}, a ${profile.archetype} on a Minecraft 1.8 factions server (Massive Factions, EssentialsX economy, mcMMO). Ambition ${Math.round((profile.ambition ?? 0.5) * 10)}/10. Values: ${Object.entries(profile.values ?? {}).map(([k, v]) => `${k} ${Math.round(v * 10)}/10`).join(', ') || 'unspecified'}.

You are given the player's notes, the current board, and a question. Write a memo of at most 250 words: (1) one-paragraph assessment of the situation, (2) the single best objective for the next 30-60 minutes, (3) three to five concrete steps naming the tools to use (goto, mine, build, sell, pay, f, board, faction_notes, attack, store, smelt_start…), (4) the risks to avoid. Be decisive and specific; coordinates and names, not generalities.

Server facts: founding a faction costs $100 and needs the money up front; there is no shop, so money comes only from /sell hand (crops, cobble surplus, ore surplus) and from other players paying you; a faction is raidable when its land exceeds its power; power drops on death; alliances need both sides; claims protect blocks. Dying loses the inventory. The player's notes are their own words and may be wrong; the board is ground truth.`;
}

export function thinkTools(deps) {
  const { profile, state, memoryStore, strategist, log } = deps;
  const [board] = boardTools(deps);

  const think = {
    name: 'think',
    description: 'Consult your strategic mind: a slower, deeper pass over your notes, the board, and a question. Use before big decisions (found or join a faction, spend money, start a raid, pick the next multi-hour project) or when you feel stuck. Returns a memo. Costs nothing in-game; do not call it every turn.',
    input_schema: {
      type: 'object',
      properties: { question: { type: 'string', maxLength: 400, description: 'what you are trying to decide' } },
      required: ['question'], additionalProperties: false,
    },
    parallelSafe: true,
    async handler({ question }) {
      if (!strategist?.turn) return fail('no_strategist', { hint: 'strategist model not configured' });
      const sections = [];
      if (state?.focus) sections.push(`## Focus card\n${state.focus}`);
      let notes = '';
      for (const f of memoryStore?.list?.() ?? []) {
        if (/journal\.md$/.test(f.path)) continue;
        try {
          const text = fs.readFileSync(memoryStore.resolve(f.path), 'utf8');
          notes += `\n### ${f.path}\n${text}\n`;
        } catch {}
        if (notes.length > MAX_NOTES_CHARS) { notes = notes.slice(0, MAX_NOTES_CHARS) + '\n…(truncated)'; break; }
      }
      if (notes) sections.push(`## Notes${notes}`);
      const journal = readJournal(profile.username, 8);
      if (journal.length) sections.push(`## Journal (latest last)\n${journal.join('\n')}`);
      let boardText = null;
      try { const b = await board.handler({}); boardText = JSON.stringify(b, null, 0); } catch (e) { boardText = `unavailable: ${e.message}`; }
      sections.push(`## Board\n${boardText}`);
      if (state?.home) sections.push(`## Home\n${JSON.stringify({ x: state.home.x, y: state.home.y, z: state.home.z, chest: state.home.chest })}`);
      sections.push(`## Question\n${String(question).trim()}`);
      const user = sections.join('\n\n');
      let memo;
      try {
        const { response, usd } = await strategist.turn({ system: strategistSystem(profile), tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: user }] }] });
        memo = (response.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (state) state.lastThinkAt = Date.now();
        log?.info?.('agent_think', { question: String(question).slice(0, 120), usd, memo_chars: memo.length });
      } catch (e) {
        return fail('strategist_error', { msg: e.message });
      }
      if (!memo) return fail('empty_memo');
      return ok({ memo });
    },
  };

  return [think];
}
