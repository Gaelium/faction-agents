#!/usr/bin/env node
/**
 * analyze_session.js — the Phase 0 benchmark readout.
 *
 *   node bots/agent/analyze_session.js [data/sessions/<bot>/<file>.jsonl]
 *   (defaults to the newest session file)
 *
 * Prints: turns, tool calls, dollars, minutes, turns/hour, per-tool
 * histogram with status mix, time-to-milestones (left spawn, first
 * wooden/stone pickaxe seen in a result, first build done), interrupts,
 * and the longest stretch of repeated identical failing calls.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_DIR } from './transcript.js';

function newestSession() {
  let best = null;
  for (const bot of fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR) : []) {
    const dir = path.join(SESSIONS_DIR, bot);
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const m = fs.statSync(p).mtimeMs;
      if (!best || m > best.m) best = { p, m };
    }
  }
  return best?.p ?? null;
}

// --sessions [bot] [n]: the relog benchmark readout — the last n sessions
// side by side with first/last focus cards, so you can see whether each
// login resumed the previous project without being told.
if (process.argv[2] === '--sessions') {
  const bot = process.argv[3] ?? (fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR).sort((a, b) => fs.statSync(path.join(SESSIONS_DIR, b)).mtimeMs - fs.statSync(path.join(SESSIONS_DIR, a)).mtimeMs)[0] : null);
  const n = Number(process.argv[4] ?? 5);
  if (!bot) { console.error('no sessions'); process.exit(1); }
  const dir = path.join(SESSIONS_DIR, bot);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().slice(-n);
  let prevLast = null;
  console.log(`bot ${bot}: last ${files.length} sessions`);
  for (const f of files) {
    const rows = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const turns = rows.filter((r) => r.t === 'turn');
    const toolsRows = rows.filter((r) => r.t === 'tool');
    const focus = toolsRows.filter((r) => r.name === 'focus').map((r) => r.input?.text ?? '');
    const memOps = toolsRows.filter((r) => r.name === 'memory').map((r) => `${r.input?.command}:${(r.input?.path ?? r.input?.old_path ?? '').replace('/memories/', '')}`);
    const deaths = rows.filter((r) => r.t === 'msg' && r.role === 'user' && Array.isArray(r.content) && r.content.some((b) => b.type === 'text' && /YOU DIED/.test(b.text ?? ''))).length;
    const usd = turns.reduce((a, r) => a + (r.usd ?? 0), 0);
    const t0 = Date.parse(rows[0]?.ts ?? 0); const t1 = Date.parse(rows[rows.length - 1]?.ts ?? 0);
    const mins = Math.round((t1 - t0) / 6000) / 10;
    const first = focus[0] ?? null; const last = focus[focus.length - 1] ?? null;
    const overlap = prevLast && first ? wordOverlap(prevLast, first) : null;
    const edits = rows.filter((r) => r.t === 'event' && r.kind === 'context_edited').length;
    console.log(`\n${f.replace('.jsonl', '')}  ${mins} min · ${turns.length} turns · $${usd.toFixed(2)} · deaths ${deaths} · context edits ${edits} · memory ops ${memOps.length}${memOps.length ? ' (' + memOps.slice(0, 6).join(', ') + ')' : ''}`);
    if (first) console.log(`  first focus: ${first.slice(0, 160)}`);
    if (last && last !== first) console.log(`  last focus:  ${last.slice(0, 160)}`);
    if (overlap != null) console.log(`  resumed previous plan? word overlap with previous last focus: ${(overlap * 100).toFixed(0)}%${overlap >= 0.3 ? ' (yes)' : overlap >= 0.15 ? ' (partly)' : ' (no)'}`);
    prevLast = last ?? prevLast;
  }
  process.exit(0);
}

function wordOverlap(a, b) {
  const words = (s) => new Set(String(s).toLowerCase().match(/[a-z_]{4,}/g) ?? []);
  const A = words(a); const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

const file = process.argv[2] ?? newestSession();
if (!file) { console.error('no session files under', SESSIONS_DIR); process.exit(1); }
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const t0 = lines.length ? Date.parse(lines[0].ts) : 0;
const tLast = lines.length ? Date.parse(lines[lines.length - 1].ts) : 0;
const minutes = Math.max(0.1, (tLast - t0) / 60000);
const turns = lines.filter((l) => l.t === 'turn');
const tools = lines.filter((l) => l.t === 'tool');
const usd = turns.reduce((a, l) => a + (l.usd ?? 0), 0);

const hist = {};
for (const t of tools) {
  const h = (hist[t.name] ??= { n: 0, ok: 0, partial: 0, failed: 0, interrupted: 0, other: 0, secs: 0 });
  h.n += 1; h.secs += (t.elapsed_ms ?? 0) / 1000;
  const s = t.result?.status;
  if (s in h) h[s] += 1; else h.other += 1;
}

const milestone = {};
const mark = (k, ts) => { if (!milestone[k]) milestone[k] = Math.round((Date.parse(ts) - t0) / 6000) / 10; };
for (const t of tools) {
  const r = JSON.stringify(t.result ?? {});
  const gained = t.result?.gained ?? {};
  if (t.name === 'leave_spawn' && t.result?.status === 'ok') mark('left_spawn_min', t.ts);
  if (/wooden_pickaxe/.test(r)) mark('wooden_pickaxe_min', t.ts);
  if (/stone_pickaxe/.test(r)) mark('stone_pickaxe_min', t.ts);
  if (/crafting_table/.test(r) && t.name === 'craft' && t.result?.status === 'ok') mark('crafting_table_min', t.ts);
  if (t.name === 'build' && t.result?.reason === 'done') mark(`build_done_${t.result.blueprint}_min`, t.ts);
  if (t.name === 'build' && t.result?.status !== 'ok') mark('first_build_attempt_min', t.ts);
  if ((gained.iron_ore ?? 0) > 0) mark('iron_ore_min', t.ts);
  if ((gained.iron_ingot ?? 0) > 0 || (t.result?.smelted?.item === 'iron_ingot') || (t.result?.collected?.iron_ingot ?? 0) > 0) mark('iron_ingot_min', t.ts);
  if (t.name === 'craft' && t.result?.status === 'ok' && /^iron_(helmet|chestplate|leggings|boots)$/.test(t.input?.item ?? '')) mark('iron_armor_min', t.ts);
  if (t.name === 'store' && t.result?.status === 'ok' && Object.keys(t.result?.deposited ?? {}).length) mark('banked_min', t.ts);
  if (t.name === 'smelt_start' && t.result?.status === 'ok') mark('first_async_smelt_min', t.ts);
  if (t.name === 'f' && t.result?.status === 'ok' && t.input?.action === 'create') mark('faction_created_min', t.ts);
  if (t.name === 'f' && t.result?.status === 'ok' && t.input?.action === 'join') mark('faction_joined_min', t.ts);
  if (t.name === 'f' && t.result?.status === 'ok' && t.input?.action === 'claim') mark('first_claim_min', t.ts);
  if (t.name === 'sell' && t.result?.status === 'ok') mark('first_sell_min', t.ts);
  if (t.name === 'pay' && t.result?.status === 'ok') mark('first_pay_min', t.ts);
  if (t.name === 'think' && t.result?.status === 'ok') mark('first_think_min', t.ts);
  if (t.name === 'run_script' && t.result?.status === 'ok') mark('first_script_ok_min', t.ts);
  if (t.name === 'save_skill' && t.result?.status === 'ok') mark('first_skill_saved_min', t.ts);
  if (t.name === 'use_skill' && t.result?.status === 'ok') mark('first_skill_used_min', t.ts);
}
const scripts = tools.filter((t) => t.name === 'run_script');
const scriptsOk = scripts.filter((t) => t.result?.status === 'ok').length;
const scriptTimeouts = scripts.filter((t) => t.result?.reason === 'timeout' || t.result?.reason === 'sync_loop').length;
const skillsSaved = tools.filter((t) => t.name === 'save_skill' && t.result?.status === 'ok').map((t) => t.input?.name);
const skillUses = tools.filter((t) => t.name === 'use_skill');
const skillUsesOk = skillUses.filter((t) => t.result?.status === 'ok').length;
const earned = tools.filter((t) => t.name === 'sell').reduce((a, t) => a + (t.result?.earned ?? 0), 0);
const boards = tools.filter((t) => t.name === 'board').length;
const thinks = tools.filter((t) => t.name === 'think' && t.result?.status === 'ok').length;
const notes = tools.filter((t) => t.name === 'faction_notes').length;
const deaths = lines.filter((l) => l.t === 'msg' && l.role === 'user' && Array.isArray(l.content)
  && l.content.some((b) => b.type === 'text' && /YOU DIED/.test(b.text ?? ''))).length;
const jobsStarted = tools.filter((t) => t.name === 'smelt_start' && t.result?.status === 'ok').length;

// Repeated identical failing calls in a row.
let worst = { n: 0, name: null };
let run = { key: null, n: 0 };
for (const t of tools) {
  const failing = t.result?.status === 'failed';
  const key = failing ? `${t.name}:${JSON.stringify(t.input)}` : null;
  if (key && key === run.key) run.n += 1; else run = { key, n: key ? 1 : 0 };
  if (run.n > worst.n) worst = { n: run.n, name: t.name };
}

const interrupts = tools.filter((t) => t.result?.status === 'interrupted').map((t) => t.result?.by);
const idle = lines.filter((l) => l.t === 'msg' && l.role === 'user' && Array.isArray(l.content) && l.content[0]?.type === 'text' && /^\(idle/.test(l.content[0].text)).length;

console.log(`session: ${file}`);
console.log(`minutes ${minutes.toFixed(1)} · turns ${turns.length} · tool calls ${tools.length} · idle nudges ${idle} · $${usd.toFixed(3)} · turns/hour ${(turns.length / (minutes / 60)).toFixed(0)} · $/hour ${(usd / (minutes / 60)).toFixed(2)}`);
console.log('milestones (min from start):', Object.keys(milestone).length ? milestone : 'none');
console.log(`deaths: ${deaths} · async smelt jobs: ${jobsStarted} · board ${boards} · think ${thinks} · faction_notes ${notes} · earned $${earned.toFixed(2)}`);
console.log(`interrupts: ${interrupts.length}${interrupts.length ? ' (' + interrupts.join(', ') + ')' : ''}`);
if (scripts.length || skillUses.length) console.log(`scripts: ${scripts.length} run (${scriptsOk} ok, ${scriptTimeouts} timed out) · skills saved: ${skillsSaved.length ? skillsSaved.join(', ') : 0} · skills used: ${skillUses.length} (${skillUsesOk} ok)`);
console.log(`longest identical-failure streak: ${worst.n}${worst.name ? ' on ' + worst.name : ''}`);
console.log('tools:');
for (const [name, h] of Object.entries(hist).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${name.padEnd(14)} n=${String(h.n).padStart(3)}  ok=${h.ok} partial=${h.partial} failed=${h.failed} interrupted=${h.interrupted}  avg ${(h.secs / h.n).toFixed(1)}s`);
}
const lastFocus = [...tools].reverse().find((t) => t.name === 'focus')?.input?.text;
if (lastFocus) console.log('last focus card:', lastFocus);
