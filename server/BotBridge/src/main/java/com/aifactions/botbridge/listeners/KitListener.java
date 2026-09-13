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
 * EssentialsX does not fire a "kit used" Bukkit event. We watch
 * PlayerCommandPreprocessEvent for /kit <name> (including aliases /ekit,
 * /essentials:kit) and emit kit_used post-execution. Events are fired on
 * MONITOR ignoreCancelled=true so we only report kits that actually ran.
 */
public class KitListener implements Listener {
    private final RedisBus bus;

    public KitListener(RedisBus bus) {
        this.bus = bus;
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onCmd(PlayerCommandPreprocessEvent e) {
        String raw = e.getMessage().trim();
        String lower = raw.toLowerCase(Locale.ROOT);
        if (!lower.startsWith("/kit") && !lower.startsWith("/ekit")
                && !lower.startsWith("/essentials:kit")) return;

        String[] parts = raw.split("\\s+");
        if (parts.length < 2) return;  // just "/kit" (list) — not a use
        String kitName = parts[1].toLowerCase(Locale.ROOT);

        Map<String, Object> m = new LinkedHashMap<>();
        m.put("player", e.getPlayer().getName());
        m.put("kit_name", kitName);
        bus.publish("kit_used", m);
    }
}
