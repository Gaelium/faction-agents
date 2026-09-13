#!/usr/bin/env node
/**
 * test_all.js — run every test_*.js under bots/, orchestrator/ and scripts/ with plain
 * `node`, print pass/fail per file and a total, exit non-zero on any failure.
 *
 *   node scripts/test_all.js                 all suites
 *   node scripts/test_all.js zones fleet     only files whose path matches an argument
 *   node scripts/test_all.js --verbose       also print the output of failing files
 *
 * There is no test framework in this repo: each suite is a script that prints
 * its own "N passed, M failed" (or "N checks passed") line and exits non-zero
 * when something failed. This runner trusts the exit code and parses the
 * counts only for the summary. A suite that runs longer than TIMEOUT_MS is
 * killed and counted as a failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['bots', 'orchestrator', 'scripts'];
const TIMEOUT_MS = 180_000;

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const filters = args.filter((a) => !a.startsWith('--'));

const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/^test_.*\.js$/.test(e.name) && path.relative(ROOT, p) !== 'scripts/test_all.js') files.push(path.relative(ROOT, p));
  }
};
for (const d of DIRS) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
files.sort();
const selected = filters.length ? files.filter((f) => filters.some((x) => f.includes(x))) : files;

// "12 passed, 3 failed" | "12 passed / 3 failed" | "377 checks passed"
const COUNT_RE = /(\d+)\s+(?:checks\s+)?passed(?:\s*[,/]\s*(\d+)\s+failed)?/;
const parseCounts = (out) => {
  const lines = out.trim().split('\n').reverse();
  for (const line of lines) {
    const m = COUNT_RE.exec(line);
    if (m) return { passed: Number(m[1]), failed: Number(m[2] ?? 0) };
  }
  return null;
};

let filesOk = 0, filesFailed = 0, checksPassed = 0, checksFailed = 0;
const failures = [];
const t0 = Date.now();
for (const f of selected) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [f], { cwd: ROOT, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  const ms = Date.now() - started;
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const counts = parseCounts(out);
  const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
  const ok = r.status === 0 && !timedOut;
  if (counts) { checksPassed += counts.passed; checksFailed += counts.failed; }
  const detail = counts ? `${counts.passed} passed, ${counts.failed} failed` : (ok ? 'ok' : 'no summary line');
  if (ok) { filesOk += 1; console.log(`ok    ${f}  (${detail}, ${ms} ms)`); }
  else {
    filesFailed += 1;
    if (!counts || counts.failed === 0) checksFailed += 1;   // crashed/timeout: count the file as one failure
    const why = timedOut ? `timeout after ${TIMEOUT_MS} ms` : (r.status === null ? `signal ${r.signal}` : `exit ${r.status}`);
    console.log(`FAIL  ${f}  (${detail}; ${why}, ${ms} ms)`);
    failures.push({ f, out });
  }
}

if (verbose) for (const { f, out } of failures) console.log(`\n===== ${f} =====\n${out.trim()}`);

console.log(`\nfiles: ${filesOk} ok, ${filesFailed} failed (of ${selected.length}); checks: ${checksPassed} passed, ${checksFailed} failed; ${Math.round((Date.now() - t0) / 1000)} s`);
if (failures.length) console.log(`failed: ${failures.map((x) => x.f).join(' ')}`);
process.exit(filesFailed ? 1 : 0);
