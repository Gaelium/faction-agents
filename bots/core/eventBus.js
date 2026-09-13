import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

/**
 * Redis pub/sub client matching the BotBridge plugin protocol.
 *
 *   Subscriptions: mc:events, mc:responses
 *   Publishes:     mc:commands
 *
 * Consumers call .on(eventType, handler) to receive events. eventType is
 * the `event` field on mc:events payloads (e.g. 'player_damage') OR the
 * wildcard '*' to receive every event.
 *
 * For commands that expect a reply, .query(type, payload) returns a Promise
 * that resolves with the matched response (matched by request_id).
 */
export class EventBus {
  constructor({ host, port, password, db, channels, logger }) {
    this.channels = channels;
    this.logger = logger;
    this.handlers = new Map();      // eventType -> Set<fn>
    this.pendingQueries = new Map();  // request_id -> { resolve, reject, timer }

    const common = {
      host, port, password, db,
      retryStrategy(times) {
        // Exponential backoff: 100ms, 200ms, 400ms, ... capped at 30s
        const delay = Math.min(times * 100, 30_000);
        return delay;
      },
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      reconnectOnError(err) {
        // Reconnect on READONLY errors (Redis failover) and connection resets
        const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
        return targetErrors.some(e => err.message.includes(e));
      },
    };
    // Two connections: one for SUBSCRIBE (blocks), one for PUBLISH/commands.
    this.subscriber = new Redis(common);
    this.publisher = new Redis(common);
  }

  async start() {
    this.subscriber.on('error', (err) => this.logger?.error('redis_sub_error', { msg: err.message }));
    this.publisher.on('error', (err) => this.logger?.error('redis_pub_error', { msg: err.message }));
    this.subscriber.on('reconnecting', (delay) =>
      this.logger?.info('redis_sub_reconnecting', { delay }));
    this.publisher.on('reconnecting', (delay) =>
      this.logger?.info('redis_pub_reconnecting', { delay }));
    this.subscriber.on('connect', () => {
      // ioredis auto-resubscribes when autoResubscribe is true (default),
      // but log it so the operator sees the recovery.
      this.logger?.info('redis_sub_connected');
    });

    this.subscriber.on('message', (channel, message) => {
      let parsed;
      try { parsed = JSON.parse(message); }
      catch (e) { this.logger?.warn('bad_json', { channel, message }); return; }

      if (channel === this.channels.events) {
        this._dispatchEvent(parsed);
      } else if (channel === this.channels.responses) {
        this._dispatchResponse(parsed);
      }
    });

    await this.subscriber.subscribe(this.channels.events, this.channels.responses);
    this.logger?.info('bus_ready', {
      events: this.channels.events,
      responses: this.channels.responses,
    });
  }

  _dispatchEvent(event) {
    const type = event.event;
    const wild = this.handlers.get('*');
    const specific = this.handlers.get(type);
    for (const fn of wild ?? []) {
      try { fn(event); } catch (e) { this.logger?.error('handler_error', { type, err: e.message }); }
    }
    for (const fn of specific ?? []) {
      try { fn(event); } catch (e) { this.logger?.error('handler_error', { type, err: e.message }); }
    }
  }

  _dispatchResponse(response) {
    const id = response.request_id;
    if (id == null) return;
    const pending = this.pendingQueries.get(id);
    if (!pending) return;
    this.pendingQueries.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  /** Register a handler for one event type (e.g. 'player_damage') or '*'. */
  on(type, fn) {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  /**
   * Dispatch an event to LOCAL handlers only (no Redis round-trip). Used for
   * events this bot derives itself from chat — e.g. economyChat parsing a
   * `/sell hand` confirmation into an `economy_transaction` so the existing
   * factions/projects/mood consumers react, without re-broadcasting to other
   * bots (which never observed our private sale). The payload must carry an
   * `event` field, exactly like a BotBridge event.
   */
  emitLocal(event) {
    if (!event || typeof event.event !== 'string') return;
    this._dispatchEvent(event);
  }

  /** Fire-and-forget command. */
  async publishCommand(command) {
    await this.publisher.publish(this.channels.commands, JSON.stringify(command));
  }

  /** Command with an awaited response via request_id. */
  async query(type, payload = {}, { timeoutMs = 5000 } = {}) {
    const request_id = randomUUID();
    const cmd = { type, request_id, ...payload };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingQueries.delete(request_id);
        reject(new Error(`query timeout: ${type}`));
      }, timeoutMs);
      this.pendingQueries.set(request_id, { resolve, reject, timer });
    });
    await this.publisher.publish(this.channels.commands, JSON.stringify(cmd));
    return promise;
  }

  async stop() {
    for (const [, p] of this.pendingQueries) clearTimeout(p.timer);
    this.pendingQueries.clear();
    this.handlers.clear();
    await Promise.allSettled([this.subscriber.quit(), this.publisher.quit()]);
  }
}
