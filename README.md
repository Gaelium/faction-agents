# AI Factions

A Minecraft 1.8.9 factions server populated by AI players. Paper 1.8.8 runs
the world. A small plugin of ours, BotBridge, publishes everything that
happens on the server to Redis and answers questions about factions, claims
and money. Each bot is a Node.js process that plays through mineflayer and
decides what to do with an LLM agent loop over 45 tools: it leaves spawn,
gathers, crafts, builds a house from a blueprint, farms, fights at night,
founds or joins a faction, claims land, sells and pays, keeps a journal and
notes, and writes small scripts of its own and keeps the ones that worked.
An orchestrator brings a roster of characters online on a schedule and a
budget, and two dashboards show what they are doing and what it costs.

```
 Minecraft 1.8.9 clients ─┐
                          ▼
   ┌────────────────────────────────┐   mc:events (JSON)     ┌──────────────────────────────┐
   │ Paper 1.8.8 + Factions, mcMMO, │ ─────────────────────▶ │ bot process ×N  (Node.js)    │
   │ EssentialsX, WorldGuard, …     │   mc:commands /        │  mineflayer ⇄ agent loop     │
   │ + BotBridge (ours)             │ ◀──── mc:responses ─── │  45 tools · nerves · memory  │
   └────────────────────────────────┘        Redis           └──────────────┬───────────────┘
                 ▲   Minecraft protocol (each bot is a player)               │ transcripts, logs
                 └──────────────────────────────────────────────────────────┘
                                                             ┌──────────────▼───────────────┐
                                                             │ orchestrator: roster, budget │
                                                             │ terminal + web dashboards    │
                                                             └──────────────────────────────┘
```

The bots run on Claude (default `claude-opus-5`) or Gemini
(`AGENT_MODEL=gemini-3.8-flash`, the cheap on-ramp). Sixteen characters ship
with backstories, voices and schedules, plus six test profiles.

## See it run

[![Ten LLM players on a fresh Minecraft factions server](https://img.youtube.com/vi/7ZkpXaVs7nc/maxresdefault.jpg)](https://www.youtube.com/watch?v=7ZkpXaVs7nc)

Ten bots join a fresh server at the same time: they leave spawn, gather wood
and stone, craft, build shelters from blueprints, mine, fight at night, and
one founds a faction and starts inviting. Nothing is scripted; every action
is a tool call the model chose, and every result came back to it honestly,
interruptions included. Fifteen minutes cost about $3 in model calls.
[Watch on YouTube](https://www.youtube.com/watch?v=7ZkpXaVs7nc).

The web dashboard during that run, with cost, turns and activity per bot:
[docs/media/faction-bot-dashboard.mp4](docs/media/faction-bot-dashboard.mp4).

## Quick start

You need Java 8 (for Paper 1.8.8), Node.js 20.6 or newer, Redis, and an
API key from Anthropic or Google AI Studio. The full walk-through, including
Linux commands and what to check at each step, is in
[docs/setup.md](docs/setup.md).

```bash
git clone https://github.com/Gaelium/faction-agents.git && cd faction-agents
npm install
cp .env.example .env            # add ANTHROPIC_API_KEY, or GEMINI_API_KEY + AGENT_MODEL=gemini-3.8-flash

# the server (jars are never committed; see server/README.md for the manual ones)
cd server && ./fetch-plugins.sh && ./fetch-plugins.sh --check
cp server.properties.example server.properties && ./start.sh   # first run writes eula.txt; set eula=true, start again
# in the server console, once: the LuckPerms commands from docs/setup.md
cd ..

redis-cli ping                  # PONG
npm test                        # 29 suites, no server or key needed

npm run bot -- test_bot_oss     # one bot: logs in, takes the kit, leaves spawn, starts gathering
npm run fleet -- --only test_bot_oss --budget 1     # the orchestrator; web dashboard at http://127.0.0.1:4545
```

Stop a bot with Ctrl-C; it logs an `agent_shutdown` line and disconnects.
`node bots/agent/analyze_session.js` prints what the last session did and
what it cost.

**Cost.** A bot costs about $1 per hour on either model: gemini-3.8-flash was
measured at $0.85 per bot-hour, and claude-opus-5 lands in the same range
because it takes half as many turns. Every session stops itself at
`AGENT_MAX_USD` (default $5) and the orchestrator has a per-day ceiling
(`--budget`). Numbers and levers: [docs/costs.md](docs/costs.md).

## Documentation

| Read this | For |
|---|---|
| [docs/setup.md](docs/setup.md) | installing everything from zero, macOS and Linux, with a check at every step |
| [docs/architecture.md](docs/architecture.md) | the three processes, what crosses each boundary, one turn end to end, what lives on disk |
| [docs/running.md](docs/running.md) | one bot, the orchestrator and every flag, the dashboards, logs, stopping cleanly |
| [docs/configuration.md](docs/configuration.md) | every environment variable (generated), the profile format, the data folder |
| [docs/agent-loop.md](docs/agent-loop.md) | the loop, the prompt, interrupts and reflexes, memory and compaction, the model adapters |
| [docs/tools.md](docs/tools.md) | the reference for all 45 tools (generated from their schemas) |
| [docs/scripts-and-skills.md](docs/scripts-and-skills.md) | model-written scripts, the sandbox and its threat model, the skill library |
| [docs/building.md](docs/building.md) | blueprints, site survey, the builder, placement, doors |
| [docs/world-substrate.md](docs/world-substrate.md) | movement, perception, combat, primitives, zones, 1.8 quirks |
| [docs/profiles.md](docs/profiles.md) | the character format, archetypes and tiers, adding one |
| [docs/server.md](docs/server.md) | the plugin set and why 1.8.8, the factions economy, zones, running on another world |
| [docs/botbridge.md](docs/botbridge.md) | the plugin: every event and query, config, build, verification |
| [docs/data-and-storage.md](docs/data-and-storage.md) | SQLite tables, transcripts, memory files, skills, what is safe to delete |
| [docs/testing.md](docs/testing.md) | `npm test`, what each suite covers, the reachability and docs checks, the live smokes |
| [docs/costs.md](docs/costs.md) | prices, measured turn rates, budget guards, reducing spend |
| [docs/troubleshooting.md](docs/troubleshooting.md) | symptom → cause → what to check |
| [docs/history.md](docs/history.md) | the planner/executor stack this replaced and what was learned |
| [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md) | house style and how to add a tool; the threat model; releases |

## Repository layout

```
bots/agent/       the agent loop: main, loop, model (+gemini), prompt, nerves, cancel, memory tool,
                  transcript, skills + scriptWorker, factionRules, prices, tools/ (one file per group)
bots/world/       the world substrate: primitives, movement, combat, perception, zones, recipes, economy, factions
bots/building/    blueprint registry, selector, builder, site survey, placement, blueprints/*.json
bots/social/      economy chat parser, SQLite memory, voice filter
bots/core/        mineflayer boot and packet guards, Redis event bus, logger, profile loader, door physics
bots/profiles/    the characters (YAML)
orchestrator/     index (fleet runner), args, scheduler, spawner, health, tracker, dashboard, web (+web/index.html)
server/           the Paper 1.8.8 template: configs, Factions rules, BotBridge source, fetch-plugins.sh (no jars, no world)
scripts/          test_all, dead_code, gen_docs (+ gen_tool_docs, gen_env_docs), test_docs
docs/             this documentation; docs/history/ holds the original design note and the test baseline
data/             created at runtime: bot databases, transcripts, memory files, skills, logs (git-ignored)
```

Tests run with plain `node`, no framework: `npm test`. `node scripts/dead_code.mjs`
lists any source file the entry points cannot reach. `npm run docs` regenerates
the two generated documents.

## Licence

MIT. Paper, the plugins and Minecraft itself are not part of this repository and
carry their own licences; `server/README.md` says where each comes from.
