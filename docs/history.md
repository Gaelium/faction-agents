# History

The bots did not start as one agent loop. From April to August 2026 they
ran on a planner/executor stack that a small model steered from a menu;
it was replaced in September 2026 and deleted on 2026-09-12. This page
says what that stack was, why it went, and what the project learned. The
design note that argued for the replacement is kept verbatim as
[history/agent-overhaul.md](history/agent-overhaul.md); it is a better
explanation of the current design than any summary.

## The planner/executor stack

Each bot was a tick-driven pipeline of controllers, all deterministic
except the one that named a goal:

| Layer | Modules (deleted) | What it did |
|---|---|---|
| strategic | `goalPicker.js`, `goals.js`, `planner.js`, `contextBuilder.js`, `projects.js`, `progression.js`, `reflection.js`, `worldModel.js`, `knownLocations.js`, `visitedPositions.js`, `llmClient.js` | every two to three minutes (and on triggers) a Haiku-class call chose one goal from a pre-filtered enum (`ESTABLISH_BASE`, `CRAFT_BASIC_TOOLS`, `EXPLORE_RESOURCES`, `RAID_ENEMY`, …); a rule-based planner expanded it into a fixed task template; a project record tracked builds across ticks |
| tactical | `executor.js` (3,300 lines), `taskRunner.js`, `actionRunner.js`, `activities.js`, `tacticalPlanner.js`, `stuckRecovery.js`, `buildPhaseWatchdog.js`, `mobScanner.js`, `survival.js`, `shortTermMemory.js`, `skills/` | ran the task queue against the world: mining loops, build projects, the stuck-recovery state machine, a second LLM ("tactical planner") that proposed a verb every ten seconds, a scanner that fled mobs and cancelled work |
| social | `chatDispatcher.js`, `chatLLM.js`, `mood.js`, `relationships.js`, `templates/*.yaml` | templated fast-path chat per archetype, a slow-path persona model for conversations, a mood tracker (tilt, confidence, boredom, social energy) and an affinity/trust table per player |
| coordination | `calloutListener.js`, `intentBroadcast.js` | faction callouts and intent broadcasts over Redis |
| entry | `run.js` (1,500 lines) | wired all of it, plus watchdogs for position corruption and stuck-in-place |

What survived unchanged is the world substrate that stack was built on:
primitives, movement, combat, perception, the blueprint builder, memory,
the economy parser, the faction state and BotBridge. The agent loop uses
the same hands.

## Why it was replaced

Three audits in June 2026 (a multi-agent failure audit, a build-failure
investigation, and a review of why bots never played like real players)
converged on the same reading, in different words.

**The model was not the problem.** The failure audit attributed about 85%
of observed failures to deterministic code below the decision layer:
mechanical code ~55% (placement timeouts, transaction rejects on 1.8,
missing site preparation), environment ~15%, control-flow arbitration
~15%, architecture ~8%; model decision quality was ~2% and format
adherence ~0%. Every one of 828 post-fix model calls parsed; the model
cost $1.52 for the whole slice. The build path had zero model calls: the
model only ever named a goal string. Fine-tuning was therefore the wrong
lever, since it would optimise the one part already working, and a
fine-tune on those trajectories would bake the bugs in.

**The controllers argued with each other.** The last log before the
overhaul (TestBot43, 2.6 hours) had 183 model calls, 117 goal picks, 275
place failures, 170 stuck-recovery transitions, 83 task cancellations, 94
build restarts, 119 planner/picker disagreements, zero structures
completed, and 213 occasions where the model's decision was deferred,
suppressed or skipped by a gate. Every fix since April had added a
controller or a valve between controllers (`plannerDriving`,
`_buildPhaseActive`, `observe_suppressed_during_build`, alignment
suppression), and the vocabulary of the executor had stopped being about
Minecraft. Expanding the model downward into per-tick control had been
tried and gated off: the tactical planner placed 15 blocks in 1,509 ticks,
because its verbs cancelled the task runner's goals and the two
oscillated. That was two hands on one wheel, not model incompetence.

**Perception, not strategy, capped ambition.** The goal catalogue already
had raids, tournaments and trading; `RAID_ENEMY` was picked zero times
across every log because the state flags gating it (an enemy faction, an
enemy claim seen by walking into it) almost never set, and the skills
behind it were stubs. There was no notion of the balance leaderboard, so
nothing to climb. The lever was richer perception of the board plus
composable mid-level skills plus a model that owns a revisable plan, not
more control per tick.

## What was learned

- **Fix mechanics first.** A tool that reports honestly what happened
  (`placed 61, failed 2, reason cells_occupied, cells […]`) lets the model
  route around a problem; a watchdog that restarts the build 94 times does
  not. Mechanics work continues, with one caller.
- **Exactly one sequencer, and make it the model.** No timer, scanner or
  state machine starts a second action while a tool runs. Reflexes take
  one survival action and interrupt; they never steer. Focus is a
  parameter the model sets per call (`interrupt_on`), not a valve the code
  applies.
- **The transcript is the mind.** An append-only conversation per session,
  compacted with a model-maintained focus card, replaces goal enums,
  decompose steps, observers, reflections and an intention backlog kept in
  sync by hand.
- **Turns per hour is the cost lever.** Chunky tools, not model tier.
- **Measure in minutes and dollars, live.** Each phase of the overhaul had
  a benchmark on the real server and a kill criterion. The first spike
  (2026-09-02) went from spawn to a finished cobble hut in 19 minutes, 31
  turns and $0.40 on Sonnet 4.6; the old stack's best run had built one
  base, once.

## Timeline

| When | What |
|---|---|
| April 2026 | server, BotBridge, orchestrator and the planner/executor bots; 18 character profiles |
| May–June 2026 | competence work on the old stack: structured objectives, site survey, scaffolding, door pairs, transaction retries, spawn bootstrap, lava and drowning guards; three audits |
| 2026-09-01 | the overhaul proposal ([history/agent-overhaul.md](history/agent-overhaul.md)) |
| 2026-09-02 | phase 0 spike passes: one loop, 27 tools, a cobble hut in 19 minutes |
| 2026-09-02 to 09-07 | nerves and escapes, memory and compaction, the board and factions, sandboxed scripts and skills, the fleet runner and dashboards, the Gemini adapter; live runs fixed doors, fences, water, night rules and faction ranks |
| 2026-09-12 | the old stack deleted (129 files, 1.4 MB, 72 tests), the substrate renamed to `bots/world/`, the server turned into a template, this documentation written |

The private repository keeps the full diary of the old stack
(`PROJECT_STATUS.md`, `BOT_COMPETENCE_OVERHAUL.md`, `SKILL_HARDENING_PLAN.md`)
and the memory notes the audits produced; none of that ships here.
