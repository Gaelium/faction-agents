*The original design note for the agent loop, written 2026-09-01 against the planner/executor stack it replaced. Kept verbatim as history; the current code is described in [../agent-loop.md](../agent-loop.md) and the shortened story in [../history.md](../history.md). The one real player name in the original examples was replaced by the shipped character Marla_K.*

# Agent Overhaul — One Brain, One Pair of Hands, a Nervous System

_Proposal for replacing the strategic/tactical/reflex control stack with a single continuous agent loop per bot. Written 2026-09-01 against branch `state` (HEAD `f7f8f53`), the TestBot43 log (2026-06-20, 2.6 h), and the three prior audits (`BOT_COMPETENCE_OVERHAUL.md`, `SKILL_HARDENING_PLAN.md`, memory notes on fine-tuning and the ambition ceiling)._

---

## 0. The one-paragraph version

The bots do not fail because the model is dumb or because the mechanics are bad. They fail because **eight different pieces of code can hold the actuators and the model is not one of them.** Goal picker, planner, task runner, executor, tactical planner, observer, stuck-recovery state machine, build watchdog, mob scanner: each was added to fix a symptom, and each one now negotiates with the others through gates, valves, dedup checks, suppression counters, and cancel calls. The model's decision is *deferred* more often than it is *executed*. Fix: collapse all of them into **one agent loop** (Claude with tool use, one long-lived conversation per session) that is the only thing that sequences actions, over a library of **chunky, honest, interruptible skills**, with reflexes demoted from *controllers* to *interrupts*. About 12k lines go away, about 2.5k come in, and ~10k lines of real mechanics (primitives, blueprints, movement, combat, memory, factions, bridge) survive untouched. Focus, multitasking, and long memory then fall out of the loop design instead of being bolted on.

---

## 1. Where it actually stands

### 1.1 What TestBot43 did for 2.6 hours

| Signal | Count | Meaning |
|---|---|---|
| `llm_call` | 183 | ~70 model calls/hour, all parsed, median 3.3 s, ~$0.25/bot-hour on Sonnet 4.6 |
| `goal_picked` | 117 | one strategic pick every ~80 s |
| `blueprint_place_failed` | 275 | mechanics still fail, but see below |
| `stuck_recovery_state` | 170 | the state machine ran ~65×/hour |
| `task_runner_cancel` | 83 | something tore down running work 32×/hour |
| `strategic_tick_deferred_planner_busy` + `tactical_tick_skip_build_phase` + `tactical_tick_skip_planner_driving` + `observe_suppressed_during_build` + `strategic_trigger_suppressed` | 213 | **the model's output was thrown away 213 times** |
| `build_project_resumed` | 94 | the build restarted 94 times |
| `planner_archetype_mismatch` | 119 | the planner and picker disagreed 119 times |
| structures completed | 0 | |

Read that table as one fact: the intelligence is available, cheap, and reliable, and it is disconnected from the hands. The 213 discarded decisions are the project's scope problem in a single number.

### 1.2 How the code got here

`git log` is 38 commits since April; the messages are "Building fixes" ×3, "stuck fixes", "Huge fixes", "freeze recovery", "combat-pathfinder coordination", "Unify Stuck Recovery into a State Machine", "Gate Pillar-Up on plannerDriving", "Build Loop Equip Dedup". Every entry is a new controller or a new gate between controllers. PROJECT_STATUS.md Phases 14.1 → 14.8 are eight consecutive arbitration fixes.

The vocabulary of the executor tells the same story: `plannerDriving`, `_buildPhaseActive`, `URGENT_INTERRUPT_GOALS`, `BUILDING_INTERRUPT_GOALS`, `GOAL_FAMILIES`, `execute_deferred_same_family`, `stuck_override`, `_suspendedQueue`, `maybeResumeSuspendedQueue`, `alignment_suppression`, `_alignedStreakCount`. None of this is Minecraft. It is the system arguing with itself.

### 1.3 Why the earlier audits were right and still missed the lever

The fine-tune audit found ~85% of failure mass is "mechanical / control-flow / architecture code below the decision layer" and concluded "fix mechanics first." True, but it filed *control-flow arbitration* under "code to fix" rather than "code to delete." The ambition-ceiling audit said the LLM should own "a hierarchical, revisable standing plan, not a leaf pick per tick" and that low-level LLM control "was tried and oscillated." Also true, and the reason it oscillated was not model competence: `tacticalPlanner` was a *second* controller emitting a verb every 10 s while `taskRunner` held the actuators. Two hands on one steering wheel. The answer is not "less LLM" and not "LLM at the packet level." It is **exactly one sequencer, and make it the model.**

---

## 2. The reframe

```
                 ┌──────────────────────────────────────────┐
                 │  BRAIN  — one agent loop per session      │
                 │  Claude + tools, append-only transcript,  │
                 │  context window = working memory/focus    │
                 └───────────────┬──────────────────────────┘
        tool calls ↓             │             ↑ tool results + events
                 ┌───────────────┴──────────────────────────┐
                 │  HANDS — skill library                    │
                 │  chunky · honest · bounded · cancellable  │
                 │  (mine, craft, build, goto, fight, say…)  │
                 └───────────────┬──────────────────────────┘
                                 │ cancel token
                 ┌───────────────┴──────────────────────────┐
                 │  NERVES — reflexes that interrupt, never  │
                 │  steer: damage, lava, drowning, hunger,   │
                 │  chat-mention, faction callout            │
                 └──────────────────────────────────────────┘
                                 │
                        mineflayer / BotBridge / Redis
```

Three rules make the whole thing work:

1. **Only the brain sequences.** No timer, watchdog, scanner, or state machine may start a second action while a tool is running. A reflex may take *one* immediate survival action (step out of lava, surface, eat) and must then hand control back.
2. **Every tool returns the truth, including "I was interrupted."** `{status, reason, progress, world_delta, elapsed_s, interrupted_by?, events[]}`. The brain never has to infer what happened from a stale state dump; it reads it in the result.
3. **The transcript is append-only and is the bot's mind.** Its plan from 40 minutes ago is in context. It is not re-asked "what is your goal" from scratch every 3 minutes. When the context gets long, it is compacted with a model-maintained focus card that survives.

This is the Claude Code architecture applied to a Minecraft player. It is also the architecture the API is now built around (tool loop, context editing, compaction, memory tool, advisor), so most of the hard parts are commodity.

---

## 3. Architecture

### 3.1 The loop

- **Manual tool loop** (not the SDK tool runner): the harness needs to inject events, honor cancel tokens, account cost, and write transcripts. ~400 lines in a new `bots/agent/loop.js`.
- **One conversation per session.** Session = orchestrator-scheduled login → logoff. The transcript is saved to disk turn-by-turn (`data/sessions/<bot>/<ts>.jsonl`). This is the new debug surface: a failure is a transcript you read, not a JSONL you grep for `stuck_recovery_state`.
- **System prompt is static** (identity, persona, values, server rules, the skill cheat-sheet). No state in it, so it caches. World state comes in through tools. Per-turn reminders go in the tool-result user message, not the system prompt.
- **Adaptive thinking on**, `effort` tuned per model (start `medium`; the loop is mostly routine, escalation is a tool, see 3.5).
- **Parallel tool use is allowed** for independent calls (`say` + `goto`, `equip` + `look`). Actuator tools are serialized by the harness; perception and social tools are parallel-safe.
- **Recommended brain:** `claude-opus-5` for the spike so the quality ceiling is measured first, then decide whether to step down (cost table in §4). `claude-sonnet-5` is the documented step-down. Haiku 4.5 is not recommended as the brain; it is the right model for the chat-triage classifier (3.3).
- **Append-only from day one.** Claude Fable 5.1 rejects edited history (preserved thinking). Never rewrite earlier turns; compaction and context editing are the only history mutations, and they are API-side.

### 3.2 The skill surface (v1, ~22 tools)

The altitude is the whole design. Too low (the old `move_to`/`mine_block` verbs) and the model burns a turn per block and fights the pathfinder. Too high (the old `ESTABLISH_BASE` objective) and code is back in charge of sequencing. The right altitude is "what a player would say they are doing for the next 30 seconds to 5 minutes."

| Group | Tool | Chunky? | Returns |
|---|---|---|---|
| Perceive | `look()` | instant | pos, hp, food, time, light, nearby players/mobs/blocks of interest, 1-line mood. ≤300 tokens. The **only** scene-dump tool. |
| | `scan(block_type, radius)` | instant | coords of matches, nearest first, capped |
| | `inventory()` | instant | grouped counts, armor worn, tool durability |
| | `board()` | instant | money, baltop rank, faction power/land/relations, who is online, own claims. Via BotBridge (3.6) |
| Move | `goto(target, {timeout})` | 5–60 s | arrived / partial + where stuck + what is around |
| | `follow(player)` / `flee_from(x, dist)` | bounded | |
| | `teleport(home\|spawn\|warp)` | ~5 s | wraps the existing `/home` path incl. cooldown truth |
| | `unstick()` | ≤30 s | the salvaged dig-escape / pillar / return-to-surface logic **as an explicit tool**, not a reflex |
| Gather | `mine(block, count, {vein:true})` | 1–5 min | mined, collected, remaining known deposits |
| | `collect_drops(radius)` | short | |
| | `craft(item, n)` / `smelt_start(item, n)` | short / **async** | smelt returns a `job_id` immediately |
| | `store(chest, items)` / `withdraw(chest, items)` | short | |
| | `equip(item)` / `eat()` | instant | |
| Build | `survey_site(blueprint, anchor?)` | short | feasibility, obstructions, materials delta |
| | `build(blueprint, anchor, {max_minutes})` | **long** | placed/failed by cell class, materials still needed, `reason` from the existing honest contract |
| | `place(block, pos)` / `dig(pos)` | instant | single-cell escape hatch |
| Fight | `attack(target, {until})` | bounded | outcome, damage dealt/taken, target hp/fled/dead |
| | `retreat(to)` | bounded | |
| Social | `say(text, {channel})` | instant | passes through `voiceFilter` |
| | `f(subcommand)` | short | parsed result from `factions.js` wrappers |
| | `sell(items)` / `pay(player, amount)` | short | parsed via `economyChat.js` |
| Mind | `focus(text)` | instant | sets the 200-token focus card (3.4) |
| | `memory` | instant | Anthropic memory tool (`memory_20250818`) over `data/memory/<bot>/` |
| | `faction_notes(read\|write)` | instant | shared per-faction doc in Redis (3.7) |
| | `think(question)` | ~20 s | strategist turn on Opus 5 (3.5) |
| | `jobs()` | instant | running async jobs and their state |
| Meta | `wait(seconds, {interrupt_on})` | bounded | the honest form of "AFK a bit" |
| | `logoff(reason)` | | writes the journal, ends the session |

Every actuator tool accepts `interrupt_on: [...]` (3.3) and a `cancel` token from the harness. Every result is capped around 400 tokens; the model asks for more with `look`/`scan` if it needs it.

Existing code maps onto this almost one-to-one: `mine` = `primitives.mineBlock` + `mineConnectedVein`; `build` = `blueprintBuilder` + `siteSurvey` + `placeGuard`; `goto` = `movement.goTo`; `attack` = `combat.engage`; `unstick` = `executor._digToEscape` + `_tryEmergencyPillarUp` + `_returnToSurface` + `exitProtection`; `store` = `primitives.storeItems`; `f` = `factions.js`; `sell` = `economyChat.js`. The skill contract from `SKILL_HARDENING_PLAN.md` Phase 0 (`skills/skillResult.js`) is the result shape. That work was the right foundation; it just had the wrong caller.

### 3.3 The nervous system: interrupts and attention (this is "focus" and "multitask")

Three tiers, decided by the harness, never by the running tool:

| Tier | Latency | Examples | What happens |
|---|---|---|---|
| **0 Reflex** | <1 s | in lava, drowning, fall damage, hit by a player, hp < 6 | Reflex takes **one** survival action (step out, surface, eat). Running tool is cancelled and returns `interrupted_by`. Brain gets the next turn immediately. |
| **1 Deliver at boundary** | next tool return | chat mention of my name, faction chat, `/pay` received, hostile mob within 8, hunger low, async job finished, join/leave of a known player | Queued into the `events[]` block of the next tool result. If the running tool was started with `interrupt_on` naming this event, it is cancelled instead. |
| **2 Background** | none | global chat not about me, ambient join/leave, weather | Counted, summarized as one line in `events[]` ("14 chat lines, nothing addressed to you"). The templated fast-path chat (existing `chatDispatcher` templates) may reply on its own for death/kill/join reactions. |

The model chooses its own attention per call: `mine(..., {interrupt_on: ['damage', 'chat_mention']})` while grinding, `build(..., {interrupt_on: ['damage']})` when it wants to stay heads-down, `wait(120, {interrupt_on: ['chat_any', 'player_within:16']})` when hanging out at spawn. **Focus is a parameter the bot sets, not a suppression valve the code applies.**

Multitasking, concretely:
- **Async jobs.** `smelt_start`, `farm_tend_start`, `wait_for_crops` return a `job_id`; completion arrives as a Tier-1 event. "Smelt while mining" is two tool calls and one event.
- **Parallel tool calls** for independent actions in one turn.
- **Chat without dropping the task.** A Tier-1 mention lands in `events[]`; the model answers with `say` and continues its loop, or decides the message matters and switches. Nothing in code decides that.
- **Reflex budget.** No reflex starts a multi-step behavior. No auto-pillar, no auto-dig-escape, no auto-flee-home. Those are `unstick`/`retreat` tools the brain calls after reading the interrupt. This single rule deletes `stuckRecovery.js`, `buildPhaseWatchdog.js`, the mob-scanner cancel path, and the run.js stuck-in-place watchdog.

A triage classifier (Haiku 4.5, ~50 tokens, or a regex first) decides Tier 1 vs Tier 2 for chat. That is the only place a second model runs on the hot path.

### 3.4 Memory: three horizons

| Horizon | Mechanism | What lives there |
|---|---|---|
| **Working memory** (minutes → hours) | the transcript itself | what I just did, what it returned, what I decided and why |
| **Focus card** (survives compaction) | `focus(text)` tool; harness re-injects it as the first user block after every compaction and at every session start | "Building builder_base_t1 at (-212, 64, 340), 60% done, need 40 more cobble. Next: mine cobble at the ravine east, then finish north wall. Blocked: door won't place at (-210,65,339), try a different cell." |
| **Long-term memory** (sessions → weeks) | Anthropic memory tool over `data/memory/<bot>/` (`journal.md`, `places.md`, `people.md`, `plans.md`), plus SQLite facts exposed as tools (`who_is(player)` from `relationships.js`, `known_locations()`) | who killed me and where, where my chest is, that Marla_K pays for iron, that faction X's base is at (…), my standing goals |

Context hygiene in order of cheapness: (1) tool results are capped at ~400 tokens; (2) context editing (`clear_tool_uses`) prunes old results once the transcript passes ~80k tokens; (3) server-side compaction (`compact-2026-01-12`) as the backstop past ~150k; (4) the focus card guarantees the plan survives (3) regardless of what the summarizer keeps. On logoff the model writes a journal entry via the memory tool; on login the first user turn is the memory index + last journal + a fresh `look()`.

`reflection.js`, `projects.js`, `progression.js`, and the `intentions`/`backlog_ops` machinery are all replaced by the model writing its own `plans.md`. That is the "durable agenda" Phase B was reaching for, without a second mechanism to keep in sync.

### 3.5 Two speeds of thinking without two controllers

The ambition-ceiling audit was right that open-ended strategy over a rich board state wants a frontier reasoning model. Do it without a second actor:

- `think(question)` is a tool. The harness calls `claude-opus-5` with the focus card, `board()`, the last journal, and the question, and returns a ~300-token memo *into the fast loop's context*. It never touches actuators. Fired by the model when it feels stuck or is about to commit to something big (found a faction, start a raid, spend money), and automatically by the harness at session start and every ~30 min.
- API-native alternative: the **advisor tool** (`advisor_20260301`, executor Sonnet 5 → advisor Opus 5 is a valid pair). Same idea, mid-generation, no harness code. Start with the explicit tool because you can log and read the memo; move to advisor if the round-trip matters.

### 3.6 Perception of the meta-game (BotBridge queries)

"You can't plan a raid you can't see or grind a leaderboard you can't measure." The plugin already has `query_nearby_players` and `query_faction_info`. Add five queries, ~200 lines of Java, each corresponding to something a human gets from a command or the tab list, so it is fair play:

`query_baltop(n)`, `query_factions_list()` (name, power, land, members online, relations to me), `query_claim_map(pos, radius)` (the `/f map` grid), `query_online()`, `query_containers_in_claim(faction)` (own faction only). `board()` composes them with `factions.getState()`. This is the entire "stockpile / bank / baltop / raid" perception gap from `BOT_COMPETENCE_OVERHAUL.md` §5, closed in one tool.

### 3.7 Faction shared memory

One markdown doc per faction in Redis, `faction_notes(read)` / `faction_notes(write, text)`. Leaders write "raiding Hearth on Sat, need 20 TNT, stash at (…)"; mates read it at login and when a Tier-1 `faction_chat` event mentions "notes." Coordination through writing, like humans on Discord, with no coordinator process. `intentBroadcast`/`calloutListener` become feeders into this doc rather than a parallel channel.

### 3.8 Skill authoring by the model (the escape from "every behavior is a week of code")

Voyager/Mindcraft pattern, gated:
- `run_script(js)` runs the model's code in a `vm` sandbox with a whitelisted API (the primitive layer, block/entity queries, `goto`, `dig`, `place`, `sleep`), a 60 s timeout, and the same cancel token as every tool. Returns stdout + the honest result shape.
- `save_skill(name, description, code)` writes to `data/skills/` for the fleet; skills are exposed through **tool search** so the schema list stays small and the cache prefix stays stable.
- Raiding, trap building, chest sorting, a cactus farm, an enderpearl bridge: these become things a bot *tries* on a quiet evening and keeps if they worked. Human review of `data/skills/` is the safety net.

This is Phase 4, not Phase 0, but design the sandbox API from the start so the primitives are the same ones the tools use.

### 3.9 Chat and persona

Keep the fast path (templates + `voiceFilter` + rate limits) for reflexive reactions: death, kill, join. Delete the ambient chat timer; the model talks when it has something to say. Route mentions and faction chat to the brain (Tier 1). `say` passes through `voiceFilter` so typo rate, caps-when-tilted, and catchphrases still come from the profile. `mood.js` survives as one line in `look()`. `chatLLM.js` (the slow-path persona) is folded into the brain; the persona is already the system prompt.

An operator channel (an admin `/tell`, or a mid-conversation system message on Opus 5) lets you coach a bot live: "stop building, go help Diana." Useful for development and it reads as a server admin talking to a player.

---

## 4. Cost model

Turns happen at tool boundaries, not on a timer. **Turns per hour is the design lever**, and chunky tools are how you pull it. A 3-minute `mine(..., vein:true)` is zero turns for 3 minutes.

Assumptions per turn: ~6k cached system+tools prefix, ~25k cached transcript tail (auto caching), ~600 fresh input, ~600 output including thinking. Cache reads at ~0.1× input price.

| Brain | $/turn | 20 turns/h (long tools) | 50 turns/h (blend) | 120 turns/h (fiddly) |
|---|---|---|---|---|
| Opus 5 ($5 / $25) | ~$0.034 | $0.68 /bot-h | $1.70 /bot-h | $4.10 /bot-h |
| Sonnet 5 ($2 / $10) | ~$0.013 | $0.27 /bot-h | $0.67 /bot-h | $1.60 /bot-h |
| Haiku 4.5 ($1 / $5) | ~$0.007 | $0.13 /bot-h | $0.34 /bot-h | $0.80 /bot-h |

Today: ~$0.25/bot-hour on Sonnet 4.6 for zero completed structures. A realistic fleet is not 18 bots 24/7; the scheduler already gives each profile 1–4 h sessions in its primary hours, so ~6 online on average × 8 h ≈ 50 bot-hours/day ≈ $35/day on Sonnet 5 at the blend, ~$85 on Opus 5. Levers, in order: chunkier tools, `effort: low` for routine stretches (per-message effort is available on Opus 5), context editing to keep the tail small, fewer concurrent bots, then model tier. Measure Opus 5 at low effort before assuming Sonnet 5 is the cheaper path; on the current generation lower effort on the stronger model often wins per completed task.

---

## 5. What survives, what goes

| Keep as-is or lightly wrapped (~10k LOC) | Delete or reduce to a tool (~12k LOC) |
|---|---|
| `core/*` (bot, eventBus, logger, profileLoader, diagnostics) | `strategic/goalPicker.js` (1411) |
| `tactical/primitives.js` (2223) — the hands | `strategic/goals.js` (373) — the enum |
| `building/*` + `data/blueprints/*` (~3.5k) — placement, site survey, guards | `strategic/planner.js` (1924) — keep `_resolvePrerequisites` as a `recipe_plan(item,n)` helper (~200) |
| `tactical/movement.js`, `combat.js` | `strategic/contextBuilder.js` (703), `projects.js` (458), `progression.js`, `reflection.js` |
| `tactical/survival.js` — as Tier-0 reflex only | `tactical/tacticalPlanner.js` (726), `actionRunner.js` (336) |
| `tactical/mobScanner.js` — as a **sensor**; delete its cancel path | `tactical/taskRunner.js` (1156) |
| `tactical/perception.js` → `look()` | `tactical/executor.js` (3321) — salvage `exitProtection`, `_digToEscape`, `_tryEmergencyPillarUp`, `_returnToSurface` into `unstick` (~400) |
| `tactical/skills/*` — the result contract | `tactical/stuckRecovery.js` (646), `buildPhaseWatchdog.js`, `activities.js` (422) |
| `social/memory.js`, `relationships.js`, `mood.js`, `voiceFilter.js`, templates | `social/chatLLM.js` — persona moves into the system prompt |
| `strategic/factions.js` (wrappers + state), `worldModel.js` (store), `knownLocations.js`, `economyChat.js`, `data/*` | `run.js` (1549) → `agent/main.js` (~300) |
| `coordination/*`, `orchestrator/*`, BotBridge (+5 queries) | ~90 arbitration unit tests → ~10 scenario benchmarks (§6) |

New: `bots/agent/{loop,tools,interrupts,memory,transcript}.js` ≈ 2.5k lines.

---

## 6. Phases, benchmarks, kill criteria

Every phase has a benchmark a fresh bot runs on a live server, measured in **minutes to completion and dollars spent**, recorded by an evolved `tools/analyze_outcomes.js`. If a phase can't beat the current system on its benchmark, stop and rethink before the next one. That is the scope control this project has been missing.

| Phase | Build | Benchmark | Kill criterion |
|---|---|---|---|
| **0 Spike** (S–M) | `agent/loop.js`, 8 tools over existing primitives (`look`, `scan`, `inventory`, `goto`, `mine`, `craft`, `place`, `say`), no memory, only auto-eat as reflex, transcript to disk, Opus 5 | From spawn + starter kit: stone tools, then a `dirt_shelter`, in < 15 min | If it can't beat the current stack's best run (TestBot31 built a base once), the thesis is wrong; stop here |
| **1 Nerves** (M) | cancel token in every tool, Tier 0/1/2 interrupts, `interrupt_on`, `events[]`, `unstick`, `attack`/`retreat`, `build`, `store` | Mine 16 iron overnight (mobs), craft iron armor, bank the rest in a chest at home, in < 30 min, and survive | More than 1 death per run from a cause a Tier-0 reflex should catch |
| **2 Mind** (M) | `focus`, memory tool, journal at logoff, login bootstrap, context editing + compaction | Across 3 forced logoff/login cycles the bot resumes the same project without being told | Bot restarts a project or forgets its chest location after a relog |
| **3 Board** (M) | BotBridge queries, `board()`, `f`, `sell`, `faction_notes`, `think` | Two bots: found a faction, claim, both contribute, reach a $ target via `/sell`; a third bot scouts and reports the claim location in notes | Raid/baltop goals never appear in transcripts because the info isn't there |
| **4 Hands that grow** (L) | `run_script`, `save_skill`, tool search | Bot writes and saves a working chest sorter or cactus farm with no human code | Scripts routinely exceed timeouts or corrupt inventory |
| **5 Fleet** (M) | orchestrator drives N agents, cost dashboard, delete the old stack, scenario suite in CI-style script | 6 bots for 8 h, zero manual intervention, $/day within budget | |

Run Phase 0 on the `state` branch in a new `bots/agent/` directory next to the old stack so both can be launched against the same server for A/B.

---

## 7. Risks, honestly

- **"The tactical LLM already failed."** It failed as a *second* controller. Phase 0 is the test of whether a *sole* controller with chunky tools behaves differently. That is why Phase 0 exists and why its kill criterion is unforgiving.
- **Mechanics still break** (275 place failures). The loop does not fix `placeBlockAt`. It changes what happens next: the model reads `{failed: 12, reason: 'server_rejected', cells: [...]}` and routes around, instead of a watchdog restarting the whole build 94 times. Mechanics work continues; it just has one caller now.
- **Cost drifts up with fiddly work.** Watch turns/hour per bot in the dashboard. The fix is always a chunkier tool, never a timer.
- **Model latency (3 s median today) makes reflexes feel slow.** That is what Tier 0 is for: survival actions don't wait for a turn.
- **Realism.** A bot that thinks in complete sentences may over-communicate. `say` stays behind `voiceFilter` and rate limits; the system prompt says most turns should be silent.
- **1.8.8 quirks** (slot-0 craft rejects, offhand transaction rejects) are unchanged. They live in primitives, where they already are.

---

## 8. What a turn looks like

```
[assistant] I'm at the ravine with 9 iron and 40 cobble. Enough for the north wall.
            → goto({named:'home'}, {interrupt_on:['damage','chat_mention']})
[tool]      {status:'ok', pos:[-212,64,340], elapsed_s:38,
             events:[{t:'chat', from:'Marla_K', text:'anyone selling iron?', tier:1}]}
[assistant] → say("got 9 iron, 40 each?")   → build('builder_base_t1', {max_minutes:5})
[tool]      {status:'partial', placed:61, failed:2, reason:'cells_occupied',
             cells:[[-210,65,339,'log']], materials_needed:{cobblestone:18},
             events:[{t:'chat', from:'Marla_K', text:'deal, /pay incoming'},
                     {t:'economy', from:'Marla_K', amount:360}]}
[assistant] Two cells have a tree log in them. Clearing them, then I need 18 more cobble.
            → dig([-210,65,339])  → focus("builder_base_t1 ~70%: dig log at (-210,65,339),
              mine 18 cobble at ravine, finish north wall. Marla_K paid 360 for 9 iron, deliver next.")
```

No goal enum, no decompose, no observer, no watchdog. The bot is playing.
