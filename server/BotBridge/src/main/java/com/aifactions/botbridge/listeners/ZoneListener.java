package com.aifactions.botbridge.listeners;

import com.aifactions.botbridge.RedisBus;
import com.sk89q.worldguard.bukkit.WGBukkit;
import com.sk89q.worldguard.bukkit.WorldGuardPlugin;
import com.sk89q.worldguard.protection.ApplicableRegionSet;
import com.sk89q.worldguard.protection.managers.RegionManager;
import com.sk89q.worldguard.protection.regions.ProtectedRegion;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.Plugin;

import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Polls WorldGuard regions on PlayerMoveEvent (only when block-position
 * changes) and emits zone_enter for any newly-entered region. Debounced
 * per-player by {@link #checkIntervalMs} to keep per-tick load bounded.
 *
 * WG 6.x does not fire a RegionEnterEvent natively, so we diff region sets.
 */
public class ZoneListener implements Listener {
    private final RedisBus bus;
    private final long checkIntervalMs;
    private final Map<UUID, Set<String>> lastRegions = new ConcurrentHashMap<>();
    private final Map<UUID, Long> lastCheck = new ConcurrentHashMap<>();
    private final WorldGuardPlugin wg;

    public ZoneListener(Plugin plugin, RedisBus bus, long checkIntervalMs) {
        this.bus = bus;
        this.checkIntervalMs = checkIntervalMs;
        this.wg = WGBukkit.getPlugin();
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onMove(PlayerMoveEvent e) {
        Location from = e.getFrom();
        Location to = e.getTo();
        if (from.getBlockX() == to.getBlockX()
                && from.getBlockY() == to.getBlockY()
                && from.getBlockZ() == to.getBlockZ()) return;

        Player p = e.getPlayer();
        UUID id = p.getUniqueId();
        long now = System.currentTimeMillis();
        Long last = lastCheck.get(id);
        if (last != null && now - last < checkIntervalMs) return;
        lastCheck.put(id, now);

        Set<String> current = regionsAt(to);
        Set<String> previous = lastRegions.getOrDefault(id, new HashSet<>());
        for (String regionId : current) {
            if (!previous.contains(regionId)) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("player", p.getName());
                m.put("zone_name", regionId);
                bus.publish("zone_enter", m);
            }
        }
        lastRegions.put(id, current);
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent e) {
        UUID id = e.getPlayer().getUniqueId();
        lastRegions.remove(id);
        lastCheck.remove(id);
    }

    private Set<String> regionsAt(Location loc) {
        Set<String> out = new HashSet<>();
        World world = loc.getWorld();
        if (world == null) return out;
        RegionManager rm = wg.getRegionManager(world);
        if (rm == null) return out;
        ApplicableRegionSet set = rm.getApplicableRegions(loc);
        for (ProtectedRegion r : set) out.add(r.getId());
        return out;
    }
}
