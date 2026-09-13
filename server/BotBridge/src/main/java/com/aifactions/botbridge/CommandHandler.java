package com.aifactions.botbridge;

import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.entity.Player;
import org.bukkit.plugin.Plugin;
import org.bukkit.plugin.java.JavaPlugin;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Handles JSON commands coming in on the commands channel and publishes
 * responses on the responses channel.
 *
 * Supported commands:
 *   {"type":"give_event_subscription","bot":"<name>"}
 *   {"type":"query_nearby_players","bot":"<name>","radius":N,"request_id":"..."}
 *   {"type":"query_faction_info","faction":"<name>","request_id":"..."}
 *
 * Queries that touch Bukkit world state are dispatched to the main thread
 * and then published back on the responses channel asynchronously.
 */
public class CommandHandler {

    private final JavaPlugin plugin;
    private final RedisBus bus;

    public CommandHandler(JavaPlugin plugin, RedisBus bus) {
        this.plugin = plugin;
        this.bus = bus;
    }

    public void onMessage(String raw) {
        Map<String, Object> cmd;
        try {
            cmd = Json.parseObject(raw);
        } catch (Exception e) {
            plugin.getLogger().warning("bad command JSON: " + e.getMessage());
            return;
        }

        String type = asString(cmd.get("type"));
        if (type == null) {
            replyError(cmd, "missing_type");
            return;
        }

        switch (type) {
            case "give_event_subscription":
                handleSubscribe(cmd);
                break;
            case "query_nearby_players":
                handleNearbyPlayers(cmd);
                break;
            case "query_faction_info":
                handleFactionInfo(cmd);
                break;
            case "query_factions":
                handleFactions(cmd);
                break;
            case "query_claims":
                handleClaims(cmd);
                break;
            case "query_online":
                handleOnline(cmd);
                break;
            case "query_player_faction":
                handlePlayerFaction(cmd);
                break;
            case "query_balance":
                handleBalance(cmd);
                break;
            case "query_baltop":
                handleBaltop(cmd);
                break;
            default:
                replyError(cmd, "unknown_type:" + type);
        }
    }

    // ---------- the board: factions, claims, online, money ----------

    private boolean factionsLoaded(Map<String, Object> cmd) {
        if (plugin.getServer().getPluginManager().getPlugin("Factions") == null) {
            replyError(cmd, "factions_not_loaded");
            return false;
        }
        return true;
    }

    private void handleFactions(Map<String, Object> cmd) {
        if (!factionsLoaded(cmd)) return;
        String bot = asString(cmd.get("bot"));
        runOnMain(() -> {
            try {
                Map<String, Object> reply = baseReply(cmd, "factions");
                reply.put("factions", FactionQuery.listAll(bot));
                reply.put("my_faction", bot == null ? null : FactionQuery.factionOf(bot));
                bus.reply(reply);
            } catch (Throwable t) {
                plugin.getLogger().warning("factions query failed: " + t);
                replyError(cmd, "query_failed:" + t.getClass().getSimpleName());
            }
        });
    }

    private void handleClaims(Map<String, Object> cmd) {
        if (!factionsLoaded(cmd)) return;
        String bot = asString(cmd.get("bot"));
        int radius = Math.max(1, Math.min(8, asInt(cmd.get("radius"), 4)));
        runOnMain(() -> {
            try {
                String world;
                int x, z;
                Player anchor = (bot == null) ? null : Bukkit.getPlayerExact(bot);
                if (cmd.get("x") != null && cmd.get("z") != null) {
                    x = asInt(cmd.get("x"), 0);
                    z = asInt(cmd.get("z"), 0);
                    world = asString(cmd.get("world"));
                    if (world == null) world = anchor != null ? anchor.getWorld().getName() : Bukkit.getWorlds().get(0).getName();
                } else if (anchor != null) {
                    Location loc = anchor.getLocation();
                    x = loc.getBlockX();
                    z = loc.getBlockZ();
                    world = anchor.getWorld().getName();
                } else {
                    replyError(cmd, "missing_position");
                    return;
                }
                Map<String, Object> reply = baseReply(cmd, "claims");
                reply.put("world", world);
                reply.put("x", x);
                reply.put("z", z);
                reply.put("radius", radius);
                reply.put("claims", FactionQuery.claimsAround(world, x, z, radius));
                bus.reply(reply);
            } catch (Throwable t) {
                plugin.getLogger().warning("claims query failed: " + t);
                replyError(cmd, "query_failed:" + t.getClass().getSimpleName());
            }
        });
    }

    private void handleOnline(Map<String, Object> cmd) {
        runOnMain(() -> {
            try {
                Map<String, Object> reply = baseReply(cmd, "online");
                if (plugin.getServer().getPluginManager().getPlugin("Factions") != null) {
                    reply.put("players", FactionQuery.online());
                } else {
                    List<Map<String, Object>> list = new ArrayList<>();
                    for (Player p : Bukkit.getOnlinePlayers()) {
                        Map<String, Object> m = new LinkedHashMap<>();
                        m.put("name", p.getName());
                        m.put("faction", null);
                        list.add(m);
                    }
                    reply.put("players", list);
                }
                bus.reply(reply);
            } catch (Throwable t) {
                replyError(cmd, "query_failed:" + t.getClass().getSimpleName());
            }
        });
    }

    private void handlePlayerFaction(Map<String, Object> cmd) {
        if (!factionsLoaded(cmd)) return;
        String player = asString(cmd.get("player"));
        if (player == null) { replyError(cmd, "missing_player"); return; }
        runOnMain(() -> {
            try {
                Map<String, Object> reply = baseReply(cmd, "player_faction");
                reply.put("player", player);
                reply.put("faction", FactionQuery.factionOf(player));
                bus.reply(reply);
            } catch (Throwable t) {
                replyError(cmd, "query_failed:" + t.getClass().getSimpleName());
            }
        });
    }

    private boolean vaultLoaded(Map<String, Object> cmd) {
        if (plugin.getServer().getPluginManager().getPlugin("Vault") == null) {
            replyError(cmd, "vault_not_loaded");
            return false;
        }
        return true;
    }

    private void handleBalance(Map<String, Object> cmd) {
        if (!vaultLoaded(cmd)) return;
        String player = asString(cmd.get("player"));
        if (player == null) player = asString(cmd.get("bot"));
        if (player == null) { replyError(cmd, "missing_player"); return; }
        final String who = player;
        runOnMain(() -> {
            try {
                Map<String, Object> reply = baseReply(cmd, "balance");
                reply.putAll(EconomyQuery.balance(who));
                bus.reply(reply);
            } catch (Throwable t) {
                replyError(cmd, "query_failed:" + t.getClass().getSimpleName());
            }
        });
    }

    private void handleBaltop(Map<String, Object> cmd) {
        if (!vaultLoaded(cmd)) return;
        String bot = asString(cmd.get("bot"));
        int limit = Math.max(1, Math.min(25, asInt(cmd.get("limit"), 10)));
        runOnMain(() -> {
            try {
                Map<String, Object> reply = baseReply(cmd, "baltop");
                reply.putAll(EconomyQuery.baltop(limit, bot));
                bus.reply(reply);
            } catch (Throwable t) {
                replyError(cmd, "query_failed:" + t.getClass().getSimpleName());
            }
        });
    }

    private void handleSubscribe(Map<String, Object> cmd) {
        String bot = asString(cmd.get("bot"));
        plugin.getLogger().info("bot subscribed: " + bot);
        Map<String, Object> reply = baseReply(cmd, "subscribed");
        reply.put("bot", bot);
        bus.reply(reply);
    }

    private void handleNearbyPlayers(Map<String, Object> cmd) {
        String bot = asString(cmd.get("bot"));
        int radius = asInt(cmd.get("radius"), 16);

        runOnMain(() -> {
            Player anchor = (bot == null) ? null : Bukkit.getPlayerExact(bot);
            if (anchor == null) {
                replyError(cmd, bot == null ? "missing_bot" : "bot_not_online:" + bot);
                return;
            }
            Location loc = anchor.getLocation();
            List<Map<String, Object>> list = new ArrayList<>();
            int r2 = radius * radius;
            for (Player p : Bukkit.getOnlinePlayers()) {
                if (p == anchor) continue;
                if (!p.getWorld().equals(anchor.getWorld())) continue;
                double dx = p.getLocation().getX() - loc.getX();
                double dy = p.getLocation().getY() - loc.getY();
                double dz = p.getLocation().getZ() - loc.getZ();
                double d2 = dx * dx + dy * dy + dz * dz;
                if (d2 > r2) continue;
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("name", p.getName());
                entry.put("uuid", p.getUniqueId().toString());
                entry.put("distance", Math.sqrt(d2));
                entry.put("x", p.getLocation().getX());
                entry.put("y", p.getLocation().getY());
                entry.put("z", p.getLocation().getZ());
                list.add(entry);
            }
            Map<String, Object> reply = baseReply(cmd, "nearby_players");
            reply.put("bot", bot);
            reply.put("radius", radius);
            reply.put("players", list);
            bus.reply(reply);
        });
    }

    private void handleFactionInfo(Map<String, Object> cmd) {
        String factionName = asString(cmd.get("faction"));
        if (factionName == null) {
            replyError(cmd, "missing_faction");
            return;
        }

        if (plugin.getServer().getPluginManager().getPlugin("Factions") == null) {
            replyError(cmd, "factions_not_loaded");
            return;
        }

        // Massive Factions API is main-thread-safe; use sync task to be safe.
        runOnMain(() -> {
            try {
                Map<String, Object> reply = FactionQuery.lookup(factionName);
                reply.putAll(baseReply(cmd, "faction_info"));
                reply.put("faction", factionName);
                bus.reply(reply);
            } catch (Throwable t) {
                plugin.getLogger().warning("faction lookup failed: " + t);
                replyError(cmd, "lookup_failed:" + t.getClass().getSimpleName());
            }
        });
    }

    // ---------- helpers ----------

    private void runOnMain(Runnable r) {
        Bukkit.getScheduler().runTask((Plugin) plugin, r);
    }

    private Map<String, Object> baseReply(Map<String, Object> cmd, String type) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", type);
        Object reqId = cmd.get("request_id");
        if (reqId != null) m.put("request_id", reqId);
        return m;
    }

    private void replyError(Map<String, Object> cmd, String err) {
        Map<String, Object> m = baseReply(cmd, "error");
        m.put("error", err);
        bus.reply(m);
    }

    private static String asString(Object o) {
        return o == null ? null : o.toString();
    }

    private static int asInt(Object o, int fallback) {
        if (o == null) return fallback;
        if (o instanceof Number) return ((Number) o).intValue();
        try { return Integer.parseInt(o.toString()); } catch (NumberFormatException e) { return fallback; }
    }
}
