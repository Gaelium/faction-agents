package com.aifactions.botbridge.listeners;

import com.aifactions.botbridge.RedisBus;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Vault does not expose "money changed" events. To cover the user-visible
 * economy actions we listen for /pay and /eco commands. Exact amounts come
 * from the command args; we don't inspect balances.
 *
 * Known gaps: shop transactions (QuickShop, sign shops) are not captured
 * here. Will be added when those plugins are installed.
 */
public class EconomyListener implements Listener {
    private final RedisBus bus;

    public EconomyListener(RedisBus bus) {
        this.bus = bus;
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onCmd(PlayerCommandPreprocessEvent e) {
        String raw = e.getMessage().trim();
        String lower = raw.toLowerCase(Locale.ROOT);
        String[] parts = raw.split("\\s+");

        if (lower.startsWith("/pay ") && parts.length >= 3) {
            Double amount = parseAmount(parts[2]);
            if (amount == null) return;
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("player", e.getPlayer().getName());
            m.put("amount", -amount);
            m.put("reason", "pay:" + parts[1]);
            bus.publish("economy_transaction", m);
            return;
        }

        if ((lower.startsWith("/eco ") || lower.startsWith("/economy "))
                && parts.length >= 4) {
            String op = parts[1].toLowerCase(Locale.ROOT);
            Double amount = parseAmount(parts[3]);
            if (amount == null) return;
            if (op.equals("take") || op.equals("withdraw")) amount = -amount;
            else if (!op.equals("give") && !op.equals("set") && !op.equals("add")) return;

            Map<String, Object> m = new LinkedHashMap<>();
            m.put("player", parts[2]);
            m.put("amount", amount);
            m.put("reason", "admin:" + op);
            bus.publish("economy_transaction", m);
        }
    }

    private Double parseAmount(String s) {
        try { return Double.parseDouble(s); } catch (NumberFormatException ex) { return null; }
    }
}
