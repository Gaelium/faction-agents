# Troubleshooting

Organised by what you see. Each entry says why it happens, what the code
already does about it, and where to look. Two files answer most questions:
`data/logs/<bot>.log` (one JSON line per event, mirrored to the bot's
stdout, so the orchestrator shows the same lines) and `server/logs/latest.log`.
The transcript in `data/sessions/<bot>/*.jsonl` has every tool call and
result; `node bots/agent/analyze_session.js` summarises the newest one.

## Starting up

**`start.sh` says `Java 8 not found`.**
Paper 1.8.8 needs Java 8 and the script only looks in the macOS places
(`/usr/libexec/java_home -v 1.8`, the Zulu and Temurin install paths).
Install it (`brew install --cask zulu@8`, or `openjdk-8-jdk` on Debian) or
point `JAVA8_HOME` at the JDK directory before running `./start.sh`.

**BotBridge logs `Redis ping failed` at boot.**
Redis was not up when the plugin enabled; events are dropped until it is.
`redis-cli ping` must answer `PONG`; then `botbridge reconnect` in the
server console (or restart). `botbridge status` shows the host and the
last error.

**The bot exits at once with `ModelClient needs LLM_API_KEY or ANTHROPIC_API_KEY`, or `GeminiClient needs GEMINI_API_KEY (or GOOGLE_API_KEY)`.**
`.env` is missing or the variable is unset, or you ran `node` without
`--env-file=.env` (the npm scripts add it). Copy `.env.example`, fill the
key, and use `npm run bot -- <profile>`. The log line before the exit is
`agent_boot_failed`.

**Gemini answers `API key not valid`.**
The adapter appends the fix to the error: a Google AI Studio key looks
like `AIza…` or `AQ.…` with nothing before or after it (a stray character
in `.env` has caused a restart loop before), and the Generative Language
API must be enabled for the key's project. `node --env-file=.env
bots/agent/smoke_gemini.js` reproduces it in seconds without Minecraft.
HTTP 429 and 5xx answers are retried with a growing delay before they are
reported.

**`agent_boot` then `mc_end` or `mc_kicked`, and the process exits.**
The bot connected and was dropped. `data/logs/<bot>.log` has the reason:
`ECONNREFUSED` (the server is not up on the profile's `host:port`),
`online-mode` (the server verifies accounts; `server.properties` needs
`online-mode=false`), a version mismatch (the profile says `1.8.9`; the
server must be 1.8.8/1.8.9), or a whitelist. The loop stops with reason
`disconnected:<reason>` and the process exits 1, which the orchestrator
counts as a crash: restarts back off 5 s, 15 s, 45 s, 120 s, 300 s, and
after five crashes without ten minutes of uptime the bot is marked
`unhealthy` until the next scheduler evaluation.

**`/kit starter` says no permission, or the bot has no armour after login.**
The LuckPerms groups were never created. Run the permission block in
[setup.md](setup.md#4d-permissions); `essentials.kits.starter` and
`essentials.kit.starter` are both needed because Essentials versions differ.

**`You do not have access to that command` in chat; the `teleport` tool fails with `denied`; `pay` or `sell` fail.**
A permission is missing for the command the tool sent: `essentials.spawn`
and `essentials.home` for `teleport`, `essentials.sethome` for `command
sethome`, `essentials.pay`, `essentials.sell`, `essentials.balance`,
`essentials.msg`. The same setup block grants them. Massive Factions
commands need nothing extra.

**`zones_server_truth_unavailable` at boot.**
Neither `plugins/WorldGuard/worlds/world/regions.yml` nor
`mstore/factions_board/world.json` could be read under `MC_SERVER_DIR`
(default `<repo>/server`), so the bot uses a built-in circle of radius 200
around (420, 220): right for the reference world, wrong for yours. Set
`MC_SERVER_DIR` to the real server folder. A healthy boot logs
`zones_loaded_from_server` with the shapes it found.

**`faction_rules_default` at boot.**
`mstore/factions_mconf/instance.json` was not readable, so the numbers
come from `bots/agent/factionRules.defaults.json`. Harmless if your server
runs the shipped config; otherwise set `MC_SERVER_DIR` or edit the
defaults file.

**`position_packet_patched` appears in the log.**
1.8.9 sometimes sends position packets with null coordinates after
knockback; unpatched, they froze mineflayer's physics. `bots/core/bot.js`
rewrites the null axes to the current position before mineflayer sees the
packet and logs the first hit and every tenth. It is information, not a
problem, unless a bot also stops moving, in which case the log around it
tells whether the server or the bot stalled.

## Moving

**The bot walks into its own door and stops, or digs out through a wall.**
mineflayer-pathfinder cannot pass a two-block door, and prismarine's 1.8
collision table gives every door state the same hitbox. `bots/agent/tools/door.js`
wraps every walk that starts or ends inside the house: it reads the
panel's real position from the door's facing and hinge bits, toggles the
door only when the panel is across the doorway, walks the free lane, and
closes the door behind; `bots/core/doorPhysics.js` tells the client that
an open door has no hitbox. `goto` never digs the bot's own walls (`dig`
refuses them without `force`). Look for `door_physics_installed` at boot
(without it the patch never applied; it now waits for mineflayer to
define `blockAt`), then `agent_door_geometry` and `agent_door_pass` lines.
Failure reasons: `inside_blocked` (a block on the cell behind the door:
dig it with `force`), `outside_unreachable` (water or a hole in front of
the door: place blocks or teleport home), `no_step_block` (the doorway is
more than two blocks above the ground and the bot has no dirt or cobble to
build a step), `door_stuck`, `walk_failed`.

**Every `goto` times out and the bot is standing on a fence.**
A player on a fence top (1.5 blocks tall) has no pathfinder move. `unstick`
detects it (`on_fence`) and steps off; a `goto` that fails from a fence says
so in its `hint`. Farm blueprints have a gate in the south fence for this
reason.

**The bot sinks and cannot get out of deep water.**
The 1.8 pathfinder sinks the player. Water is a forbidden step from land
and only expensive when already swimming; the drowning reflex holds jump
until the head is clear; `unstick` (`strategy: swim`, chosen automatically
when in water) floats up and swims to the nearest shore. While it swims it
ignores drowning damage so the event cannot cancel the tool that saves the
bot. If `unstick` returns `still_swimming` the model is told to call it
again or `teleport`.

**`leave_spawn` runs for its whole timeout, or the log fills with `leave_spawn_hop`.**
Older code re-targeted the bot's own position when it spawned just outside
the WorldGuard box but inside the margin and hopped thousands of times.
`leave_spawn` now pushes the target clear of every zone plus the margin
(default 48 blocks), never hops faster than once a second, and returns
`partial` with `still_inside`, `moved` and `attempts` when the timeout
(default 150 s) runs out, telling the model to call it again or `goto` a
point farther in the same direction. If it never clears, check
`zones_loaded_from_server`: a fallback circle can put "spawn" where your
world has none.

**`mine` returns `no_progress` after about 90 seconds.**
A stall watchdog ends a `mine` call after 90 s with no inventory change
instead of letting the pathfinder fail for the whole 300 s budget. The
result carries `stalled_after_s` and the hint to move 20+ blocks, dig a
fresh tunnel at another y, or `scan` for a different deposit. Repeated
`no_progress` at the same spot means the ore is behind lava, water or
someone's claim.

**`goto` with `hint: you did not move at all`.**
The area is not loaded or the bot is wedged. `unstick` (sidestep, pillar,
surface) or `teleport`.

## Factions and money

**`faction_perm_denied` from `dig`, `place`, `mine` or `build`; chat says `<Faction> does not allow you to build`.**
The bot joined a faction and is a *recruit*, who cannot build or break on
faction land. Massive Factions' fix is the leader (or an officer) running
`/f rank <bot> member`; the bot's `f rank` action does it for its own
faction, the `join` result and the prompt tell it to ask, and the
`faction_denied` event is queued so the model stops retrying. A human-led
faction has to rank its bots by hand.

**`f claim` fails with "not enough power" right after founding.**
Not a bug: players start at 0 power and gain 2 per hour online, and a
chunk costs 1, so a solo founder waits about 30 minutes (the exact numbers
come from `server/mstore/factions_mconf/instance.json` and appear in the
claim hint and the system prompt). Recruiting members adds their power.
See [server.md](server.md#the-factions-economy).

**`board` says everything is `unavailable`.**
BotBridge is not answering: the plugin is not loaded, Redis is down, or the
jar predates the query commands. The bot falls back to a parsed `/balance`;
the fix is on the server (`botbridge status`). See [botbridge.md](botbridge.md#troubleshooting).

**The dashboard header says `redis DOWN`.**
That light is the orchestrator's own subscription for the chat feed, not
the bots' bus. `redis-cli ping`; check `REDIS_HOST` / `REDIS_PORT` in the
orchestrator's environment and `redis_sub_failed` in
`data/logs/orchestrator.log`. It reconnects on its own; the bots keep their
own connections regardless.

## Building and farming

**`build` a farm returns `need_bucket`.**
Water cells are placed best-effort and a dry plot reverts to dirt, so the
builder refuses a farm without a bucket unless `allow_dry` is passed. Craft
one (3 iron ingots); `build` then fills it at water within reach and lays
the channel, and the result reports `water: {placed, cells}`.

**Water is not placed, or lands beside the plot.**
In 1.8 the server pours where the look ray hits, so the pour aims at the
top face of the reference block, waits a tick after turning, then up to
1.5 s for the water to appear, with one retry. A bucket is filled only from
a source block (metadata 0) while standing on a dry cell beside it, and
the use packet goes out two ticks after the look packet; sent in the same
tick, the server ray-traces with the old heading. If water still fails,
the plot is usually not an air cell (`hint: water goes into an air cell`).

**`farm` says `no farmland within radius`; seeds are never planted.**
There is no farm plot yet: build `wheat_farm_small` first (a hoe and a
bucket). Tilling waits up to 1.5 s for the server's block update before
judging a cell, and `mine wheat_seeds` sweeps tall grass for seeds.

**`build` returns `too_close_to_spawn` or `no_site`.**
Sites inside or within 48 blocks of a protected zone are refused; the hint
says to move farther out, or to survey somewhere flatter.

**A structure is finished but the bot cannot get in, or later mines its own house.**
On a verified completion the build tool registers the wall cells with the
movement layer, so paths go through the door and `mine`/`dig` refuse those
cells without `force`. Homes built before that existed are filled in at the
next boot (`refreshHomeCells`). `unstick` inside the house does nothing
(`inside_home`) and tells the model to `goto` outside through the door.

## Night and survival

**Bots stand still or hide all night.**
The `dusk` event carries the bot's torches, armour pieces and sword; with
a sword, two armour pieces and eight torches it says to keep working
(light the area, mine underground, smelt, craft, farm by torchlight, sell,
plan); otherwise it says get inside. `wait` is for a specific pending job,
never for the night, and the prompt repeats the fighting rules (one mob:
fight; two or a creeper: door first; below 8 hp eat behind a door;
teleport to spawn, not home, when the door is unlit). If a bot idles
anyway, read its focus card and the `[events]` lines in the transcript;
the `[pace]` nudge appears after three turns of looking without acting.

**The bot dies in lava or drowns repeatedly.**
Lava and drowning are Tier-0 reflexes in `bots/agent/nerves.js`: one
immediate action (step out of lava to the nearest safe block; hold jump
when drowning), then the running tool is cancelled so the model gets the
next turn at once. `teleport` is uninterruptible (only death or shutdown
cancel it) and `attack` is shielded from mob and player damage so a fight
finishes. `analyze_session.js` prints `deaths` and `interrupts`; more than
one death per run from lava or drowning is the kill criterion the reflexes
are tested against.

**A fight ends with `remaining_hostile: creeper`.**
Creepers are never auto-targeted. The model is expected to get behind a
door; `attack` keeps fighting zombies, skeletons and spiders within 6
blocks after the first target dies (`until_clear`).

## Scripts and skills

**`run_script` returns `timeout`.**
The default budget is 60 s (`timeout_s`, at most 300). A script that
blocks its thread after an `await` cannot be interrupted by `vm`; the main
thread waits three seconds past the budget and terminates the worker, the
bot keeps playing, and the next script gets a fresh worker. Interrupts
(`interrupted`) unwind a script mid-sleep or mid-tool the same way.

**`out_of_memory`.**
The worker runs with a 128 MB old-space limit; a memory bomb dies inside
it. Nothing on the main thread is affected.

**`not_allowed_in_scripts`, listed under `denied`.**
Inside scripts `command` and `pay` do not exist; `dig` and `unstick` with
`force`, `f create|leave|disband|kick|enemy|ally|neutral|unclaim`,
`faction_notes write` and `logoff` are refused; `sell`, `say`,
`faction_notes`, `note`, `f`, `teleport` and `attack` are capped per
script; `run_script`, `use_skill`, `save_skill`, `skills`, `memory`,
`think` and `focus` cannot be called from a script. This is policy, not a
bug: the model's own code gets less authority than the model
([scripts-and-skills.md](scripts-and-skills.md)).

**`use_skill` returns `skill_disabled`; `skills` shows `disabled`.**
A skill is quarantined after three consecutive failures (`skill_disabled`
in the log with the reason). Read it (`skills show=<name>`), fix it, and
`save_skill` a new version; a new version starts with a clean streak. The
files stay readable in `data/skills/` for a human to review.

## Cost

**A session stops with reason `budget`.**
`AGENT_MAX_USD` (default $5 per session) was reached; the loop ends
itself. The orchestrator's `--budget` is the fleet ceiling per rolling 24
hours and pauses spawning (or kills, with `--budget-action kill`) above it.
Per-model rates and what an hour costs are in [costs.md](costs.md).

**Gemini costs as much per hour as Claude despite a lower token price.**
It takes about twice the turns per hour, so the hourly figure comes out
the same. `AGENT_EFFORT=low` and a lower `AGENT_MAX_TURNS` are the levers.

## `/kit starter` answers "You do not have access to that command"

**Cause.** The bot has the kit node (`essentials.kits.starter`) but not the
command node `essentials.kit`; Essentials checks the command first. "That
kit does not exist" means the kit node or the kit definition is missing
instead.
**What the code does.** The bot carries on without the kit (no tools, no
armour); `wear_armor` reports nothing to wear and nothing retries.
**Check.** `lp group default permission info` in the console must list
`essentials.kit`, `essentials.kits.starter` and `essentials.kit.starter`;
the full block is in [setup.md](setup.md#4d-permissions). `/kit` with no
argument lists the kits the player may take.

## The bots ran on Claude although `GEMINI_API_KEY` is set

**Cause.** `AGENT_MODEL` decides the model; the key alone changes nothing,
and an older `.env` that sets `LLM_MODEL` to a Claude model keeps the bots
there.
**What the code does.** The orchestrator prints `bots run on <model>
(<which variable>)` before spawning and logs `fleet_model`; every bot's
first log line, `agent_boot`, names its model.
**Check.** `AGENT_MODEL=gemini-3.8-flash` in `.env` (and
`AGENT_STRATEGIST_MODEL` if the `think` tool should stay on Gemini too);
see [configuration.md](configuration.md).

## Every bot walks the same way out of spawn

**Cause.** They spawn on one block; the old exit pushed each straight away
from the zone centre along the same vector, and they all scanned for the
same nearest trees (ten bots ended a session within 40 blocks of each
other).
**What the code does.** `leave_spawn` walks each bot out on a heading
derived from its name and reports it as `dir`; the login message tells the
bot which side of spawn is its own; `direction` overrides it.
**Check.** `leave_spawn_hop` in the bot log shows the target; the result's
`dir` differs between bots.
