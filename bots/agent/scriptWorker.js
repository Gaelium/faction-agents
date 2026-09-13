/**
 * scriptWorker.js — the thread model-written scripts run in.
 *
 * Isolation, in layers:
 *  1. This worker is started with an EMPTY environment (no API key), memory
 *     limits, and no reference to the bot. Everything a script wants from
 *     the world is a message to the main thread, which answers with JSON.
 *  2. Inside the worker the script runs in a vm context whose global is a
 *     null-prototype object, with eval/Function/WebAssembly disabled. Every
 *     global the script sees (tools, me, world, sleep, log, params) is
 *     created by code running INSIDE that context; the host bridge is only
 *     ever a closure variable, and all values crossing the boundary are
 *     JSON strings or primitives. So `this.constructor.constructor`,
 *     `tools.x.constructor`, thrown errors, returned promises and results
 *     all belong to the sandbox realm, where code generation is off.
 *  3. If a script blocks this thread (a synchronous loop after an await),
 *     the main thread terminates the worker and starts a fresh one; the
 *     bot never stops responding.
 */

import { parentPort, workerData, receiveMessageOnPort } from 'node:worker_threads';
import vm from 'node:vm';

const FLAG_CANCEL = 0;
const FLAG_SYNC = 1;
const flags = new Int32Array(workerData.sab);
const syncPort = workerData.syncPort;
const SYNC_TIMEOUT_MS = 15_000;

let callSeq = 0;
const pendingTools = new Map();   // call → resolve(jsonString)
const pendingSleeps = new Set();  // reject fns, fired on cancel
let jobId = null;

parentPort.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'run') { runJob(m).catch((e) => post({ type: 'done', id: m.id, outcome: { error: { name: 'Error', message: 'worker failure: ' + (e?.message ?? e) } } })); return; }
  if (m.type === 'tool_result') { const r = pendingTools.get(m.call); pendingTools.delete(m.call); r?.(m.result); return; }
  if (m.type === 'cancel') { for (const rej of pendingSleeps) { try { rej(new Error('interrupted: ' + (m.reason ?? 'cancelled'))); } catch {} } pendingSleeps.clear(); }
});

function post(msg) { parentPort.postMessage(msg); }

// Everything the sandbox can reach lives in this object, only ever through
// closures created by INSTALL_SRC; the script cannot obtain the object.
function makeBridge(exposed) {
  return {
    exposed: exposed.slice(),
    tool(name, json) {
      return new Promise((resolve) => {
        const call = ++callSeq;
        pendingTools.set(call, resolve);
        post({ type: 'tool', id: jobId, call, name, input: json });
      });
    },
    query(name, argsJson) {
      Atomics.store(flags, FLAG_SYNC, 0);
      const call = ++callSeq;
      post({ type: 'query', id: jobId, call, name, args: argsJson });
      const r = Atomics.wait(flags, FLAG_SYNC, 0, SYNC_TIMEOUT_MS);
      if (r === 'timed-out') throw new Error(`query ${name} timed out`);
      const msg = receiveMessageOnPort(syncPort)?.message;
      if (!msg || msg.call !== call) throw new Error(`query ${name}: reply mismatch`);
      if (!msg.ok) throw new Error(msg.error ?? 'query failed');
      return msg.value;   // JSON string
    },
    sleep(ms) {
      return new Promise((resolve, reject) => {
        if (Atomics.load(flags, FLAG_CANCEL) === 1) { reject(new Error('interrupted')); return; }
        const t = setTimeout(() => { pendingSleeps.delete(reject); resolve(); }, Math.min(Math.max(0, Number(ms) || 0), 60_000));
        pendingSleeps.add((e) => { clearTimeout(t); reject(e); });
      });
    },
    cancelled() { return Atomics.load(flags, FLAG_CANCEL) === 1; },
    log(line) { post({ type: 'log', id: jobId, line: String(line).slice(0, 300) }); },
  };
}

// Runs inside the sandbox realm. Only primitives and JSON strings cross.
const INSTALL_SRC = `'use strict';
(function install(bridge, paramsJson) {
  const parse = JSON.parse, stringify = JSON.stringify, P = Promise, E = Error, freeze = Object.freeze, keys = Object.keys;
  const msg = (e) => { try { return String(e !== null && typeof e === 'object' && 'message' in e ? e.message : e); } catch (x) { return 'error'; } };
  const wrapReject = (reject) => (e) => { try { reject(new E(msg(e))); } catch (x) { reject(new E('error')); } };
  const names = []; for (let i = 0; i < bridge.exposed.length; i++) names.push(String(bridge.exposed[i]));
  const tools = {};
  for (const name of names) {
    tools[name] = function (input) {
      let json;
      try { json = stringify(input === undefined ? {} : input); } catch (e) { return P.reject(new E('tool input must be JSON: ' + msg(e))); }
      if (typeof json !== 'string') json = '{}';
      return new P((resolve, reject) => {
        let hp;
        try { hp = bridge.tool(name, json); } catch (e) { wrapReject(reject)(e); return; }
        hp.then((r) => { try { resolve(parse(String(r))); } catch (e) { wrapReject(reject)(e); } }, wrapReject(reject));
      });
    };
  }
  freeze(tools);
  const list = names.join(', ');
  const toolsProxy = new Proxy(tools, {
    get(t, k) {
      if (typeof k === 'symbol' || k in t || k === 'then' || k === 'toJSON') return t[k];
      return function () { throw new E('no such tool in scripts: ' + String(k) + ' (available: ' + list + ')'); };
    },
  });
  const q = (name) => function () {
    const args = []; for (let i = 0; i < arguments.length; i++) args.push(arguments[i]);
    let r;
    try { r = bridge.query(name, stringify(args)); } catch (e) { throw new E(msg(e)); }
    try { return parse(String(r)); } catch (e) { throw new E('bad query reply'); }
  };
  const me = freeze({ pos: q('me.pos'), inventory: q('me.inventory'), health: q('me.health'), food: q('me.food'), holding: q('me.holding'), time: q('me.time') });
  const world = freeze({ blockAt: q('world.blockAt'), isSolid: q('world.isSolid'), findBlocks: q('world.findBlocks'), entities: q('world.entities'), players: q('world.players') });
  const sleep = function (ms) {
    return new P((resolve, reject) => {
      let hp;
      try { hp = bridge.sleep(Number(ms) || 0); } catch (e) { wrapReject(reject)(e); return; }
      hp.then(() => resolve(undefined), wrapReject(reject));
    });
  };
  const log = function () {
    const parts = []; for (let i = 0; i < arguments.length; i++) { const a = arguments[i]; let s; try { s = typeof a === 'string' ? a : stringify(a); } catch (e) { s = String(a); } parts.push(s === undefined ? 'undefined' : s); }
    try { bridge.log(parts.join(' ')); } catch (e) {}
  };
  const cancelled = function () { try { return bridge.cancelled() === true; } catch (e) { return true; } };
  let params = {}; try { params = parse(paramsJson); } catch (e) { params = {}; }
  const g = globalThis;
  g.tools = toolsProxy; g.me = me; g.world = world; g.sleep = sleep; g.log = log; g.console = freeze({ log: log, error: log, warn: log, info: log });
  g.params = params; g.cancelled = cancelled;
})`;

function describeError(e) {
  let name = 'Error'; let message = 'unknown'; let stack = '';
  try { name = String(e?.name ?? 'Error'); } catch {}
  try { message = String(e?.message ?? e); } catch {}
  try { stack = String(e?.stack ?? ''); } catch {}
  const m = /(?:run_script|skill_\w+)\.js:(\d+)/.exec(stack);
  return { name: name.slice(0, 80), message: message.slice(0, 400), line: m ? Math.max(1, Number(m[1]) - 1) : null };
}

function serialize(v) {
  if (v === undefined) return undefined;
  let s;
  try { s = JSON.stringify(v); } catch { try { s = JSON.stringify(String(v)); } catch { s = null; } }
  if (s == null) return null;
  if (s.length > 2000) return JSON.stringify({ truncated: true, preview: s.slice(0, 2000) });
  return s;
}

async function runJob(job) {
  jobId = job.id;
  Atomics.store(flags, FLAG_CANCEL, 0);
  const filename = job.name ? `skill_${job.name}.js` : 'run_script.js';
  let ctx; let script;
  try {
    // A null-prototype global: `this.constructor` inside the script is undefined.
    ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, name: filename });
    const install = vm.runInContext(INSTALL_SRC, ctx, { filename: 'install.js' });
    install(makeBridge(job.exposed ?? []), JSON.stringify(job.params ?? {}));
  } catch (e) {
    post({ type: 'done', id: job.id, outcome: { error: { ...describeError(e), setup: true } } });
    return;
  }
  try { script = new vm.Script(`(async () => {\n${job.code}\n})()`, { filename }); }
  catch (e) { post({ type: 'done', id: job.id, outcome: { syntax: describeError(e) } }); return; }
  let outcome;
  try {
    const p = script.runInContext(ctx, { timeout: job.syncBudgetMs ?? 5000 });
    const v = await p;
    outcome = { value: serialize(v) };
  } catch (e) {
    outcome = { error: describeError(e), sync_timeout: /Script execution timed out/i.test(String(e?.message ?? '')) };
  }
  outcome.cancelled = Atomics.load(flags, FLAG_CANCEL) === 1;
  for (const rej of pendingSleeps) { try { rej(new Error('done')); } catch {} }
  pendingSleeps.clear();
  post({ type: 'done', id: job.id, outcome });
}

post({ type: 'hello', envKeys: Object.keys(process.env).length });
