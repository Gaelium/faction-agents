# bots/agent

The agent loop: one model conversation per session, playing through the
tools in `tools/`. The documentation moved to `docs/`:

- [docs/agent-loop.md](../../docs/agent-loop.md) — boot, one turn, interrupts and nerves, context, transcripts, the two model adapters
- [docs/tools.md](../../docs/tools.md) — every tool (generated from the schemas; `npm run docs`)
- [docs/scripts-and-skills.md](../../docs/scripts-and-skills.md) — model-written scripts and the sandbox
- [docs/costs.md](../../docs/costs.md) and [docs/history.md](../../docs/history.md)

Run one bot: `npm run bot -- <profile>`; tests: `node bots/agent/test_agent.js`.
