/**
 * model.js — one model turn for the agent loop.
 *
 * Anthropic models go through the SDK; a `gemini-*` model id routes to the
 * fetch-based adapter in gemini.js, which returns the same response shape.
 *
 * Wraps the Anthropic SDK with the request shape the loop needs:
 *   - static system prompt with a cache breakpoint
 *   - tool definitions (stable order → cacheable prefix)
 *   - adaptive thinking + effort on models that support it
 *   - API-side context editing (clear old tool results) so the transcript
 *     stays append-only and the tail stays lean
 *   - per-turn usage → dollars, using the published per-MTok rates
 *
 * Nothing here knows about Minecraft.
 */

import Anthropic from '@anthropic-ai/sdk';
import { GeminiClient, GEMINI_PRICING, geminiCost, isGeminiModel } from './gemini.js';

const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_EFFORT = 'medium';
const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_TIMEOUT_MS = 120_000;

// $ per million tokens. Cache reads are 0.1× input (0.025× on Fable 5.1);
// cache writes are 1.25× input (5-minute TTL).
export const PRICING = Object.freeze({
  ...GEMINI_PRICING,
  'claude-fable-5-1':  { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5':    { input: 10, output: 50 },
  'claude-opus-5':     { input: 5,  output: 25 },
  'claude-opus-4-8':   { input: 5,  output: 25 },
  'claude-opus-4-7':   { input: 5,  output: 25 },
  'claude-opus-4-6':   { input: 5,  output: 25 },
  'claude-sonnet-5':   { input: 2,  output: 10 },
  'claude-sonnet-4-6': { input: 3,  output: 15 },
  'claude-haiku-4-5':  { input: 1,  output: 5 },
});

// What the server-side summary must keep when it compacts the transcript.
export const COMPACTION_INSTRUCTIONS = [
  'You are summarizing a Minecraft player\'s session so they can keep playing without the details.',
  'Keep, verbatim where possible: the current focus card and plan; home, chest, door and workstation coordinates;',
  'every known resource location with coordinates; people met and what was said or promised; money owed or paid;',
  'what is in the inventory and the chest; what is currently cooking in a furnace; deaths and their causes;',
  'and anything the player decided to avoid. Drop routine tool chatter. Write in first person, compact, factual.',
].join(' ');

// Models that take `thinking: {type:'adaptive'}` + `output_config.effort`.
// Older models (Haiku 4.5, Sonnet 4.5) need budget_tokens and reject
// effort, so the request is sent vanilla for them.
function supportsAdaptive(model) {
  return !/^claude-(haiku-4-5|sonnet-4-5|opus-4-5|3-)/.test(model);
}

export function costOf(usage, model) {
  if (isGeminiModel(model)) return geminiCost(usage, model);
  const p = PRICING[model] ?? PRICING[DEFAULT_MODEL];
  const cacheRead = p.cacheRead ?? p.input * 0.1;
  const cacheWrite = p.input * 1.25;
  const inTok = usage?.input_tokens ?? 0;
  const outTok = usage?.output_tokens ?? 0;
  const cr = usage?.cache_read_input_tokens ?? 0;
  const cw = usage?.cache_creation_input_tokens ?? 0;
  const usd = (inTok * p.input + outTok * p.output + cr * cacheRead + cw * cacheWrite) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

export class ModelClient {
  constructor({
    apiKey = process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY,
    model = process.env.AGENT_MODEL ?? process.env.LLM_MODEL ?? DEFAULT_MODEL,
    effort = process.env.AGENT_EFFORT ?? DEFAULT_EFFORT,
    maxTokens = DEFAULT_MAX_TOKENS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = 3,
    contextEditing = process.env.AGENT_CONTEXT_EDIT !== '0',
    contextTriggerTokens = 60_000,
    keepToolUses = 30,
    compaction = process.env.AGENT_COMPACT !== '0',
    compactionTriggerTokens = Number(process.env.AGENT_COMPACT_TOKENS ?? 120_000),
    memoryTool = true,
    log = null,
    client = null,
  } = {}) {
    this.model = model;
    this.effort = effort;
    this.maxTokens = maxTokens;
    this.log = log;
    this.contextEditing = contextEditing;
    this.contextTriggerTokens = contextTriggerTokens;
    this.keepToolUses = keepToolUses;
    this.compaction = compaction;
    this.compactionTriggerTokens = compactionTriggerTokens;
    this.memoryTool = memoryTool;
    this.totals = { turns: 0, usd: 0, input: 0, output: 0, cache_read: 0, cache_create: 0 };
    // A Gemini model id routes every turn to the REST adapter; the loop
    // sees the same response shape either way.
    this.gemini = isGeminiModel(model) ? (client ?? new GeminiClient({ model, effort, maxTokens, timeoutMs, maxRetries, log })) : null;
    if (this.gemini) { this.client = null; return; }
    if (!client && !apiKey) {
      throw new Error('ModelClient needs LLM_API_KEY or ANTHROPIC_API_KEY (or ant auth login)');
    }
    this.client = client ?? new Anthropic({ apiKey, timeout: timeoutMs, maxRetries });
  }

  _accumulate(usage, usd) {
    this.totals.turns += 1;
    this.totals.usd = Math.round((this.totals.usd + usd) * 1e6) / 1e6;
    this.totals.input += usage.input_tokens ?? 0;
    this.totals.output += usage.output_tokens ?? 0;
    this.totals.cache_read += usage.cache_read_input_tokens ?? 0;
    this.totals.cache_create += usage.cache_creation_input_tokens ?? 0;
  }

  /**
   * One request. `messages` is the append-only history; a copy is sent with
   * a cache breakpoint on the final user block so the tail caches.
   * Returns { response, usage, usd, latencyMs }.
   */
  async turn({ system, tools, messages }) {
    if (this.gemini) {
      const r = await this.gemini.turn({ system, tools, messages });
      this._accumulate(r.usage, r.usd);
      return r;
    }
    const params = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools,
      messages: withTailBreakpoint(messages),
    };
    if (supportsAdaptive(this.model)) {
      params.thinking = { type: 'adaptive' };
      params.output_config = { effort: this.effort };
    }
    const betas = [];
    const usesMemoryTool = this.memoryTool && tools.some((t) => t?.type === 'memory_20250818');
    const edits = [];
    if (this.contextEditing) {
      edits.push({
        type: 'clear_tool_uses_20250919',
        trigger: { type: 'input_tokens', value: this.contextTriggerTokens },
        keep: { type: 'tool_uses', value: this.keepToolUses },
        clear_at_least: { type: 'input_tokens', value: 8000 },
        exclude_tools: ['focus', 'note', 'memory'],
      });
    }
    if (this.compaction) {
      betas.push('compact-2026-01-12');
      edits.push({
        type: 'compact_20260112',
        trigger: { type: 'input_tokens', value: this.compactionTriggerTokens },
        instructions: COMPACTION_INSTRUCTIONS,
      });
    }
    if (edits.length || usesMemoryTool) betas.push('context-management-2025-06-27');
    if (edits.length) params.context_management = { edits };
    const startedAt = Date.now();
    let response;
    try {
      response = betas.length
        ? await this.client.beta.messages.create({ ...params, betas })
        : await this.client.messages.create(params);
    } catch (err) {
      this.log?.warn?.('model_call_failed', {
        model: this.model, status: err?.status ?? null, msg: err?.message, latency_ms: Date.now() - startedAt,
      });
      throw err;
    }
    const latencyMs = Date.now() - startedAt;
    const usage = response.usage ?? {};
    const usd = costOf(usage, this.model);
    this._accumulate(usage, usd);
    this.log?.info?.('model_turn', {
      model: this.model, stop: response.stop_reason,
      input: usage.input_tokens, output: usage.output_tokens,
      cache_read: usage.cache_read_input_tokens, cache_create: usage.cache_creation_input_tokens,
      usd, total_usd: this.totals.usd, latency_ms: latencyMs,
      context_edits: response.context_management?.applied_edits?.length ?? 0,
      compacted: (response.content ?? []).some((b) => b.type === 'compaction') || undefined,
    });
    return { response, usage, usd, latencyMs };
  }
}

/**
 * Copy `messages` and put a cache_control marker on the last block of the
 * final user message. History itself is never mutated (append-only).
 */
export function withTailBreakpoint(messages) {
  if (!messages?.length) return messages;
  const out = messages.slice();
  const lastIdx = out.length - 1;
  const last = out[lastIdx];
  if (last?.role !== 'user') return out;
  const content = Array.isArray(last.content)
    ? last.content.map((b) => ({ ...b }))
    : [{ type: 'text', text: String(last.content) }];
  if (content.length) content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: 'ephemeral' } };
  out[lastIdx] = { ...last, content };
  return out;
}
