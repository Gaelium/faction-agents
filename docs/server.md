# The server

The bots play on a Paper 1.8.8 server with a specific plugin set. This page
is what a server admin needs to know: why 1.8, which plugins and versions,
the economy and rules the bots reason about, how spawn protection reaches
the bots, and what to change for a different world. Installing it step by
step is [setup.md](setup.md); the bridge plugin is [botbridge.md](botbridge.md).

## Why 1.8.8

Minecraft 1.8.9 is the last version with the classic PvP model: no
shields, no off-hand, no attack cooldown, no axe crits; sword block-hitting
is the only defensive move, and a fight is decided by clicks per second,
aim and blocking. The bots' combat code (`bots/world/combat.js`) and their
profiles' `combat:` block (reaction time, aim error, CPS, block-hit rate)
are written for that model. Paper 1.8.8 build 445 is the newest server for
that client, and it needs Java 8.

The cost is the plugin set: every plugin is pinned to the last build of its
1.8 line. WorldEdit and WorldGuard 7, mcMMO 2, QuickShop and current
EssentialsX do not load; the versions below do.

## The plugins

`ls server/plugins/*.jar` on the reference server, with what each one is
for. *compile* marks the six jars `server/BotBridge/pom.xml` reads to build
the bridge.

| Plugin | Version | Jar filename | Source | `fetch-plugins.sh` | Needed for |
|---|---|---|---|---|---|
| Paper | 1.8.8 build 445 | `paper-1.8.8-445.jar` (in `server/`) | PaperMC download API v3 | yes | the server |
| BotBridge | 0.1.0 | `BotBridge-0.1.0.jar` | `server/BotBridge/` or the GitHub release | no, build it | every event and query the bots use |
| MassiveCore | 2.8.5 | `MassiveCore.jar` | [SpigotMC 1898](https://www.spigotmc.org/resources/massivecore.1898/) | manual | Factions dependency; *compile* |
| Factions (Massive) | 2.8.5 | `Factions.jar` | [SpigotMC 1900](https://www.spigotmc.org/resources/factions.1900/) | manual | the `f` tool, `faction_event`, faction queries; *compile* |
| EssentialsX | 2.19.7 | `EssentialsX-2.19.7.jar` | [GitHub release](https://github.com/EssentialsX/Essentials/releases/tag/2.19.7) | yes | `/kit starter`, `/sell`, `/pay`, `/balance`, `/msg`, `/spawn`, `/home`; `kit_used`, `economy_transaction` |
| EssentialsX Chat | 2.19.7 | `EssentialsXChat-2.19.7.jar` | same release | yes | chat formatting with faction tags |
| EssentialsX Spawn | 2.19.7 | `EssentialsXSpawn-2.19.7.jar` | same release | yes | `/spawn`, `/setspawn`, `spawn.yml` |
| Vault | 1.7.3 | `Vault-1.7.3.jar` | [GitHub release](https://github.com/MilkBowl/Vault/releases/tag/1.7.3) | yes | the economy API behind `query_balance` and `query_baltop`, Factions costs; *compile* |
| LuckPerms | 5.4.145 | `LuckPerms-Bukkit-5.4.145.jar` | [Modrinth v5.4.145-bukkit](https://modrinth.com/plugin/luckperms/version/v5.4.145-bukkit); 5.5+ is compiled for Java 17 and does not load on 1.8.8 | yes | permissions |
| WorldEdit | 6.1.9 | `worldedit-bukkit-6.1.9.jar` | [dev.bukkit file 2597538](https://dev.bukkit.org/projects/worldedit/files/2597538) | yes | WorldGuard's dependency, the region wand; *compile* |
| WorldGuard | 6.1 | `worldguard-6.1.jar` | [dev.bukkit file 881691](https://dev.bukkit.org/projects/worldguard/files/881691) (the 1.8 line; the list shows 7.x first) | yes | the `spawn` region, `zone_enter`, `bots/world/zones.js`; *compile* |
| mcMMO | 1.5.00 (Classic) | `mcMMO-1.5.00.jar` | [dev.bukkit file 781681](https://dev.bukkit.org/projects/mcmmo/files/781681); 1.5.10+ call 1.12's `NamespacedKey` and do not enable on 1.8.8 | yes | `mcmmo_levelup`; *compile* |
| CoreProtect | 2.12.0 | `CoreProtect_2.12.0.jar` | [dev.bukkit file 886944](https://dev.bukkit.org/projects/coreprotect/files/886944) | yes, optional | rollback of griefing for admins; nothing in the bots needs it |
| SkinsRestorer | 15.12.5 | `SkinsRestorer.jar` | [GitHub release](https://github.com/SkinsRestorer/SkinsRestorer/releases/tag/15.12.5) | `--with-skins`, optional | bots get a player's skin instead of Steve; its `config.yml` is tracked |

EssentialsX, LuckPerms and Vault declare `api-version: 1.13` in their
`plugin.yml`; Paper 1.8.8 ignores the field and they run. BotBridge has one
switch per feature in its `config.yml` (`combat`, `chat`, `kit`, `economy`,
`zone`, `mcmmo`, `factions`) and skips a feature whose plugin is missing.

## What is in `server/` and what is not

Tracked, and shipped with the repo:

| Path | What it is |
|---|---|
| `start.sh` | launcher: finds Java 8, Aikar's GC flags, 4 GB heap (`RAM=` in the script) |
| `server.properties.example` | the reference values; copy to `server.properties`. `online-mode=false` is required because the bots log in with offline-mode names; `spawn-protection=0` because WorldGuard and the Factions safezone protect spawn instead |
| `bukkit.yml`, `spigot.yml`, `paper.yml`, `commands.yml`, `help.yml`, `permissions.yml`, `wepif.yml` | server configs (the server rewrites `paper.yml` and `spigot.yml` on every boot; that churn is expected) |
| `plugins/<Plugin>/*.yml` | plugin configs: BotBridge; Essentials (`config.yml`, `kits.yml`, `worth.yml`, `spawn.yml`, `motd.txt`, `tpr.yml`, `custom_items.yml`); Vault; WorldEdit; WorldGuard (global and per-world configs, blacklists, the `spawn` region); mcMMO; SkinsRestorer |
| `mstore/factions_mconf/instance.json` | the Massive Factions rules (the economy below) |
| `mstore/factions_mflag/`, `mstore/factions_mperm/`, `mstore/massivecore_*` | Factions flag and permission defaults, MassiveCore settings |
| `BotBridge/` | the plugin source, `pom.xml`, a short README |
| `fetch-plugins.sh` | downloads what has a direct URL, lists the rest, `--check` reports presence |

Not tracked, regenerated by the plugins or specific to one install: every
jar, the world folders, logs, `eula.txt`, `server.properties`,
`plugins/*/data`, `plugins/*/backup*`, LuckPerms' database, Essentials'
`items.csv`, `usermap.csv`, `userdata/` and warps, MassiveCore's `conf.json`
(a per-install server id) and `idnamecache.json`, the Factions board and
player/faction records (`mstore/factions_board`, `factions_mplayer`,
`factions_faction`), WorldGuard's profile cache, WorldEdit sessions and
schematics, SkinsRestorer's caches. `.gitignore` has the full list.

## What the bots read from `server/`

`bots/agent/main.js` resolves the server folder as `MC_SERVER_DIR` (default
`<repo>/server`) and reads three things at boot. Each has a fallback, so a
checkout without a server next to it still runs; the log line tells you
which path was taken.

| File | Reader | Used for | If missing |
|---|---|---|---|
| `mstore/factions_mconf/instance.json` | `bots/agent/factionRules.js` | the power economy in the system prompt and the `f` tool's hints | the copy in `bots/agent/factionRules.defaults.json`, logged `faction_rules_default` |
| `plugins/Essentials/worth.yml` | `bots/agent/prices.js` | sell prices for the `inventory` and `sell` tools and the prompt's price line | no prices; the prompt omits the line; `sell` still works, it just cannot predict the income |
| `plugins/WorldGuard/worlds/world/regions.yml` and `mstore/factions_board/world.json` | `bots/world/zones.js` | the shapes `leave_spawn`, the builder and `mine` keep out of | regions alone when only the board is missing; with neither, a built-in circle of radius 200 around (420, 220) and a `zones_server_truth_unavailable` warning |

A healthy boot logs `zones_loaded_from_server`, `prices_loaded` and
`faction_rules_loaded` with the file paths and counts.

## The factions economy

Massive Factions is configured in `mstore/factions_mconf/instance.json`.
The values the bots plan around:

| Rule | Value | Key |
|---|---|---|
| founding a faction | $100 | `econCostCreate` |
| claiming a chunk | 1 faction power (no money) | `econChunkCost.BUY` |
| a new player's power | 0 | `defaultPlayerPower` |
| power gained per hour online | 2 | `powerPerHour` |
| power cap per player | 10 | `powerMax` |
| power lost per death | 2 | `powerPerDeath` (−2) |
| claims must touch each other | yes | `claimsMustBeConnected` |
| `f sethome` only inside a claim | yes | `homesMustBeInClaimedTerritory` |
| faction name length | 3–16 | `factionNameLengthMin/Max` |

Faction power is the sum of its members' power, and a faction with more
land than power is raidable. So a solo founder can claim the first chunk
after about 30 minutes online, and recruiting is the only fast way to more
land. `factionRules.js` turns the file into exactly those sentences for the
system prompt and into the hint a failed `f claim` returns ("each chunk
costs 1 power; you gain 2/hour online…"). Change the numbers in the file
and the bots pick them up at the next boot; keep
`bots/agent/factionRules.defaults.json` in step if you want the fallback to
match.

Ranks matter: a player who joins a faction is a *recruit* and cannot build
or break on faction land ("<Faction> does not allow you to build"). The
leader (or an officer) must run `/f rank <name> member`. The bots know this
(the `f rank` action, the `faction_denied` event, the `faction_perm_denied`
failure reason) but a human-led faction has to do it by hand.

Massive Factions 2.8 sub-command syntax, used by the `f` tool: `/f create
<name>`, `/f invite add <player>`, `/f join <faction>`, `/f claim one`,
`/f unclaim one`, `/f sethome`, `/f home`, `/f ally|enemy|neutral
<faction>`, `/f rank <player> <rank>`, `/f player` (your own power).

## The Essentials economy

Money is EssentialsX' economy through Vault. There is no shop: income comes
from `/sell` (the `sell` tool: `sell hand <n>` for surplus above the bot's
reserves, or named items) at the prices in `plugins/Essentials/worth.yml`
(166 sellable items; logs 2, cobblestone, ores, crops, …) and from other
players paying with `/pay` (the `pay` tool). `/balance` and the `board`
tool's `query_balance` / `query_baltop` read the same accounts.

The starter kit (`plugins/Essentials/kits.yml`, `/kit starter`, 10-minute
cooldown) is what every bot takes at login: wooden sword, wooden shovel,
pickaxe and axe, a leather armour set, 16 bread and 8 cooked beef. `vip`
and `mvp` kits exist for human players.

`money` in the system prompt is therefore the balance the bot last saw,
corrected by every `economy_transaction` event on the bus and every parsed
`/balance` reply (`bots/world/factions.js`, `bots/social/economyChat.js`).

## Zones: what the bots will not touch

Three shapes protect spawn on the reference server, and the bots read the
two that are files:

1. The WorldGuard region `spawn` in `plugins/WorldGuard/worlds/world/regions.yml`
   (a cuboid, x 306–493 and z 126–314, with mob spawning, TNT, creeper and
   other explosions, lightning and leaf decay denied).
2. Factions `safezone` and `warzone` claims in the board
   (`mstore/factions_board/world.json`, runtime state): no building or
   breaking, and PvP only in the warzone.
3. `spawn-protection=0` in `server.properties`, because vanilla spawn
   protection would fight the two above.

`bots/world/zones.js` loads the cuboids and the claimed chunks (player
factions' claims are excluded on purpose, a bot must be able to build on its
own land), answers `isInProtectedZone` for every position, and writes a
one-line description of each zone into the system prompt. On that
foundation:

- [`leave_spawn`](tools.md#leave_spawn) walks the bot out of every zone plus
  a margin, hopping outward once a second until it is clear
  (`still_inside: false`, `moved`, `attempts` in its result).
- `survey_site` and `build` refuse a site inside or within 48 blocks of a
  zone (`too_close_to_spawn`, "move at least 48 blocks farther from spawn").
- `mine`'s block search skips protected cells.

BotBridge adds the live signal: `zone_enter` fires when a player crosses a
WorldGuard region border, so a bot learns when someone walks into spawn.

## Skins (optional)

SkinsRestorer 15.12.5 gives the bots the skin of the player whose name
matches, so they do not all look like Steve. It needs internet access from
the server (it fetches skins from Mojang) and is the only plugin that
downloads anything at runtime. Nothing in the bots depends on it; drop the
jar and they play the same.

## Running on a different world

1. Stop the server, delete `world`, `world_nether` and `world_the_end` (or
   set another `level-name`), start it: a new world generates.
2. Redo the three spawn markers from [setup.md](setup.md#4e-spawn):
   `/setspawn`, the WorldGuard `spawn` region with its flags, the Factions
   safezone claim. `zones.js` reads whatever `regions.yml` and the board
   then contain, so the bots follow your new shapes without code changes.
3. The profiles' `spawn:` blocks are only a fallback (`goto named spawn`
   uses the position the bot actually landed on); update them if you want
   them accurate.
4. Nothing else in `server/` is world-specific. If you also change the
   Factions numbers, mirror them in `bots/agent/factionRules.defaults.json`.
