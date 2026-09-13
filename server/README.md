# server/ — the Paper 1.8.8 template

The configuration of the AI Factions server and nothing else: no server
jar, no plugin jars, no world, no logs, no player data. Those are
git-ignored and produced on your machine by `fetch-plugins.sh`, the manual
downloads it lists, and the first boot. The full story is in the docs:

- [docs/setup.md](../docs/setup.md) — install from zero: Java 8, jars, first boot, permissions, spawn, verification.
- [docs/server.md](../docs/server.md) — the plugin set and why 1.8.8, the factions and Essentials economies, zones, what the bots read from here, running on another world.
- [docs/botbridge.md](../docs/botbridge.md) — our plugin: build, config, the Redis protocol.

What is tracked here:

| Path | What it is |
|---|---|
| `start.sh` | launcher: finds Java 8 (`JAVA8_HOME` overrides), Aikar's flags, 4 GB heap |
| `server.properties.example` | copy to `server.properties` (`online-mode=false`, `spawn-protection=0`) |
| `bukkit.yml`, `spigot.yml`, `paper.yml`, `commands.yml`, `help.yml`, `permissions.yml`, `wepif.yml` | server configs |
| `plugins/<Plugin>/*.yml` | plugin configs: BotBridge, Essentials (`config.yml`, `kits.yml`, `worth.yml`, `spawn.yml`, …), Vault, WorldEdit, WorldGuard (with the `spawn` region), mcMMO, SkinsRestorer |
| `mstore/factions_mconf/instance.json` | the Massive Factions rules the bots reason about |
| `mstore/factions_mflag/`, `mstore/factions_mperm/`, `mstore/massivecore_*` | Factions flag and permission defaults, MassiveCore settings |
| `BotBridge/` | our plugin: `pom.xml`, `src/`, [README](BotBridge/README.md) |
| `fetch-plugins.sh` | downloads Paper and every plugin with a direct URL; `--with-skins`; `--check` reports what is present |

Quick start once the jars are in place (`./fetch-plugins.sh --check` shows
all ✓): `cp server.properties.example server.properties`, `./start.sh`, set
`eula=true` in `eula.txt`, `./start.sh` again, then the console commands in
[docs/setup.md](../docs/setup.md#4d-permissions).
