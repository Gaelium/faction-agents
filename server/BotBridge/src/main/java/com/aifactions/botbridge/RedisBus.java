package com.aifactions.botbridge;

import org.bukkit.plugin.java.JavaPlugin;
import redis.clients.jedis.Jedis;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.JedisPoolConfig;
import redis.clients.jedis.JedisPubSub;
import redis.clients.jedis.exceptions.JedisConnectionException;

import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Pub/sub wrapper around Jedis.
 *
 *   publish(...)  → serializes a Map as JSON and PUBLISHes on the events channel.
 *   reply(...)    → publishes a JSON response on the responses channel.
 *
 * Command subscription runs on a dedicated thread. Failures trigger reconnect
 * with simple backoff.
 */
public class RedisBus {

    private final JavaPlugin plugin;
    private final String host, password, eventsChan, commandsChan, responsesChan;
    private final int port, database, timeoutMs;

    private JedisPool pool;
    private Thread subThread;
    private JedisPubSub subscriber;
    private CommandHandler commandHandler;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private volatile String lastError = "none";

    public RedisBus(JavaPlugin plugin, String host, int port, String password,
                    int database, int timeoutMs,
                    String eventsChan, String commandsChan, String responsesChan) {
        this.plugin = plugin;
        this.host = host;
        this.port = port;
        this.password = password == null ? "" : password;
        this.database = database;
        this.timeoutMs = timeoutMs;
        this.eventsChan = eventsChan;
        this.commandsChan = commandsChan;
        this.responsesChan = responsesChan;
    }

    public void setCommandHandler(CommandHandler handler) {
        this.commandHandler = handler;
    }

    public void start() {
        JedisPoolConfig cfg = new JedisPoolConfig();
        cfg.setMaxTotal(8);
        cfg.setMaxIdle(2);
        if (password.isEmpty()) {
            pool = new JedisPool(cfg, host, port, timeoutMs, null, database);
        } else {
            pool = new JedisPool(cfg, host, port, timeoutMs, password, database);
        }

        // sanity ping
        try (Jedis j = pool.getResource()) {
            String pong = j.ping();
            plugin.getLogger().info("Redis ping: " + pong + " (" + host + ":" + port + ")");
        } catch (Exception e) {
            lastError = e.getMessage();
            plugin.getLogger().warning("Redis ping failed: " + e.getMessage()
                    + " — events will be dropped until connection is restored.");
        }

        running.set(true);
        startSubscriberThread();
    }

    private void startSubscriberThread() {
        subThread = new Thread(this::subscribeLoop, "BotBridge-RedisSub");
        subThread.setDaemon(true);
        subThread.start();
    }

    private void subscribeLoop() {
        long backoffMs = 1000;
        while (running.get()) {
            try (Jedis j = pool.getResource()) {
                subscriber = new JedisPubSub() {
                    @Override
                    public void onMessage(String channel, String message) {
                        if (commandHandler != null) {
                            try {
                                commandHandler.onMessage(message);
                            } catch (Throwable t) {
                                plugin.getLogger().warning("command handler error: " + t);
                            }
                        }
                    }
                };
                backoffMs = 1000;
                plugin.getLogger().info("Subscribed to " + commandsChan);
                j.subscribe(subscriber, commandsChan);  // blocks
            } catch (JedisConnectionException e) {
                lastError = "subscribe: " + e.getMessage();
                if (!running.get()) break;
                try {
                    Thread.sleep(backoffMs);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                }
                backoffMs = Math.min(backoffMs * 2, 30000);
            } catch (Throwable t) {
                lastError = "subscribe: " + t.getMessage();
                plugin.getLogger().warning("Redis subscriber error: " + t);
                try { Thread.sleep(2000); } catch (InterruptedException ie) { break; }
            }
        }
    }

    /** Publishes {@code fields} as a JSON object on the events channel. */
    public void publish(String eventType, Map<String, Object> fields) {
        if (pool == null) return;
        fields.put("event", eventType);
        fields.put("ts", System.currentTimeMillis());
        String json = Json.write(fields);
        try (Jedis j = pool.getResource()) {
            j.publish(eventsChan, json);
        } catch (Exception e) {
            lastError = "publish: " + e.getMessage();
            // don't log at WARNING — could flood if Redis is down
        }
    }

    /** Publishes a response on the responses channel. */
    public void reply(Map<String, Object> payload) {
        if (pool == null) return;
        payload.putIfAbsent("ts", System.currentTimeMillis());
        String json = Json.write(payload);
        try (Jedis j = pool.getResource()) {
            j.publish(responsesChan, json);
        } catch (Exception e) {
            lastError = "reply: " + e.getMessage();
        }
    }

    public boolean isConnected() {
        if (pool == null) return false;
        try (Jedis j = pool.getResource()) {
            return "PONG".equalsIgnoreCase(j.ping());
        } catch (Exception e) {
            return false;
        }
    }

    public String statusLine() {
        return (isConnected() ? "connected" : "disconnected")
                + " host=" + host + ":" + port
                + " events=" + eventsChan
                + " commands=" + commandsChan
                + " lastError=" + lastError;
    }

    public void reconnect() {
        if (subscriber != null) {
            try { subscriber.unsubscribe(); } catch (Exception ignored) {}
        }
    }

    public void shutdown() {
        running.set(false);
        if (subscriber != null) {
            try { subscriber.unsubscribe(); } catch (Exception ignored) {}
        }
        if (subThread != null) subThread.interrupt();
        if (pool != null) pool.close();
    }
}
