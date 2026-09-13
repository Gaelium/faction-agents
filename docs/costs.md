# Costs

A bot costs money for as long as it is logged in, because every turn is a
model call. This page gives the prices the code uses, what runs have
measured, the guards that stop spend, where the numbers show up, and how
to lower them.

## Prices the code uses

The dollar figures everywhere (logs, transcripts, dashboards, the budget
guards) come from two tables, in dollars per million tokens. They are
copied from the providers' published rates and change when the providers
change them; edit the tables when they do.

Anthropic (`PRICING` in `bots/agent/model.js`; cache reads are 0.1× input
unless listed, cache writes 1.25× input with a 5-minute TTL):

| Model | Input | Output | Cache read |
|---|---|---|---|
| `claude-fable-5-1` | 10 | 50 | 0.25 |
| `claude-fable-5` | 10 | 50 | 1.0 |
| `claude-opus-5` (default) | 5 | 25 | 0.5 |
| `claude-opus-4-8`, `4-7`, `4-6` | 5 | 25 | 0.5 |
| `claude-sonnet-5` | 2 | 10 | 0.2 |
| `claude-sonnet-4-6` | 3 | 15 | 0.3 |
| `claude-haiku-4-5` | 1 | 5 | 0.1 |

Google (`GEMINI_PRICING` in `bots/agent/gemini.js`; thinking tokens are
billed as output; implicit caching on prefix matches is billed at the cache
read rate, with no write cost):

| Model | Input | Output | Cache read |
|---|---|---|---|
| `gemini-3.8-flash` | 0.75 | 3.75 | 0.075 |
| `gemini-3.7-flash` | 0.75 | 3.75 | 0.075 |
| `gemini-3.5-flash-lite` | 0.30 | 2.50 | 0.03 |

The design note in `bots/agent/README.md` records that the Gemini 3.8
Flash rates above run through 2026-12-31 and double after. An unknown model
id is priced as the default of its family.

## What runs have measured

| Run | Model | Result |
|---|---|---|
| first spike, 2026-09-02 (TestBot44, spawn to a finished cobble hut) | Sonnet 4.6 | 19 min, 31 turns, $0.40 |
| open-source smoke, 2026-09-12 (TestBotOSS, spawn → leave spawn → scan → mine 8 logs) | Gemini 3.8 Flash | 2.4 min, 4 turns, 6 tool calls, $0.034, 99 turns/h, $0.85/bot-hour |
| three-bot Gemini run, 2026-09-07 (about 10 min each) | Gemini 3.8 Flash | about $0.30 per bot, $1.9–2.1/bot-hour at about 300 turns/h |
| three-bot long run, 2026-09-06 (24 min) | Opus 5 | $2.45 total; 140–220 turns/h |

The Gemini and Opus hourly costs came out about the same despite a
seven-times lower token price, because Gemini took twice the turns per
hour: it inspected constantly (`look`, `scan`, small read-only scripts).
The `[pace]` nudge in the loop exists because of that run. Turn rate is
the lever: a long `mine` or `build` is one turn for minutes.

The design note's per-turn estimate (about 6k cached prefix, 25k cached
tail, 600 fresh input, 600 output):

| Brain | $/turn | 20 turns/h | 50 turns/h | 120 turns/h |
|---|---|---|---|---|
| Opus 5 | ~0.034 | $0.68/bot-h | $1.70 | $4.10 |
| Sonnet 5 | ~0.013 | $0.27 | $0.67 | $1.60 |
| Haiku 4.5 | ~0.007 | $0.13 | $0.34 | $0.80 |

A measured Gemini 3.8 Flash turn (10–11k input tokens, no cache hit on a
fresh session) cost $0.0085.

A realistic fleet is not every profile online all day: the scheduler gives
each profile sessions of one to four hours in its own hours, so a fleet of
21 profiles averages about six bots online ([running.md](running.md)).

## The guards

| Guard | Where | Effect |
|---|---|---|
| `AGENT_MAX_USD` (default 5) | `bots/agent/loop.js` | the session stops with reason `budget_exhausted` when the model client's running total (both the main model and the strategist share it) reaches the ceiling |
| `AGENT_MAX_TURNS` (default 600) | `loop.js` | stops with `max_turns` |
| `--budget <usd>` or `FLEET_MAX_USD_PER_DAY` | `orchestrator/args.js`, `index.js` | a fleet ceiling per rolling 24 hours summed over every bot's transcripts; above it no bot is spawned until spend drops back under |
| `--budget-action kill` or `FLEET_BUDGET_ACTION=kill` | same | also stops the running bots when the ceiling is hit (default `pause` only stops new spawns) |
| idle back-off | `loop.js` | a turn with no tool call waits 5, 10, 20, then 30 s before the next, so a chatty model cannot burn money at full speed |

All variables: [configuration.md](configuration.md).

## Where the numbers show up

- **Bot log** (`data/logs/<bot>.log`): every `model_turn` line carries
  `usd` and `total_usd`, plus input, output and cached token counts and the
  latency.
- **Transcript** (`data/sessions/<bot>/*.jsonl`): every `turn` line carries
  the same, so a session's cost is the sum of its `turn` lines and the last
  `total_usd` is the session total.
- **Readout**: `node bots/agent/analyze_session.js` prints `$<total>`,
  `$/hour` and `turns/hour` for the newest session (or a given file).
- **Terminal dashboard**: the fleet row per bot shows `$` for the session
  and `$/h`; the header shows spend against the budget.
- **Web dashboard** (`http://127.0.0.1:4545`): the KPI row has the session
  cost with a fleet sparkline, last-24-hour spend against the budget and
  the projected dollars per day; the cost-over-time chart has one line per
  bot; `/api/fleet` returns the same numbers as JSON.
- **`data/fleet_status.json`**: rewritten every orchestrator tick with the
  per-bot and fleet totals.

## Lowering the bill

In order of effect:

1. **Fewer turns.** Chunky calls (`mine` with `count: 16`, `build`,
   `leave_spawn`, `wait` with an interrupt list) instead of single actions;
   the `[pace]` line pushes the model that way after three read-only turns.
   Watch `turns/hour` in the readout or the dashboard; the fix for a high
   number is a chunkier tool, never a timer.
2. **Effort.** `AGENT_EFFORT=low` for routine play; `high` costs more output
   tokens per turn. The strategist has its own `AGENT_STRATEGIST_EFFORT`
   (default `high`) and only runs when `think` is called.
3. **Context size.** On Anthropic, context editing (on by default, clears
   old tool results past 60k input tokens) and compaction (past 120k) keep
   the cached tail short; on Gemini, `GEMINI_CONTEXT_CHARS` (400k
   characters) is the point where old results are blanked client-side.
   Lower them for cheaper, more forgetful sessions.
4. **Session length and turn cap.** `--session min,max` on the orchestrator
   and `AGENT_MAX_TURNS` bound what one login can spend.
5. **Fewer bots online.** `--target n,m` or `--only a,b,c`.
6. **Model tier.** `AGENT_MODEL=gemini-3.8-flash` for the lowest token
   price; the note above about turn rate applies. Measure a stronger model
   at low effort before assuming the cheaper tier wins per completed task.
