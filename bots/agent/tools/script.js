/**
 * script.js — run_script, save_skill, skills, use_skill (Phase 4).
 *
 * The model writes JavaScript over its own tools for jobs no single tool
 * covers (sort a chest, plant a cactus row, torch a tunnel, fence a
 * perimeter). run_script tests it; save_skill keeps what worked for every
 * bot; skills is the search over the shared library so the tool schema
 * list stays small; use_skill runs a saved one with params.
 */

import { runScript, SCRIPT_DEFAULT_TIMEOUT_MS, SCRIPT_MAX_TIMEOUT_MS, SKILL_NAME_RE } from '../skills.js';
import { INTERRUPT_SCHEMA } from './move.js';
import { ok, fail } from './result.js';

const hashCode = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
const normalize = (code) => String(code ?? '').replace(/\r\n/g, '\n').trim();

export function scriptTools(deps) {
  const { log, state, profile, skillStore } = deps;
  // The registry is created after these tools exist; it is handed in later.
  let registry = null;
  const setRegistry = (r) => { registry = r; };

  const runScriptTool = {
    name: 'run_script',
    description: `Run JavaScript you write, in an isolated sandbox (no files, no network, no server commands, no paying) whose globals are your own tools (await tools.mine({block:'log',count:8}), tools.goto, tools.dig, tools.place, tools.craft, tools.withdraw, tools.store, tools.farm, …), me.* and world.* queries, sleep(ms), log(...) and cancelled(). See the Scripts section of your instructions for the API and the rules. For repetitive or multi-step jobs no single tool does: sort a chest, plant a cactus row, torch a tunnel every 8 blocks, fence a perimeter. Returns what the script returned plus its log and the tool calls it made. Stops at timeout_s (default ${SCRIPT_DEFAULT_TIMEOUT_MS / 1000}, max ${SCRIPT_MAX_TIMEOUT_MS / 1000}) and on interrupts. When it worked, save_skill it.`,
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', maxLength: 12000, description: 'the body of an async function; use await on every tools.* call and sleep; return a summary object' },
        timeout_s: { type: 'integer', minimum: 5, maximum: SCRIPT_MAX_TIMEOUT_MS / 1000, default: SCRIPT_DEFAULT_TIMEOUT_MS / 1000 },
        interrupt_on: INTERRUPT_SCHEMA,
      },
      required: ['code'], additionalProperties: false,
    },
    defaultInterrupts: ['damage'],
    async handler({ code, timeout_s }, { cancel }) {
      if (!registry) return fail('not_ready');
      const src = normalize(code);
      const r = await runScript({ code: src, tools: registry, deps, cancel, log, timeoutMs: Math.min(SCRIPT_MAX_TIMEOUT_MS, (timeout_s ?? SCRIPT_DEFAULT_TIMEOUT_MS / 1000) * 1000) });
      if (state) state.lastScript = { hash: hashCode(src), status: r.status, at: Date.now() };
      log?.info?.('agent_script', { status: r.status, reason: r.reason ?? null, calls: r.n_tool_calls, elapsed_s: r.elapsed_s, bytes: src.length });
      if (r.status === 'ok' && !r.hint) r.hint = 'worked: save_skill it with a short name, a one-line description and this exact code if you will want it again';
      return r;
    },
  };

  const saveSkill = {
    name: 'save_skill',
    description: 'Save a script that worked as a named skill for every bot on this server (data/skills). Give the exact code you ran with run_script so it is marked verified. params documents the params object use_skill will pass (e.g. "{chest:{x,y,z}, keep:[item names]}"). Saving an existing name makes a new version.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', pattern: SKILL_NAME_RE.source, description: 'snake_case, 3-32 chars' },
        description: { type: 'string', maxLength: 300 },
        code: { type: 'string', maxLength: 12000 },
        params: { type: 'string', maxLength: 300, description: 'what params the skill reads, in one line' },
      },
      required: ['name', 'description', 'code'], additionalProperties: false,
    },
    parallelSafe: true,
    async handler({ name, description, code, params }) {
      if (!skillStore) return fail('no_skill_store');
      if (!SKILL_NAME_RE.test(name ?? '')) return fail('bad_name', { hint: 'lowercase letters, digits and underscores, 3-32 chars, starting with a letter' });
      const src = normalize(code);
      const verified = !!(state?.lastScript && state.lastScript.status === 'ok' && state.lastScript.hash === hashCode(src));
      const r = skillStore.save({ name, description, code: src, params, author: profile?.username ?? null, verified });
      if (!r.ok) return fail(r.reason, { error: r.error, line: r.line, hint: r.hint });
      return ok({
        saved: name, version: r.meta.version, verified,
        hint: verified ? `use_skill ${name} runs it; other bots see it in skills` : 'saved unverified: it was not the exact code of a successful run_script. Test it with use_skill soon',
      });
    },
  };

  const skills = {
    name: 'skills',
    description: 'List or search the saved skills every bot shares, with how often each worked (ok/failed) and who wrote it. Run one with use_skill. Prefer proven ones; read the code with show=true before trusting a stranger\'s.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 80, description: 'words to match in the name or description; empty lists everything' },
        show: { type: 'string', maxLength: 32, description: 'a skill name whose code you want to read' },
      },
      additionalProperties: false,
    },
    parallelSafe: true,
    async handler({ query, show }) {
      if (!skillStore) return fail('no_skill_store');
      if (show) {
        const s = skillStore.get(show);
        if (!s) return fail('unknown_skill', { name: show });
        return ok({ name: s.name, description: s.description, params: s.params, author: s.author, version: s.version, uses: s.uses, ok: s.ok, failed: s.failed, disabled: s.disabled ? s.disabled_reason ?? true : undefined, code: s.code.slice(0, 6000) });
      }
      const list = skillStore.search(query).slice(0, 20).map((m) => ({
        name: m.name, description: m.description, params: m.params ?? undefined, author: m.author,
        uses: m.uses, ok: m.ok, failed: m.failed, verified: m.verified || undefined, last_status: m.last_status ?? undefined,
        disabled: m.disabled ? m.disabled_reason ?? true : undefined,
      }));
      return ok({ count: list.length, skills: list, hint: list.length ? 'use_skill <name> {params} runs one' : 'no skills saved yet: write one with run_script, then save_skill' });
    },
  };

  const useSkill = {
    name: 'use_skill',
    description: 'Run a saved skill by name with a params object (see its params line in skills). Same sandbox, timeout and interrupts as run_script; the outcome is tallied on the skill.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 32 },
        params: { type: 'object', additionalProperties: true },
        timeout_s: { type: 'integer', minimum: 5, maximum: SCRIPT_MAX_TIMEOUT_MS / 1000, default: SCRIPT_DEFAULT_TIMEOUT_MS / 1000 },
        interrupt_on: INTERRUPT_SCHEMA,
      },
      required: ['name'], additionalProperties: false,
    },
    defaultInterrupts: ['damage'],
    async handler({ name, params = {}, timeout_s }, { cancel }) {
      if (!registry) return fail('not_ready');
      if (!skillStore) return fail('no_skill_store');
      const s = skillStore.get(name);
      if (!s) return fail('unknown_skill', { name, hint: 'skills lists what exists' });
      if (s.disabled) return fail('skill_disabled', { name, why: s.disabled_reason, hint: 'this skill was quarantined after repeated failures: read it (skills show), fix it, and save_skill a new version to re-enable it' });
      const r = await runScript({ code: s.code, params, tools: registry, deps, cancel, log, timeoutMs: Math.min(SCRIPT_MAX_TIMEOUT_MS, (timeout_s ?? SCRIPT_DEFAULT_TIMEOUT_MS / 1000) * 1000), name });
      skillStore.recordUse(name, r.status);
      log?.info?.('agent_skill_used', { name, status: r.status, reason: r.reason ?? null, calls: r.n_tool_calls, elapsed_s: r.elapsed_s });
      return { ...r, skill: name, version: s.version };
    },
  };

  const list = [runScriptTool, saveSkill, skills, useSkill];
  list.setRegistry = setRegistry;
  return list;
}
