# Profiles: the characters

A profile is one YAML file in `bots/profiles/`. It is the whole of a
character: who the bot says it is, how it talks, how well it fights, when
it plays, and where it connects. The loader (`bots/core/profileLoader.js`)
fills in defaults for everything but `username`, so a minimal profile is
one line; the full field list with types and defaults is in
[configuration.md](configuration.md#profile-yaml).

## What ships

Sixteen characters and six test profiles. The file name is how you refer
to a bot on the command line; the `username` is what the server sees.

| File | Username | Archetype | File | Username | Archetype |
|---|---|---|---|---|---|
| `Archon_` | Archon_ | diplomat | `hexafrost` | hexafrost | builder |
| `Calcifer_` | Calcifer_ | pvper | `lvl_max` | lvl_max | grinder |
| `Diana_Eve` | Diana_Eve | grinder | `mint_kunai` | mint_kunai | pvper |
| `Marla_K` | Marla_K | builder | `oatmeal_ollie` | oatmeal_ollie | farmer |
| `Rook_Vantis` | Rook_Vantis | diplomat | `ore_hermit` | ore_hermit | grinder |
| `Zephyrr` | Zephyrr | pvper | `test_bot_1` | TestBot1 | pvper |
| `cobble_knight` | cobble_knight | builder | `test_bot_2` | TestBot2 | pvper |
| `ghosst` | ghosst | ratter | `test_bot_3` | TestBot3 | builder |
| `glizzy_lord99` | glizzy_lord99 | pvper | `test_bot_4` | TestBot4 | farmer |
| `grandpa_spud` | grandpa_spud | farmer | `test_bot_5` | TestBot44 | builder |
| `hay4lyfe` | hay4lyfe | farmer | `test_bot_oss` | TestBotOSS | builder |

The test profiles are ordinary characters with plainer backstories;
`test_bot_oss` is the one the smoke runs use ([testing.md](testing.md)).

## An annotated example

`bots/profiles/Rook_Vantis.yaml`, the founder character:

```yaml
username: Rook_Vantis        # the Minecraft name; offline mode, so any name works
archetype: diplomat          # one of pvper, builder, farmer, grinder, ratter, diplomat
skill_tier: 3                # 1–5, quoted to the model as "Skill tier 3/5"

# Written as a character, not as instructions: the prompt quotes it verbatim.
backstory: >
  Ran a twelve-player faction on a server that shut down, and came here to
  do it again from scratch. Order of business is always the same: a roof
  before dark, then sell everything that isn't nailed down until there's a
  hundred for the charter, then claim the ground the house sits on, then
  recruit. …

voice:
  tone: confident, warm, a little grand   # quoted to the model
  greeting: "o7"
  catchphrases: ["join up", "we're building something", "land is only worth what you can hold"]
  typo_rate: 0.015             # per-character chance of a typo in chat
  caps_when_tilted: 0.15       # chance of SHOUTING when tilted
  signature_rate: 0.2          # chance a catchphrase is attached to a line
  punctuation: casual          # minimal | casual | formal

values:                        # 0–1, shown to the model as n/10
  risk_tolerance: 0.5
  social_preference: 0.85
  material_greed: 0.6
  loyalty: 0.7
  curiosity: 0.6

ambition: 0.9                  # 0–1, shown as 9/10; how much the bot wants to lead
faction_preferences:           # hints for naming a faction
  style: short-punchy
  themes: ["rook", "vantage", "keep"]

host: localhost                # where to connect
port: 25565
version: "1.8.9"
auth: offline
redis: { host: localhost, port: 6379 }
spawn: { x: 0, y: 64, z: 0 }   # a fallback; the bot learns the real spawn when it lands

schedule:                      # when the orchestrator brings this bot online
  primary_hours: [18, 23]      # local time; score 0.85 inside
  secondary_hours: [12, 15]    # score 0.45 inside
  session_minutes: [90, 240]   # a session lasts a random length in this range
  weekend_boost: true          # +0.15 on Saturday and Sunday

combat:                        # the fighting engine's knobs (bots/world/combat.js)
  reaction_ms_min: 280
  reaction_ms_max: 420
  aim_error_deg: 3.5
  cps: 8
  block_hit_rate: 0.35
  pot_at_hp: 13
  pot_success_rate: 0.65
  combo_follow_rate: 0.55
  flee_at_hp: 8
  preferred_weapon: sword
```

## What each part does

**Identity in the prompt.** `bots/agent/prompt.js` opens the system prompt
with a "Who you are" block built from the profile: `Archetype: <archetype>.
Skill tier <skill_tier>/5.`, the backstory, the values as n/10, ambition,
and the voice's `tone`, `punctuation` and up to four `catchphrases`
("rarely"). The strategist behind the `think` tool
(`bots/agent/tools/think.js`) gets the same archetype, ambition and values
in its own system prompt. Nothing else in the agent reads `values` or
`ambition`; they shape behaviour only through the model.

**Archetype** is a label, not a switch: apart from the prompt line it is
shown on the dashboards and in the transcript's `meta` record. The
characters' backstories carry the actual differences (a diplomat recruits,
a grinder mines, a ratter lurks). The orchestrator test only checks that
every profile uses one of the six names and that each name appears at least
once.

**Skill tier** is quoted to the model and shown in the bot view of the
terminal dashboard. Fighting quality comes from the `combat` block, which
the profiles set per tier by hand (tier 2 profiles react in 350–500 ms with
5° of aim error and 6 clicks per second; tier 3 in 280–420 ms at 3.5° and
8). `bots/world/combat.js` reads exactly these keys: `reaction_ms_min`,
`reaction_ms_max`, `aim_error_deg`, `aim_lag_ms` (default 180),
`block_hit_rate`, `cps`, `combo_follow_rate`, `pot_at_hp`,
`pot_success_rate`, `flee_at_hp`, `preferred_weapon`. `flee_at_hp` is the
health at which the engine disengages on its own during an `attack` call;
the prompt's own rules use 8 hp.

**Voice** is applied twice. The tone and catchphrases go into the prompt, so
the model writes in character; then `bots/social/voiceFilter.js` mangles
every line the `say` tool sends: a catchphrase is attached with
`signature_rate`, characters are dropped or swapped at `typo_rate`, and
`punctuation` decides whether trailing punctuation is stripped (`minimal`),
kept (`formal`) or occasionally turned into "…" (`casual`).
`caps_when_tilted` only fires when the caller reports a tilted mood, which
the agent does not track today, so it is inert.

**Schedule** drives the orchestrator's scheduler ([running.md](running.md#who-is-online-the-scheduler-orchestratorschedulerjs)):
the hour windows set the base score, `weekend_boost` adds to it,
`session_minutes` bounds each session, and `always_online: true` (what
`--only` sets in memory) pins the bot at the top. Hours are the machine's
local time and may pass midnight (`[22, 28]`).

**Connection** fields go straight to mineflayer (`host`, `port`, `version`,
`auth`) and to the Redis bus (`redis.host`, `redis.port`, optional
`redis.password`, `redis.db`, `redis.channels.{events,commands,responses}`).
`spawn` is only a fallback for `goto named spawn` before the bot has
landed; the real spawn is recorded at login.

## Adding a character

1. Copy a profile with the same archetype to `bots/profiles/<file>.yaml`.
   The file stem and the `username` may differ (`test_bot_5.yaml` is
   `TestBot44`); both are accepted by `npm run bot -- <name>` and `--only`.
   Usernames must be valid offline-mode Minecraft names (up to 16
   characters, letters, digits, underscore).
2. Write the backstory as a character sketch with an order of business,
   not as a list of commands: the model reads it as who it is. Keep the
   voice fields modest; typo rates above 0.05 make chat hard to read.
3. Pick a `combat` block from a profile of the intended tier.
4. Check it loads: `node -e "import('./bots/core/profileLoader.js').then(m => console.log(m.loadProfile('<file>')))"`.
5. `npm test`: `orchestrator/test_orchestrator.js` counts one profile per
   YAML file and requires a known archetype, so a typo in `archetype`
   fails there.

The orchestrator picks up new files at its next start; a running fleet
does not reload the directory.

## Fields nothing reads any more

Older profiles may still carry `rank:` and `arena:`; the loader ignores
them (they belonged to the retired planner stack and its combat harness).
The `raw` object the loader used to expose is gone too.
