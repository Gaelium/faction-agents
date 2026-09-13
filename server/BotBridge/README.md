# BotBridge

The Paper 1.8.8 plugin that publishes server events (chat, damage, deaths,
kits, money, zones, mcMMO, factions) as JSON on Redis and answers the
bots' queries (factions, claims, online players, balances). Full
reference, config keys, every event and command with its fields, and the
redis-cli verification recipe: [docs/botbridge.md](../../docs/botbridge.md).

Build (Java 8, Maven, and the six plugin jars in `../plugins` that
`pom.xml` reads with `system` scope; `../fetch-plugins.sh --check` lists them):

```bash
cd server/BotBridge
JAVA_HOME=$(/usr/libexec/java_home -v 1.8) mvn -DskipTests package      # macOS; Linux: JAVA_HOME=/usr/lib/jvm/java-8-openjdk-amd64
cp target/BotBridge-0.1.0.jar ../plugins/
# server console: reload confirm   (or restart)
```

The first build needs the network for the Spigot API and Jedis; after that
`mvn -o -DskipTests package` builds offline. Config lives in
`server/plugins/BotBridge/config.yml` (Redis host, channels, one switch per
feature).
