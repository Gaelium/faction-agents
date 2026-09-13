package com.aifactions.botbridge;

import net.milkbowl.vault.economy.Economy;
import org.bukkit.Bukkit;
import org.bukkit.OfflinePlayer;
import org.bukkit.plugin.RegisteredServiceProvider;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Isolated Vault access: a player's balance and the balance leaderboard,
 * the same numbers a human sees with /balance and /baltop.
 */
public final class EconomyQuery {
    private EconomyQuery() {}

    private static Economy economy() {
        RegisteredServiceProvider<Economy> rsp = Bukkit.getServicesManager().getRegistration(Economy.class);
        return rsp == null ? null : rsp.getProvider();
    }

    public static Map<String, Object> balance(String playerName) {
        Map<String, Object> out = new LinkedHashMap<>();
        Economy econ = economy();
        if (econ == null) { out.put("error", "no_economy"); return out; }
        OfflinePlayer p = Bukkit.getPlayerExact(playerName);
        if (p == null) p = Bukkit.getOfflinePlayer(playerName);
        out.put("player", playerName);
        out.put("balance", econ.getBalance(p));
        return out;
    }

    /** Top `limit` balances plus the bot's own rank (1-based) and balance. */
    public static Map<String, Object> baltop(int limit, String botName) {
        Map<String, Object> out = new LinkedHashMap<>();
        Economy econ = economy();
        if (econ == null) { out.put("error", "no_economy"); return out; }
        List<Map<String, Object>> rows = new ArrayList<>();
        for (OfflinePlayer p : Bukkit.getOfflinePlayers()) {
            if (p == null || p.getName() == null) continue;
            double bal;
            try { bal = econ.getBalance(p); } catch (Throwable t) { continue; }
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", p.getName());
            m.put("balance", Math.round(bal * 100.0) / 100.0);
            rows.add(m);
        }
        rows.sort((a, b) -> Double.compare(((Number) b.get("balance")).doubleValue(), ((Number) a.get("balance")).doubleValue()));
        int rank = -1;
        double mine = 0;
        for (int i = 0; i < rows.size(); i++) {
            if (botName != null && botName.equalsIgnoreCase(String.valueOf(rows.get(i).get("name")))) {
                rank = i + 1;
                mine = ((Number) rows.get(i).get("balance")).doubleValue();
                break;
            }
        }
        out.put("players", rows.size());
        out.put("top", rows.subList(0, Math.min(limit, rows.size())));
        out.put("my_rank", rank);
        out.put("my_balance", mine);
        return out;
    }
}
