# Scripts and skills

The model can write JavaScript for a job no single tool covers (sort a
chest, torch a tunnel every eight blocks, plant a cactus row, fence a
perimeter), run it, and keep it as a named skill every bot on the machine
can reuse. This is the one place model-written code executes, so it runs
in a sandbox with three layers and a policy on what the bot's authority
may be used for. Code: `bots/agent/skills.js` (host side, policy, skill
store), `bots/agent/scriptWorker.js` (the worker thread), and the four
tools in `bots/agent/tools/script.js`.

## The four tools

| Tool | What it does |
|---|---|
| `run_script` | runs `code` (the body of an async function) with a `timeout_s` (default 60, max 300) and the usual `interrupt_on`; returns what the script returned plus its log lines and the last 20 tool calls it made |
| `save_skill` | writes `data/skills/<name>.js` and updates `data/skills/index.json`; the code is marked *verified* when it is byte-for-byte the code of the last successful `run_script` in this session |
| `skills` | lists or searches the shared library with uses, ok and failed counts, author and version; `show=<name>` returns a skill's code |
| `use_skill` | runs a saved skill with a `params` object, same sandbox and limits; the outcome is tallied on the skill |

Full schemas: [tools.md](tools.md#scripts-botsagenttoolsscriptjs).

## What a script sees

Inside the script these globals exist and nothing else:

| Global | Meaning |
|---|---|
| `tools.<name>(input)` | any exposed tool, awaited; same handlers, same cancel token, same honest results as the model's own calls. An unknown name throws with the list of available tools |
| `me.pos()`, `me.inventory()`, `me.health()`, `me.food()`, `me.holding()`, `me.time()` | read-only self queries |
| `world.blockAt(x,y,z)`, `world.isSolid(x,y,z)`, `world.findBlocks(names, radius, max)`, `world.entities(radius)`, `world.players(radius)` | read-only world queries (`findBlocks` searches at most 64 blocks out and returns at most 256, nearest first) |
| `await sleep(ms)` | a pause, at most 60 s per call, rejected when the script is cancelled |
| `log(...)` (and `console.log`) | collects up to 60 lines returned with the result |
| `params` | the object `use_skill` passed |
| `cancelled()` | true once an interrupt or timeout fired; loops should check it |

The result of a script is the result of `run_script`: if the script returns
an object with `status` `ok`, `partial` or `failed`, that object is the
result; any other return value comes back under `returned`. Failures have
their own reasons: `syntax_error` (with the line), `script_error` (name,
message, line), `sync_loop`, `timeout`, `out_of_memory`, `worker_crashed`,
`busy` (one script per bot at a time), `not_allowed_in_scripts`,
`script_cap`, `no_such_tool`.

The prompt's rules for the model: await every call, one job per script,
under about 60 lines, stop after two identical failures, return a status
object, test with `run_script` before `save_skill`, and prefer proven skills
over writing new ones.

## The sandbox

### Layer 1: a worker thread with nothing in it

Scripts run in a `worker_threads` Worker (`ScriptHost` in `skills.js`)
started with an empty environment (`env: {}`, so no API key), resource
limits (128 MB old space, 32 MB young, 16 MB code range, 4 MB stack), its
stdout and stderr captured, and no reference to the bot, Redis or SQLite.
One worker per bot process; one script at a time. Everything a script
wants from the world is a message to the main thread:

- tool calls are asynchronous messages (`tool` → `tool_result`), the main
  thread runs the real handler and answers with a JSON string;
- `me.*` and `world.*` queries are synchronous: the worker posts a `query`
  message, then blocks on `Atomics.wait` over a `SharedArrayBuffer` flag
  (15 s limit) until the main thread has written the JSON reply on a
  `MessageChannel` port and notified the flag;
- `sleep` is a worker timer; a cancel message rejects every pending sleep;
- a cancel flag in the same shared buffer is what `cancelled()` reads.

When the script must stop (timeout, an interrupt, shutdown) the host sets
the flag and posts `cancel`. A script that keeps running anyway, which is
what a synchronous loop after an `await` does, is cut off: after a 3 s
grace the host terminates the worker and starts a fresh one for the next
script; the bot never stops responding, and the tool returns `timeout` (or
`interrupted`) with a note that the sandbox was restarted. A memory bomb
dies inside the worker's limits (`out_of_memory`); a crash is
`worker_crashed`; both restart the worker.

### Layer 2: a sealed realm inside the worker

Inside the worker the script runs in a `vm` context whose global object has
a null prototype, with `codeGeneration: { strings: false, wasm: false }`,
so `eval`, `new Function` and WebAssembly are off. Every global the script
can see (`tools`, `me`, `world`, `sleep`, `log`, `console`, `params`,
`cancelled`) is created by code running inside that context
(`INSTALL_SRC` in `scriptWorker.js`); the host bridge exists only as a
closure variable those functions capture, and every value crossing the
boundary is a JSON string or a primitive. So `this.constructor.constructor`,
`tools.x.constructor`, a returned promise, a thrown error, a result object
or `params` all belong to the sandbox realm, where code generation is off.
`process` and `require` do not exist there. The sync part of a script has a
5 s budget (`vm`'s `timeout`), which turns a runaway synchronous loop into
`sync_loop` with a hint to await inside loops.

`test_agent.js` section 21 probes each of these routes (constructor chains,
returned promises, thrown errors, results, params), the post-await hang
(killed in under 8 s), the memory bomb and the policy below.

### Layer 3: a policy on what the bot may do from a script

Scripts have the bot's authority in the world but not its judgement.
Deliberate, irreversible or money-moving acts stay with the model.

| Rule | Detail (`skills.js`) |
|---|---|
| Not exposed at all | `run_script`, `use_skill`, `save_skill`, `skills`, `memory`, `logoff`, `think`, `focus` (`SCRIPT_BLOCKED`), and `command` and `pay` (denied for every input, so they are not listed either) |
| Denied by input (`scriptDeny`) | `dig` and `unstick` with `force`; `f` with `create`, `leave`, `disband`, `kick`, `enemy`, `ally`, `neutral` or `unclaim`; `faction_notes` with `action: write` (append is allowed); `logoff` |
| Capped per script (`SCRIPT_CAPS`) | `sell` 3, `say` 5, `faction_notes` 2, `note` 3, `f` 6, `teleport` 3, `attack` 40 |

A denied call returns `not_allowed_in_scripts` with the reason as the hint
and is listed under `denied` in the script's result (first five); a call
over its cap returns `script_cap`. Inputs are validated against the tool's
schema exactly as the model's own calls are. The script's cancel token is
chained to the tool's, so an interrupt unwinds the script mid-sleep or
mid-tool, and any handler still in flight is cancelled when the script
ends for any reason.

### What remains

The layers leave V8 itself: a JIT bug could in principle cross layer 2 and
land in layer 1, which holds no secrets, no bot and no network beyond the
message port. The other residual is in-game: a script can still do
everything a bot may do with its own hands, bounded by the caps. The
saved-skill files stay readable on disk for exactly that reason; a human
reviewing `data/skills/` is the last safety net.

## The skill store

`data/skills/` is shared by every bot on the machine ([data-and-storage.md](data-and-storage.md)):

- `<name>.js` holds the code with a readable header: the description, the
  `params` line, the author, the version, the date, and whether it was
  verified by a successful `run_script`.
- `index.json` holds the metadata per skill: `name`, `description`,
  `params`, `author`, `updated_by`, `created`, `updated`, `version`,
  `uses`, `ok`, `failed`, `verified`, `last_status`, `last_used`,
  `fail_streak`, `disabled`, `disabled_reason`, `disabled_at`.

Names match `^[a-z][a-z0-9_]{2,31}$`; code must parse (a syntax error is
refused with its line) and stay under 12 KB. Saving an existing name makes
a new version, which resets the failure streak and re-enables a quarantined
skill. `skills` lists by net success (ok minus failed), then uses. The
store re-reads the index on every list, so one bot's save shows up for the
others at once.

**Quarantine.** Three consecutive failures (`QUARANTINE_AFTER`) mark a
skill `disabled` for everyone; `use_skill` then answers `skill_disabled`
with the reason, and `skills` shows `disabled`. Someone reads the code
(`skills show=<name>`), fixes it and saves a new version to re-enable it.
The log line is `skill_disabled`.

## Where to look when it fails

| Symptom | Look at |
|---|---|
| every script returns `timeout` | the `hint` says whether it stopped on request or had to be killed; `script_worker_killed` in the bot log; scripts that never `await` in a loop |
| `sync_loop` | a `while` or `for` that computes without awaiting for more than 5 s |
| `not_allowed_in_scripts` or `script_cap` | `denied` in the result; the tables above; the job belongs to the model's own hands |
| `busy` | the previous script has not finished; `shutdownScriptHost()` at process exit terminates it |
| a skill everyone stops using | `disabled_reason` in `index.json`; fix and save a new version |
| `script_worker_stderr` lines | the worker printed something; stdout is swallowed, stderr is logged |

`analyze_session.js` prints `scripts: N run (ok, timed out) · skills saved · skills used` for a session.
