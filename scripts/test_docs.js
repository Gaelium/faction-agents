#!/usr/bin/env node
/**
 * test_docs.js — the generated docs are current and every relative link in
 * the Markdown files resolves to a file in the repo.
 *
 *   node scripts/test_docs.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const check = (cond, label) => { if (cond) { passed++; console.log('  ok  ' + label); } else { failed++; console.log('FAIL  ' + label); } };

// 1. generated docs are up to date
const gen = spawnSync(process.execPath, ['scripts/gen_docs.js', '--check'], { cwd: ROOT, encoding: 'utf8' });
check(gen.status === 0, `generated docs are current (${(gen.stdout + gen.stderr).trim().split('\n').join('; ')})`);

// 2. relative links resolve
const mdFiles = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'oss') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('.md')) mdFiles.push(p);
  }
};
walk(ROOT);
const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
let links = 0; const broken = [];
for (const f of mdFiles) {
  const src = fs.readFileSync(f, 'utf8'); let m;
  while ((m = LINK.exec(src))) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const file = target.replace(/#.*$/, '');
    if (!file) continue;
    links++;
    const abs = path.resolve(path.dirname(f), decodeURI(file));
    if (!fs.existsSync(abs)) broken.push(`${path.relative(ROOT, f)} → ${target}`);
  }
}
check(broken.length === 0, `every relative link resolves (${links} links in ${mdFiles.length} files)${broken.length ? ': ' + broken.join(', ') : ''}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
