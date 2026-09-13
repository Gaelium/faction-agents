package com.aifactions.botbridge;

import com.aifactions.botbridge.listeners.ChatListener;
import com.aifactions.botbridge.listeners.CombatListener;
import com.aifactions.botbridge.listeners.EconomyListener;
import com.aifactions.botbridge.listeners.FactionsListener;
import com.aifactions.botbridge.listeners.KitListener;
import com.aifactions.botbridge.listeners.McmmoListener;
import com.aifactions.botbridge.listeners.ZoneListener;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.event.Listener;
import org.bukkit.plugin.PluginManager;
import org.bukkit.plugin.java.JavaPlugin;

public class BotBridgePlugin extends JavaPlugin {

    private RedisBus bus;
    private CommandHandler commandHandler;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        FileConfiguration cfg = getConfig();

        bus = new RedisBus(
                this,
                cfg.getString("redis.host", "localhost"),
                cfg.getInt("redis.port", 6379),
                cfg.getString("redis.password", ""),
                cfg.getInt("redis.database", 0),
                cfg.getInt("redis.timeout-ms", 2000),
                cfg.getString("channels.events", "mc:events"),
                cfg.getString("channels.commands", "mc:commands"),
                cfg.getString("channels.responses", "mc:responses")
        );
        bus.start();

        commandHandler = new CommandHandler(this, bus);
        bus.setCommandHandler(commandHandler);

        PluginManager pm = getServer().getPluginManager();
        if (cfg.getBoolean("features.combat", true)) registerIf(pm, new CombatListener(bus));
        if (cfg.getBoolean("features.chat", true))   registerIf(pm, new ChatListener(bus));
        if (cfg.getBoolean("features.kit", true))    registerIf(pm, new KitListener(bus));
        if (cfg.getBoolean("features.economy", true)) registerIf(pm, new EconomyListener(bus));

        if (cfg.getBoolean("features.zone", true) && pm.getPlugin("WorldGuard") != null) {
            registerIf(pm, new ZoneListener(this, bus, cfg.getLong("zone.check-interval-ms", 250L)));
        } else {
            getLogger().info("WorldGuard not present; zone_enter disabled.");
        }

        if (cfg.getBoolean("features.mcmmo", true) && pm.getPlugin("mcMMO") != null) {
            try {
                registerIf(pm, new McmmoListener(bus));
            } catch (Throwable t) {
                getLogger().warning("mcMMO listener failed to register: " + t.getMessage());
            }
        } else {
            getLogger().info("mcMMO not present; mcmmo_levelup disabled.");
        }

        if (cfg.getBoolean("features.factions", true) && pm.getPlugin("Factions") != null) {
            try {
                registerIf(pm, new FactionsListener(bus));
            } catch (Throwable t) {
                getLogger().warning("Factions listener failed to register: " + t.getMessage());
            }
        } else {
            getLogger().info("Factions not present; faction_event disabled.");
        }

        getLogger().info("BotBridge enabled.");
    }

    @Override
    public void onDisable() {
        if (bus != null) bus.shutdown();
        getLogger().info("BotBridge disabled.");
    }

    private void registerIf(PluginManager pm, Listener l) {
        pm.registerEvents(l, this);
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!command.getName().equalsIgnoreCase("botbridge")) return false;
        if (args.length == 0) {
            sender.sendMessage("§eBotBridge §7" + getDescription().getVersion()
                    + " — " + (bus.isConnected() ? "§aconnected" : "§cdisconnected"));
            return true;
        }
        if (args[0].equalsIgnoreCase("status")) {
            sender.sendMessage("§eBotBridge: §7" + bus.statusLine());
            return true;
        }
        if (args[0].equalsIgnoreCase("reconnect")) {
            bus.reconnect();
            sender.sendMessage("§eBotBridge: reconnect requested.");
            return true;
        }
        return false;
    }
}
