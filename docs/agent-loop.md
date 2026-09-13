# The agent loop

Every bot is one Node process that runs one conversation with a model
for the length of a play session. The model plays Minecraft through
[tools](tools.md); nothing else in the process decides what the bot does
next. This document is the loop itself: how a session boots, what one
turn looks like, how events reach the model, how the context is kept in
bounds, what is written to disk, and how the two model adapters differ.
The code is `bots/agent/`.

| File | Role |
|---|---|
| `main.js` | boot: profile → server files → model client → Redis bus → mineflayer bot → spawn → kit → world substrate + nerves + tools → loop → shutdown |
| `loop.js` | the only sequencer: model turn → run tools → results + `[events]` + `[now]` → next turn |
| `model.js` | one Anthropic turn: cached system prompt, adaptive thinking and effort, context editing, compaction, dollars |
| `gemini.js` | the same `turn()` contract over Google's `generateContent` REST endpoint |
| `nerves.js` | sensors → tiered events; reflexes take one action and interrupt the running tool |
| `cancel.js` | `CancelToken`, `awaitHandle`, `cancellableSleep` |
| `prompt.js` | the static system prompt (identity and rules; no live state) |
| `transcript.js` | `data/sessions/<bot>/<start>.jsonl`, every message, turn and tool call |
| `memoryTool.js` | the `/memories` directory behind the memory tool |
| `tools/` | the tool library; `tools/index.js` is the registry |
| `analyze_session.js` | readout of a transcript: turns, dollars, milestones, tool histogram |

Run one bot with `npm run bot -- <profile>` (which is
`node --env-file=.env bots/agent/main.js <profile>`); the profile name is
a file in `bots/profiles/`. Configuration is in
[configuration.md](configuration.md).

## Boot (`main.js`)

1. Load the profile and open the bot's logger (`data/logs/<username>.log`,
   INFO and above mirrored to stdout).
2. Read the server folder (`MC_SERVER_DIR`, default `server/`): protection
   zones, sell prices and the faction rules. Missing files fall back to
   defaults and log it ([server.md](server.md)).
3. Build the model client first, so a missing API key fails before the bot
   touches the server. A second client, the strategist, backs the `think`
   tool and shares the session's dollar total.
4. Start the Redis bus (`bots/core/eventBus.js`). If Redis is down the bot
   still plays; board queries and bus events are simply unavailable.
5. Create the mineflayer bot, install the door-physics patch
   ([world-substrate.md](world-substrate.md)), open the SQLite memory
   (`data/bots/<username>.db`) and restore the persisted home and focus
   card from its key-value table.
6. On spawn: record the real spawn point, announce the bot to BotBridge,
   enable auto-eat and the armor manager, run `/kit starter`, wear the kit.
7. Build the world substrate (Movement wrapped by the door macro, Combat,
   Perception, the blueprint registry and builder), the nerves, then the
   tool registry over all of them.
8. Write the transcript's `meta` line, build the system prompt, and hand the
   loop a bootstrap message: the time, the focus card from last time and
   its age, the last twelve journal lines, the memory files, the inventory,
   spawn, home, faction and balance, and the saved skills.

Shutdown (`logoff`, budget, turn cap, SIGINT/SIGTERM, disconnect) stops the
nerves, closes the transcript, quits the bot, stops the bus and closes the
database. The process exits 0 for `logoff`, `max_turns` and `budget`, 1
for anything else, which the orchestrator reads as a crash
([running.md](running.md)). Every exit but a logoff appends a
`session ended (<reason>)` line to the journal.

## One turn (`loop.js`)

```
messages ──▶ model.turn(system, tools, messages) ──▶ response
                                                     │
              ┌── no tool call: idle back-off 5 → 30 s, nudge, next turn
              │
              └── tool calls ──▶ parallel-safe ones together, actuators one by one
                                  each: validate input → arm nerves → run → result
                     ──▶ user message = tool_result blocks + trailer ──▶ messages
```

Per turn, in order:

- **Guards.** Stop with `max_turns` at `AGENT_MAX_TURNS` (600) or
  `budget_exhausted` when the model client's running total reaches
  `AGENT_MAX_USD` ($5).
- **Model call.** A 400/401/403/404 or five consecutive errors end the
  session with `model_error:<status>`; other errors retry after 15 s.
- **Append the full response** (thinking blocks included, since the API
  requires them back verbatim) to the history and the transcript.
- **Refusal** (`stop_reason: refusal`): a one-line note is sent back and
  the loop carries on.
- **No tool call.** The loop sleeps 5, 10, 20, then 30 s per consecutive
  idle turn and sends `(idle Ns, no tool called. Use wait to idle on
  purpose.)` plus the trailer. A reply cut by the token limit gets `(Your
  last message was cut off by the length limit. Be brief and call a tool.)`.
- **Tool calls.** Tools flagged parallel-safe (reads, memory, focus, note,
  `say`) run concurrently; every other tool runs serially in the order the
  model gave. Before an actuator runs the loop waits for the bot to be alive
  (up to 30 s after a death) and arms the nerves with the call's
  `interrupt_on` list. Every call has a hard cap of 15 minutes.
- **Results.** Each result becomes a `tool_result` block: JSON, capped at
  2,400 characters, `is_error` set for `failed` and `unsupported`. Inputs
  are checked against the schema first (`validateInput`); a bad call costs
  no world time and returns `bad_input` with the problems listed. An
  unknown tool name returns `unsupported` with the known names.
- **Trailer.** One text block after the results, see below.

The history is append-only. Nothing ever edits an earlier turn; the two
ways the context shrinks (context editing and compaction) happen on the
API side and are reported back, see *Keeping the context in bounds*.

### The trailer

Appended to every user message after the tool results:

| Line | When |
|---|---|
| `[pace] N turns of looking without acting…` | three or more consecutive turns that only used read-only tools (`look`, `scan`, `inventory`, `recipes`, `blueprints`, `skills`, `board`, `jobs`, `memory`, `survey_site`, or a `run_script` whose code never calls `tools.`) |
| `[events]` + one line per event | anything the nerves queued since the last turn (at most the last 12), plus a summary line for background chat and joins/leaves |
| `[context] …` + `[focus card]` + `[home]` | the turn after the API edited or compacted the context |
| `[focus card] …` | every 12th turn otherwise |
| `[session] N min played this login` | every 20th turn |
| `[strategy] …` | a nudge toward `think` after 30 minutes without one (never more often, never before turn 20) |
| `[now] pos x,y,z · hp · food · day/dusk/night/dawn · IN SPAWN PROTECTION` | always (`statusLine` in `tools/perceive.js`) |

Because `[now]` and `[events]` arrive with every result, the prompt tells
the model it rarely needs `look`.

## The system prompt (`prompt.js`)

The prompt is static for the whole session so the API can cache it; live
state only ever arrives through tool results and the trailer. Sections:

- **Identity** from the profile: username, archetype, skill tier,
  backstory, values, ambition, voice (tone, punctuation, catchphrases).
- **How to play**, the rules, in brief: one decision per turn and prefer
  chunky calls (`mine` 16, `build`) over single blocks; the fresh-spawn
  bootstrap order (leave spawn, logs → planks → table → pickaxe → cobble →
  stone tools → shelter → food, coal, iron); change something before
  retrying and never repeat an identical failing call more than twice; look
  then act; what `interrupt_on` is for; chat like a player and never mention
  being an AI; keep a focus card; keep `/memories` (`plans.md`, `places.md`,
  `people.md`, `journal.md`) and read it at login; how the house door works
  and that own walls are never dug; deep water sinks you; make stone tools
  early and mine 20+ blocks from home, never below y 12; nights are working
  time when equipped (sword, two armor pieces, eight torches) and indoor
  time otherwise; fighting rules (one mob: fight; two or a creeper: door
  first; eat below 8 hp; teleport to spawn rather than an unlit door); farm
  rules (hoe and bucket, water within 4 blocks, seeds from tall grass);
  smelting as a background job; banking in the home chest; 1.8 combat
  (no shield, no offhand, sword blocks on right-click); the protected zones
  read from the server; factions and money (prices from `worth.yml`, the
  faction rules from `instance.json`, the order create → invite → power →
  claim → sethome → notes, recruits cannot build, land costs power not
  money, wear iron armor before selling ingots).
- **Scripts**: the sandbox API and rules ([scripts-and-skills.md](scripts-and-skills.md)).
- **Output**: one or two sentences of thought, then tool calls; several in
  one turn only when independent; end a turn without a call only to idle.

Change the rules there; change identity in the profile YAML
([profiles.md](profiles.md)). Prices and faction rules are injected at boot
from the server files, so they follow the server's configuration.

## Tools

The registry (`tools/index.js`) assembles the fourteen tool modules plus
the memory tool into one list in a fixed order, so the API's cached prefix
stays stable, and a `byName` map with each tool's handler, schema, default
interrupts, `uninterruptible` and `parallelSafe` flags. Handlers have the
signature `(input, { cancel, log, deps })` and never throw to the loop: an
exception becomes `{ status: 'failed', reason: 'exception:<message>' }`.

Every result is one JSON object with `status` (`ok`, `partial`, `failed`,
`interrupted`, `unsupported`), a `reason` token, an optional `hint`, and
`elapsed_s`; interrupted results carry `by` and `detail`. The complete
reference, generated from the schemas, is [tools.md](tools.md).

## Interrupts and the nerves (`nerves.js`, `cancel.js`)

The nerves never start a behaviour; they queue events, take at most one
survival action, and cancel the running tool. That single rule is what
lets the loop be the only sequencer.

| Tier | Events | Effect |
|---|---|---|
| 0, reflex | damage in lava or while drowning, oxygen running low, health at or below 8, death | one immediate action (jump and push toward a non-lava side; hold jump until the head is out of water), then the running tool is cancelled no matter what it armed |
| 1, deliver | `damage`, `chat_mention`, `whisper`, `mob_near` (hostile within 6 blocks, once per mob per 30 s), `player_near` (within 10, once per player per minute), `hunger` (food at or below 6 with no food carried, once a minute), `job_done`, `dusk`, `dawn`, `faction_invite`, `faction_member`, `faction_denied` | queued for the next `[events]`; cancels the running tool only when the tool was armed with that kind |
| 2, background | other chat, joins, leaves | counted; one summary line per drain. `chat_any` never queues but can interrupt a tool armed for it |

Sensors: the `health` event (a drop in HP is damage; `entityHurt` alone,
which also fires for blocked hits, only primes attacker attribution), the
BotBridge `player_damage` event for the attacker's name and weapon, a 1 s
scan for day phase, oxygen, hostile mobs and players, chat and whisper
events, and server messages parsed for Massive Factions invites, membership
and "does not allow you to build" denials. Damage cause is classified from
the blocks around the bot (lava, water with no oxygen, fire), else the
nearest hostile within 4 blocks, the nearest player within 5, starvation,
or `unknown`. The dusk event carries what the bot has for a night out
(torches, worn armor pieces, a sword) and the loop formats it as "keep
working" or "get inside" accordingly.

Arming: before each actuator the loop calls `nerves.arm({ interruptOn,
cancel, uninterruptible })` with the tool's `interrupt_on` (or its default)
and disarms after. A Tier-1 event whose kind is armed calls
`cancel.cancel(kind, data)`; the tool's `onCancel` hook stops the
mineflayer handle (`awaitHandle`), and the tool returns `interrupted` with
what it achieved so far.

The shield: tools marked `uninterruptible` (`teleport`, `attack` for damage
that is not lava, fire or drowning, `unstick` while it swims) are protected
from Tier-0 cancellation so an escape finishes before the model gets to
reconsider; only `death`, `shutdown` and the 15-minute `hard_timeout`
always cancel. The event is still queued and delivered with the result. The
log line for a shielded cancellation is `nerve_shielded`.

Stopping from outside (`loop.stop(reason)`, used by SIGINT/SIGTERM, the
disconnect handler and `logoff`) cancels the current tool with reason
`shutdown` and ends the loop after the current turn.

## Keeping the context in bounds

Three mechanisms, cheapest first:

1. **Result caps.** Tool results are cut at 2,400 characters; `look` and
   `scan` are designed to stay small.
2. **Context editing** (Anthropic only, `AGENT_CONTEXT_EDIT=0` disables).
   The request carries a `clear_tool_uses_20250919` edit: once the input
   passes 60k tokens the API clears tool results older than the newest 30
   tool uses (at least 8k tokens' worth), never those of `focus`, `note` or
   `memory`.
3. **Compaction** (Anthropic only, `AGENT_COMPACT=0` disables,
   `AGENT_COMPACT_TOKENS` sets the trigger, default 120k). The API replaces
   the history with a summary written under instructions to keep the focus
   card, home/chest/door/workstation coordinates, resource locations, people
   and promises, money, inventory, furnace contents, deaths and things to
   avoid; the summary comes back as a `compaction` block that is appended
   like any other content.

After either, the next trailer says so (`[context]`) and re-shows the focus
card and home, so the plan survives whatever the summary kept;
`agent_context_edited` marks it in the log and the transcript. On Gemini
the adapter trims client-side instead (below).

**The memory tool** (`memoryTool.js`) is the durable store: Anthropic's
`memory_20250818` over `data/memory/<bot>/`, addressed as `/memories/…`,
with `view`, `create`, `str_replace`, `insert`, `delete` and `rename`;
files are capped at 64 KB and views at 12,000 characters, and paths cannot
escape the directory. `note` appends a dated line to `journal.md`; the
`focus` card is also written to the SQLite key-value store so the next
login shows it with its age.

## Transcripts and cost (`transcript.js`, `model.js`)

Every session writes `data/sessions/<bot>/<ISO start>.jsonl`, one JSON
object per line with `ts` and `t`:

| `t` | Fields | Written when |
|---|---|---|
| `meta` | profile, archetype, model, effort, spawn, tools | once at loop start |
| `msg` | role, content (the exact blocks sent or received) | every message appended to the history |
| `turn` | n, stop, usd, total_usd, latency_ms, input, output, cache_read, cache_create, tools, text (first 400 chars) | every model call |
| `tool` | name, input, result (the full object, before the character cap), elapsed_ms | every tool execution |
| `event` | kind (for example `context_edited`) and fields | harness events |

The fleet tracker and the web dashboard read these files
([running.md](running.md), [data-and-storage.md](data-and-storage.md)), and
`node bots/agent/analyze_session.js [file]` prints a readout of the newest
one: minutes, turns, tool calls, idle nudges, dollars, turns per hour and
dollars per hour, time-to-milestone (left spawn, first pickaxe, first
build, first iron, first sale…), deaths, interrupts, scripts and skills,
the longest streak of identical failing calls, a per-tool histogram with
status mix and average duration, and the last focus card.
`--sessions <bot> [n]` lays the last n sessions side by side with their
first and last focus cards and a word-overlap estimate of whether each
login resumed the previous plan.

Dollars: `costOf(usage, model)` multiplies the usage counts by the table in
`model.js` (`PRICING`, per million tokens; cache reads at 0.1× input unless
the table says otherwise, cache writes at 1.25×) or by `GEMINI_PRICING` in
`gemini.js`. Each turn's `usd` and the running `total_usd` are logged as
`model_turn` and written to the transcript; the loop's budget guard reads
the same total. Figures and levers are in [costs.md](costs.md).

## Model adapters

Both adapters expose `turn({ system, tools, messages })` and return
`{ response, usage, usd, latencyMs }` with an Anthropic-shaped response, so
the loop never knows which one it is talking to. `AGENT_MODEL` picks: a
`gemini-*` id goes to `gemini.js`, anything else to the Anthropic SDK.

**Anthropic (`model.js`).** The system prompt is sent as one text block
with a cache breakpoint and a second breakpoint is put on the last user
block of each request, so the prefix and the tail both cache. Models that
support it get `thinking: adaptive` and `output_config.effort` from
`AGENT_EFFORT` (default `medium`); Haiku 4.5, Sonnet 4.5 and older are sent
vanilla. Context editing and compaction ride on the beta headers
`context-management-2025-06-27` and `compact-2026-01-12`. `max_tokens` is
8,000, the timeout 120 s, three SDK retries.

**Gemini (`gemini.js`).** Plain `fetch` against
`generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`
with the key in `x-goog-api-key`. On the way out: tool definitions become
`functionDeclarations` with schemas sanitised (`additionalProperties`,
`default`, `$schema`, `examples`, `title` dropped, since the API rejects
them), the memory tool becomes an explicit function with the same commands,
`tool_result` blocks become `functionResponse` parts matched by call id, and
the system prompt becomes `systemInstruction`. On the way back: text and
`functionCall` parts become `text` and `tool_use` blocks (numeric strings
coerced to the schema's numbers), `finishReason` maps to `tool_use`,
`end_turn`, `max_tokens` or `refusal`, and the raw parts, thought
signatures included, ride along in a hidden `gemini_parts` block on the
assistant message, which is what gets echoed back on the next request
(Gemini 3 requires the signatures verbatim). Thinking is
`thinkingConfig.thinkingLevel` from `AGENT_EFFORT` or `GEMINI_THINKING`
(`low`, `medium`, `high`, `off`); if the API rejects the field the adapter
logs `gemini_thinking_config_rejected` and retries without it, once per
session. 429 and 5xx retry with back-off. There is no server-side context
editing: once the serialised history passes `GEMINI_CONTEXT_CHARS`
(400,000 characters, about 100k tokens) the adapter blanks tool results
older than the newest 30 and reports a `client_clear_tool_uses` edit so the
loop re-shows the focus card. Usage is mapped to the Anthropic field names
(`input_tokens` = prompt minus cached, `output_tokens` = candidates plus
thoughts, `cache_read_input_tokens` = cached), so cost tracking, transcripts
and dashboards are unchanged.

Prove an adapter works before a long run:
`node --env-file=.env bots/agent/smoke_gemini.js` does one tool round trip
against the Gemini API (two turns, about $0.0003) and prints the cost.

### What a turn costs

Per turn the model reads the cached prefix (system prompt plus 46 tool
schemas, about 10k tokens) and the cached tail, plus the fresh results, and
writes a short thought and a tool call. Measured (transcripts of
2026-09-12): a Gemini 3.8 Flash turn cost $0.0085 with 10–11k input
tokens; the design note's estimate for Opus 5 is about $0.034 per turn.
Turn rate matters as much as price: a long `mine` or `build` is one turn
for minutes, three consecutive `look`s are three turns for nothing, which
is what the `[pace]` line is for. The table is in [costs.md](costs.md).

## Where to look when it fails

| Symptom | Look at |
|---|---|
| bot exits at once with `ModelClient needs LLM_API_KEY…` or `GeminiClient needs GEMINI_API_KEY` | `.env`; the key variables in [configuration.md](configuration.md) |
| `agent_model_fatal` with status 400/401/403/404 | the key, the model id in `AGENT_MODEL`, the request body (a Gemini 400 that mentions `thinking` is retried without the field automatically) |
| `agent_idle` lines repeating | the model is answering without tools; the prompt's Output section and `AGENT_EFFORT` |
| the same tool failing in a row (`longest identical-failure streak` in the readout) | the tool's `reason` and `hint` in the transcript; the rule in the prompt says change something after two |
| `nerve_shielded` followed by a death | the tool was uninterruptible; check whether the shield should apply to that cause |
| `agent_context_edited` and a lost plan | the focus card was empty or stale; `[context]` re-shows only what `focus` and `memory` hold |
| `bot_force_exit`-style crashes in the orchestrator | the bot log's last `mc_*` and `agent_*` lines; exit code 1 means an abnormal stop |

Structural tests that need no server or key: `node bots/agent/test_agent.js`
(379 checks: the loop with a stub model and bot, cancellation, nerves,
result shapes, the registry, the prompt, the sandbox probes, door and
water physics simulations).
