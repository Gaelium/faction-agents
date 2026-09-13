/**
 * perception.js — Reads the bot's immediate game state into a compact
 * object for the tactical LLM prompt. Called every tactical tick (~10s).
 *
 * Returns an object whose stringified form fits in roughly 400 tokens.
 * Pure synchronous mineflayer state reads — no awaits, no LLM, no DB.
 */

const HOSTILE_MOB_NAMES = new Set([
  'zombie', 'skeleton', 'creeper', 'spider',
  'cave_spider', 'cavespider',
  'witch', 'slime',
  'magma_cube', 'magmacube', 'lavaslime',
  'blaze', 'silverfish',
  'enderman', 'endermite',
  'wither_skeleton', 'witherskeleton',
  'ghast', 'guardian',
  'giant',
]);

const NEARBY_PLAYER_RANGE = 24;
const NEARBY_MOB_RANGE = 16;
const NEARBY_BLOCK_RANGE = 8;
const MAX_PLAYERS = 5;
const MAX_MOBS = 5;
const CHAT_BUFFER_SIZE = 5;
const CHAT_RECENT_WINDOW_MS = 60_000;

const INTEREST_BLOCK_TYPES = [
  'water', 'lava',
  'chest', 'trapped_chest', 'ender_chest',
  'crafting_table', 'furnace', 'enchanting_table',
  'wheat', 'cactus', 'sugar_cane',
  'iron_ore', 'coal_ore', 'gold_ore', 'diamond_ore', 'redstone_ore',
];

// Module-scope chat ring buffer, filled through feedChat(). Nothing in the
// agent loop calls it today, so a snapshot's recentChat stays empty.
const _chatBuffer = [];

export function feedChat(sender, message) {
  if (!sender || !message) return;
  _chatBuffer.push({ sender, message: String(message).slice(0, 200), ts: Date.now() });
  while (_chatBuffer.length > CHAT_BUFFER_SIZE) _chatBuffer.shift();
}

/**
 * Clear the module-scoped chat buffer. Called on shutdown so a
 * subsequent in-process bot restart doesn't read stale chat from
 * the previous session.
 */
export function clearChatBuffer() {
  _chatBuffer.length = 0;
}

function direction(dx, dz) {
  // Bucket atan2(dz, dx) into 8 compass directions. Minecraft north
  // is -Z, east is +X.
  const angle = Math.atan2(-dz, dx) * 180 / Math.PI;   // -180..180, 0=East
  const norm = (angle + 360) % 360;
  if (norm < 22.5 || norm >= 337.5) return 'E';
  if (norm < 67.5)  return 'NE';
  if (norm < 112.5) return 'N';
  if (norm < 157.5) return 'NW';
  if (norm < 202.5) return 'W';
  if (norm < 247.5) return 'SW';
  if (norm < 292.5) return 'S';
  return 'SE';
}

function distance(p1, p2) {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  const dz = p1.z - p2.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function describeOffset(from, to) {
  const dist = distance(from, to);
  const dir = direction(to.x - from.x, to.z - from.z);
  return { distance: Number(dist.toFixed(1)), direction: dir };
}

function timeOfDayLabel(t) {
  if (typeof t !== 'number') return 'unknown';
  if (t < 12000) return 'day';
  if (t < 13800) return 'dusk';
  if (t < 22200) return 'night';
  return 'dawn';
}

function isFood(item, foodsByName) {
  if (!item?.name) return false;
  if (foodsByName && foodsByName[item.name]) return true;
  if (/^cooked_/.test(item.name)) return true;
  if (item.name === 'bread' || item.name === 'apple' || item.name === 'cake'
      || item.name === 'cookie' || item.name === 'mushroom_stew'
      || item.name === 'melon' || item.name === 'pumpkin_pie'
      || item.name === 'carrot' || item.name === 'potato'
      || item.name === 'baked_potato' || item.name === 'beetroot'
      || item.name === 'beetroot_soup' || item.name === 'rabbit_stew'
      || item.name === 'golden_apple' || item.name === 'golden_carrot'
      || item.name === 'steak' || item.name === 'porkchop'
      || item.name === 'beef' || item.name === 'chicken'
      || item.name === 'mutton' || item.name === 'rabbit'
      || /^cooked/.test(item.name)) {
    return true;
  }
  return false;
}

function isWeapon(name) {
  return /_(sword|axe)$/.test(name);
}
function isArmor(name) {
  return /_(helmet|chestplate|leggings|boots)$/.test(name);
}
function isTool(name) {
  return /_(pickaxe|shovel|hoe)$/.test(name);
}
function isBlock(name) {
  return /^(cobblestone|stone|dirt|grass|sand|gravel|netherrack|planks|oak_planks|spruce_planks|birch_planks|jungle_planks|acacia_planks|dark_oak_planks|log|log2|wool|wood)$/.test(name)
      || /_planks$/.test(name) || /_log$/.test(name);
}

export class Perception {
  constructor(bot, { combat = null } = {}) {
    if (!bot) throw new Error('Perception requires bot');
    this.bot = bot;
    // The mineflayer bot itself doesn't expose a `combat` field — our
    // Combat wrapper lives separately. Accept it explicitly so the
    // perception snapshot's combatState is accurate.
    this.combat = combat;
  }

  read() {
    const bot = this.bot;
    const me = bot.entity?.position;
    const meName = bot.username ?? null;

    const out = {
      position: me ? { x: Math.round(me.x), y: Math.round(me.y), z: Math.round(me.z) } : null,
      health: typeof bot.health === 'number' ? bot.health : null,
      food: typeof bot.food === 'number' ? bot.food : null,
      heldItem: bot.heldItem?.name ?? null,
      nearbyPlayers: [],
      nearbyMobs: [],
      nearbyBlocks: {},
      recentChat: [],
      isUnderground: false,
      timeOfDay: timeOfDayLabel(bot.time?.timeOfDay),
      combatState: null,
      pathfinderState: null,
      inventorySummary: { weapons: [], armor: [], food: 0, blocks: 0, tools: [] },
    };

    if (!me) return out;

    // Nearby players (within 24 blocks).
    try {
      const players = bot.players ?? {};
      const collected = [];
      for (const name of Object.keys(players)) {
        if (name === meName) continue;
        const p = players[name];
        const ent = p?.entity;
        if (!ent?.position) continue;
        const d = distance(me, ent.position);
        if (d > NEARBY_PLAYER_RANGE) continue;
        const desc = describeOffset(me, ent.position);
        collected.push({
          name,
          distance: desc.distance,
          direction: desc.direction,
          health: typeof ent.health === 'number' ? ent.health : null,
        });
      }
      collected.sort((a, b) => a.distance - b.distance);
      out.nearbyPlayers = collected.slice(0, MAX_PLAYERS);
    } catch {}

    // Nearby mobs (within 16 blocks). Skip player entities up-front
    // (the players loop above already covered them) and skip dropped
    // items. Filtering on the type field before the per-entry name
    // and distance work avoids the 18-bot double-pass that the old
    // code did on every tactical tick.
    try {
      const ents = bot.entities ?? {};
      const collected = [];
      for (const id of Object.keys(ents)) {
        const e = ents[id];
        if (!e?.position) continue;
        if (e.type === 'player' || e.type === 'object') continue;
        // prismarine-entity's e.mobType is a deprecated getter that
        // prints a stack trace on every read; reorder to prefer
        // displayName and drop mobType entirely so we stop spamming
        // the console on every tactical/observe tick.
        const rawName = (e.name ?? e.displayName ?? '').toString().toLowerCase().replace(/\s+/g, '');
        if (!rawName) continue;
        const isHostile = HOSTILE_MOB_NAMES.has(rawName);
        const d = distance(me, e.position);
        if (d > NEARBY_MOB_RANGE) continue;
        if (!isHostile && e.type !== 'mob') continue;
        const desc = describeOffset(me, e.position);
        collected.push({
          type: rawName,
          distance: desc.distance,
          direction: desc.direction,
          hostile: isHostile,
        });
      }
      collected.sort((a, b) => a.distance - b.distance);
      out.nearbyMobs = collected.slice(0, MAX_MOBS);
    } catch {}

    // Nearby blocks of interest.
    try {
      const registry = bot.registry;
      for (const name of INTEREST_BLOCK_TYPES) {
        const b = registry?.blocksByName?.[name];
        if (!b) continue;
        const found = bot.findBlock?.({ matching: b.id, maxDistance: NEARBY_BLOCK_RANGE, count: 1 });
        if (found) out.nearbyBlocks[name] = true;
      }
    } catch {}

    // Recent chat.
    try {
      const now = Date.now();
      out.recentChat = _chatBuffer
        .filter((c) => now - c.ts <= CHAT_RECENT_WINDOW_MS)
        .slice(-3)
        .map((c) => ({
          sender: c.sender,
          message: c.message,
          secsAgo: Math.round((now - c.ts) / 1000),
        }));
    } catch {}

    // Underground check.
    try {
      out.isUnderground = me.y < 50
        && !bot.blockAt?.(me.offset?.(0, 10, 0))?.skyLight;
    } catch {}

    // Combat state.
    try {
      const c = this.combat ?? null;
      if (c?.engaged && c.target) {
        const t = c.target;
        const tDist = t.position ? distance(me, t.position) : null;
        out.combatState = {
          engaged: true,
          target: t.username ?? t.name ?? 'unknown',
          targetHealth: typeof t.health === 'number' ? t.health : null,
          targetDistance: tDist != null ? Number(tDist.toFixed(1)) : null,
        };
      }
    } catch {}

    // Pathfinder state.
    try {
      const moving = !!bot.pathfinder?.isMoving?.();
      if (moving) {
        out.pathfinderState = { moving: true, goal: null };
      }
    } catch {}

    // Inventory summary.
    try {
      const items = bot.inventory?.items?.() ?? [];
      const foodsByName = bot.registry?.foodsByName ?? null;
      const weapons = new Set();
      const armor = new Set();
      const tools = new Set();
      let foodCount = 0;
      let blockCount = 0;
      for (const it of items) {
        const n = it?.name;
        if (!n) continue;
        if (isWeapon(n)) weapons.add(n);
        else if (isArmor(n)) armor.add(n);
        else if (isTool(n)) tools.add(n);
        else if (isFood(it, foodsByName)) foodCount += it.count ?? 1;
        else if (isBlock(n)) blockCount += it.count ?? 1;
      }
      out.inventorySummary = {
        weapons: [...weapons],
        armor: [...armor],
        food: foodCount,
        blocks: blockCount,
        tools: [...tools],
      };
    } catch {}

    return out;
  }
}
