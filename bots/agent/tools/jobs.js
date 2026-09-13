/**
 * jobs.js — background work that the WORLD does while the bot does
 * something else. A furnace cooks server-side, so `smelt_start` loads it
 * and returns at once; the harness tracks the job and emits a `job_done`
 * event when it should be ready; `smelt_collect` walks back and empties
 * the output. One pair of hands: no bot loop runs in the background.
 */

import { SMELTABLE, FUEL_VALUES } from '../../world/minecraft.js';
import { countInventory, safeFindBlock, placeWorkstation } from '../../world/primitives.js';
import { awaitHandle, cancellableSleep } from '../cancel.js';
import { ok, fail, partial, interrupted, roundPos, distance, toVec3 } from './result.js';

export const SMELT_MS_PER_ITEM = 10_000;
const FUEL_ORDER = ['coal', 'charcoal', 'log', 'log2', 'planks', 'stick'];

function findFurnace(bot, near = null) {
  const a = safeFindBlock(bot, 'furnace', 16, null);
  const b = safeFindBlock(bot, 'lit_furnace', 16, null);
  if (near) {
    const exact = bot.blockAt?.(toVec3(near));
    if (exact && /furnace/.test(exact.name ?? '')) return exact;
  }
  return a ?? b ?? null;
}

async function walkTo(movement, pos, cancel, range = 2) {
  if (!movement?.goTo) return;
  const h = movement.goTo({ x: pos.x, y: pos.y, z: pos.z }, { timeoutMs: 15_000, range });
  await awaitHandle(h, cancel);
}

export function jobTools(deps) {
  const { bot, movement, log, state, nerves } = deps;
  state.jobs ??= new Map();
  let seq = 0;
  const msPerItem = deps.jobTiming?.msPerItem ?? SMELT_MS_PER_ITEM;

  const pickFuel = (inv, count, preferred) => {
    const order = preferred ? [preferred, ...FUEL_ORDER.filter((f) => f !== preferred)] : FUEL_ORDER;
    for (const f of order) {
      const per = FUEL_VALUES[f] ?? (f === 'log' || f === 'log2' ? 1.5 : null);
      if (!per) continue;
      const need = Math.ceil(count / per);
      if ((inv[f] ?? 0) >= need) return { fuel: f, need };
    }
    return null;
  };

  const smeltStart = {
    name: 'smelt_start',
    description: 'Load a furnace with `count` of an item plus fuel and return immediately; the furnace cooks on its own (10 s per item) while you do other things. You get a job_done event when it should be ready, then call smelt_collect. Finds a furnace within 16 blocks or places one from inventory next to you. Fuel: coal (default), or logs/planks.',
    input_schema: {
      type: 'object',
      properties: {
        item: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 64, default: 8 },
        fuel: { type: 'string' },
      },
      required: ['item'], additionalProperties: false,
    },
    defaultInterrupts: ['damage'],
    async handler({ item, count = 8, fuel }, { cancel }) {
      const output = SMELTABLE[item];
      if (!output) return fail('not_smeltable', { item, smeltable: Object.keys(SMELTABLE).slice(0, 12) });
      const inv = countInventory(bot);
      const have = inv[item] ?? 0;
      if (have <= 0) return fail('no_input', { item });
      const n = Math.min(count, have);
      const fuelPick = pickFuel(inv, n, fuel);
      if (!fuelPick) return fail('not_enough_fuel', { item, count: n, have_coal: inv.coal ?? 0, have_log: (inv.log ?? 0) + (inv.log2 ?? 0), hint: 'mine coal_ore or bring logs' });
      let furnace = findFurnace(bot);
      if (!furnace) {
        const placed = await placeWorkstation(bot, 'furnace', log);
        if (!placed.success) return fail(placed.reason ?? 'no_furnace', { hint: 'craft a furnace (8 cobblestone) or stand next to one' });
        furnace = bot.blockAt?.(placed.position) ?? findFurnace(bot);
        if (!furnace) return fail('no_furnace_placed');
      }
      await walkTo(movement, furnace.position, cancel);
      if (cancel.cancelled) return interrupted(cancel, {});
      let win;
      try { win = await bot.openFurnace(furnace); } catch (e) { return fail('open_error', { msg: e.message }); }
      const off = cancel.onCancel(() => { try { win.close(); } catch {} });
      let tookLeftover = null;
      try {
        try {
          const out = win.outputItem?.();
          if (out && out.count > 0) { const t = await win.takeOutput(); tookLeftover = { item: t?.name ?? out.name, count: t?.count ?? out.count }; }
        } catch {}
        const inputDef = bot.registry?.itemsByName?.[item];
        const fuelDef = bot.registry?.itemsByName?.[fuelPick.fuel];
        if (!inputDef || !fuelDef) return fail('unknown_item_def');
        await win.putFuel(fuelDef.id, null, fuelPick.need);
        await win.putInput(inputDef.id, null, n);
      } catch (e) {
        try { win.close(); } catch {}
        off();
        return fail('load_failed', { msg: e.message });
      }
      try { win.close(); } catch {}
      off();
      const id = `smelt-${++seq}`;
      const readyAt = Date.now() + n * msPerItem + 1500;
      const job = { id, kind: 'smelt', item, output, count: n, fuel: fuelPick.fuel, furnace: roundPos(furnace.position), startedAt: Date.now(), readyAt, status: 'cooking' };
      job._timer = setTimeout(() => {
        job.status = 'ready';
        try { nerves?.notify?.('job_done', { job_id: id, item: output, count: n, furnace: job.furnace }); } catch {}
      }, readyAt - Date.now());
      job._timer.unref?.();
      state.jobs.set(id, job);
      log?.info?.('agent_job_started', { id, item, count: n, fuel: fuelPick.fuel, furnace: job.furnace });
      return ok({ job_id: id, item, count: n, output, fuel: fuelPick.fuel, furnace: job.furnace, ready_in_s: Math.ceil((readyAt - Date.now()) / 1000), took_leftover: tookLeftover ?? undefined });
    },
  };

  const smeltCollect = {
    name: 'smelt_collect',
    description: 'Walk to the furnace of a smelting job (default: the most recent) and take everything cooked so far. Reports what you got and how long is left if it is still cooking.',
    input_schema: { type: 'object', properties: { job_id: { type: 'string' } }, additionalProperties: false },
    defaultInterrupts: ['damage'],
    async handler({ job_id }, { cancel }) {
      let job = job_id ? state.jobs.get(job_id) : null;
      if (!job) {
        const open = [...state.jobs.values()].filter((j) => j.kind === 'smelt' && j.status !== 'collected').sort((a, b) => b.startedAt - a.startedAt);
        job = open[0] ?? null;
      }
      if (!job) return fail('no_job', { hint: 'start one with smelt_start' });
      const furnace = findFurnace(bot, job.furnace) ?? bot.blockAt?.(toVec3(job.furnace));
      if (!furnace || !/furnace/.test(furnace.name ?? '')) return fail('furnace_missing', { at: job.furnace });
      await walkTo(movement, furnace.position, cancel);
      if (cancel.cancelled) return interrupted(cancel, { job_id: job.id });
      let win;
      try { win = await bot.openFurnace(furnace); } catch (e) { return fail('open_error', { msg: e.message }); }
      const off = cancel.onCancel(() => { try { win.close(); } catch {} });
      const collected = {};
      let inputLeft = 0;
      try {
        for (let i = 0; i < 8; i++) {
          const out = win.outputItem?.();
          if (!out || out.count <= 0) break;
          const t = await win.takeOutput();
          const name = t?.name ?? out.name; const c = t?.count ?? out.count;
          collected[name] = (collected[name] ?? 0) + c;
          await cancellableSleep(150, cancel);
        }
        inputLeft = win.inputItem?.()?.count ?? 0;
      } catch (e) { log?.debug?.('smelt_collect_err', { msg: e.message }); }
      finally { try { win.close(); } catch {} off(); }
      const remainingS = inputLeft > 0 ? Math.max(0, Math.ceil((job.readyAt - Date.now()) / 1000)) || inputLeft * Math.ceil(msPerItem / 1000) : 0;
      if (inputLeft === 0) { job.status = 'collected'; if (job._timer) clearTimeout(job._timer); }
      const base = { job_id: job.id, collected, input_left: inputLeft, remaining_s: remainingS, furnace: job.furnace };
      if (cancel.cancelled) return interrupted(cancel, base);
      if (Object.keys(collected).length) return inputLeft > 0 ? partial('still_cooking', base) : ok(base);
      return inputLeft > 0 ? partial('nothing_ready_yet', { ...base, hint: `wait ~${remainingS}s or do something else; a job_done event will tell you` }) : fail('empty', base);
    },
  };

  const jobs = {
    name: 'jobs',
    description: 'List background jobs (smelting) with status and seconds remaining.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    parallelSafe: true,
    async handler() {
      const now = Date.now();
      const list = [...state.jobs.values()].map((j) => ({
        job_id: j.id, kind: j.kind, item: j.item, count: j.count, output: j.output, furnace: j.furnace,
        status: j.status, remaining_s: j.status === 'cooking' ? Math.max(0, Math.ceil((j.readyAt - now) / 1000)) : 0,
        distance: distance(roundPos(bot.entity?.position), j.furnace),
      }));
      return ok({ jobs: list });
    },
  };

  return [smeltStart, smeltCollect, jobs];
}
