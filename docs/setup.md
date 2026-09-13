# Setup

From nothing to one bot playing on your own Paper 1.8.8 server, on macOS or
Linux. Every step ends with a command that proves it worked. Budget an
hour the first time, most of it waiting for downloads.

What you end up with, all on one machine:

```
Paper 1.8.8 + plugins ──BotBridge──▶ Redis (mc:events / mc:commands / mc:responses)
                                        ▲
   bots/agent/main.js  × N processes ───┘   each: mineflayer + the agent loop + an LLM key
   orchestrator/index.js  spawns and watches them, dashboards in the terminal and at 127.0.0.1:4545
```

## 1. Prerequisites

| Tool | Why | macOS | Debian / Ubuntu |
|---|---|---|---|
| Java 8 | Paper 1.8.8 runs on nothing newer; BotBridge compiles for it | `brew install --cask zulu@8` | `sudo apt install openjdk-8-jdk` |
| Node.js 20.6 or newer | `--env-file` and the ESM code | `brew install node` | [nodesource](https://github.com/nodesource/distributions) or nvm |
| Redis | the event bus between server and bots | `brew install redis && brew services start redis` | `sudo apt install redis-server` |
| curl, python3 | `server/fetch-plugins.sh` | present | `sudo apt install curl python3` |
| Maven 3 | only to build BotBridge yourself | `brew install maven` | `sudo apt install maven` |
| A Minecraft 1.8.9 client | to watch and to play with the bots | any launcher | any launcher |
| One model key | Anthropic (Claude) or Google AI Studio (Gemini) | | |

Check:

```bash
node --version          # v20.6.0 or newer (this repo was verified on v24)
redis-cli ping          # PONG
/usr/libexec/java_home -v 1.8 2>/dev/null || ls /usr/lib/jvm   # a Java 8 install exists
```

`server/start.sh` finds Java 8 by itself on macOS (`java_home` and the
Zulu/Temurin install paths). On Linux, or with an unusual layout, set
`JAVA8_HOME=/usr/lib/jvm/java-8-openjdk-amd64` (or wherever `bin/java` is)
before running it.

## 2. Clone and install

```bash
git clone https://github.com/Gaelium/faction-agents.git && cd faction-agents
npm install             # one root package.json: bots + orchestrator + scripts
npm test                # 28 suites, no server and no key needed
```

`npm test` runs every `test_*.js` under `bots/`, `orchestrator/` and
`scripts/` with plain `node` (see [testing.md](testing.md)). It should end
with `0 failed`; `better-sqlite3` compiles a native module during
`npm install`, so a failure there means build tools are missing (`xcode-select
--install` on macOS, `build-essential` on Debian).

## 3. Keys and environment

```bash
cp .env.example .env
```

Edit `.env`. One of the two model keys is required:

- **Anthropic** (default): `ANTHROPIC_API_KEY=…`. The loop runs on
  `claude-opus-5` unless `AGENT_MODEL` says otherwise.
- **Gemini**: `GEMINI_API_KEY=…` and `AGENT_MODEL=gemini-3.8-flash`.

Node loads the file with `--env-file=.env`; nothing else reads it, so keep
it out of git (it is ignored). Every variable, its default and what reads
it is in [configuration.md](configuration.md). Prove the key works without
touching Minecraft:

```bash
node --env-file=.env bots/agent/smoke_gemini.js      # Gemini: one tool round trip, prints the cost (about $0.0003)
```

There is no equivalent smoke for Anthropic; the first bot session (step 8)
fails within seconds with `ModelClient needs LLM_API_KEY or
ANTHROPIC_API_KEY` if the key is missing.

## 4. The server

`server/` holds the configuration of the reference server and nothing that
cannot be redistributed: no server jar, no plugin jars, no world. The
[server folder README](../server/README.md) lists what is tracked;
[server.md](server.md) explains the plugin set and the economy the bots
play in.

### 4a. Jars

```bash
cd server
./fetch-plugins.sh                # Paper 1.8.8 build 445, EssentialsX (+Chat, +Spawn), Vault, WorldEdit 6.1.9, latest LuckPerms
./fetch-plugins.sh --with-skins   # optional: SkinsRestorer, so bots get player skins
```

The script then prints the jars you must download by hand, with the
filenames to save them under in `server/plugins/`:

| Jar | Version | Where |
|---|---|---|
| `MassiveCore.jar` | 2.8.5 | [SpigotMC 1898](https://www.spigotmc.org/resources/massivecore.1898/) |
| `Factions.jar` | 2.8.5 | [SpigotMC 1900](https://www.spigotmc.org/resources/factions.1900/) |
| `worldguard-6.1.jar` | 6.1 | [dev.bukkit files](https://dev.bukkit.org/projects/worldguard/files), the 1.8 line |
| `mcMMO-1.5.10.jar` | 1.5.10 (Classic) | build from [mcMMO-Classic](https://github.com/mcMMO-Dev/mcMMO-Classic) with `mvn package`, or [dev.bukkit files](https://dev.bukkit.org/projects/mcmmo/files) |
| `CoreProtect_2.12.0.jar` | 2.12.0, optional | [dev.bukkit files](https://dev.bukkit.org/projects/coreprotect/files) |
| `BotBridge-0.1.0.jar` | ours | the GitHub release, or build it (4b) |

Filenames matter: `start.sh` expects the Paper jar name, and
`server/BotBridge/pom.xml` compiles against six of the plugin jars by name.
Check what is present at any time:

```bash
./fetch-plugins.sh --check        # ✓ / ✗ per expected jar, exit 1 if a required one is missing
```

### 4b. BotBridge

BotBridge is the plugin that publishes server events to Redis and answers
the bots' queries; without it the bots are blind to chat, damage, money
and factions. Take the release jar, or build it (Java 8 and Maven, plus the
six plugin jars from 4a already in `server/plugins/`):

```bash
cd server/BotBridge
JAVA_HOME=$(/usr/libexec/java_home -v 1.8) mvn -DskipTests package      # macOS
JAVA_HOME=/usr/lib/jvm/java-8-openjdk-amd64 mvn -DskipTests package     # Debian/Ubuntu
cp target/BotBridge-0.1.0.jar ../plugins/
cd ..
```

The first build downloads the Spigot API and Jedis; after that `mvn -o`
builds offline. Details and the protocol: [botbridge.md](botbridge.md).

### 4c. First boot

```bash
cp server.properties.example server.properties   # online-mode=false (bots use offline names), spawn-protection=0
./start.sh                                        # prints the Java it found, writes eula.txt, stops
sed -i.bak 's/eula=false/eula=true/' eula.txt
./start.sh
```

All jars can be in place before the first boot; Bukkit orders them by
their declared dependencies (Vault → LuckPerms → Essentials → WorldEdit →
WorldGuard → MassiveCore → Factions → mcMMO → CoreProtect → BotBridge).
Wait for `Done (…s)! For help, type "help"` and look for the three
BotBridge lines:

```
[BotBridge] Redis ping: PONG (localhost:6379)
[BotBridge] Subscribed to mc:commands
[BotBridge] BotBridge enabled.
```

`Redis ping failed` means Redis was not up; start it and type `botbridge
reconnect` in the console. Leave the server running for the rest of this
page.

### 4d. Permissions

The bots are ordinary players in LuckPerms' `default` group. Paste this
into the server console once:

```
lp creategroup default
lp creategroup vip
lp creategroup mvp
lp group vip parent add default
lp group mvp parent add vip

lp group default permission set essentials.kits.starter true
lp group default permission set essentials.kit.starter true
lp group vip permission set essentials.kits.vip true
lp group mvp permission set essentials.kits.mvp true

lp group default permission set essentials.balance true
lp group default permission set essentials.pay true
lp group default permission set essentials.sell true
lp group default permission set essentials.msg true

lp group default permission set essentials.spawn true
lp group default permission set essentials.home true
lp group default permission set essentials.sethome true
lp group default permission set essentials.back true
lp group default permission set essentials.tp.others true
```

What each is for: the kit nodes for `/kit starter` at login (both
spellings, Essentials versions differ); `balance`, `pay`, `sell`, `msg` for
the `board`, `pay`, `sell` and `say` tools; `spawn`, `home` and `sethome`
for the `teleport` tool and `command sethome`; `back` and `tp.others` are
the recovery commands the old README granted and cost nothing to keep.
Massive Factions grants its player commands by default.

### 4e. Spawn

Three things mark spawn, and the bots read all three from the files in
`server/` (see [server.md](server.md#zones-what-the-bots-will-not-touch)):

1. **Essentials spawn**: stand where new players should appear and run
   `/setspawn`. The tracked `plugins/Essentials/spawn.yml` points at the
   reference world's spawn (around x 400, z 220).
2. **WorldGuard region `spawn`**: the tracked `regions.yml` defines it
   for the reference world (x 306–493, z 126–314, no mob spawning, no
   explosions). On a new world: `//wand`, select the area, `/rg define
   spawn`, then `/rg flag spawn mob-spawning deny` and the same for `tnt`,
   `creeper-explosion`, `other-explosion`, `lightning`, `leaf-decay`.
3. **Factions safezone**: stand in the middle and run `/f claim square 6
   safezone`; optionally `/f claim square 10 warzone` for a PvP ring
   outside it. This claim lives in the Factions board, which is runtime
   state and not tracked.

### 4f. Verify the bridge

```bash
redis-cli SUBSCRIBE mc:events
```

Join with your client (`localhost:25565`, any username) and type in chat:
a `{"event":"chat_message",…}` line appears. `botbridge status` in the
console prints the Redis host, the channels and the last error.

## 5. The first bot

```bash
cd ..                                   # repo root
npm run bot -- test_bot_oss             # = node --env-file=.env bots/agent/main.js test_bot_oss
```

`test_bot_oss` is the smoke profile (a low-risk builder; the other
profiles are in `bots/profiles/`, see [profiles.md](profiles.md)). On
Gemini, prefix `AGENT_MODEL=gemini-3.8-flash` unless `.env` sets it. What a
healthy start looks like, from the run on 2026-09-12:

```
[TestBotOSS] agent_boot { archetype: 'builder', model: 'gemini-3.8-flash' }
[TestBotOSS] zones_loaded_from_server { zones: 1, detail: [ 'region:spawn(box)' ] }
[TestBotOSS] prices_loaded { file: '…/server/plugins/Essentials/worth.yml', items: 166 }
[TestBotOSS] faction_rules_loaded { file: '…/server/mstore/factions_mconf/instance.json', powerPerHour: 2, … }
[TestBotOSS] redis_sub_connected
[TestBotOSS] bus_ready { events: 'mc:events', responses: 'mc:responses' }
[TestBotOSS] mc_login
[TestBotOSS] agent_spawned { pos: { x: 401, y: 66, z: 221 }, hp: 20, food: 20, in_protection: true }
[TestBotOSS] agent_loop_start { transcript: '…/data/sessions/TestBotOSS/2026-09-12T18-48-18-954Z.jsonl', tools: 46 }
[TestBotOSS] agent_tool { tool: 'look', status: 'ok', … }
```

In that run the bot looked around, put its armour on, set a focus card,
walked 137 blocks out of spawn protection, scanned for logs and had mined
eight when it was stopped after 150 seconds: 4 turns, 6 tool calls,
$0.034. Stop a bot with Ctrl-C (it logs off cleanly) and read the session:

```bash
node bots/agent/analyze_session.js       # minutes, turns, $, tool histogram, milestones of the newest transcript
```

Where things land: the transcript in `data/sessions/<bot>/`, the log in
`data/logs/<bot>.log`, memory files in `data/memory/<bot>/`, the SQLite
store in `data/bots/<bot>.db` ([data-and-storage.md](data-and-storage.md)).
`AGENT_MAX_USD` (default $5) ends a session by itself.

## 6. The fleet

```bash
node orchestrator/index.js --once --dry --only TestBotOSS   # prints the plan as JSON and exits, spawns nothing
npm run fleet -- --only TestBotOSS --budget 1              # keeps that bot online, at most $1 per rolling 24 h
```

`--only` takes usernames (`TestBotOSS`, the `username:` line of the
profile), while `npm run bot` takes either the file name or the username.
The orchestrator spawns one process per bot, restarts crashes with
backoff, enforces per-profile session lengths, and shows a terminal
dashboard (`q` quits everything cleanly). The web dashboard is on by
default at <http://127.0.0.1:4545> (`--web <port>`, `--no-web`); it also
runs alone over `data/sessions/` for bots started by hand:

```bash
npm run web                              # http://127.0.0.1:4545, /api/fleet and /api/bot/<name> behind it
```

Flags, schedules and the dashboards are in [running.md](running.md); what
an hour of a bot costs on each model is in [costs.md](costs.md).

## If something does not work

[troubleshooting.md](troubleshooting.md) is organised by symptom. The two
places that always have the answer are `data/logs/<bot>.log` (structured
JSON lines, mirrored to the bot's stdout) and `server/logs/latest.log`.
