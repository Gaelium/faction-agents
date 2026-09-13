/**
 * mind.js — focus, note, wait, logoff. The bot's own bookkeeping.
 *
 *   focus   the ~200-token card the harness re-shows after context
 *           clearing and at every login: what I'm doing, why, next steps
 *   note    a line in data/memory/<bot>/journal.md (survives sessions)
 *   wait    deliberate idling with a clear interrupt policy
 *   logoff  end the session (writes a journal line)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cancellableSleep } from '../cancel.js';
import { INTERRUPT_SCHEMA } from './move.js';
import { ok, fail, interrupted } from './result.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
export const MEMORY_DIR = path.join(PROJECT_ROOT, 'data', 'memory');

export function journalPath(username) {
  const dir = path.join(MEMORY_DIR, username);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'journal.md');
}

export function appendJournal(username, text) {
  const line = `- ${new Date().toISOString().slice(0, 16).replace('T', ' ')} ${String(text).replace(/\s+/g, ' ').trim()}\n`;
  fs.appendFileSync(journalPath(username), line);
  return line;
}

export function readJournal(username, lines = 12) {
  try {
    const all = fs.readFileSync(journalPath(username), 'utf8').split('\n').filter(Boolean);
    return all.slice(-lines);
  } catch { return []; }
}

export function mindTools(deps) {
  const { state, profile, log } = deps;

  const focus = {
    name: 'focus',
    description: 'Set your focus card: what you are doing, why, the next 2-3 steps, and anything blocking you. Keep it under ~60 words. The harness shows it back to you after long stretches, after context trimming, and at your next login, so it is how you hold a plan across sessions.',
    input_schema: { type: 'object', properties: { text: { type: 'string', maxLength: 600 } }, required: ['text'], additionalProperties: false },
    parallelSafe: true,
    async handler({ text }) {
      const t = String(text ?? '').trim();
      if (!t) return fail('empty');
      state.focus = t.slice(0, 600);
      state.focusSetAt = Date.now();
      // Survives relogs: shown again in the next login bootstrap.
      try { deps.memory?.kvSet?.('agent_focus', { text: state.focus, ts: state.focusSetAt }); } catch {}
      return ok({ focus: state.focus });
    },
  };

  const note = {
    name: 'note',
    description: 'Append one dated line to /memories/journal.md; the last dozen lines are shown at login. Use for events worth keeping: who paid you, who killed you, what you finished. For structured facts you will edit later (plans, places, people) use the memory tool on its own files.',
    input_schema: { type: 'object', properties: { text: { type: 'string', maxLength: 300 } }, required: ['text'], additionalProperties: false },
    parallelSafe: true,
    async handler({ text }) {
      const t = String(text ?? '').trim();
      if (!t) return fail('empty');
      try { appendJournal(profile.username, t); } catch (e) { return fail('write_failed', { msg: e.message }); }
      return ok({ noted: t.slice(0, 300) });
    },
  };

  const wait = {
    name: 'wait',
    description: 'Deliberately idle for `seconds` while waiting for one specific thing (a smelt job, a player who said they are coming, crops). Not for passing the night: idle time earns nothing; mine underground with torches, smelt, craft, farm by torchlight, sell or plan instead. Interrupts pull you out early; default is any damage or chat mention.',
    input_schema: {
      type: 'object',
      properties: { seconds: { type: 'integer', minimum: 5, maximum: 600, default: 30 }, interrupt_on: INTERRUPT_SCHEMA },
      required: ['seconds'], additionalProperties: false,
    },
    defaultInterrupts: ['damage', 'chat_mention', 'whisper'],
    async handler({ seconds = 30 }, { cancel }) {
      const start = Date.now();
      const finished = await cancellableSleep(seconds * 1000, cancel);
      const elapsed = Math.round((Date.now() - start) / 1000);
      if (!finished) return interrupted(cancel, { waited_s: elapsed });
      return ok({ waited_s: elapsed, hint: seconds >= 60 ? 'that was idle time; if nothing specific is pending, work: mine underground with torches, smelt_start, craft, farm, store, sell, faction_notes, think' : undefined });
    },
  };

  const logoff = {
    name: 'logoff',
    description: 'End your play session (as a player would: gtg, dinner, bed). Writes a journal line. The session ends after this call.',
    input_schema: { type: 'object', properties: { reason: { type: 'string', maxLength: 200 } }, additionalProperties: false },
    parallelSafe: false,
    async handler({ reason }) {
      const why = String(reason ?? 'done for now').trim();
      try { appendJournal(profile.username, `logged off: ${why}${state.focus ? ` | focus: ${state.focus}` : ''}`); } catch {}
      state.stop = `logoff: ${why}`;
      log?.info?.('agent_logoff', { reason: why });
      return ok({ logged_off: true, reason: why });
    },
  };

  return [focus, note, wait, logoff];
}
