package com.aifactions.botbridge.listeners;

import com.aifactions.botbridge.RedisBus;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.AsyncPlayerChatEvent;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

public class ChatListener implements Listener {
    private final RedisBus bus;

    public ChatListener(RedisBus bus) {
        this.bus = bus;
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onChat(AsyncPlayerChatEvent e) {
        Player p = e.getPlayer();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("sender", p.getName());
        m.put("message", e.getMessage());
        m.put("channel", "global");
        bus.publish("chat_message", m);
    }

    /**
     * Faction- and local-channel messages on Massive Factions are sent via
     * /f chat, /f c, /f c faction, /f c public, etc. We intercept those so
     * the bridge tags the channel correctly. The chat itself still fires
     * AsyncPlayerChatEvent (above) for the actual message — this just
     * publishes an intent event when the toggle happens.
     */
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onCommand(PlayerCommandPreprocessEvent e) {
        String msg = e.getMessage().toLowerCase(Locale.ROOT);
        if (!(msg.startsWith("/f chat") || msg.startsWith("/f c"))) return;

        String channel = "global";
        if (msg.contains("faction") || msg.equals("/f chat") || msg.equals("/f c")) channel = "faction";
        else if (msg.contains("public")) channel = "global";
        else if (msg.contains("ally") || msg.contains("truce")) channel = "ally";

        Map<String, Object> m = new LinkedHashMap<>();
        m.put("sender", e.getPlayer().getName());
        m.put("message", "<chat-toggle>");
        m.put("channel", channel);
        m.put("source", "faction-toggle");
        bus.publish("chat_message", m);
    }
}
