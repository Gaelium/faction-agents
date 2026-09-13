package com.aifactions.botbridge;

import com.massivecraft.factions.Rel;
import com.massivecraft.factions.entity.BoardColl;
import com.massivecraft.factions.entity.Faction;
import com.massivecraft.factions.entity.FactionColl;
import com.massivecraft.factions.entity.MPlayer;
import com.massivecraft.massivecore.ps.PS;
import com.massivecraft.massivecore.ps.PSBuilder;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Isolated Massive Factions API access. Lives in its own class so the
 * classloader only loads these imports when Factions is present.
 *
 * Everything here answers questions a human can answer with /f list,
 * /f who, /f map, and the tab list: the "board" the bots play on.
 */
public final class FactionQuery {
    private FactionQuery() {}

    public static Map<String, Object> lookup(String name) {
        Map<String, Object> out = new LinkedHashMap<>();
        Faction f = FactionColl.get().getByName(name);
        if (f == null) {
            out.put("found", false);
            return out;
        }
        out.put("found", true);
        out.put("faction_id", f.getId());
        out.put("power", f.getPower());
        out.put("land_count", f.getLandCount());

        List<Map<String, Object>> members = new ArrayList<>();
        for (MPlayer mp : f.getMPlayers()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", mp.getName());
            m.put("uuid", mp.getId());
            m.put("role", mp.getRole() == null ? null : mp.getRole().name());
            m.put("power", mp.getPower());
            members.add(m);
        }
        out.put("members", members);

        Set<PS> chunks = BoardColl.get().getChunks(f);
        List<Map<String, Object>> claims = new ArrayList<>();
        if (chunks != null) {
            for (PS ps : chunks) {
                Map<String, Object> c = new LinkedHashMap<>();
                c.put("world", ps.getWorld());
                c.put("chunk_x", ps.getChunkX());
                c.put("chunk_z", ps.getChunkZ());
                claims.add(c);
            }
        }
        out.put("claims", claims);

        return out;
    }

    /** Faction of a player by name (online or known offline), or null. */
    public static String factionOf(String playerName) {
        if (playerName == null) return null;
        MPlayer mp = null;
        Player p = Bukkit.getPlayerExact(playerName);
        try { mp = (p != null) ? MPlayer.get(p) : MPlayer.get(playerName); } catch (Throwable ignored) {}
        if (mp == null || !mp.hasFaction()) return null;
        Faction f = mp.getFaction();
        if (f == null || f.isNone()) return null;
        return f.getName();
    }

    private static boolean isSystemFaction(Faction f) {
        if (f == null || f.isNone()) return true;
        try {
            Faction safe = FactionColl.get().getSafezone();
            Faction war = FactionColl.get().getWarzone();
            if (safe != null && safe.getId().equals(f.getId())) return true;
            if (war != null && war.getId().equals(f.getId())) return true;
        } catch (Throwable ignored) {}
        return false;
    }

    /**
     * Every player faction: name, power, max power, land, members, online
     * members, leader, and (when `botName` is given) the relation to the
     * bot's own faction. Sorted by power descending.
     */
    public static List<Map<String, Object>> listAll(String botName) {
        Faction mine = null;
        if (botName != null) {
            String fname = factionOf(botName);
            if (fname != null) mine = FactionColl.get().getByName(fname);
        }
        List<Map<String, Object>> list = new ArrayList<>();
        for (Faction f : FactionColl.get().getAll()) {
            if (isSystemFaction(f)) continue;
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", f.getName());
            m.put("power", round1(f.getPower()));
            m.put("power_max", round1(f.getPowerMax()));
            m.put("land", f.getLandCount());
            m.put("members", f.getMPlayers().size());
            int online = 0;
            try { online = f.getMPlayersWhereOnline(true).size(); } catch (Throwable ignored) {}
            m.put("online", online);
            try {
                MPlayer leader = f.getLeader();
                m.put("leader", leader == null ? null : leader.getName());
            } catch (Throwable ignored) { m.put("leader", null); }
            if (mine != null) {
                if (mine.getId().equals(f.getId())) m.put("relation", "own");
                else {
                    try {
                        Rel rel = mine.getRelationTo(f);
                        m.put("relation", rel == null ? "neutral" : rel.name().toLowerCase());
                    } catch (Throwable ignored) { m.put("relation", "neutral"); }
                }
            }
            // Raidable: land exceeds power (Massive's overclaim rule).
            m.put("raidable", f.getLandCount() > f.getPower());
            list.add(m);
        }
        list.sort((a, b) -> Double.compare(asDouble(b.get("power")), asDouble(a.get("power"))));
        return list;
    }

    /** Claimed chunks within `radius` chunks of (x, z), as {chunk_x, chunk_z, faction}. */
    public static List<Map<String, Object>> claimsAround(String world, int x, int z, int radius) {
        List<Map<String, Object>> out = new ArrayList<>();
        int cx0 = Math.floorDiv(x, 16);
        int cz0 = Math.floorDiv(z, 16);
        for (int dx = -radius; dx <= radius; dx++) {
            for (int dz = -radius; dz <= radius; dz++) {
                int cx = cx0 + dx, cz = cz0 + dz;
                PS ps = new PSBuilder().world(world).chunkX(cx).chunkZ(cz).build();
                Faction f = BoardColl.get().getFactionAt(ps);
                if (f == null || f.isNone()) continue;
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("chunk_x", cx);
                m.put("chunk_z", cz);
                m.put("faction", f.getName());
                out.add(m);
            }
        }
        return out;
    }

    /** Online players with their faction (null when factionless). */
    public static List<Map<String, Object>> online() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Player p : Bukkit.getOnlinePlayers()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", p.getName());
            String fname = null;
            try { fname = factionOf(p.getName()); } catch (Throwable ignored) {}
            m.put("faction", fname);
            m.put("x", (int) p.getLocation().getX());
            m.put("z", (int) p.getLocation().getZ());
            out.add(m);
        }
        return out;
    }

    private static double round1(double v) { return Math.round(v * 10.0) / 10.0; }

    private static double asDouble(Object o) {
        return (o instanceof Number) ? ((Number) o).doubleValue() : 0.0;
    }
}
