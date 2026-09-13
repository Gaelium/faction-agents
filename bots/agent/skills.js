/**
 * skills.js — Phase 4, "hands that grow".
 *
 * runScript() executes JavaScript the model wrote inside a node:vm context
 * whose globals are the bot's own tools (same handlers, same cancel token,
 * same honest results), a few read-only world/self queries, sleep and log.
 * SkillStore keeps scripts that worked under data/skills/ for every bot on
 * the server, with a use/success tally so bots prefer proven ones. Humans
 * review the directory; that is the safety net the plan calls for.
 *
 * Isolation (see scriptWorker.js for the details): scripts run in a worker
 * thread with an empty environment and memory limits, inside a vm context
 * with a null-prototype global and code generation off; every value that
 * crosses the boundary is a JSON string. The host side here maps tool calls
 * onto the bot's real handlers under a deny list and per-script caps, and
 * terminates the worker when a script does not stop on request.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { countInventory } from '../world/primitives.js';
import { CancelToken } from './cancel.js';
import { validateInput } from './tools/index.js';
import { roundPos, distance, toVec3 } from './tools/result.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const SKILLS_DIR = path.join(PROJECT_ROOT, 'data', 'skills');

/** Tools a script may not call: recursion, the mind, and session control. */
export const SCRIPT_BLOCKED = new Set(['run_script', 'use_skill', 'save_skill', 'skills', 'memory', 'logoff', 'think', 'focus']);
export const SCRIPT_DEFAULT_TIMEOUT_MS = 60_000;
export const SCRIPT_MAX_TIMEOUT_MS = 300_000;
const SYNC_BUDGET_MS = 5_000;      // a synchronous stretch longer than this is a runaway loop
const STDOUT_MAX_LINES = 60;
const CALLS_MAX = 40;
export const QUARANTINE_AFTER = 3;
export const SKILL_NAME_RE = /^[a-z][a-z0-9_]{2,31}$/;

export class ScriptInterrupted extends Error {
  constructor(reason, detail = null) { super(`interrupted: ${reason}`); this.name = 'ScriptInterrupted'; this.reason = reason; this.detail = detail; }
}

function dayPhase(bot) {
  const t = bot?.time?.timeOfDay ?? 0;
  if (t < 12000) return 'day';
  if (t < 13800) return 'dusk';
  if (t < 22300) return 'night';
  return 'dawn';
}

function errorLine(err, wrapperOffset = 1) {
  const m = /(?:run_script|skill_\w+)\.js:(\d+)/.exec(err?.stack ?? '');
  return m ? Math.max(1, Number(m[1]) - wrapperOffset) : null;
}

/** The read-only world/self API given to scripts. */
export function makeScriptApi({ bot }) {
  const registry = bot.registry;
  const me = {
    pos: () => roundPos(bot.entity?.position),
    inventory: () => countInventory(bot),
    health: () => bot.health ?? null,
    food: () => bot.food ?? null,
    holding: () => bot.heldItem?.name ?? null,
    time: () => dayPhase(bot),
  };
  const world = {
    blockAt(x, y, z) {
      try {
        const b = bot.blockAt(toVec3({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }));
        return b ? { name: b.name, metadata: b.metadata ?? 0, x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) } : null;
      } catch { return null; }
    },
    isSolid(x, y, z) {
      const b = world.blockAt(x, y, z);
      if (!b) return false;
      try { const raw = bot.blockAt(toVec3(b)); return raw?.boundingBox === 'block'; } catch { return false; }
    },
    findBlocks(names, radius = 32, max = 64) {
      const list = Array.isArray(names) ? names : [names];
      const ids = [];
      for (const n of list) {
        const b = registry?.blocksByName?.[n];
        if (!b) throw new Error(`unknown block: ${n}`);
        ids.push(b.id);
      }
      const me0 = bot.entity?.position;
      if (!me0 || typeof bot.findBlocks !== 'function') return [];
      let found = [];
      try { found = bot.findBlocks({ matching: ids, maxDistance: Math.min(64, Math.max(1, radius)), count: Math.min(256, Math.max(1, max)) }) ?? []; } catch { return []; }
      return found
        .map((p) => { let name = null; try { name = bot.blockAt(toVec3(p))?.name ?? null; } catch {} return { x: p.x, y: p.y, z: p.z, name, distance: Math.round(distance(me0, p) * 10) / 10 }; })
        .sort((a, b) => a.distance - b.distance);
    },
    entities(radius = 16) {
      const me0 = bot.entity?.position;
      if (!me0) return [];
      const out = [];
      for (const e of Object.values(bot.entities ?? {})) {
        if (!e?.position || e === bot.entity) continue;
        const d = distance(me0, e.position);
        if (d == null || d > radius) continue;
        out.push({ name: e.username ?? e.name ?? e.displayName ?? 'entity', type: e.type ?? 'unknown', x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z), distance: Math.round(d * 10) / 10 });
      }
      return out.sort((a, b) => a.distance - b.distance);
    },
    players(radius = 32) { return world.entities(radius).filter((e) => e.type === 'player'); },
  };
  return { me, world };
}

// ---------- policy: what a script may do inside the game ----------

/** Per-script caps on tools that spend money, speak, or write shared state. */
export const SCRIPT_CAPS = Object.freeze({ sell: 3, say: 5, faction_notes: 2, note: 3, f: 6, teleport: 3, attack: 40 });

/**
 * Deny rules for tool calls made from scripts. Scripts have the bot's
 * authority in the world but not its judgement: deliberate, irreversible
 * or money-moving acts stay with the brain.
 */
export function scriptDeny(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (name === 'command') return 'scripts may not run raw server commands; call the specific tool instead';
  if (name === 'pay') return 'scripts may not pay other players; do that yourself, deliberately';
  if (name === 'dig' && i.force) return 'scripts may not dig with force: your own walls, chests and furnaces stay';
  if (name === 'unstick' && i.force) return 'scripts may not dig own walls with force';
  if (name === 'f' && /^(create|leave|disband|kick|enemy|ally|neutral|unclaim)$/.test(String(i.action ?? ''))) return `scripts may not run f ${i.action}; do that yourself, deliberately`;
  if (name === 'faction_notes' && i.action === 'write') return 'scripts may append to faction_notes but not replace the page';
  if (name === 'logoff') return 'scripts may not end the session';
  return null;
}

// ---------- the host side of the sandbox ----------

const FLAG_CANCEL = 0;
const FLAG_SYNC = 1;
const GRACE_MS = 3_000;
const INPUT_MAX_CHARS = 64_000;
const RESOURCE_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, codeRangeSizeMb: 16, stackSizeMb: 4 });

/**
 * Owns the worker that runs scripts. One per bot process, restarted after
 * a terminate or a crash. Every message from the worker is plain data.
 */
export class ScriptHost {
  constructor({ log = null, workerUrl = null, resourceLimits = RESOURCE_LIMITS } = {}) {
    this.log = log;
    this.workerUrl = workerUrl ?? new URL('./scriptWorker.js', import.meta.url);
    this.resourceLimits = resourceLimits;
    this.worker = null;
    this.job = null;
    this.seq = 0;
    this.info = { envKeys: null, restarts: 0 };
  }

  async _ensureWorker() {
    if (this.worker) return;
    const { Worker, MessageChannel } = await import('node:worker_threads');
    const sab = new SharedArrayBuffer(16);
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(this.workerUrl, {
      env: {},                       // no API key, no secrets
      resourceLimits: this.resourceLimits,
      workerData: { sab, syncPort: port2 },
      transferList: [port2],
      stdout: true, stderr: true,    // a script that escaped cannot write to the bot's console
    });
    worker.unref();
    worker.stdout?.on?.('data', () => {});
    worker.stderr?.on?.('data', (d) => this.log?.warn?.('script_worker_stderr', { text: String(d).slice(0, 300) }));
    const hello = new Promise((resolve) => {
      const onMsg = (m) => { if (m?.type === 'hello') { worker.off('message', onMsg); resolve(m); } };
      worker.on('message', onMsg);
      setTimeout(() => resolve(null), 5000);
    });
    worker.on('message', (m) => this._onMessage(worker, m));
    worker.on('error', (e) => this._onWorkerError(worker, e));
    worker.on('exit', (code) => this._onExit(worker, code));
    this.worker = worker;
    this.flags = new Int32Array(sab);
    this.syncPort = port1;
    const h = await hello;
    if (h) this.info.envKeys = h.envKeys;
  }

  _teardown(reason) {
    const w = this.worker;
    if (!w) return;
    this.worker = null;
    this.info.restarts += 1;
    this.log?.info?.('script_worker_teardown', { reason });
    try { w.terminate(); } catch {}
  }

  _onExit(worker, code) {
    if (this.worker === worker) { this.worker = null; this.info.restarts += 1; }
    if (this.job && this.job.worker === worker) this._finish({ status: 'failed', reason: 'worker_exited', error: `worker exited with code ${code}` });
  }

  _onWorkerError(worker, e) {
    const oom = /ERR_WORKER_OUT_OF_MEMORY|out of memory/i.test(String(e?.code ?? '') + String(e?.message ?? ''));
    this.log?.warn?.('script_worker_error', { msg: e?.message, code: e?.code ?? null });
    if (this.job && this.job.worker === worker) {
      this._finish({ status: 'failed', reason: oom ? 'out_of_memory' : 'worker_crashed', error: String(e?.message ?? e).slice(0, 300), hint: oom ? 'the script used more than 128 MB; do not build huge arrays or strings' : undefined });
    }
    if (this.worker === worker) { this.worker = null; this.info.restarts += 1; try { worker.terminate(); } catch {} }
  }

  _onMessage(worker, m) {
    const job = this.job;
    if (!job || job.worker !== worker || !m || m.id !== job.id) return;
    if (m.type === 'log') { job.stdout.push(String(m.line)); if (job.stdout.length > STDOUT_MAX_LINES) job.stdout.shift(); return; }
    if (m.type === 'tool') { this._handleTool(job, m); return; }
    if (m.type === 'query') { this._handleQuery(job, m); return; }
    if (m.type === 'done') { this._finish(this._outcomeToResult(job, m.outcome)); }
  }

  async _handleTool(job, m) {
    let r;
    try {
      const input = typeof m.input === 'string' && m.input.length <= INPUT_MAX_CHARS ? JSON.parse(m.input) : {};
      r = await job.callTool(String(m.name), input && typeof input === 'object' ? input : {});
    } catch (e) { r = { status: 'failed', reason: 'exception:' + (e?.message ?? 'unknown') }; }
    let json;
    try { json = JSON.stringify(r ?? { status: 'failed', reason: 'no_result' }); } catch { json = JSON.stringify({ status: 'failed', reason: 'unserializable_result' }); }
    if (this.job === job && job.worker === this.worker) job.worker.postMessage({ type: 'tool_result', call: m.call, result: json });
  }

  _handleQuery(job, m) {
    let reply;
    try {
      const args = typeof m.args === 'string' && m.args.length <= INPUT_MAX_CHARS ? JSON.parse(m.args) : [];
      const v = job.query(String(m.name), Array.isArray(args) ? args : []);
      reply = { call: m.call, ok: true, value: JSON.stringify(v === undefined ? null : v) };
    } catch (e) { reply = { call: m.call, ok: false, error: String(e?.message ?? e).slice(0, 300) }; }
    try { this.syncPort.postMessage(reply); } catch {}
    Atomics.store(this.flags, FLAG_SYNC, 1);
    Atomics.notify(this.flags, FLAG_SYNC);
  }

  _outcomeToResult(job, o) {
    if (!o) return { status: 'failed', reason: 'no_outcome' };
    if (o.syntax) return { status: 'failed', reason: 'syntax_error', error: `${o.syntax.name}: ${o.syntax.message}`, line: o.syntax.line };
    if (job.cancelReason === 'timeout') return { status: 'failed', reason: 'timeout', hint: `the script ran past ${Math.round(job.timeoutMs / 1000)} s; do less per script, raise timeout_s (max ${SCRIPT_MAX_TIMEOUT_MS / 1000}), or split the job` };
    if (o.cancelled || job.cancelReason) return { status: 'interrupted', by: job.cancelReason ?? 'cancelled', detail: job.cancelDetail ?? null };
    if (o.error) {
      if (o.sync_timeout) return { status: 'failed', reason: 'sync_loop', error: `${o.error.name}: ${o.error.message}`, line: o.error.line, hint: 'a synchronous loop ran for 5 s without awaiting anything; await tool calls or sleep inside loops' };
      return { status: 'failed', reason: o.error.setup ? 'sandbox_setup_failed' : 'script_error', error: `${o.error.name}: ${o.error.message}`, line: o.error.line };
    }
    let v;
    try { v = o.value === undefined ? undefined : JSON.parse(o.value); } catch { v = null; }
    if (v && typeof v === 'object' && !Array.isArray(v) && ['ok', 'partial', 'failed'].includes(v.status)) {
      const { status, ...rest } = v;
      return { status, ...rest };
    }
    return { status: 'ok', returned: v };
  }

  _finish(result) {
    const job = this.job;
    if (!job) return;
    this.job = null;
    clearTimeout(job.timer); clearTimeout(job.grace);
    job.off?.();
    const elapsed_s = Math.round((Date.now() - job.started) / 100) / 10;
    job.resolve({ ...result, stdout: job.stdout, elapsed_s });
  }

  _cancel(job, reason, detail) {
    if (!job.cancelReason) { job.cancelReason = reason; job.cancelDetail = detail ?? null; }
    try { Atomics.store(this.flags, FLAG_CANCEL, 1); Atomics.notify(this.flags, FLAG_CANCEL); } catch {}
    try { job.worker.postMessage({ type: 'cancel', reason }); } catch {}
    // A script that ignores the token (a synchronous loop) is cut off with the worker.
    if (!job.grace) job.grace = setTimeout(() => {
      if (this.job !== job) return;
      this.log?.warn?.('script_worker_killed', { reason, name: job.name ?? null, elapsed_ms: Date.now() - job.started });
      this._teardown('unresponsive script');
      const timedOut = reason === 'timeout';
      this._finish(timedOut
        ? { status: 'failed', reason: 'timeout', hint: `the script ran past ${Math.round(job.timeoutMs / 1000)} s and did not stop when asked; the sandbox was restarted. Await inside loops, do less per script, or raise timeout_s (max ${SCRIPT_MAX_TIMEOUT_MS / 1000})` }
        : { status: 'interrupted', by: reason, detail: detail ?? null, note: 'the script did not stop on its own; the sandbox was restarted' });
    }, GRACE_MS);
  }

  /** Run one script. Serialized: one script per bot at a time. */
  async run({ code, params = {}, name = null, timeoutMs = SCRIPT_DEFAULT_TIMEOUT_MS, exposed = [], callTool, query, cancel = null }) {
    if (this.job) return { status: 'failed', reason: 'busy', hint: 'another script is still running' };
    await this._ensureWorker();
    if (!this.worker) return { status: 'failed', reason: 'no_sandbox' };
    const id = ++this.seq;
    return new Promise((resolve) => {
      const job = { id, name, worker: this.worker, started: Date.now(), timeoutMs, stdout: [], callTool, query, resolve, cancelReason: null, cancelDetail: null, timer: null, grace: null };
      this.job = job;
      Atomics.store(this.flags, FLAG_CANCEL, 0);
      job.off = cancel?.onCancel?.((r, d) => { if (this.job === job) this._cancel(job, r ?? 'cancelled', d); }) ?? null;
      job.timer = setTimeout(() => { if (this.job === job) { try { cancel?.cancel?.('timeout', { timeout_ms: timeoutMs }); } catch {} if (this.job === job && !job.cancelReason) this._cancel(job, 'timeout', { timeout_ms: timeoutMs }); } }, timeoutMs);
      let paramsJson = '{}';
      try { paramsJson = JSON.stringify(params ?? {}); } catch {}
      try { this.worker.postMessage({ type: 'run', id, code, params: JSON.parse(paramsJson), name, exposed, syncBudgetMs: SYNC_BUDGET_MS }); }
      catch (e) { this._finish({ status: 'failed', reason: 'post_failed', error: e.message }); }
    });
  }

  async shutdown() {
    const w = this.worker;
    this.worker = null;
    if (this.job) this._finish({ status: 'interrupted', by: 'shutdown' });
    if (w) { try { await w.terminate(); } catch {} }
  }
}

let defaultHost = null;
export function getScriptHost(opts = {}) {
  if (!defaultHost) defaultHost = new ScriptHost(opts);
  return defaultHost;
}
export async function shutdownScriptHost() {
  const h = defaultHost; defaultHost = null;
  if (h) await h.shutdown();
}

/**
 * Run `code` in the sandbox. Resolves to the tool-result shape:
 *   { status: ok|partial|failed|interrupted, returned, stdout, tool_calls, n_tool_calls, elapsed_s, error?, line?, denied? }
 */
export async function runScript({ code, params = {}, tools, deps, cancel = null, log = null, timeoutMs = SCRIPT_DEFAULT_TIMEOUT_MS, name = null, host = null }) {
  const h = host ?? getScriptHost({ log });
  const exposed = [...(tools?.byName?.keys?.() ?? [])].filter((n) => !SCRIPT_BLOCKED.has(n) && !tools.byName.get(n)?.raw && scriptDeny(n, {}) === null);
  const counts = new Map();
  const calls = [];
  const denied = [];
  const script = { calls, denied };
  // The script's own cancel token: the outer one (interrupts) plus timeout.
  const runToken = new CancelToken();
  const off = cancel?.onCancel?.((r, d) => runToken.cancel(r, d)) ?? (() => {});
  const record = (toolName, r) => { calls.push({ tool: toolName, status: r?.status ?? 'failed', reason: r?.reason }); if (calls.length > CALLS_MAX) calls.shift(); };

  const callTool = async (toolName, input) => {
    const meta = tools.byName.get(toolName);
    if (!meta || !exposed.includes(toolName)) { const r = { status: 'failed', reason: 'no_such_tool', tool: toolName }; record(toolName, r); return r; }
    const why = scriptDeny(toolName, input);
    if (why) { denied.push({ tool: toolName, why }); const r = { status: 'failed', reason: 'not_allowed_in_scripts', hint: why }; record(toolName, r); return r; }
    const cap = SCRIPT_CAPS[toolName];
    const n = (counts.get(toolName) ?? 0) + 1;
    counts.set(toolName, n);
    if (cap != null && n > cap) { const r = { status: 'failed', reason: 'script_cap', hint: `scripts may call ${toolName} at most ${cap} times` }; record(toolName, r); return r; }
    const problems = meta.schema ? validateInput(meta.schema, input) : [];
    if (problems.length) { const r = { status: 'failed', reason: 'bad_input', problems }; record(toolName, r); return r; }
    const { interrupt_on: _omit, ...clean } = input;
    let r;
    try { r = await meta.handler(clean, { cancel: runToken, log, deps }); }
    catch (e) { r = { status: 'failed', reason: 'exception:' + (e?.message ?? 'unknown') }; }
    record(toolName, r);
    return r;
  };
  const { me, world } = makeScriptApi({ bot: deps.bot });
  const query = (qname, args) => {
    const [ns, fn] = String(qname).split('.');
    const obj = ns === 'me' ? me : ns === 'world' ? world : null;
    const f = obj && typeof obj[fn] === 'function' ? obj[fn] : null;
    if (!f) throw new Error(`unknown query ${qname}`);
    return f(...args);
  };
  const r = await h.run({ code, params, name, timeoutMs, exposed, callTool, query, cancel: runToken });
  // Handlers still mid-flight stop when the script has ended for any reason.
  if (!runToken.cancelled) runToken.cancel(r.status === 'interrupted' ? (r.by ?? 'cancelled') : 'script_done');
  off();
  r.tool_calls = calls.slice(-20);
  r.n_tool_calls = calls.length;
  if (script.denied.length) r.denied = script.denied.slice(0, 5);
  return r;
}

/** Saved scripts shared by every bot on this machine. */
export class SkillStore {
  constructor({ dir = SKILLS_DIR, log = null } = {}) {
    this.dir = dir;
    this.log = log;
    this.indexPath = path.join(dir, 'index.json');
    this._index = null;
  }

  _load() {
    if (this._index) return this._index;
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch {}
    try { this._index = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')); }
    catch { this._index = { skills: {} }; }
    if (!this._index.skills || typeof this._index.skills !== 'object') this._index.skills = {};
    return this._index;
  }

  _persist() {
    try { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(this.indexPath, JSON.stringify(this._index, null, 2)); }
    catch (e) { this.log?.warn?.('skill_index_write_failed', { msg: e.message }); }
  }

  /** Re-read the index so another bot's saves show up. */
  refresh() { this._index = null; return this._load(); }

  list() {
    const idx = this.refresh();
    return Object.values(idx.skills)
      .map((m) => ({ ...m }))
      .sort((a, b) => (b.ok - b.failed) - (a.ok - a.failed) || b.uses - a.uses || a.name.localeCompare(b.name));
  }

  search(query) {
    const all = this.list();
    const words = String(query ?? '').toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
    if (!words.length) return all;
    return all.filter((m) => words.some((w) => m.name.includes(w) || (m.description ?? '').toLowerCase().includes(w)));
  }

  get(name) {
    const idx = this._load();
    const meta = idx.skills[name];
    if (!meta) return null;
    let code = null;
    try { code = stripHeader(fs.readFileSync(path.join(this.dir, `${name}.js`), 'utf8')); } catch { return null; }
    return { ...meta, code };
  }

  save({ name, description, code, params = null, author = null, verified = false }) {
    if (!SKILL_NAME_RE.test(name ?? '')) return { ok: false, reason: 'bad_name', hint: 'lowercase letters, digits and underscores, 3-32 chars, starting with a letter' };
    if (!code || typeof code !== 'string' || code.trim().length < 10) return { ok: false, reason: 'no_code' };
    if (code.length > 12_000) return { ok: false, reason: 'too_long', hint: 'keep a skill under 12 KB; split the job' };
    try { new vm.Script(`(async () => {\n${code}\n})()`, { filename: `skill_${name}.js` }); }
    catch (e) { return { ok: false, reason: 'syntax_error', error: `${e.name}: ${e.message}`, line: errorLine(e) }; }
    const idx = this._load();
    const prev = idx.skills[name];
    const now = new Date().toISOString();
    const meta = {
      name, description: String(description ?? '').slice(0, 300), params: params ? String(params).slice(0, 300) : null,
      author: prev?.author ?? author, updated_by: author, created: prev?.created ?? now, updated: now,
      version: (prev?.version ?? 0) + 1, uses: prev?.uses ?? 0, ok: prev?.ok ?? 0, failed: prev?.failed ?? 0,
      verified: !!verified, last_status: prev?.last_status ?? null,
      fail_streak: 0, disabled: false, disabled_reason: null,   // a new version gets a fresh chance
    };
    const header = [
      '/**', ` * ${name} — ${meta.description}`, meta.params ? ` * params: ${meta.params}` : null,
      ` * author: ${author ?? 'unknown'} · v${meta.version} · ${now}${verified ? ' · verified by a successful run_script' : ''}`,
      ' * Runs inside the agent script sandbox: tools.*, me.*, world.*, sleep, log, params.', ' */', '',
    ].filter((l) => l != null).join('\n');
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, `${name}.js`), header + code.replace(/\s+$/, '') + '\n');
    } catch (e) { return { ok: false, reason: 'write_failed', error: e.message }; }
    idx.skills[name] = meta;
    this._persist();
    this.log?.info?.('skill_saved', { name, version: meta.version, author, verified: !!verified, bytes: code.length });
    return { ok: true, meta };
  }

  recordUse(name, status) {
    const idx = this._load();
    const meta = idx.skills[name];
    if (!meta) return;
    meta.uses = (meta.uses ?? 0) + 1;
    if (status === 'ok') { meta.ok = (meta.ok ?? 0) + 1; meta.fail_streak = 0; }
    else if (status === 'failed') {
      meta.failed = (meta.failed ?? 0) + 1;
      meta.fail_streak = (meta.fail_streak ?? 0) + 1;
      // Quarantine: a skill that keeps failing stops running for everyone
      // until someone reads it, fixes it and saves a new version.
      if (meta.fail_streak >= QUARANTINE_AFTER && !meta.disabled) {
        meta.disabled = true;
        meta.disabled_reason = `${meta.fail_streak} consecutive failures`;
        meta.disabled_at = new Date().toISOString();
        this.log?.warn?.('skill_disabled', { name, reason: meta.disabled_reason });
      }
    }
    meta.last_status = status;
    meta.last_used = new Date().toISOString();
    this._persist();
  }
}

function stripHeader(text) {
  // Drop the leading block comment the store wrote; keep everything else verbatim.
  const m = /^\/\*\*[\s\S]*?\*\/\n\n?/.exec(text);
  return m ? text.slice(m[0].length) : text;
}
