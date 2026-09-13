#!/usr/bin/env node
/**
 * gen_docs.js — regenerate every generated document.
 *
 *   npm run docs              rewrite docs/tools.md and the env table in docs/configuration.md
 *   npm run docs -- --check   exit 1 if either is stale (what scripts/test_docs.js runs)
 */
import { run as tools } from './gen_tool_docs.js';
import { run as env } from './gen_env_docs.js';

const check = process.argv.includes('--check');
let failed = false;
for (const gen of [tools, env]) {
  const r = gen({ check });
  for (const p of r.problems ?? []) { console.error('problem:', p); failed = true; }
  console.log(`${r.file}: ${check ? (r.stale ? 'STALE (run npm run docs)' : 'up to date') : (r.written ? 'written' : 'unchanged')}`);
  if (check && r.stale) failed = true;
}
process.exit(failed ? 1 : 0);
