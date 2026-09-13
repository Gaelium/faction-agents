import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { createRequire } from 'node:module';

const { pathfinder } = pathfinderPkg;

// --- Vec3.prototype.set null-component guard ---
// Defense-in-depth for the position-corruption bug (Phase 14.1-14.16
// chased its symptoms). Mineflayer mutates entity positions via
// `entity.position.set(packet.x, packet.y, packet.z)` from MULTIPLE
// packet handlers — not just the 'position' packet patched in
// Phase 14.16, but also `entity_teleport`, `rel_entity_move` (via
// translate), etc. Any one of them can deliver null/undefined/NaN
// coordinates after a malformed packet and corrupt the local
// position state, which silences mineflayer's physicsTick (gate at
// node_modules/mineflayer/lib/plugins/physics.js:79) and freezes
// the bot.
//
// We patch Vec3.prototype.set + .update to reject non-finite
// components individually: pass through finite values, leave the
// existing component unchanged for null/undefined/NaN. A genuinely
// malformed packet becomes a partial or full no-op instead of a
// corruption event. Patches the prototype, so it covers every Vec3
// instance ever created — the bot's own position, every entity's
// position, pathfinder waypoints, all of them. Patch is idempotent
// (tagged with a Symbol) so re-imports don't double-wrap.
//
// Side note: legitimate code never tries to set a Vec3 component to
// null. NaN is universally an error state in mineflayer/prismarine.
// Passing 0 explicitly still works (0 is finite). So this patch
// only changes behavior for genuinely malformed inputs.
const _vec3PatchTag = Symbol.for('aifactions.vec3.set.guard.v1');
function patchVec3Prototype() {
  const require_ = createRequire(import.meta.url);
  let Vec3;
  try { Vec3 = require_('vec3').Vec3; }
  catch { return false; }
  if (!Vec3?.prototype || Vec3.prototype[_vec3PatchTag]) return true;
  const origSet = Vec3.prototype.set;
  Vec3.prototype.set = function guardedSet(x, y, z) {
    if (x != null && Number.isFinite(x)) this.x = x;
    if (y != null && Number.isFinite(y)) this.y = y;
    if (z != null && Number.isFinite(z)) this.z = z;
    return this;
  };
  Vec3.prototype.set.__guarded = true;
  Vec3.prototype.set.__original = origSet;

  const origUpdate = Vec3.prototype.update;
  if (typeof origUpdate === 'function') {
    Vec3.prototype.update = function guardedUpdate(other) {
      if (!other) return this;
      return this.set(other.x, other.y, other.z);
    };
    Vec3.prototype.update.__guarded = true;
    Vec3.prototype.update.__original = origUpdate;
  }

  Vec3.prototype[_vec3PatchTag] = true;
  return true;
}
patchVec3Prototype();

// --- Prismarine-item crash guard ---
// 1.8.9 entity_metadata occasionally delivers slot payloads as undefined
// or with malformed shapes, causing prismarine-item's Item.fromNotch to
// throw `Cannot read properties of undefined (reading 'present')`. The
// throw bubbles into mineflayer's packet parser, which stalls keepalive
// — bot then disconnects ~30s later before we can respawn cleanly.
//
// prismarine-item exports a LOADER function that creates a fresh `Item`
// class per call (one per minecraft version). Patching one Item class
// only fixes that closure. Wrap the loader itself so every Item class
// it returns has a guarded fromNotch.
//
// The patch is shape-narrow: only swallows the specific
// "Cannot read properties of undefined (reading X)" throws this bug
// produces. Other exceptions re-throw so we don't silently hide real
// problems.
const _patchedLoaderTag = Symbol.for('aifactions.prismarineItem.fromNotchGuard.v1');
function patchPrismarineItemLoader() {
  const require_ = createRequire(import.meta.url);
  let mod;
  try { mod = require_('prismarine-item'); }
  catch { return false; }
  if (mod[_patchedLoaderTag]) return true;
  const original = mod;
  function wrapItem(Item) {
    if (!Item || typeof Item.fromNotch !== 'function') return Item;
    if (Item.fromNotch.__guarded) return Item;
    const orig = Item.fromNotch;
    const guarded = function fromNotchGuarded(networkItem, stackId) {
      if (networkItem == null) return null;
      try {
        return orig.call(this, networkItem, stackId);
      } catch (e) {
        if (e && /(reading\s+'(present|blockId|itemCount|nbt|nbtData)')/.test(e.message)) {
          return null;
        }
        throw e;
      }
    };
    guarded.__guarded = true;
    Item.fromNotch = guarded;
    return Item;
  }
  function patchedLoader(registryOrVersion) {
    return wrapItem(original(registryOrVersion));
  }
  // Preserve any extra properties on the original loader.
  for (const k of Object.keys(original)) patchedLoader[k] = original[k];
  patchedLoader[_patchedLoaderTag] = true;
  // Replace the cached module export so all subsequent requires get the
  // wrapper. mineflayer requires prismarine-item via its own subgraph,
  // and Node's require cache is process-global.
  const cacheKey = require_.resolve('prismarine-item');
  if (require_.cache[cacheKey]) {
    require_.cache[cacheKey].exports = patchedLoader;
  }
  return true;
}
patchPrismarineItemLoader();

/**
 * Creates a mineflayer bot from a profile returned by profileLoader.
 *
 * The returned object is the raw mineflayer Bot with:
 *   - bot.profile          — the loaded profile
 *   - bot.sayLine(msg)     — chat wrapper that respects the 100-char limit
 *
 * pathfinder is loaded here; the Movements config is owned by
 * tactical/movement.js (single source of truth, lazy-initialized on the
 * first goTo/follow/flee call).
 *
 * `respawn: true` is passed to mineflayer so the built-in death handler
 * fires `bot.respawn()` automatically on update_health(0).
 */
export function createBot(profile) {
  const bot = mineflayer.createBot({
    host: profile.host,
    port: profile.port,
    username: profile.username,
    version: profile.version,
    auth: profile.auth,
    respawn: true,
    hideErrors: false,
  });

  bot.profile = profile;
  bot.loadPlugin(pathfinder);

  // mineflayer-auto-eat 5.x's `buildEatingListener` registers two
  // listeners per eat cycle:
  //   1. `entity_status` on bot._client
  //   2. `updateSlot`    on bot.inventory (the prismarine-windows
  //                      Window emitter)
  // The happy paths remove both, but the eat-timeout path
  // (`setTimeout(() => rej(...))`) doesn't, so a bot taking sustained
  // damage and eating constantly leaks one of each per timeout. Bump
  // the cap on both so Node's default 10-listener warning doesn't
  // flood the log. bot.inventory is created on spawn, not at boot —
  // so wire the bump to fire on first spawn. The leak is harmless
  // (each listener is a fresh closure and the off() in the success
  // path drops the right one) but the warning obscures real errors.
  try { bot._client?.setMaxListeners?.(50); } catch {}
  const _bumpInventoryListeners = () => {
    try { bot.inventory?.setMaxListeners?.(50); } catch {}
  };
  bot.once('spawn', _bumpInventoryListeners);
  // Inventory is also re-created on respawn after death; reattach.
  bot.on('respawn', _bumpInventoryListeners);

  // --- Position-packet null-axis guard (THE root cause of the
  // "freeze on knockback" bug Phases 14.1-14.15 chased) ---
  //
  // 1.8.9 occasionally delivers Player Position And Look (clientbound,
  // S→C 0x08) packets where `packet.x` and `packet.z` are `null` —
  // typically right after a knockback or teleport sequence. Mineflayer's
  // handler at node_modules/mineflayer/lib/plugins/physics.js:407-411
  // does this:
  //
  //   pos.set(
  //     packet.flags & 1 ? (pos.x + packet.x) : packet.x,
  //     packet.flags & 2 ? (pos.y + packet.y) : packet.y,
  //     packet.flags & 4 ? (pos.z + packet.z) : packet.z
  //   )
  //
  // With flags=0 (absolute coords), `pos.set(null, 64, null)` writes
  // null straight into `bot.entity.position`. The downstream physics
  // gates at physics.js:79 (non-finite check) and physics.js:80
  // (chunk-unloaded check) then short-circuit, so physicsTick stops
  // emitting, the bot can't move, and combat goes silent — the exact
  // freeze symptom users see when bots get hit.
  //
  // We attach a prependListener to the 'position' event so this
  // handler runs BEFORE mineflayer's. We rewrite any null axis to the
  // bot's current finite value, turning the malformed packet into a
  // "stay where you are" no-op. Mineflayer's handler then runs against
  // sane values and never corrupts the position. This is upstream of
  // every Phase 14.x recovery mechanism — corruption stops happening
  // at all.
  //
  // Logged at info level on the first hit per session so we can see
  // how often the server sends malformed packets without spamming
  // every retaliation.
  let _nullAxisHits = 0;
  try {
    bot._client.prependListener('position', (packet) => {
      const cur = bot.entity?.position;
      const cx = Number.isFinite(cur?.x) ? cur.x : 0;
      const cy = Number.isFinite(cur?.y) ? cur.y : 0;
      const cz = Number.isFinite(cur?.z) ? cur.z : 0;
      let patched = false;
      if (packet.x == null || !Number.isFinite(packet.x)) { packet.x = cx; patched = true; }
      if (packet.y == null || !Number.isFinite(packet.y)) { packet.y = cy; patched = true; }
      if (packet.z == null || !Number.isFinite(packet.z)) { packet.z = cz; patched = true; }
      if (patched) {
        _nullAxisHits += 1;
        // Cheap rate-limited logging via stdout — the bot's structured
        // logger isn't available in this scope, but the orchestrator
        // captures stdout per-bot.
        if (_nullAxisHits === 1 || _nullAxisHits % 10 === 0) {
          process.stdout.write(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            bot: profile.username,
            event: 'position_packet_patched',
            hits: _nullAxisHits,
            patched_to: { x: cx, y: cy, z: cz },
          }) + '\n');
        }
      }
    });
  } catch (err) {
    // If prependListener isn't available for some reason, the
    // Vec3.prototype.set guard above still drops the null components.
    process.stderr.write(`position_packet_guard_install_failed: ${err.message}\n`);
  }

  bot.sayLine = (msg) => {
    const text = String(msg ?? '');
    const cap = text.startsWith('/') ? 256 : 100;
    bot.chat(text.slice(0, cap));
  };

  return bot;
}
