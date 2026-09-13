#!/usr/bin/env bash
# AI Factions — Paper 1.8.8 launcher
set -euo pipefail

cd "$(dirname "$0")"

JAR="paper-1.8.8-445.jar"
RAM="4G"

find_java8() {
  if [[ -n "${JAVA8_HOME:-}" ]] && [[ -x "$JAVA8_HOME/bin/java" ]]; then
    echo "$JAVA8_HOME/bin/java"; return
  fi
  if command -v /usr/libexec/java_home >/dev/null 2>&1; then
    local home
    home=$(/usr/libexec/java_home -v 1.8 2>/dev/null || true)
    if [[ -n "$home" ]] && [[ -x "$home/bin/java" ]]; then
      echo "$home/bin/java"; return
    fi
  fi
  for c in \
    /Library/Java/JavaVirtualMachines/*1.8*/Contents/Home/bin/java \
    /Library/Java/JavaVirtualMachines/*jdk8*/Contents/Home/bin/java \
    /Library/Java/JavaVirtualMachines/zulu-8.jdk/Contents/Home/bin/java \
    /Library/Java/JavaVirtualMachines/temurin-8.jdk/Contents/Home/bin/java; do
    if [[ -x "$c" ]]; then echo "$c"; return; fi
  done
  echo ""
}

JAVA_BIN=$(find_java8)
if [[ -z "$JAVA_BIN" ]]; then
  cat <<EOF >&2
ERROR: Java 8 not found. Paper 1.8.8 requires Java 8.

Install on macOS (Apple Silicon or Intel):
  brew install --cask zulu@8        # recommended
  # or
  brew install --cask temurin@8

Then re-run ./start.sh. Override with JAVA8_HOME=/path/to/jdk if needed.
EOF
  exit 1
fi

if [[ ! -f "$JAR" ]]; then
  echo "ERROR: $JAR not found in $(pwd)" >&2
  exit 1
fi

echo "Using Java: $JAVA_BIN"
"$JAVA_BIN" -version

exec "$JAVA_BIN" \
  -Xms${RAM} -Xmx${RAM} \
  -XX:+UseG1GC \
  -XX:+ParallelRefProcEnabled \
  -XX:MaxGCPauseMillis=200 \
  -XX:+UnlockExperimentalVMOptions \
  -XX:+DisableExplicitGC \
  -XX:+AlwaysPreTouch \
  -XX:G1NewSizePercent=30 \
  -XX:G1MaxNewSizePercent=40 \
  -XX:G1HeapRegionSize=8M \
  -XX:G1ReservePercent=20 \
  -XX:G1HeapWastePercent=5 \
  -XX:G1MixedGCCountTarget=4 \
  -XX:InitiatingHeapOccupancyPercent=15 \
  -XX:G1MixedGCLiveThresholdPercent=90 \
  -XX:G1RSetUpdatingPauseTimePercent=5 \
  -XX:SurvivorRatio=32 \
  -XX:+PerfDisableSharedMem \
  -XX:MaxTenuringThreshold=1 \
  -Dusing.aikars.flags=https://mcflags.emc.gs \
  -Daikars.new.flags=true \
  -jar "$JAR" nogui
