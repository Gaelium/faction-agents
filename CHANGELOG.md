# Changelog

## 0.1.0 — first public release (2026-09)

The agent-loop runtime, the orchestrator with its two dashboards, the
BotBridge plugin, the server template and this documentation set.

- **Bots** play through one LLM agent loop over 45 tools (perceive, move,
  escape, gather, jobs, build, farm, fight, social, board, faction, think,
  scripts, mind) plus Anthropic's memory tool; nerves deliver server and
  world events as interrupts; the transcript is the bot's working memory,
  with context editing, compaction and a persistent focus card. Claude
  models through the Anthropic SDK; Gemini through a fetch-based adapter.
- **Mechanics** carried over from the earlier stack and hardened during the
  overhaul: pathfinding with door macros and 1.8 door physics, fences and
  gates, deep water, blueprint building with scaffolding and site survey,
  farming with water pouring, combat tuned to 1.8 rules, transaction retries
  for 1.8 crafting.
- **Model-written scripts** in a sandboxed worker with a policy and a shared
  skill library.
- **Orchestrator**: roster, schedules, session lengths, health and restarts,
  a per-day budget, a terminal dashboard and a local web dashboard over the
  transcripts.
- **BotBridge 0.1.0**: eight event types and nine queries over Redis.
- **Server template**: Paper 1.8.8 configs, Massive Factions rules, a fetch
  script for the plugins with direct download URLs and a manual list for the
  rest; no third-party jars in the repository.
- Removed: the 2026 planner/executor runtime (`bots/run.js`, strategic and
  tactical layers, chat dispatcher, 72 tests) that the agent loop replaced.
  See `docs/history.md`.
