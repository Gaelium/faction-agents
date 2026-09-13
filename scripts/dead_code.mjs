#!/usr/bin/env node
/**
 * dead_code.mjs — which source files can the live entry points reach?
 *
 *   node scripts/dead_code.mjs            reachability report from the live entries
 *   node scripts/dead_code.mjs tests      keep/drop split of test_*.js files
 *   node scripts/dead_code.mjs legacy     files reachable only from LEGACY_ENTRIES (empty since Phase 1 deleted bots/run.js)
 *   node scripts/dead_code.mjs edges F..  direct imports of the given files
 *   node scripts/dead_code.mjs rdeps F..  who imports the given files
 *
 * Static analysis over ESM `import`/`export … from`, `import()` and `require()`
 * with relative specifiers. Files loaded by path (Worker entries, CLIs) are not
 * seen: keep the ENTRIES list honest. Written for OPEN_SOURCE_PLAN.md, 2026-09-12.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['bots', 'orchestrator', 'scripts'];
// Everything the public repo runs. Extend when a CLI is added.
const ENTRIES = [
  'bots/agent/main.js', 'bots/agent/analyze_session.js', 'bots/agent/smoke_gemini.js', 'bots/agent/scriptWorker.js',
  'orchestrator/index.js', 'orchestrator/web.js', 'scripts/dead_code.mjs', 'scripts/test_all.js',
  'scripts/gen_docs.js', 'scripts/gen_tool_docs.js', 'scripts/gen_env_docs.js',
];
// The planner/executor runtime (bots/run.js and its CLIs) was deleted on 2026-09-12; list a
// retired entry here to see what only it still reaches before deleting it.
const LEGACY_ENTRIES = [];

const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(m?js|cjs)$/.test(e.name)) files.push(p);
  }
};
for (const d of DIRS) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));

const RE = /(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+|import\(\s*|require\(\s*)['"]([^'"]+)['"]/g;
const rel = (f) => path.relative(ROOT, f);
const resolveSpec = (from, spec) => {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
  const p = path.resolve(path.dirname(from), spec);
  for (const c of [p, `${p}.js`, `${p}.mjs`, path.join(p, 'index.js')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return rel(c);
  return `${rel(p)} (MISSING)`;
};
const graph = new Map();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8'); const deps = new Set(); let m;
  while ((m = RE.exec(src))) { const r = resolveSpec(f, m[1]); if (r) deps.add(r); }
  graph.set(rel(f), deps);
}
const reach = (roots) => {
  const seen = new Set(); const st = roots.filter((r) => graph.has(r));
  while (st.length) { const f = st.pop(); if (seen.has(f)) continue; seen.add(f); for (const d of graph.get(f) ?? []) if (!seen.has(d)) st.push(d); }
  return seen;
};
const isTest = (f) => /(^|\/)test_[^/]*\.js$/.test(f) && !ENTRIES.includes(f);   // scripts/test_all.js is the runner, not a suite
const kb = (f) => Math.round(fs.statSync(path.join(ROOT, f)).size / 1024);
const byDir = (list) => { const c = {}; for (const f of list) { const k = f.split('/').slice(0, 2).join('/'); c[k] = (c[k] ?? 0) + 1; } return c; };

const mode = process.argv[2] ?? 'report';
const args = process.argv.slice(3);
if (mode === 'edges') { for (const e of args) console.log(e, '->', [...(graph.get(e) ?? [])].join(', ') || '(none)'); process.exit(0); }
if (mode === 'rdeps') { for (const e of args) console.log(e, '<-', [...graph].filter(([, d]) => d.has(e)).map(([f]) => f).join(', ') || '(none)'); process.exit(0); }

const live = reach(ENTRIES);
const legacy = reach(LEGACY_ENTRIES);
const nonTest = [...graph.keys()].filter((f) => !isTest(f));
const unreachable = nonTest.filter((f) => !live.has(f)).sort();
const legacyOnly = unreachable.filter((f) => legacy.has(f));
const dead = unreachable.filter((f) => !legacy.has(f));

if (mode === 'tests') {
  const keep = []; const drop = [];
  for (const t of [...graph.keys()].filter(isTest).sort()) {
    const bad = [...graph.get(t)].filter((d) => !live.has(d) && !isTest(d)).map((d) => path.basename(d));
    (bad.length ? drop : keep).push(bad.length ? `${t}  <- ${[...new Set(bad)].join(', ')}` : t);
  }
  console.log(`KEEP (${keep.length}): tests that import only live code\n${keep.join('\n')}`);
  console.log(`\nDROP (${drop.length}): tests that import legacy or dead files\n${drop.join('\n')}`);
  process.exit(0);
}
if (mode === 'legacy') {
  console.log(`LEGACY-ONLY (${legacyOnly.length}, ${legacyOnly.reduce((a, f) => a + kb(f), 0)} KB): reachable from ${LEGACY_ENTRIES.join(', ') || '(no legacy entries)'} only`);
  console.log(legacyOnly.map((f) => `${f} (${kb(f)} KB)`).join('\n'));
  process.exit(0);
}
console.log('LIVE ENTRIES:', ENTRIES.filter((e) => graph.has(e)).join(', '));
console.log('reachable non-test files:', [...live].filter((f) => !isTest(f)).length, JSON.stringify(byDir([...live].filter((f) => !isTest(f)))));
console.log(`\nNOT reachable from live entries: ${unreachable.length}  (legacy-only ${legacyOnly.length}, dead ${dead.length})`);
console.log('\n-- legacy-only (reachable from LEGACY_ENTRIES only):'); console.log(legacyOnly.join('\n') || '(none)');
console.log('\n-- dead (reachable from nothing):'); console.log(dead.join('\n') || '(none)');
const missing = [...new Set([...graph.values()].flatMap((d) => [...d]).filter((x) => x.endsWith('(MISSING)')))];
console.log('\nMISSING import targets:', missing.join(', ') || 'none');
process.exit(unreachable.length ? 1 : 0);
