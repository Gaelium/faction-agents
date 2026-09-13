#!/usr/bin/env node
/**
 * gen_env_docs.js — the environment-variable table in docs/configuration.md.
 *
 *   node scripts/gen_env_docs.js            rewrite the table between the markers
 *   node scripts/gen_env_docs.js --check    exit 1 if the table is stale or a variable has no note
 *
 * The variable NAMES and the files that read them come from a scan of
 * bots/ and orchestrator/ (process.env.X, env.X, env['X']); the meaning of
 * each comes from NOTES below. A variable the code reads without a note
 * fails the run, so the table cannot silently fall behind the code.
 * Everything outside the two marker comments in docs/configuration.md is
 * hand-written and left alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = path.join(ROOT, 'docs', 'configuration.md');
const START = '<!-- env-table:start -->';
const END = '<!-- env-table:end -->';
const SCAN_DIRS = ['bots', 'orchestrator'];

// default: what applies when the variable is unset; effect: one sentence.
const NOTES = {
  ANTHROPIC_API_KEY: { default: '—', effect: 'Anthropic API key for every model turn when the model is a Claude model. Required unless `LLM_API_KEY` is set or every model is a Gemini one.' },
  LLM_API_KEY: { default: '—', effect: 'Alternative name for the Anthropic key; takes precedence over `ANTHROPIC_API_KEY`.' },
  AGENT_MODEL: { default: '`LLM_MODEL`, else `claude-opus-5`', effect: 'Model for the agent loop. A `gemini-*` id routes every turn through the Gemini adapter (`bots/agent/gemini.js`); anything else goes to the Anthropic SDK. Setting `GEMINI_API_KEY` alone does nothing: this variable decides. Also read by `smoke_gemini.js`.' },
  LLM_MODEL: { default: '—', effect: 'Older name for `AGENT_MODEL`, used only when `AGENT_MODEL` is unset. An old `.env` that sets `LLM_MODEL` to a Claude model keeps the bots on Claude however many Gemini keys it also holds.' },
  AGENT_EFFORT: { default: '`medium`', effect: 'Thinking effort per turn: `low`, `medium` or `high`. On Gemini it becomes the thinking level unless `GEMINI_THINKING` overrides it.' },
  AGENT_MAX_USD: { default: '`5`', effect: 'Spend ceiling per bot session; the loop ends itself with reason `budget` when the running total reaches it.' },
  AGENT_MAX_TURNS: { default: '`600`', effect: 'Turn ceiling per session; the loop ends with reason `max_turns`.' },
  AGENT_CONTEXT_EDIT: { default: 'on', effect: '`0` disables API-side context editing (clearing old tool results once the context passes about 60k tokens). Anthropic models only.' },
  AGENT_COMPACT: { default: 'on', effect: '`0` disables compaction (the API summarises the conversation, keeping the focus card, coordinates, people, inventory and furnace contents). Anthropic models only.' },
  AGENT_COMPACT_TOKENS: { default: '`120000`', effect: 'Input-token count at which compaction triggers.' },
  AGENT_STRATEGIST_MODEL: { default: '`claude-opus-5`', effect: 'Model behind the `think` tool (the strategist memo). May be a Gemini id.' },
  AGENT_STRATEGIST_EFFORT: { default: '`high`', effect: 'Thinking effort for the strategist.' },
  AGENT_EXIT_BEARING: { default: 'a stable hash of the bot name', effect: 'Degrees (0 = north, 90 = east) that `leave_spawn` walks out on when the bot starts inside the spawn zone. The orchestrator sets one per bot, evenly spaced around its roster, so a fleet fans out; the tool\'s `direction` input overrides it.' },
  GEMINI_API_KEY: { default: '—', effect: 'Google AI Studio key for the Gemini adapter. Required when `AGENT_MODEL` or `AGENT_STRATEGIST_MODEL` is a Gemini model.' },
  GOOGLE_API_KEY: { default: '—', effect: 'Alternative name for `GEMINI_API_KEY`.' },
  GEMINI_THINKING: { default: 'from `AGENT_EFFORT`', effect: 'Gemini thinking level: `low`, `medium`, `high` or `off`. If the API rejects the field the adapter retries without it and logs `gemini_thinking_config_rejected`.' },
  GEMINI_CONTEXT_CHARS: { default: '`400000`', effect: 'Size of the Gemini history (in characters, about 100k tokens) at which the adapter blanks tool results older than the newest 30 and re-shows the focus card, since Gemini has no server-side context editing.' },
  MC_SERVER_DIR: { default: '`<repo>/server`', effect: 'The Paper server folder the bots read at boot: WorldGuard regions and the Factions board (protection zones), Essentials `worth.yml` (sell prices) and `mstore/factions_mconf/instance.json` (faction rules). See [server.md](server.md).' },
  REDIS_HOST: { default: '`localhost`', effect: 'Redis host for the orchestrator\'s chat feed. Each bot reads its own Redis host from its profile (`redis.host`), not from this variable.' },
  REDIS_PORT: { default: '`6379`', effect: 'Redis port for the orchestrator\'s chat feed (bots: profile `redis.port`).' },
  FLEET_MAX_USD_PER_DAY: { default: '—', effect: 'Fleet spend ceiling per rolling 24 hours across every bot, same as `--budget`; the flag wins when both are given.' },
  FLEET_BUDGET_ACTION: { default: '`pause`', effect: '`kill` stops running bots when the ceiling is hit instead of only pausing new spawns (same as `--budget-action kill`).' },
  FLEET_WEB_PORT: { default: '`4545`', effect: 'Port of the standalone web dashboard (`node orchestrator/web.js`); `--port` wins. The orchestrator takes `--web <port>` instead.' },
  FLEET_WEB_DEV: { default: '—', effect: 'When set, the web dashboard re-reads `orchestrator/web/index.html` on every request instead of caching it (for editing the page).' },
};

const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.m?js$/.test(e.name) && !/^test_/.test(e.name)) files.push(p);
  }
};
for (const d of SCAN_DIRS) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));

export function scan() {
  const seen = new Map();   // VAR -> Set(rel file)
  const RE = /(?:process\.env|\benv)\.([A-Z][A-Z0-9_]+)|\benv\[['"]([A-Z][A-Z0-9_]+)['"]\]/g;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8'); let m;
    while ((m = RE.exec(src))) { const v = m[1] ?? m[2]; if (!seen.has(v)) seen.set(v, new Set()); seen.get(v).add(path.relative(ROOT, f)); }
  }
  return seen;
}

const processOf = (rel) => (rel.startsWith('orchestrator/') ? 'orchestrator' : 'bot');

export function renderTable() {
  const seen = scan();
  const problems = [];
  const rows = [];
  for (const v of [...seen.keys()].sort()) {
    const note = NOTES[v];
    if (!note) problems.push(`${v} (read in ${[...seen.get(v)].join(', ')}) has no entry in NOTES`);
    const readers = [...seen.get(v)].sort();
    const procs = [...new Set(readers.map(processOf))].join(' + ');
    rows.push(`| \`${v}\` | ${procs} (${readers.map((r) => `\`${r.replace(/^(bots|orchestrator)\//, '')}\``).join(', ')}) | ${note?.default ?? '?'} | ${note?.effect ?? '**undocumented — add a note in scripts/gen_env_docs.js**'} |`);
  }
  for (const v of Object.keys(NOTES)) if (!seen.has(v)) problems.push(`${v} is documented in NOTES but nothing reads it`);
  const table = [
    '*Generated by `scripts/gen_env_docs.js` from the `process.env` reads in `bots/` and `orchestrator/`; run `npm run docs` after adding one. `npm test` fails when this table is stale or a variable lacks a note.*',
    '',
    '| Variable | Read by | Default | Effect |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n');
  return { table, problems };
}

const SKELETON = `# Configuration

Every knob the bots and the orchestrator read, in one place.

## Environment variables

Put them in \`.env\` (loaded by \`node --env-file=.env …\`, see \`.env.example\`) or export them; the orchestrator passes its environment to every bot it spawns.

${START}
${END}
`;

export function run({ check = false } = {}) {
  const { table, problems } = renderTable();
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : SKELETON;
  const a = current.indexOf(START); const b = current.indexOf(END);
  if (a < 0 || b < 0 || b < a) throw new Error(`${path.relative(ROOT, OUT)} must contain the markers ${START} and ${END}`);
  const next = `${current.slice(0, a + START.length)}\n${table}\n${current.slice(b)}`;
  const stale = next !== current || !fs.existsSync(OUT);
  if (check) return { file: path.relative(ROOT, OUT), stale, problems };
  if (stale) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, next); }
  return { file: path.relative(ROOT, OUT), stale, written: stale, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  const r = run({ check });
  for (const p of r.problems) console.error('problem:', p);
  console.log(check ? `${r.file}: ${r.stale ? 'STALE (run npm run docs)' : 'up to date'}` : `${r.file}: ${r.written ? 'written' : 'unchanged'}`);
  process.exit((check && r.stale) || r.problems.length ? 1 : 0);
}
