# Contributing

## Set up

Follow [docs/setup.md](docs/setup.md) once. For code work you only need Node
and `npm install`; the server and Redis are needed only to run a bot.

```bash
npm test                        # every suite, ~90 s, no server or key
node scripts/dead_code.mjs      # every source file must be reachable from an entry point
npm run docs                    # regenerate docs/tools.md and the env table after touching tools or process.env
```

`npm test` includes both checks above (`scripts/test_docs.js` fails when a
generated doc is stale or a link in any Markdown file is broken), so a green
`npm test` is the bar for a pull request.

## House style

- ES modules, plain `node`, no build step, no TypeScript, no test framework.
  Each test is a script that prints `N passed, M failed` and exits non-zero on
  failure, next to the code it tests, named `test_<topic>.js`.
- Every file opens with a comment that says why it exists and how it is used,
  not what each line does. Keep it true when you change the file.
- Tools never throw to the loop and never lie: a tool that did part of the
  job returns `partial` with what it achieved; one that was interrupted says
  so and by what. See `bots/agent/tools/result.js`.
- Log with the structured logger (`log.info('event_name', { fields })`),
  snake_case event names, so the orchestrator and `analyze_session.js` can
  read them.
- No new controller, timer or watchdog may start an action while a tool is
  running. If a behaviour needs sequencing, it is a tool the model calls or a
  Tier-0 reflex that takes one step and interrupts
  ([docs/agent-loop.md](docs/agent-loop.md)).
- Prefer a chunkier tool over more turns; every extra turn costs money
  ([docs/costs.md](docs/costs.md)).

## Running one bot against your server

```bash
npm run bot -- test_bot_oss                          # Claude
AGENT_MODEL=gemini-3.8-flash npm run bot -- test_bot_oss
node bots/agent/analyze_session.js                  # readout of the newest transcript
```

Use a test profile, not one of the sixteen characters, and set `AGENT_MAX_USD`
low while iterating. Transcripts land in `data/sessions/<bot>/` and are the
first thing to read when a bot misbehaves ([docs/running.md](docs/running.md)).

## Adding a tool

1. Pick the group file under `bots/agent/tools/` (or add one and register its
   factory in `tools/index.js`). A tool is an object:
   `{ name, description, input_schema, defaultInterrupts, uninterruptible?, parallelSafe?, handler(input, { cancel, log, deps }) }`.
   The description is what the model reads: say what the tool does, what it
   returns, and when to use it, in one paragraph.
2. Build it on the world substrate (`bots/world/`) or an existing primitive;
   honour the cancel token (`awaitHandle`, `cancellableSleep` in
   `bots/agent/cancel.js`) and return through `result.js` helpers.
3. Add checks to `bots/agent/test_agent.js` with the stub bot (no server), and
   a structural test elsewhere if the mechanics are new.
4. `npm run docs` to regenerate [docs/tools.md](docs/tools.md); mention the
   tool in the prompt (`bots/agent/prompt.js`) only if the model needs a rule
   about it, not to advertise it.
5. Run it live once and read the transcript.

Blueprints: [docs/building.md](docs/building.md). BotBridge events and
queries: [docs/botbridge.md](docs/botbridge.md). Characters:
[docs/profiles.md](docs/profiles.md).

## Pull requests

One change per PR, tests green, docs regenerated, and the commit message
says what changed and why. Do not commit anything from `data/`, `.env`, the
server's jars, world or player files; `.gitignore` covers them and
`git status` should stay quiet after a run.
