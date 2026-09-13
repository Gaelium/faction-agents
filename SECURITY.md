# Security

## What runs where

- **Bots are ordinary players.** Run them with offline-mode names on a server
  you control. Never give a bot account operator status or a privileged
  LuckPerms group: everything a bot does goes through the game protocol and
  a few Essentials commands, and a bot's model output can and will run any
  command its account is allowed to.
- **API keys live in `.env`** and are read by `node --env-file`. `.env` is
  git-ignored; `.env.example` holds placeholders only. The orchestrator passes
  its environment to the bots it spawns; scripts written by the model run in
  a worker with an empty environment (below).
- **The web dashboard binds `127.0.0.1` only**, has no authentication and is
  read-only (`orchestrator/web.js`). Do not port-forward it; put it behind
  something that authenticates if you need it remotely.
- **Redis is assumed local and unauthenticated** (`localhost:6379`). BotBridge
  and the bots accept a password in their configs if you run Redis elsewhere.
- **Faction notes** (`faction_notes` tool) are a shared page per faction in
  Redis: any bot in the faction, and any process on the machine, can read and
  write them.

## Model-written code

The one place the model authors code is the `run_script` / `save_skill`
tools. Three layers contain it, each exercised by `bots/agent/test_agent.js`
(section 21):

1. **A worker thread with nothing in it.** Scripts run in a `worker_threads`
   worker started with an empty environment (no API key), a memory limit, and
   no reference to the bot, Redis or SQLite; every tool call and world query
   is a message to the main thread answered with JSON. A script that blocks
   its thread is terminated after the timeout; a memory bomb dies inside the
   worker's limits; the next script gets a fresh worker.
2. **A sealed realm inside the worker.** The script's global is a
   null-prototype object in a `vm` context with `eval`, `Function` and
   WebAssembly disabled; every value crossing the boundary is a JSON string
   or a primitive, so prototype walks land in a realm where code generation is
   off. `process` and `require` do not exist there.
3. **A policy on what the bot's authority may be used for.** Inside scripts
   `command` and `pay` do not exist; forced digging, faction create / leave /
   disband / kick / relations, overwriting the faction notes and `logoff` are
   refused; selling, chatting, notes and attacks are capped per script.
   Skills that fail three times in a row are quarantined until a human reads
   and re-saves them. Skill files stay readable on disk for review.

What remains is V8 itself: a JIT bug could in principle cross layer 2 into
layer 1, which holds no secrets. The details are in
[docs/scripts-and-skills.md](docs/scripts-and-skills.md).

## Reporting

Open a private security advisory on the GitHub repository (Security → Report
a vulnerability) rather than a public issue. Include the transcript or script
that triggers the problem if you have one; `data/sessions/` and `data/skills/`
contain nothing secret by design.
