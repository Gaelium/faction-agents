# Testing

There is no test framework. Each suite is a plain Node script that builds
stub bots, models and worlds, prints one line per check and a
`N passed, M failed` summary, and exits non-zero when something failed.
No suite needs the Minecraft server, Redis or an API key. Three checks
are not tests but part of the same gate: the reachability report, the
generated-docs check and, before a release, a live smoke.

```bash
npm test                     # every suite, about 90 s on a laptop
npm test -- zones fleet      # only files whose path contains one of the words
npm test -- --verbose        # also print the output of failing suites
node bots/world/test_zones.js   # one suite directly
```

## The runner: `scripts/test_all.js`

Walks `bots/`, `orchestrator/` and `scripts/` for `test_*.js`, runs each
with `node` from the repo root, and parses the summary line for the
totals. A suite that runs longer than 180 s is killed and counted as a
failure. Output:

```
ok    bots/agent/test_agent.js  (379 passed, 0 failed, 47761 ms)
ok    bots/building/test_build_footprint.js  (8 passed, 0 failed, 46 ms)
…
files: 29 ok, 0 failed (of 29); checks: 899 passed, 0 failed; 69 s
```

The exit code is the number of failed files (0 when green). The runner
trusts each suite's exit code; the counts are for the summary only.

## What each suite covers

| Suite | Covers |
|---|---|
| `bots/agent/test_agent.js` (379 checks) | the agent loop with a stub model and bot, in 25 numbered sections: cancel tokens; result mapping; nerves tiers, arming and drain; loop dispatch, events, idle backoff, logoff; interrupts during an actuator; external stop and the budget guard; the real tool registry (schemas, validation, prompt); model helpers; transcript; builder resume; gather own-block guard and progress by inventory; vein following above lava; escape (confinement, sidestep, teleport); smelt jobs; withdraw, store, home cells, dusk; the memory store and its sandbox; memory-tool routing and focus persistence; factions and money (create gate, sell, pay, notes, board, think, invites); prices and builder skip reasons; door passage, spawn-margin exit, deep water, faction command shapes, shielded escapes; door steps and panels, farm tool, seeds, faction member events, night rules; the script sandbox (worker + vm), policy and skill store; doors with the physics patch, fights that finish, mines that give up, buckets; the Gemini adapter; deferred door physics, door geometry, faction ranks, grass sweep, bucket timing, pace; fence tops, farm gates, pouring water. Sections 19, 22 and 24 run prismarine-physics simulations, which is where the 48 s go. |
| `bots/building/test_build_footprint.js` | the builder stands outside the footprint |
| `bots/building/test_cheap_first.js` | base selection prefers a cheap build first, even for high tiers |
| `bots/building/test_completion_scan.js` | ground-truth completion of a blueprint |
| `bots/building/test_door_pairs.js` | two-block doors in blueprints and the builder |
| `bots/building/test_farm_affordable.js` | farms become affordable once dirt, a bucket and a hoe are in hand |
| `bots/building/test_farm_builder.js` | a JSON farm blueprint builds correctly (10 s: simulated placement) |
| `bots/building/test_no_progress.js` | "complete" versus "never reached the anchor" |
| `bots/building/test_place_guard.js` | pre-flight cell classification and poll-verified placement |
| `bots/building/test_placement.js` | placement methods and gatherable sources per block |
| `bots/building/test_scaffold.js` | scaffolding for cells with no reference block |
| `bots/building/test_site_clearing.js` | natural obstructions are clearable during site prep |
| `bots/building/test_site_survey.js` | picking a flat, dry, unprotected anchor |
| `bots/social/test_economy_chat.js` | server economy messages (`/sell`, `/balance`, `/baltop`) parsed into state |
| `bots/world/test_dig_protection.js` | the protected-zone dig gate |
| `bots/world/test_economy.js` | `computeSellable` honours per-item reserves |
| `bots/world/test_gapple_eat.js` | the golden-apple eat sequence in combat |
| `bots/world/test_lava_bridge.js` | the pathfinder's lava-bridging guard |
| `bots/world/test_minecraft.js` | the recipe and tool-requirement data |
| `bots/world/test_own_structure.js` | the "don't break my own blocks" registry and break exclusion |
| `bots/world/test_plank_rescue.js` | door crafting with 1.8's wood-variant strictness |
| `bots/world/test_spawn_protection.js` | no workstation inside the safezone |
| `bots/world/test_submerged_target.js` | the two water guards behind the drown/mine livelock fix |
| `bots/world/test_txn_retry.js` | the 1.8 inventory-transaction retry wrapper |
| `bots/world/test_vein_mine.js` | vein following takes the whole vein, bounded |
| `bots/world/test_zones.js` | zone geometry and the server-file loader (the warzone-chunk pin runs only when `server/mstore/factions_board/world.json` exists) |
| `orchestrator/test_orchestrator.js` | scheduler scoring and the health monitor's backoff, with stubs; pins the profile count to the files in `bots/profiles/` and the archetype set |
| `orchestrator/test_fleet.js` | args and roster, the transcript tracker, budget maths, both dashboards (it starts the web server on a free port and fetches its routes) |
| `scripts/test_docs.js` | the generated docs are current and every relative Markdown link resolves |

## The other gates

**Reachability.** `node scripts/dead_code.mjs` (also `npm run dead-code`)
walks the import graph from the entry points (`bots/agent/main.js`,
`analyze_session.js`, `smoke_gemini.js`, `scriptWorker.js`,
`orchestrator/index.js`, `web.js`, the scripts) and exits non-zero if any
non-test file is unreachable or an import target is missing. Modes:
`tests` (which test files import only live code), `legacy` (files reachable
only from retired entries; the list is empty now), `edges <file>` (its
imports), `rdeps <file>` (who imports it). Add a new CLI to `ENTRIES` in the
script or it will be reported as dead.

**Generated docs.** `npm run docs -- --check` exits non-zero when
`docs/tools.md` or the environment table in `docs/configuration.md` no
longer matches the code, or when a `process.env` variable has no note in
`scripts/gen_env_docs.js`. `scripts/test_docs.js` runs it under `npm test`
and also checks every relative link in every `.md` file.

**Live smokes.** These talk to real services and are run by hand:

| Command | What it proves |
|---|---|
| `node --env-file=.env bots/agent/smoke_gemini.js [model]` | one tool round trip through the Gemini adapter, printing the cost (about $0.0003); needs `GEMINI_API_KEY` |
| `AGENT_MODEL=gemini-3.8-flash AGENT_MAX_USD=0.5 npm run bot -- test_bot_oss` for two to three minutes, then `node bots/agent/analyze_session.js` | a bot boots on the current tree, leaves spawn and gathers; the analyzer prints turns, tool calls, dollars and the tool histogram |

`test_bot_oss` (username TestBotOSS, a tier-2 builder) exists for this.
The reference run on 2026-09-12, 150 s on `gemini-3.8-flash`: 4 turns,
6 tool calls (`look`, `wear_armor`, `focus`, `leave_spawn` 137 blocks,
`scan`, `mine log` with 8 logs gained before the stop), $0.034, no errors,
no reflexes. Anything much worse than that after a change to
`bots/agent/`, `bots/world/` or `bots/building/` deserves a look at the
transcript before merging.

## Writing a test

House style, so the runner and the reader get the same experience from
every suite:

```js
#!/usr/bin/env node
/**
 * test_thing.js — one sentence on what this pins and why it exists.
 */
import { thing } from './thing.js';

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

assert('does the obvious thing', thing(1) === 2);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
```

- Put the file next to the code it tests, named `test_<topic>.js`; the
  runner finds it by name. Fixtures are stub objects in the file: a
  fake `bot` with `blockAt`, `inventory.items()` and an `entity.position`
  is usually enough, as the existing suites show.
- Print a `N passed, M failed` (or `N checks passed`) line last and exit
  with the failure count as the code. `test_agent.js` uses
  `node:assert/strict` and a `check()` counter instead; either is fine.
- No network, no server, no key, no timers longer than a few seconds;
  keep a suite under a minute so `npm test` stays fast.
- A test that imports a file nothing live reaches is flagged by
  `node scripts/dead_code.mjs tests`.

## The baseline

`docs/history/test-baseline-2026-09-12.txt` is the runner's output on the
tree just before the open-source cleanup (tag `pre-oss-cleanup`): 103
files, 2,381 checks, 26 failures, all explained in its header. Every
cleanup step since was gated on the suite being green; today it is 29
files and 899 checks.
