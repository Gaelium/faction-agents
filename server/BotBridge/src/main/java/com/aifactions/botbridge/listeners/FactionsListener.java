package com.aifactions.botbridge.listeners;

import com.aifactions.botbridge.RedisBus;
import com.massivecraft.factions.entity.Faction;
import com.massivecraft.factions.event.EventFactionsChunksChange;
import com.massivecraft.factions.event.EventFactionsCreate;
import com.massivecraft.factions.event.EventFactionsDisband;
import com.massivecraft.factions.event.EventFactionsRelationChange;
import org.bukkit.command.CommandSender;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;

import java.util.LinkedHashMap;
import java.util.Map;

public class FactionsListener implements Listener {
    private final RedisBus bus;

    public FactionsListener(RedisBus bus) {
        this.bus = bus;
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onCreate(EventFactionsCreate e) {
        Map<String, Object> m = base(e.getSender());
        m.put("type", "create");
        m.put("faction", e.getFactionName());
        m.put("faction_id", e.getFactionId());
        bus.publish("faction_event", m);
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onDisband(EventFactionsDisband e) {
        Faction f = e.getFaction();
        Map<String, Object> m = base(e.getSender());
        m.put("type", "disband");
        m.put("faction", f != null ? f.getName() : "unknown");
        m.put("faction_id", e.getFactionId());
        bus.publish("faction_event", m);
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onChunksChange(EventFactionsChunksChange e) {
        Faction newF = e.getNewFaction();
        Map<String, Object> m = base(e.getSender());
        m.put("type", "claim");
        m.put("faction", newF != null ? newF.getName() : "wilderness");
        m.put("chunks", e.getChunks() == null ? 0 : e.getChunks().size());
        bus.publish("faction_event", m);
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onRelation(EventFactionsRelationChange e) {
        String rel = e.getNewRelation() == null ? "unknown" : e.getNewRelation().name();
        Map<String, Object> m = base(e.getSender());
        m.put("type", mapRelationToType(rel));
        m.put("faction", e.getFaction() != null ? e.getFaction().getName() : null);
        m.put("other_faction", e.getOtherFaction() != null ? e.getOtherFaction().getName() : null);
        m.put("relation", rel);
        bus.publish("faction_event", m);
    }

    private Map<String, Object> base(CommandSender sender) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("actor", sender == null ? "console" : sender.getName());
        return m;
    }

    private String mapRelationToType(String rel) {
        switch (rel) {
            case "ALLY":
            case "TRUCE":
                return "ally";
            case "ENEMY":
                return "enemy";
            case "NEUTRAL":
                return "neutral";
            case "MEMBER":
                return "membership";
            default:
                return "relation";
        }
    }
}
