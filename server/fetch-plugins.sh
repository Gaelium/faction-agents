#!/usr/bin/env bash
# fetch-plugins.sh — download the Paper jar and every plugin that has a direct
# URL into server/ and server/plugins/, optionally build mcMMO from source,
# then list what is left to fetch by hand. Idempotent: existing jars are kept.
# Needs curl and python3 (two JSON answers).
#
#   ./fetch-plugins.sh               Paper, EssentialsX ×3, Vault, WorldEdit, WorldGuard, LuckPerms, mcMMO, CoreProtect
#   ./fetch-plugins.sh --with-skins  also SkinsRestorer (optional: bot skins)
#   ./fetch-plugins.sh --check       download nothing; report which expected jars are present
#
# The filenames below are the ones start.sh, BotBridge/pom.xml and the docs
# refer to; keep them when you download by hand.
set -euo pipefail
cd "$(dirname "$0")"

WITH_SKINS=0; CHECK=0
for a in "$@"; do
  case "$a" in
    --with-skins) WITH_SKINS=1 ;;
    --check) CHECK=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

PAPER_JAR="paper-1.8.8-445.jar"
REQUIRED=(MassiveCore.jar Factions.jar EssentialsX-2.19.7.jar EssentialsXChat-2.19.7.jar
          EssentialsXSpawn-2.19.7.jar Vault-1.7.3.jar worldedit-bukkit-6.1.9.jar
          worldguard-6.1.jar mcMMO-1.5.00.jar LuckPerms-Bukkit-5.4.145.jar BotBridge-0.1.0.jar)
OPTIONAL=(SkinsRestorer.jar CoreProtect_2.12.0.jar)

dl() {
  local url="$1" out="$2"
  if [[ -f "$out" ]]; then echo "✓ have $out"; return; fi
  echo "→ $out"
  curl -sSL --fail --retry 3 -o "$out.part" "$url"
  mv "$out.part" "$out"
}

check() {
  local missing=0
  echo "== server/"
  if [[ -f "$PAPER_JAR" ]]; then echo "  ✓ $PAPER_JAR"; else echo "  ✗ $PAPER_JAR"; missing=1; fi
  echo "== server/plugins/ (required)"
  for j in "${REQUIRED[@]}"; do
    if [[ -f "plugins/$j" ]]; then echo "  ✓ $j"; else echo "  ✗ $j"; missing=1; fi
  done
  echo "== server/plugins/ (optional)"
  for j in "${OPTIONAL[@]}"; do
    if [[ -f "plugins/$j" ]]; then echo "  ✓ $j"; else echo "  - $j (not installed)"; fi
  done
  return $missing
}

if [[ $CHECK == 1 ]]; then check; exit $?; fi

# --- Paper 1.8.8 build 445 (PaperMC download API v3) ---
if [[ ! -f "$PAPER_JAR" ]]; then
  paper_url=$(curl -sSL --fail https://fill.papermc.io/v3/projects/paper/versions/1.8.8/builds \
    | python3 -c 'import sys,json; b=[x for x in json.load(sys.stdin) if x["id"]==445][0]; print(b["downloads"]["server:default"]["url"])')
  dl "$paper_url" "$PAPER_JAR"
else
  echo "✓ have $PAPER_JAR"
fi

mkdir -p plugins
cd plugins

# --- EssentialsX 2.19.7: the last release that runs on 1.8.8 ---
ESS="https://github.com/EssentialsX/Essentials/releases/download/2.19.7"
dl "$ESS/EssentialsX-2.19.7.jar"      "EssentialsX-2.19.7.jar"
dl "$ESS/EssentialsXChat-2.19.7.jar"  "EssentialsXChat-2.19.7.jar"
dl "$ESS/EssentialsXSpawn-2.19.7.jar" "EssentialsXSpawn-2.19.7.jar"

# --- Vault 1.7.3 ---
dl "https://github.com/MilkBowl/Vault/releases/download/1.7.3/Vault.jar" "Vault-1.7.3.jar"

# --- WorldEdit 6.1.9 and WorldGuard 6.1: the 1.8 line (7.x needs 1.13+), from dev.bukkit's file archive ---
dl "https://dev.bukkit.org/projects/worldedit/files/2597538/download"  "worldedit-bukkit-6.1.9.jar"
dl "https://dev.bukkit.org/projects/worldguard/files/881691/download"  "worldguard-6.1.jar"

# --- LuckPerms 5.4.145: the last line compiled for Java 8 (5.5+ needs Java 17 and will not load on Paper 1.8.8).
#     Resolved through Modrinth's API by exact version; the CDN file behind it is
#     https://cdn.modrinth.com/data/Vebnzrzj/versions/cfNN7sys/LuckPerms-Bukkit-5.4.145.jar ---
if [[ ! -f LuckPerms-Bukkit-5.4.145.jar ]]; then
  lp_url=$(curl -sSL --fail -A "faction-agents-setup" https://api.modrinth.com/v2/project/luckperms/version \
    | python3 -c 'import sys,json; v=[x for x in json.load(sys.stdin) if x["version_number"]=="v5.4.145-bukkit"][0]; f=[y for y in v["files"] if y.get("primary")] or v["files"]; print(f[0]["url"])')
  dl "$lp_url" "LuckPerms-Bukkit-5.4.145.jar"
else
  echo "✓ have LuckPerms-Bukkit-5.4.145.jar"
fi

# --- CoreProtect 2.12.0 (optional; block logging and rollback for admins) ---
dl "https://dev.bukkit.org/projects/coreprotect/files/886944/download" "CoreProtect_2.12.0.jar"

# --- SkinsRestorer 15.12.5 (optional) ---
if [[ $WITH_SKINS == 1 ]]; then
  dl "https://github.com/SkinsRestorer/SkinsRestorer/releases/download/15.12.5/SkinsRestorer.jar" "SkinsRestorer.jar"
fi

# --- mcMMO Classic 1.5.00: the last build that runs on 1.8.8 (1.5.10 and later use 1.12's NamespacedKey and fail to enable) ---
dl "https://dev.bukkit.org/projects/mcmmo/files/781681/download" "mcMMO-1.5.00.jar"

cd ..
cat <<'MANUAL'

== Still by hand (login-gated), save under server/plugins/ with these names ==
  MassiveCore.jar         MassiveCore 2.8.5   https://www.spigotmc.org/resources/massivecore.1898/   (SpigotMC account needed)
  Factions.jar            Factions 2.8.5      https://www.spigotmc.org/resources/factions.1900/      (SpigotMC account needed)
  BotBridge-0.1.0.jar     ours: build it (docs/botbridge.md) or take the GitHub release jar

MANUAL
check || true
