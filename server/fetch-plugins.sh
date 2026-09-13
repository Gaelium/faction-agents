#!/usr/bin/env bash
# fetch-plugins.sh — download the Paper jar and the plugins that have direct
# URLs, then list what has to be fetched by hand. Idempotent: existing jars
# are kept. Needs curl and python3 (for two JSON answers).
#
#   ./fetch-plugins.sh               Paper + EssentialsX ×3, Vault, WorldEdit, LuckPerms
#   ./fetch-plugins.sh --with-skins  also SkinsRestorer (optional: bot skins)
#   ./fetch-plugins.sh --check       download nothing; report which expected jars are present
#
# The filenames below are the ones start.sh, BotBridge/pom.xml and README.md
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
          worldguard-6.1.jar mcMMO-1.5.10.jar BotBridge-0.1.0.jar)
OPTIONAL=(SkinsRestorer.jar CoreProtect_2.12.0.jar)

dl() {
  local url="$1" out="$2"
  if [[ -f "$out" ]]; then echo "✓ have $out"; return; fi
  echo "→ $out"
  curl -L --fail --retry 3 -o "$out.part" "$url"
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
  if ls plugins/LuckPerms-Bukkit-*.jar >/dev/null 2>&1; then echo "  ✓ $(basename "$(ls plugins/LuckPerms-Bukkit-*.jar | head -1)")"; else echo "  ✗ LuckPerms-Bukkit-<version>.jar"; missing=1; fi
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

# --- WorldEdit 6.1.9 (the 1.8 line; 7.x needs 1.13+) ---
dl "https://dev.bukkit.org/projects/worldedit/files/2597538/download" "worldedit-bukkit-6.1.9.jar"

# --- LuckPerms: latest Bukkit loader (the reference server runs 5.4.145; LuckPerms keeps 1.8.8 support) ---
if ! ls LuckPerms-Bukkit-*.jar >/dev/null 2>&1; then
  lp_url=$(curl -sSL --fail https://metadata.luckperms.net/data/downloads \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["downloads"]["bukkit"])')
  dl "$lp_url" "$(basename "$lp_url")"
else
  echo "✓ have $(basename "$(ls LuckPerms-Bukkit-*.jar | head -1)")"
fi

# --- SkinsRestorer 15.12.5 (optional) ---
if [[ $WITH_SKINS == 1 ]]; then
  dl "https://github.com/SkinsRestorer/SkinsRestorer/releases/download/15.12.5/SkinsRestorer.jar" "SkinsRestorer.jar"
fi

cd ..
cat <<'MANUAL'

== Download by hand (login-gated or unpublished), save under server/plugins/ with these names ==
  MassiveCore.jar         MassiveCore 2.8.5   https://www.spigotmc.org/resources/massivecore.1898/
  Factions.jar            Factions 2.8.5      https://www.spigotmc.org/resources/factions.1900/
  worldguard-6.1.jar      WorldGuard 6.1      https://dev.bukkit.org/projects/worldguard/files  (pick 6.1, the 1.8 line)
  mcMMO-1.5.10.jar        mcMMO 1.5.10        build from https://github.com/mcMMO-Dev/mcMMO-Classic (mvn package)
                                              or https://dev.bukkit.org/projects/mcmmo/files
  CoreProtect_2.12.0.jar  optional            https://dev.bukkit.org/projects/coreprotect/files
  BotBridge-0.1.0.jar     ours                build it: see BotBridge/README.md, or take the GitHub release jar

MANUAL
check || true
