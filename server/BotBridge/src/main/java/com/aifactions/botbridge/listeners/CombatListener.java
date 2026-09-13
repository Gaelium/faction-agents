package com.aifactions.botbridge.listeners;

import com.aifactions.botbridge.RedisBus;
import org.bukkit.Location;
import org.bukkit.entity.Entity;
import org.bukkit.entity.LivingEntity;
import org.bukkit.entity.Player;
import org.bukkit.entity.Projectile;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.inventory.ItemStack;

import java.util.LinkedHashMap;
import java.util.Map;

public class CombatListener implements Listener {
    private final RedisBus bus;

    public CombatListener(RedisBus bus) {
        this.bus = bus;
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onEntityDamage(EntityDamageByEntityEvent e) {
        if (!(e.getEntity() instanceof Player)) return;

        Player victim = (Player) e.getEntity();
        Entity attackerEntity = e.getDamager();
        String attackerName;
        String weapon = "unknown";

        if (attackerEntity instanceof Player) {
            Player p = (Player) attackerEntity;
            attackerName = p.getName();
            ItemStack hand = p.getItemInHand();
            if (hand != null && hand.getType() != org.bukkit.Material.AIR) {
                weapon = hand.getType().name();
            } else {
                weapon = "FIST";
            }
        } else if (attackerEntity instanceof Projectile) {
            Projectile proj = (Projectile) attackerEntity;
            Object shooter = proj.getShooter();
            if (shooter instanceof Player) {
                attackerName = ((Player) shooter).getName();
            } else if (shooter instanceof LivingEntity) {
                attackerName = "mob:" + ((LivingEntity) shooter).getType().name();
            } else {
                attackerName = "projectile:" + proj.getType().name();
            }
            weapon = proj.getType().name();
        } else {
            attackerName = "mob:" + attackerEntity.getType().name();
        }

        Map<String, Object> m = new LinkedHashMap<>();
        m.put("attacker", attackerName);
        m.put("victim", victim.getName());
        m.put("damage", e.getFinalDamage());
        m.put("weapon", weapon);
        bus.publish("player_damage", m);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPlayerDeath(PlayerDeathEvent e) {
        Player victim = e.getEntity();
        Player killer = victim.getKiller();
        Location loc = victim.getLocation();

        String cause = "unknown";
        if (victim.getLastDamageCause() != null) {
            cause = victim.getLastDamageCause().getCause().name();
        }

        Map<String, Object> m = new LinkedHashMap<>();
        m.put("victim", victim.getName());
        m.put("killer", killer != null ? killer.getName() : null);
        m.put("cause", cause);

        Map<String, Object> locMap = new LinkedHashMap<>();
        locMap.put("world", loc.getWorld().getName());
        locMap.put("x", loc.getBlockX());
        locMap.put("y", loc.getBlockY());
        locMap.put("z", loc.getBlockZ());
        m.put("location", locMap);

        bus.publish("player_death", m);
    }
}
