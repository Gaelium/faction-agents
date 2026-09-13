# Data and storage

Everything a bot remembers or reports lives under `data/`, per bot, in
plain files. Nothing in `data/` is tracked by git except three old
diagnostic notes. This page lists each store, its shape, who writes it,
who reads it and what deleting it costs.

| Path | Format | Written by | Read by |
|---|---|---|---|
| `data/bots/<username>.db` | SQLite (`bots/social/memory.js`) | the bot | the bot at the next login |
| `data/sessions/<username>/<start>.jsonl` | JSONL transcript (`bots/agent/transcript.js`) | the bot, one file per session | `analyze_session.js`, the orchestrator's tracker, the dashboards |
| `data/memory/<username>/*.md` | Markdown (`bots/agent/memoryTool.js`, `tools/mind.js`) | the model through the memory tool; `note` and logoff | the model, the login bootstrap, the dashboards (`plans.md`, `journal.md`) |
| `data/skills/<name>.js`, `index.json` | JavaScript + JSON (`bots/agent/skills.js`) | any bot through `save_skill` | every bot (shared library) |
| `data/logs/<username>.log`, `orchestrator.log` | JSONL (`bots/core/logger.js`) | each process | humans; the orchestrator watches its children's stdout, not the files |
| `data/fleet_status.json` | JSON | the orchestrator every 15 s | anything that wants the fleet state without the dashboard |
| `data/diagnostics/` | CSV and Markdown | nothing any more | the three tracked notes are old-stack analyses kept for history |

## SQLite: `data/bots/<username>.db`

One database per bot, opened with WAL journaling at boot and closed at
shutdown. Two tables:

| Table | Columns | Used for |
|---|---|---|
| `kv` | `key TEXT PRIMARY KEY`, `value TEXT` (JSON), `updated_at INTEGER` | every piece of durable agent state (below) |
| `events` | `id`, `ts`, `type`, `actors` (JSON array), `data` (JSON), `importance REAL` | `recordEvent()` / `recentEvents()` / `eventsInvolving()`; the API exists but no live code writes events today |

The KV keys the code persists:

| Key | Written by | Contents |
|---|---|---|
| `faction_state` | `bots/world/factions.js` | `ourFaction`, `foundedAt`, `allies`, `enemies`, `memberships` (player → faction cache), `balance` (running tally corrected by every `/balance` reply and board query) |
| `agent_focus` | the `focus` tool (`tools/mind.js`) | `{ text, ts }`; shown with its age at the next login |
| `agent_home` | the `build` tool and `main.js` | the finished house: anchor `x,y,z`, `blueprint`, `rotation`, `door`, `inside`, `interior`, `chest`; `goto named home` and `store named home` depend on it |
| `base_structure_cells` | `bots/world/movement.js` | the wall cells the pathfinder must not dig and `mine` must not harvest; re-armed at the first pathfind of a session |
| `build_progress` | `bots/building/blueprintBuilder.js` | the blueprint being built and how far, so a build resumes after a relog |
| `built_blueprints` | `blueprintBuilder.js` | ids of finished blueprints |
| `current_build`, `blueprint_blacklist` | `bots/building/blueprintSelector.js` | the selector's current pick and blueprints that failed repeatedly |

Databases written before 2026-09-12 also contain `relationships`,
`reflections` and `intentions` tables from the retired planner stack. They
are neither created nor read any more and are harmless; drop them with
`sqlite3 data/bots/<name>.db 'DROP TABLE relationships; …'` or delete the
file.

Inspecting: `sqlite3 data/bots/Rook_Vantis.db "SELECT key, value FROM kv"`.

**Deleting the file** makes the bot forget its faction, focus card, home
and wall registry. It still owns the house on the server, but it will not
know where it is until it reads its own `places.md`, and `mine` may then
harvest its own walls.

## Transcripts: `data/sessions/<username>/<start>.jsonl`

One file per session, named by the session's start time
(`2026-09-12T18-48-18-954Z.jsonl`), appended as the session runs. Every
line is a JSON object with `ts` (ISO time) and `t` (the record kind):

| `t` | Fields | One per |
|---|---|---|
| `meta` | `profile`, `archetype`, `model`, `effort`, `spawn`, `tools` (the names sent to the API) | session, first line |
| `msg` | `role` (`user`/`assistant`), `content` (the API content blocks: text, `tool_use`, `tool_result`; on Gemini also a `gemini_parts` block carrying thought signatures) | message appended to the model history |
| `turn` | `n`, `stop` (stop reason), `usd` (this turn), `total_usd` (running), `latency_ms`, `input`, `output`, `cache_read`, `cache_create` (tokens), `tools` (names called), `text` (first 400 chars of the assistant's text, when any) | model call |
| `tool` | `name`, `input`, `result` (the full tool result, see [tools.md](tools.md#result-shape)), `elapsed_ms` | tool execution |
| `event` | `kind` (for example `context_edited`) plus fields | loop event worth marking |

The tracker (`orchestrator/tracker.js`) tails the newest file per bot and
derives everything the dashboards show: cost and turns from `turn`
lines; tool counts, the last tool, the focus card (from `focus` calls),
faction (from `f create/join/leave`), home (from a `build` result with
`home_set`), money (from `board` and `sell`), scripts (from `run_script`,
`use_skill`, `save_skill`) and the session end (`logoff`) from `tool`
lines; deaths (`YOU DIED`), incoming chat and whispers, and the `[events]`
block from `user` messages; context edits from `event` lines. The 24-hour
budget sums the last `total_usd` of every session file written in the
window, so deleting transcripts lowers the measured spend.

`analyze_session.js` reads the same file for its readout
([running.md](running.md#while-it-runs)).

**Deleting** a transcript loses the record and the dashboard history; the
bot itself does not read transcripts.

## Memory files: `data/memory/<username>/`

The model's own notes, edited through Anthropic's memory tool (on Gemini,
through an equivalent function). Paths the model uses start with
`/memories/` and map onto this directory; anything that would escape it is
refused. Commands: `view` (with an optional line range; output truncated
at 12,000 characters), `create`, `str_replace` (the old string must match
exactly once), `insert`, `delete` (never the root), `rename`. A file may
not exceed 64 KB. Errors come back to the model as text
(`status: failed, reason: memory_error` in the transcript).

Files by convention, all optional:

| File | Who writes it | What |
|---|---|---|
| `journal.md` | the `note` tool (one dated line), `logoff` and the shutdown path (`session ended (<reason>) | focus: …`) | a running log; the last 12 lines are shown at login |
| `plans.md` | the model | standing goals and the current project; the dashboards show its first 14 lines as "goals" |
| `places.md` | the model | coordinates: home, chest, ore, water, other bases |
| `people.md` | the model | who is who, trades, grudges |

The login bootstrap lists every file with its size and asks the model to
read the ones that matter before deciding.

**Deleting** the directory erases the bot's long-term memory; the SQLite
state above survives independently.

## Skills: `data/skills/`

A library shared by every bot on the machine, created on the first
`save_skill`. `index.json` holds `{ "skills": { "<name>": meta } }` where
meta has `name`, `description` (≤ 300 chars), `params`, `author`,
`updated_by`, `created`, `updated`, `version` (bumped on every save),
`uses`, `ok`, `failed`, `verified` (the exact code of a successful
`run_script`), `last_status`, `fail_streak`, `disabled`,
`disabled_reason`, `disabled_at`. Each skill is `<name>.js` with a
readable header:

```js
/**
 * sort_chest — put ores and ingots in the home chest, keep tools
 * params: none
 * author: Rook_Vantis · v2 · 2026-09-07T20:11:03.120Z · verified by a successful run_script
 * Runs inside the agent script sandbox: tools.*, me.*, world.*, sleep, log, params.
 */
```

Names match `^[a-z][a-z0-9_]{2,31}$`; code is capped at 12 KB and must
parse. Three consecutive failures quarantine a skill (`disabled: true`) until
someone saves a new version. The files are meant to be read by humans;
review the directory now and then ([scripts-and-skills.md](scripts-and-skills.md)).

**Deleting** the directory removes every saved skill for every bot.

## Logs: `data/logs/`

`bots/core/logger.js` writes one JSON object per line:

```json
{"ts":"2026-09-12T18:48:14.685Z","level":"info","bot":"TestBotOSS","event":"agent_boot","archetype":"builder","model":"gemini-3.8-flash"}
```

`level` is `debug`, `info`, `warn` or `error`; `event` is a stable
snake_case name; the rest are the event's fields. The file gets every
level; the console (and therefore the orchestrator's stdout capture) gets
info and above. Files are appended across sessions and never rotated:
delete or truncate them freely. `orchestrator.log` has the same shape with
`bot: "orchestrator"`.

Useful greps: `grep '"event":"agent_tool"' data/logs/<bot>.log | tail`,
`grep -c '"level":"warn"' data/logs/<bot>.log`.

## Fleet status: `data/fleet_status.json`

Rewritten every orchestrator tick (unless `--no-status-json`): `at`,
`totals` (bots, online, usd, usdAll, turns, toolCalls, deaths, scripts),
`bots` (per username: `session` {file, startedAt, model, effort}, `usd`,
`pastUsd`, `turns`, `toolCalls`, `toolsOk`, `toolsFailed`, `interrupts`,
`deaths`, `scripts`, `focus`, `faction`, `home`, `money`, `lastTool`,
`lastThought`, `lastTs`), plus `online`, `target`, `budget` and
`orchestratorStart`. Safe to delete at any time.

## What is safe to delete

| Delete | Cost |
|---|---|
| `data/logs/*` | nothing but history |
| `data/sessions/*` | dashboard history and the 24-hour budget measurement |
| `data/fleet_status.json` | nothing; rewritten next tick |
| `data/memory/<bot>/` | that bot's notes, journal and plans |
| `data/bots/<bot>.db` | that bot's faction state, focus, home and wall registry |
| `data/skills/` | every saved skill, for every bot |

All of it is git-ignored; a fresh clone starts with an empty `data/` that
the processes create on demand.
