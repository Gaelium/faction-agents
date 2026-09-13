# BotBridge

BotBridge is the Paper 1.8.8 plugin (`server/BotBridge/`, package
`com.aifactions.botbridge`, version 0.1.0) that connects the server to the
bots. It publishes server events as JSON on a Redis channel and answers
JSON queries on another. It is the only way a bot learns about damage,
chat, money, kits, zones, mcMMO and faction changes without parsing chat
lines, and the only way it reads the board: factions, claims, balances,
who is online. The Node side is `bots/core/eventBus.js`.

```
Paper 1.8.8 ── BotBridge ──publish──▶ mc:events ────▶ every bot (EventBus.on)
                   ▲                                       │
                   └──subscribe── mc:commands ◀───publish──┘  EventBus.query / publishCommand
                   └──publish───▶ mc:responses ──▶ the bot whose request_id matches
```

Everything on `mc:events` is broadcast: each bot process subscribes and
filters what concerns it. Commands carry a `request_id`; the answer echoes
it on `mc:responses`, and `EventBus.query(type, payload, { timeoutMs })`
resolves the matching promise.

## Building

Requirements: Java 8 (`JAVA_HOME` pointing at it; the compiler targets
1.8), Maven 3, and the six plugin jars `pom.xml` reads with `system`
scope from `../plugins`: `Factions.jar`, `MassiveCore.jar`,
`mcMMO-1.5.10.jar`, `worldguard-6.1.jar`, `worldedit-bukkit-6.1.9.jar`,
`Vault-1.7.3.jar` (`server/fetch-plugins.sh --check` tells you which are
there). They are compile-time only: `plugin.yml` lists them as
`softdepend` and the plugin runs without any of them. The Spigot API
(`1.8.8-R0.1-SNAPSHOT`) and Jedis come from Maven repositories the first
time; afterwards `mvn -o` builds offline.

```bash
cd server/BotBridge
JAVA_HOME=$(/usr/libexec/java_home -v 1.8)   mvn -DskipTests package   # macOS
JAVA_HOME=/usr/lib/jvm/java-8-openjdk-amd64  mvn -DskipTests package   # Debian/Ubuntu
cp target/BotBridge-0.1.0.jar ../plugins/
# server console:
reload confirm            # or restart the server
```

The jar is about 1.2 MB: Jedis, commons-pool2, slf4j-api and Gson are
shaded in and relocated under `com.aifactions.botbridge.lib` so they cannot
clash with other plugins. There is no CI build because the SpigotMC-gated
jars cannot be fetched unattended; the release jar on GitHub is built this
way.

## Configuration (`server/plugins/BotBridge/config.yml`)

```yaml
redis:
  host: localhost
  port: 6379
  password: ""          # empty for a local Redis
  database: 0
  timeout-ms: 2000
channels:
  events: "mc:events"     # plugin → bots
  commands: "mc:commands" # bots → plugin
  responses: "mc:responses"
features:                 # each listener can be switched off
  combat: true            # player_damage, player_death
  chat: true              # chat_message
  kit: true               # kit_used            (needs Essentials)
  economy: true           # economy_transaction (needs Essentials /pay, /eco)
  zone: true              # zone_enter          (needs WorldGuard)
  mcmmo: true             # mcmmo_levelup       (needs mcMMO)
  factions: true          # faction_event, faction queries (needs Factions + MassiveCore)
zone:
  check-interval-ms: 250  # per-player debounce of PlayerMoveEvent for zone checks
```

A feature whose plugin is not installed is skipped with a console line
(`WorldGuard not present; zone_enter disabled.`) and everything else keeps
working. The bots read the same channel names from their profiles
(`redis.channels`, defaults `mc:events`, `mc:commands`, `mc:responses`);
change both or neither.

`RedisBus.java` holds one publisher connection and one subscriber thread
with reconnects, and pings Redis at startup; a failed ping is logged and
events are dropped until Redis is reachable. Console commands (permission
`botbridge.admin`, ops have it): `botbridge` / `botbridge status` (host,
channels, last error) and `botbridge reconnect`.

## Events on `mc:events`

Every message is one JSON object with `event` and `ts` (epoch
milliseconds) plus the fields below. Names are player names, not UUIDs.

| `event` | Fields | Fired by |
|---|---|---|
| `chat_message` | `sender`, `message`, `channel` (`global`) | AsyncPlayerChatEvent. A player running `/f chat` or `/f c …` additionally sends `message: "<chat-toggle>"`, `channel` (`faction`, `ally` or `global`) and `source: "faction-toggle"` |
| `player_damage` | `attacker` (a player name, `mob:<TYPE>` or `projectile:<TYPE>`), `victim`, `damage` (final, in half-hearts), `weapon` (Bukkit material name, `FIST`, or the projectile type) | EntityDamageByEntityEvent on a player victim; environmental damage (fall, lava, drowning) is not an entity event and is not published — the bots sense that themselves |
| `player_death` | `victim`, `killer` (null unless a player), `cause`, `location: {world, x, y, z}` | PlayerDeathEvent |
| `kit_used` | `player`, `kit_name` | `/kit <name>` |
| `economy_transaction` | `player`, `amount`, `reason` | `/pay`: `player` is the payer, `amount` negative, `reason: "pay:<recipient>"`. `/eco give|take|set`: `player` is the target, `reason: "admin:<op>"`. (A bot's own `/sell` is parsed from its chat echo by `bots/social/economyChat.js` and merged into the same stream locally with `reason: "sell:<item>"`; it never crosses Redis) |
| `zone_enter` | `player`, `zone_name` | a player entering a WorldGuard region, once per entry, checked at most every `zone.check-interval-ms` per player |
| `mcmmo_levelup` | `player`, `skill`, `new_level` | McMMOPlayerLevelUpEvent |
| `faction_event` | `type` plus: `create` → `faction`, `faction_id`; `disband` → `faction`, `faction_id`; `claim` → `faction` (`wilderness` on unclaim), `chunks`; `ally` / `enemy` / `truce` / `neutral` → `faction`, `other_faction`, `relation`. Each carries `actor` (a player name or `console`) | Massive Factions events |

Example lines:

```
{"event":"chat_message","ts":1757700000000,"sender":"Rook_Vantis","message":"anyone selling iron","channel":"global"}
{"event":"player_damage","ts":1757700000123,"attacker":"mob:ZOMBIE","victim":"TestBotOSS","damage":2.0,"weapon":"FIST"}
{"event":"faction_event","ts":1757700000456,"type":"create","faction":"Vantis","faction_id":"3d2c…","actor":"Rook_Vantis"}
```

How a bot uses them: `bots/agent/nerves.js` turns `player_damage` on itself
into a `damage` event (and a Tier-0 reflex for lava or drowning), chat into
`chat_mention` / `whisper` / a chat count, `faction_event` and the faction
chat lines into `faction_invite`, `faction_member` and `faction_denied`;
`bots/world/factions.js` keeps the balance tally and the ally/enemy lists
from `economy_transaction` and `faction_event`. The agent sees the result
as `[events]` lines with its next turn ([agent-loop.md](agent-loop.md)).

## Commands on `mc:commands`, answers on `mc:responses`

Publish one JSON object with `type` and, for anything you want to match, a
`request_id`; the answer echoes `request_id` and adds `ts`. Queries that
touch world state run on the server's main thread and answer
asynchronously (in practice within a tick).

| Command (`type`) | Request fields | Answer (`type`) and fields |
|---|---|---|
| `give_event_subscription` | `bot` | `subscribed`: `bot`. Logged on the console; the events channel is broadcast, so this is a handshake, not a filter |
| `query_nearby_players` | `bot`, `radius` (default 16) | `nearby_players`: `bot`, `radius`, `players: [{name, uuid, distance, x, y, z}]`, other players in the same world within the radius |
| `query_online` | — | `online`: `players: [{name, faction, x, z}]` (`faction` null without Factions) |
| `query_factions` | `bot` (optional) | `factions`: `factions: [{name, power, power_max, land, members, online, leader, relation, raidable}]`, `my_faction`. `relation` is `own`, `ally`, `enemy`, `truce` or `neutral` relative to `bot`; `raidable` is land > power |
| `query_faction_info` | `faction` | `faction_info`: `faction`, `found`, `faction_id`, `power`, `land_count`, `members: [{name, uuid, role, power}]`, `claims: [{world, chunk_x, chunk_z}]` |
| `query_player_faction` | `player` | `player_faction`: `player`, `faction` (null if none) |
| `query_claims` | `bot` **or** `x`, `z` (+ optional `world`), `radius` 1–8 (default 4) | `claims`: `world`, `x`, `z`, `radius`, `claims: [{chunk_x, chunk_z, faction}]`, claimed chunks around the point in chunk coordinates |
| `query_balance` | `player` (or `bot`) | `balance`: `player`, `balance` (through Vault) |
| `query_baltop` | `bot` (optional), `limit` 1–25 (default 10) | `baltop`: `players` (count), `top: [{name, balance}]`, `my_rank`, `my_balance` |

Errors come back as `{"type":"error","request_id":…,"error":"<code>"}`:

| Code | Meaning |
|---|---|
| `missing_type`, `unknown_type:<t>` | the command had no `type` or an unknown one |
| `missing_bot`, `bot_not_online:<name>` | `query_nearby_players` needs an online player to anchor on |
| `missing_faction`, `missing_player`, `missing_position` | a required field is absent |
| `factions_not_loaded`, `vault_not_loaded` | the plugin the query needs is not running |
| `no_economy` | Vault found no economy provider (EssentialsX missing or failed) |
| `query_failed:<Exception>`, `lookup_failed:<Exception>` | the plugin API threw; the server log has the stack trace |

The bot side (`bots/agent/tools/board.js`) composes `query_balance`,
`query_baltop`, `query_factions`, `query_online` and `query_claims` into
the `board` tool and lists under `unavailable` whatever did not answer, so
a half-working bridge degrades instead of failing.

## Verifying with redis-cli

Redis running, the server started with `./start.sh`, the jar in
`plugins/`. Two terminals:

```bash
# A — watch events
redis-cli SUBSCRIBE mc:events
# B — trigger them in game or on the console
#   type in chat                  → chat_message
#   punch a mob or player         → player_damage
#   /kill                         → player_death
#   /kit starter                  → kit_used
#   /pay <other> 10               → economy_transaction
#   walk into the spawn region    → zone_enter
#   mine until a skill levels     → mcmmo_levelup
#   /f create TestFaction         → faction_event (create); /f claim one → claim; /f disband → disband
```

Commands (a third terminal; the bot named in `query_nearby_players` must
be online):

```bash
redis-cli SUBSCRIBE mc:responses
redis-cli PUBLISH mc:commands '{"type":"give_event_subscription","bot":"alice"}'
redis-cli PUBLISH mc:commands '{"type":"query_online","request_id":"r1"}'
redis-cli PUBLISH mc:commands '{"type":"query_factions","bot":"alice","request_id":"r2"}'
redis-cli PUBLISH mc:commands '{"type":"query_faction_info","faction":"TestFaction","request_id":"r3"}'
redis-cli PUBLISH mc:commands '{"type":"query_balance","player":"alice","request_id":"r4"}'
```

## Troubleshooting

- **No events in redis-cli.** `botbridge status` in the console;
  `lastError=publish:…` means Redis is unreachable (`redis-cli ping`). Fix
  Redis, then `botbridge reconnect`.
- **Plugin did not load.** `server/logs/latest.log`. Usual causes: the
  server runs on Java 9+ (must be Java 8), or a Factions/MassiveCore
  version other than 2.8.5.
- **No `faction_event`.** `botbridge status` says `Factions not present`;
  both `Factions.jar` and `MassiveCore.jar` must load.
- **No `zone_enter`.** WorldGuard 6.1 must be loaded (7.x does not run on
  1.8.8) and the player must cross a region border; moving inside a region
  does not repeat the event.
- **No `mcmmo_levelup`.** mcMMO 1.5.10 (Classic) must be installed.
- **`query_balance` answers `no_economy`.** Vault found no economy
  provider: EssentialsX is missing or failed to enable.
- **A bot's `board` lists everything under `unavailable`.** Its Redis
  connection or the plugin is down; the bot's log has `bus_start_failed`
  or `redis_sub_connected` is missing, and the dashboard header says
  `redis DOWN`.

## Adding an event

Write a listener under `src/main/java/com/aifactions/botbridge/listeners/`
that builds a `LinkedHashMap` of fields and calls `bus.publish("<event>",
m)` (the bus adds `event` and `ts`); register it in
`BotBridgePlugin.onEnable` behind a `features.<name>` flag; rebuild and
copy the jar. On the Node side, subscribe with `bus.on('<event>', …)`
(`bots/core/eventBus.js`) where the bot should react, most likely in
`bots/agent/nerves.js` if the model should hear about it, and add a row to
the table above.
