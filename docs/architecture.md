# Architecture

Three kinds of process, one Redis between them, and a Minecraft protocol
connection per bot.

| Process | Language | Starts with | Talks to |
|---|---|---|---|
| Paper 1.8.8 server with the plugins and **BotBridge** | Java | `server/start.sh` | Minecraft clients and bots over the game protocol; Redis for BotBridge |
| **Bot** (one per character online) | Node.js, `bots/agent/main.js` | `npm run bot -- <profile>` or the orchestrator | the server over the game protocol (mineflayer); Redis; the model API; its own SQLite file and transcript |
| **Orchestrator** | Node.js, `orchestrator/index.js` | `npm run fleet -- <flags>` | spawns and stops bot processes; reads their transcripts; Redis for the chat feed; serves the web dashboard |

Nothing else runs. There is no central "world model" service, no shared
database between bots, and no queue: bots coordinate the way players do,
through chat, faction commands and a shared notes page.

## What crosses each boundary

**Server ⇄ bot, game protocol.** Each bot is an ordinary offline-mode player.
mineflayer gives the bot the world it can see (blocks, entities, inventory,
chat) and the controls (move, dig, place, attack, chat). Everything a human
player could do, the bot does through this connection, and nothing more: the
server does not grant bots any privilege.

**Server → bots, `mc:events`.** BotBridge publishes one JSON line per server
event: chat, damage, deaths, kit use, money transfers, zone entry, mcMMO
levels, faction create/claim/disband/relations. A bot subscribes once and
turns the lines into the events its nerves react to
([botbridge.md](botbridge.md) lists every event and field).

**Bots → server, `mc:commands` / `mc:responses`.** Questions a player would
answer by running a command or reading the tab list: the faction list with
power and land, claims around a position, who is online, a balance, the
baltop ladder. A bot publishes a request with a `request_id` and gets the
answer back on the responses channel. The `board` tool composes them.

**Bot → model API.** One HTTPS call per turn to Anthropic or Google, carrying
the static system prompt, the tool definitions and the transcript so far.
Nothing else leaves the machine.

**Orchestrator ⇄ bots.** The orchestrator is a parent process: it spawns
`bots/agent/main.js` with the profile name, watches stdout for the bot's
structured log lines, sends SIGTERM when a session is over, and restarts
crashed bots with backoff. It learns what a bot is doing not from the process
but from the transcript the bot writes to disk, which is why the dashboard
can also show a bot's last session while it is offline.

## Inside a bot process

`bots/agent/main.js` boots in a fixed order: profile → protection zones,
prices and faction rules from the server folder → Redis bus → mineflayer bot
with the packet guards → spawn → `/kit starter` and armour → the world
substrate (`Movement`, `Perception`, `Combat`, the blueprint registry and
builder, SQLite memory, faction state) → the nerves → the tool registry → one
agent loop until logoff, disconnect, budget or a signal.

```
            ┌───────────────────────────── the loop (bots/agent/loop.js) ─────────────────────────────┐
            │  system prompt (static)  +  transcript  ──▶  model turn  ──▶  tool calls                │
            │        ▲                                                         │                        │
            │        │  results + [events] + [now]  ◀───── run tools ◀─────────┘                        │
            └────────┼────────────────────────────────────┬────────────────────────────────────────────┘
                     │                                    │ cancel token
   nerves (bots/agent/nerves.js): sensors → events;       ▼
   Tier-0 reflexes take one action and interrupt   tools (bots/agent/tools/*): 45 chunky, honest,
                                                    interruptible skills over the world substrate
                                                           │
                                                           ▼
   bots/world/: movement, combat, perception, primitives, zones, recipes   bots/building/: blueprints
                                                           │
                                                           ▼
                                        mineflayer · BotBridge queries · SQLite · Redis
```

Three rules hold it together, and they are the reason the code is shaped
the way it is:

1. **Only the loop sequences.** No timer, watchdog or state machine starts an
   action while a tool is running. A reflex (lava, drowning, hunger, damage)
   may take one survival step and must then interrupt the running tool and
   hand the next turn to the model.
2. **Every tool tells the truth, including "I was interrupted."** Results are
   one JSON object with a status, a stable reason, what was achieved and what
   is left ([tools.md](tools.md)); the model never has to infer what happened
   from a stale state dump.
3. **The transcript is the bot's mind.** Its plan from forty minutes ago is
   still in context. When the context grows, the API clears old tool results
   and eventually compacts, and a model-maintained focus card survives both;
   across sessions the bot keeps files under `data/memory/<bot>/` through the
   memory tool.

[agent-loop.md](agent-loop.md) goes through the loop step by step;
[scripts-and-skills.md](scripts-and-skills.md) covers the one place the model
writes code.

## One turn, end to end

1. The model answers with text and one or more tool calls, for example
   `goto {named: "home", interrupt_on: ["damage", "chat_mention"]}`.
2. The loop validates the input against the schema, then runs the tool with a
   cancel token. Parallel-safe tools (perception, `say`) may run together;
   actuators run one at a time.
3. While `goto` walks, the nerves watch. A player mentioning the bot's name
   is a Tier-1 event: since the call asked for `chat_mention`, the token is
   cancelled, the pathfinder stops, and `goto` returns
   `{status: "interrupted", by: "chat_mention", pos: …, detail: {…}}`.
4. The loop writes the result, then a `[events]` block with anything queued
   (a `job_done` from a furnace, dusk), then a one-line `[now]` trailer
   (position, hp, food, time) into the next user message, records the turn
   in the transcript with its token counts and dollars, and calls the model
   again.
5. The model replies to the chat with `say`, then continues the walk, or
   changes its plan and writes a new focus card. Nothing in code decides
   which.

Turns happen at tool boundaries, not on a timer, so a three-minute `mine`
is zero turns for three minutes. Turns per hour is the cost lever
([costs.md](costs.md)).

## What lives where on disk

| Path | Written by | Contents |
|---|---|---|
| `data/bots/<name>.db` | bot (SQLite) | events observed; key-value state: faction state, home, focus card |
| `data/sessions/<name>/<timestamp>.jsonl` | bot | the transcript: every message, turn (tokens, cost, latency) and tool call with its result |
| `data/memory/<name>/*.md` | bot, through the memory tool | `journal.md`, `plans.md`, `places.md`, `people.md` |
| `data/skills/` | bots | model-written skills (`<name>.js` with a readable header) and `index.json`; shared by every bot on the machine |
| `data/logs/<name>.log`, `orchestrator.log` | bot, orchestrator | structured log lines (also mirrored to stdout) |
| `data/fleet_status.json` | orchestrator | the dashboard's data, rewritten every tick |
| `server/` | you and the server | the Paper template; the world, jars and player data are git-ignored |

[data-and-storage.md](data-and-storage.md) has the formats and what is safe
to delete.

## Why one loop

The first version of this project (April to August 2026) had a strategic
goal picker on a model tick, a planner that decomposed goals into task
chains, a task runner and an executor that held the actuators, a tactical
planner emitting a verb every ten seconds, a stuck-recovery state machine, a
build watchdog and a mob scanner. Each was added to fix a symptom, and each
negotiated with the others through gates, valves and cancel calls. Reading
one long log showed the model's decision being thrown away 213 times in
2.6 hours while the build restarted 94 times and no structure was ever
finished. The intelligence was available and cheap; it was disconnected
from the hands.

The overhaul collapsed all of it into one sequencer, the model, over a
library of chunky, honest, interruptible tools, with reflexes demoted from
controllers to interrupts. About 12,000 lines went away; the mechanics
underneath (primitives, blueprints, movement, combat, memory, BotBridge)
survived and now have one caller. The original design note is kept as
[history/agent-overhaul.md](history/agent-overhaul.md) and
[history.md](history.md) tells the rest.
