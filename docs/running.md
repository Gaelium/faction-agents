# Running bots

Two ways to run: one bot by hand for development, or the orchestrator for a
fleet with a roster, a budget and dashboards. Both need the Paper server and
Redis up ([setup.md](setup.md)) and a model key in `.env`
([configuration.md](configuration.md)).

## One bot

```bash
npm run bot -- test_bot_oss                        # Anthropic, claude-opus-5 by default
AGENT_MODEL=gemini-3.8-flash npm run bot -- test_bot_oss
AGENT_MAX_USD=0.5 AGENT_MAX_TURNS=100 npm run bot -- Rook_Vantis
```

`npm run bot` is `node --env-file=.env bots/agent/main.js`; the argument is a
profile: the file stem under `bots/profiles/` (`test_bot_oss`) or the
`username:` inside it (`TestBotOSS`) both work. The process boots in this
order (`bots/agent/main.js`): profile → protection zones, sell prices and
faction rules from the server folder → the model client (a missing key
fails here, before the bot touches the server) → Redis bus → the mineflayer
bot → spawn → `/kit starter` and armour → senses, hands, nerves → the agent
loop.

The console mirrors the bot's structured log (`data/logs/<username>.log`,
one JSON line per event) at info level and above, prefixed with the
username. A healthy boot looks like this:

```
[TestBotOSS] agent_boot { archetype: 'builder', model: 'gemini-3.8-flash' }
[TestBotOSS] zones_loaded_from_server { zones: 1, detail: [ 'region:spawn(box)' ] }
[TestBotOSS] prices_loaded { file: '…/server/plugins/Essentials/worth.yml', items: 166 }
[TestBotOSS] faction_rules_loaded { file: '…/server/mstore/factions_mconf/instance.json', powerPerHour: 2, powerMax: 10, defaultPlayerPower: 0 }
[TestBotOSS] redis_sub_connected
[TestBotOSS] bus_ready { events: 'mc:events', responses: 'mc:responses' }
[TestBotOSS] door_physics_installed
[TestBotOSS] mc_login
[TestBotOSS] agent_spawned { pos: { x: 401, y: 66, z: 221 }, hp: 20, food: 20, in_protection: true }
[TestBotOSS] blueprints_loaded { count: 24 }
[TestBotOSS] agent_loop_start { transcript: '…/data/sessions/TestBotOSS/2026-09-12T18-48-18-954Z.jsonl', tools: 46 }
[TestBotOSS] model_turn { model: 'gemini-3.8-flash', stop: 'tool_use', input: 10237, output: 208, usd: 0.008458, total_usd: 0.008458, latency_ms: 2411 }
[TestBotOSS] agent_tool { tool: 'look', status: 'ok', reason: null, by: null, elapsed_ms: 203 }
```

From there every model call logs a `model_turn` line with tokens, dollars
and latency, and every tool call an `agent_tool` line with its status.
`bus_start_failed` means Redis is down: the bot still plays, but without
server events or board queries. `faction_rules_default` means the server
folder was not found and the shipped defaults apply
([server.md](server.md)).

### Stopping

Ctrl-C (SIGINT) or SIGTERM asks the loop to stop: the running tool is
cancelled with `by: "shutdown"`, the model gets no further turn, a journal
line `session ended (sigterm)` is appended with the focus card, the
transcript is closed, the bot quits the server and the process exits. A
clean stop ends with:

```
[TestBotOSS] agent_stop { reason: 'sigterm' }
[TestBotOSS] agent_tool { tool: 'mine', status: 'interrupted', reason: 'cancelled', by: 'shutdown', elapsed_ms: 77152 }
[TestBotOSS] agent_loop_end { reason: 'sigterm', turns: 4, usd: 0.034209, minutes: 2.4, tool_calls: 6, nerves: { events: 1, interrupts: 1, reflexes: 0 } }
[TestBotOSS] agent_shutdown { reason: 'sigterm' }
```

Exit codes are deliberate: `0` when the session ended by the bot's own
decision or its limits (`logoff`, `max_turns`, `budget_exhausted`), `1` for
everything else, including a signal, a disconnect
(`disconnected:<reason>`), a model error after five consecutive failures
(`model_error:<status>`) or a boot failure. The orchestrator's health
monitor treats a signal it sent itself as clean and any other non-zero exit
as a crash.

### While it runs

- `node bots/agent/analyze_session.js` prints the newest transcript's
  readout: minutes, turns, tool calls, dollars, turns and dollars per hour,
  milestones, deaths, interrupts, the per-tool histogram with status mix,
  the longest streak of identical failing calls, and the last focus card.
  `--sessions <bot> [n]` compares the last n sessions of one bot.
- `npm run web` (below) shows the same bot in a browser even though the
  orchestrator is not running.
- `tail -f data/logs/<username>.log` for everything, including debug lines.

## The orchestrator

```bash
npm run fleet                                            # every profile, 6–12 online by schedule
npm run fleet -- --only Rook_Vantis,oatmeal_ollie --budget 15
npm run fleet -- --only TestBotOSS --session 20,30 --no-web
npm run fleet -- --once --dry                            # print the plan and exit, spawn nothing
```

`npm run fleet` is `node --env-file=.env orchestrator/index.js`. It loads
every profile in `bots/profiles/`, spawns each chosen bot as its own
`bots/agent/main.js` child process with the orchestrator's environment,
enforces session lengths, restarts crashes, tracks cost from the
transcripts and draws the dashboards. It ticks every 15 s; the tracker
polls transcripts every 2.5 s.

### Flags (`orchestrator/args.js`)

| Flag | Effect |
|---|---|
| `--only a,b,c` | Roster: only these usernames (case-insensitive), kept online regardless of their schedule hours. Unknown names abort the start. |
| `--respect-schedule` | With `--only`, still honour each profile's hours instead of forcing `always_online`. |
| `--target n` or `--target n,m` | How many bots should be online (min,max). Default `6,12`, or the roster size with `--only`. |
| `--budget usd` | Fleet spend ceiling per rolling 24 hours, summed over every session file in `data/sessions/` written in that window. Above it no bot is spawned until spend drops back under. Env `FLEET_MAX_USD_PER_DAY` is the same knob; the flag wins. |
| `--budget-action pause` or `kill` | What happens at the ceiling: `pause` (default) stops new spawns; `kill` also stops the running bots. Env `FLEET_BUDGET_ACTION=kill`. |
| `--session min,max` | Session length in minutes for every profile, overriding `schedule.session_minutes`. |
| `--web [port]`, `--no-web` | The browser dashboard (on by default at `127.0.0.1:4545`). |
| `--dry` | Plan and dashboards but never spawn or kill. |
| `--once` | Evaluate one tick, print `{ online, toSpawn, toKill, keep }` as JSON, exit. Combine with `--dry` to be sure nothing starts. |
| `--no-dashboard` | No terminal view (the web view still runs unless `--no-web`); the web URL is printed once. |
| `--status-json`, `--no-status-json` | Whether `data/fleet_status.json` is rewritten every tick (default on). |

Per-bot limits (`AGENT_MAX_USD`, `AGENT_MAX_TURNS`, `AGENT_MODEL`, …) are
inherited by every child from the orchestrator's environment.

### Who is online: the scheduler (`orchestrator/scheduler.js`)

Every tick each profile gets a score: `always_online` → 1.0; the current
local hour inside `schedule.primary_hours` → 0.85; inside
`secondary_hours` → 0.45; otherwise 0.08. Saturday and Sunday add 0.15
when `weekend_boost` is on, every profile gets ±0.1 of random jitter so
ties break differently, and a bot that is already online gets +0.30 so it
is not kicked on one unlucky roll. Profiles scoring at least 0.25 are
eligible; the top N stay or come online, where N is the eligible count
clamped to the target range. The difference against the currently online
set is the plan (`toSpawn`, `toKill`, `keep`). Hour windows may wrap past
midnight (`[22, 28]` is 22:00 to 04:00).

Spawns are staggered 1.5 s apart (Paper's connection throttle). A bot stays
until its session window (`session_minutes`, drawn at random between min
and max) elapses, the scheduler gives its slot to someone else, or the
budget action kills it.

### Crashes and restarts (`orchestrator/health.js`)

An exit is clean when the orchestrator asked for it (scheduled, session
end, shutdown, budget) or the code is 0. Anything else is a crash: the bot
is restarted after 5 s, then 15 s, 45 s, 120 s, 300 s for consecutive
crashes; after five it is marked **unhealthy** and left alone until it is
cleared (or until it stays up ten minutes, which resets the counter). A
bot whose last logged event was `bot_force_exit` with reason
`position_corrupt_unrecovered` waits three times longer, since that
server-side condition recurs on an immediate reconnect. The crash feed on
both dashboards shows the last exits.

### The terminal dashboard (`orchestrator/dashboard.js`)

Redraws every 2 s. The fleet view has a header (online count, uptime,
Redis state, session cost and rate, 24-hour spend against the budget), one
row per bot (archetype, faction, uptime, $, $/h, turns/h, tools ok/total,
deaths, last tool with result and duration, focus card), then recent chat,
recent events and crashes. Keys need a TTY:

| Key | Action |
|---|---|
| `↑`/`↓` or `k`/`j` | select a bot |
| `Enter`, `Tab`, `l`, or `1`–`9` | zoom into the selected (or numbered) bot: focus card, goals from `plans.md`, journal, the last 15 tool calls with results and timings, thoughts, events, chat |
| `b`, `h`, Esc | back to the fleet view |
| `r` | redraw |
| `q`, Ctrl-C | quit the orchestrator cleanly |

### The web dashboard (`orchestrator/web.js`)

Same data in a browser at `http://127.0.0.1:4545` (change with
`--web <port>`), bound to localhost only, read-only, no authentication.
The page shows a KPI row (session cost with a fleet sparkline, last-24 h
spend against the budget, projected $/day, turns/h, tools ok, deaths,
scripts), the bot table, a cost-over-time chart with one line per bot,
fleet events, chat and crashes, and a per-bot panel (click a row or use
↑/↓). Light and dark follow the OS. Two JSON routes feed it:

| Route | Returns |
|---|---|
| `GET /api/fleet` | `at`, `totals`, `budget`, `target`, `online`, `orchestratorStart`, `redis`, `mode`, one entry per bot in `bots`, `chat`, `events`, `crashes`, the cost `series` |
| `GET /api/bot/<name>` | everything about one bot: session, model, focus, goals (from `plans.md`/`journal.md`), `recentTools`, `recentThoughts`, `recentEvents`, `recentChat`, `series`, rates |

Anything else is `404`. Standalone, without the orchestrator:

```bash
npm run web                          # bots with a transcript written in the last 24 h
node orchestrator/web.js --all       # every bot directory under data/sessions
node orchestrator/web.js --port 4599 --only TestBotOSS
```

Standalone it tails `data/sessions/` only, so it works for bots started
with `npm run bot`; "active" means written to in the last 90 s. The port
comes from `--port`, then `FLEET_WEB_PORT`, then 4545.

### Files the fleet writes

| Path | Written by | Contents |
|---|---|---|
| `data/logs/<username>.log` | each bot | one JSON line per event, all levels (the console shows info and above) |
| `data/logs/orchestrator.log` | orchestrator | its own events: `profiles_loaded`, `tick`, `bot_spawned`, `bot_exited`, `bot_crash`, `budget_ceiling`, `shutdown_begin` |
| `data/sessions/<username>/<start-ts>.jsonl` | each bot | the transcript: every message, turn (with cost) and tool call; the source of truth for the dashboards ([data-and-storage.md](data-and-storage.md)) |
| `data/fleet_status.json` | orchestrator, every tick | the tracker snapshot plus `online`, `target` and `budget`, for scripts that want the fleet state without the dashboard |

### Stopping cleanly

`q` in the dashboard, or Ctrl-C / SIGTERM to the orchestrator: it stops
the timers, closes the dashboards, writes the status file once more, sends
SIGTERM to every bot (SIGKILL follows 10 s later for any that has not
exited), disconnects Redis and exits after 12 s at most. Each bot ends its
session the way described above, so the transcripts and journals are
complete.

## When something is off

| Symptom | Where to look |
|---|---|
| `bus_start_failed` at boot, `redis DOWN` in the dashboard header | Redis is not running or not on the profile's host/port: `redis-cli ping`. The orchestrator's own chat feed reconnects by itself. |
| `model_error:…` ends the session | the key or model id in `.env`; the log line before it carries the HTTP status. Five consecutive failures stop the loop. |
| `mc_kicked` / `mc_end` right after login | the server console (`server/logs/latest.log`), the username (offline mode allows any name) and `online-mode=false` |
| A bot restarts every few seconds | `data/logs/orchestrator.log` for `bot_crash` and the exit code; `data/logs/<bot>.log` for the last `agent_boot_failed` or `uncaught_exception` |
| The dashboard row never changes | the bot is not writing its transcript; check that `data/sessions/<bot>/` gains a file at spawn |
| `budget_ceiling` and nothing spawns | expected: spend in the last 24 h reached `--budget`; lower the roster or raise the ceiling |
