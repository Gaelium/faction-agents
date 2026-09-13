/**
 * tools/index.js — the skill registry.
 *
 * `createTools(deps)` returns:
 *   definitions  — the array sent to the API (name/description/input_schema),
 *                  in a fixed order so the cached prefix is stable
 *   byName       — handler + metadata per tool
 *
 * Every handler has the signature (input, ctx) → result, where ctx is
 * { cancel, log, deps }. Handlers never throw to the loop.
 */

import { perceiveTools } from './perceive.js';
import { moveTools } from './move.js';
import { gatherTools } from './gather.js';
import { buildTools } from './build.js';
import { fightTools } from './fight.js';
import { socialTools } from './social.js';
import { mindTools } from './mind.js';
import { escapeTools } from './escape.js';
import { jobTools } from './jobs.js';
import { boardTools } from './board.js';
import { factionTools } from './faction.js';
import { thinkTools } from './think.js';
import { farmTools } from './farm.js';
import { scriptTools } from './script.js';

export function createTools(deps) {
  const scripts = scriptTools(deps);
  const groups = [
    perceiveTools(deps), moveTools(deps), escapeTools(deps), gatherTools(deps), jobTools(deps), buildTools(deps), farmTools(deps),
    fightTools(deps), socialTools(deps), boardTools(deps), factionTools(deps), thinkTools(deps), scripts, mindTools(deps),
  ];
  const all = groups.flat();
  // Anthropic's memory tool: schema-less on our side (the model knows the
  // command shape); the store handles view/create/str_replace/insert/
  // delete/rename under /memories → data/memory/<bot>/.
  if (deps.memoryStore) {
    all.push({
      name: 'memory',
      apiDefinition: { type: 'memory_20250818', name: 'memory' },
      parallelSafe: true,
      handler: async (input) => {
        const r = deps.memoryStore.run(input);
        return r.isError ? { status: 'failed', reason: 'memory_error', text: r.text } : { status: 'ok', text: r.text };
      },
    });
  }
  const byName = new Map();
  for (const t of all) {
    if (byName.has(t.name)) throw new Error(`duplicate tool: ${t.name}`);
    byName.set(t.name, {
      name: t.name,
      handler: t.handler,
      parallelSafe: !!t.parallelSafe,
      defaultInterrupts: t.defaultInterrupts ?? [],
      uninterruptible: t.uninterruptible ?? false,
      schema: t.input_schema ?? null,
      raw: !!t.apiDefinition,
    });
  }
  const definitions = all.map((t) => t.apiDefinition ?? ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
  const registry = { definitions, byName };
  // Scripts call tools by name through the finished registry.
  scripts.setRegistry?.(registry);
  return registry;
}

/** Cheap structural validation: required keys present, enum values legal. */
export function validateInput(schema, input) {
  const problems = [];
  const obj = input && typeof input === 'object' ? input : {};
  for (const key of schema?.required ?? []) {
    if (obj[key] === undefined || obj[key] === null || obj[key] === '') problems.push(`missing ${key}`);
  }
  for (const [key, spec] of Object.entries(schema?.properties ?? {})) {
    const v = obj[key];
    if (v === undefined) continue;
    if (spec.enum && !spec.enum.includes(v)) problems.push(`${key} must be one of ${spec.enum.join('|')}`);
    if (spec.type === 'integer' && !(Number.isInteger(v))) problems.push(`${key} must be an integer`);
    if (spec.type === 'number' && typeof v !== 'number') problems.push(`${key} must be a number`);
    if (spec.type === 'string' && typeof v !== 'string') problems.push(`${key} must be a string`);
    if (spec.type === 'boolean' && typeof v !== 'boolean') problems.push(`${key} must be a boolean`);
    if (spec.type === 'array' && !Array.isArray(v)) problems.push(`${key} must be an array`);
    if (typeof v === 'number' && spec.minimum != null && v < spec.minimum) problems.push(`${key} below minimum ${spec.minimum}`);
    if (typeof v === 'number' && spec.maximum != null && v > spec.maximum) problems.push(`${key} above maximum ${spec.maximum}`);
  }
  if (schema?.additionalProperties === false) {
    for (const key of Object.keys(obj)) {
      if (!schema.properties?.[key]) problems.push(`unknown field ${key}`);
    }
  }
  return problems;
}
