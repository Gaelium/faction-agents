/**
 * prices.js — what things sell for. EssentialsX `/sell` pays the values in
 * plugins/Essentials/worth.yml, so the bot can know that 7 coal is a
 * faction charter and 100 cobblestone is the same money. Loaded once at
 * boot from the server directory; absent file → no prices, tools say so.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// mineflayer 1.8 names → Essentials worth.yml keys (which drop underscores
// and use a few legacy spellings).
const NAME_MAP = Object.freeze({
  reeds: 'sugarcane', sugar_cane: 'sugarcane', log2: 'log', iron_ingot: 'ironingot', gold_ingot: 'goldingot',
  cooked_beef: 'cookedbeef', cooked_porkchop: 'cookedporkchop', cooked_chicken: 'cookedchicken',
  wheat_seeds: 'seeds', melon_block: 'melonblock', lapis_lazuli: 'lapislazuli', gold_nugget: 'goldnugget',
});

function firstNumber(v) {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object') {
    for (const k of ['0', 'default', ...Object.keys(v)]) {
      if (k in v) { const n = firstNumber(v[k]); if (n != null) return n; }
    }
  }
  return null;
}

export class Prices {
  constructor(table = {}) { this.table = table; }

  get known() { return Object.keys(this.table).length; }

  priceOf(name) {
    if (!name) return null;
    const key = NAME_MAP[name] ?? String(name).replace(/_/g, '').toLowerCase();
    const v = this.table[key];
    return typeof v === 'number' && v > 0 ? v : null;
  }

  /** {total, items:[{item,count,each,value}]} for an inventory map, best value first. */
  inventoryValue(inventory = {}) {
    const items = [];
    for (const [item, count] of Object.entries(inventory)) {
      const each = this.priceOf(item);
      if (each == null || !count) continue;
      items.push({ item, count, each, value: Math.round(each * count * 100) / 100 });
    }
    items.sort((a, b) => b.value - a.value);
    return { total: Math.round(items.reduce((a, i) => a + i.value, 0) * 100) / 100, items };
  }

  /** A short reference line for the prompt / bootstrap. */
  summary(names = ['coal', 'iron_ingot', 'wheat', 'diamond', 'redstone', 'sugar_cane', 'cactus', 'stone', 'log', 'cobblestone', 'dirt']) {
    return names.map((n) => { const p = this.priceOf(n); return p != null ? `${n} $${p}` : null; }).filter(Boolean).join(', ');
  }
}

export function loadPrices({ serverDir = null, file = null, log = null } = {}) {
  const p = file ?? (serverDir ? path.join(serverDir, 'plugins', 'Essentials', 'worth.yml') : null);
  if (!p || !fs.existsSync(p)) { log?.info?.('prices_unavailable', { file: p }); return new Prices({}); }
  try {
    const doc = yaml.load(fs.readFileSync(p, 'utf8')) ?? {};
    const worth = doc.worth ?? doc;
    const table = {};
    for (const [k, v] of Object.entries(worth)) {
      const n = firstNumber(v);
      if (n != null && n > 0) table[String(k).toLowerCase()] = n;
    }
    log?.info?.('prices_loaded', { file: p, items: Object.keys(table).length });
    return new Prices(table);
  } catch (e) {
    log?.warn?.('prices_load_failed', { file: p, msg: e.message });
    return new Prices({});
  }
}
