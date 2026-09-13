#!/usr/bin/env node
/**
 * test_cheap_first.js — base selection must prefer a CHEAP build first
 * and upgrade later, even for skilled (high-tier) bots.
 *
 * Bug (TestBot14, 2026-06-05): a tier-3 builder's query excluded every
 * cheap starter (cobble_hut / dirt_shelter are tier 1-2, and the query
 * rejected botTier > tier_max), so the only options were obsidian/diamond
 * bases — the gather cascade-failed and the bot got stuck. Fix: the query
 * keeps the tier_min floor but drops the tier_max ceiling, and _score
 * prefers the cheapest UNBUILT base (lower tier, fewer blocks). Once that
 * starter is built, the next-cheapest unbuilt (a higher tier) is picked —
 * an organic upgrade path.
 */

import { BlueprintRegistry } from './blueprintRegistry.js';
import { BlueprintSelector } from './blueprintSelector.js';

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function section(n) { console.log('\n# ' + n); }

// Mock memory: a mutable built-blueprints list, no resumable build.
function makeMemory(builtIds = []) {
  return {
    _built: builtIds,
    kvGet: (k, def) => (k === 'built_blueprints' ? builtIds : def),
    kvSet: () => {},
  };
}

const registry = new BlueprintRegistry({ log: null });
const anchor = { x: 1000, y: 64, z: 1000 }; // far from spawn so no zone effects

// Materials that mark a base as "expensive" (high-tier gating).
const EXPENSIVE = ['obsidian', 'diamond', 'diamond_block', 'enchanting_table', 'brewing_stand'];
function neededMaterials(bp) {
  return Object.keys(bp?.materials ?? {});
}

// =====================================================================
section('tier-3 builder, no resources → picks a CHEAP starter base');
{
  const selector = new BlueprintSelector({ registry, memory: makeMemory([]), log: null });
  // Run several times (random jitter) — every pick must be cheap.
  const picks = new Set();
  let everExpensive = false;
  for (let i = 0; i < 25; i++) {
    const sel = selector.select({
      profile: { archetype: 'builder', skill_tier: 3 },
      inventory: {}, anchor, category: 'base',
    });
    picks.add(sel.blueprint.id);
    if (neededMaterials(sel.blueprint).some((m) => EXPENSIVE.includes(m))) everExpensive = true;
  }
  assert('never selects an obsidian/diamond base for a fresh tier-3 bot',
    !everExpensive, [...picks].join(','));
  assert('selected base is tier_min 1 (a true starter)',
    [...picks].every((id) => registry.query({ category: 'base' }).find((b) => b.id === id).tier_min === 1),
    [...picks].join(','));
  console.log('    picks seen: ' + [...picks].join(', '));
}

// =====================================================================
section('cheap starter available even though tier-3 bases exist');
{
  // Prove the regression is fixed: cobble_hut / dirt_shelter / a tier-1
  // generic base must be REACHABLE for a tier-3 bot (the old query hid
  // them because botTier > tier_max).
  const visible = registry.query({ category: 'base', archetype: 'builder', tier: 3 })
    .map((b) => b.id);
  assert('a tier-1 starter is visible to a tier-3 builder',
    visible.some((id) => /cobble_hut|dirt_shelter|generic_base_t1|builder_base_t1/.test(id)),
    visible.join(','));
}

// =====================================================================
section('upgrade later: once the cheap base is built, pick a fancier one');
{
  // Mark every tier-1 base as already built; the selector should now move
  // UP to a tier-2+ base instead of re-picking a tier-1.
  const tier1Ids = registry.query({ category: 'base' })
    .filter((b) => b.tier_min === 1).map((b) => b.id);
  const selector = new BlueprintSelector({ registry, memory: makeMemory([...tier1Ids]), log: null });
  const sel = selector.select({
    profile: { archetype: 'builder', skill_tier: 3 },
    inventory: {}, anchor, category: 'base',
  });
  const picked = registry.query({ category: 'base' }).find((b) => b.id === sel.blueprint.id);
  assert('with all tier-1 bases built, upgrades to tier ≥ 2',
    picked.tier_min >= 2, `picked ${sel.blueprint.id} (tier_min ${picked.tier_min})`);
}

// =====================================================================
section('blacklisted blueprints skipped (TestBot23 sugarcane loop)');
{
  // Find what a fresh farmer picks for the farm category, blacklist
  // it, and re-select — the pick must change. Stale blacklist entries
  // (older than the cooldown) are ignored.
  const memoryNoBl = {
    kvGet: (k, def) => (k === 'blueprint_blacklist' ? {} : (k === 'built_blueprints' ? [] : def)),
    kvSet: () => {},
  };
  const profile = { archetype: 'farmer', skill_tier: 1, username: 'TB' };
  const first = new BlueprintSelector({ registry, memory: memoryNoBl, log: null })
    .select({ profile, inventory: {}, anchor, category: 'farm' });
  assert('baseline farm pick exists', !!first?.blueprint?.id, JSON.stringify(first?.blueprint?.id));

  const memoryBl = {
    kvGet: (k, def) => {
      if (k === 'blueprint_blacklist') return { [first.blueprint.id]: Date.now() };
      if (k === 'built_blueprints') return [];
      return def;
    },
    kvSet: () => {},
  };
  const second = new BlueprintSelector({ registry, memory: memoryBl, log: null })
    .select({ profile, inventory: {}, anchor, category: 'farm' });
  assert('blacklisted pick avoided', second?.blueprint?.id !== first.blueprint.id,
    `still picked ${second?.blueprint?.id}`);

  const memoryStale = {
    kvGet: (k, def) => {
      if (k === 'blueprint_blacklist') return { [first.blueprint.id]: Date.now() - 31 * 60_000 };
      if (k === 'built_blueprints') return [];
      return def;
    },
    kvSet: () => {},
  };
  const third = new BlueprintSelector({ registry, memory: memoryStale, log: null })
    .select({ profile, inventory: {}, anchor, category: 'farm' });
  assert('stale blacklist entry ignored (cooldown expired)',
    third?.blueprint?.id === first.blueprint.id, third?.blueprint?.id);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
