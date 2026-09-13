package com.aifactions.botbridge.listeners;

import com.aifactions.botbridge.RedisBus;
import com.gmail.nossr50.events.experience.McMMOPlayerLevelUpEvent;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;

import java.util.LinkedHashMap;
import java.util.Map;

public class McmmoListener implements Listener {
    private final RedisBus bus;

    public McmmoListener(RedisBus bus) {
        this.bus = bus;
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onLevelUp(McMMOPlayerLevelUpEvent e) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("player", e.getPlayer().getName());
        m.put("skill", e.getSkill().name());
        m.put("new_level", e.getSkillLevel());
        bus.publish("mcmmo_levelup", m);
    }
}
