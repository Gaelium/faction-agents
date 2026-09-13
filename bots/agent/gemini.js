/**
 * gemini.js — the same `turn({ system, tools, messages })` contract as the
 * Anthropic client, spoken to Google's generateContent REST endpoint with
 * plain fetch (no SDK to install). The loop keeps its Anthropic-shaped
 * history (text / tool_use / tool_result blocks); this file translates on
 * the way out and back.
 *
 * What is different on Gemini and how it is handled here:
 *   - tools are functionDeclarations; results go back as functionResponse
 *     parts carrying the call's id and a JSON object
 *   - Gemini 3 returns thought signatures on parts; they must be echoed
 *     verbatim, so each assistant message keeps its raw parts in a hidden
 *     `gemini_parts` block and those are what get sent back
 *   - there is no server-side context editing or compaction: when the
 *     history grows past a size, old tool results are blanked client-side
 *     (the newest 30 tool uses keep theirs) and the loop is told so it
 *     re-shows the focus card, exactly as after an Anthropic edit
 *   - the Anthropic memory tool type is replaced by an explicit function
 *     declaration with the same command shape; the store executes it
 *   - usage is mapped to the Anthropic field names so cost tracking, the
 *     transcript and the dashboard need no changes
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS = 120_000;
const KEEP_TOOL_RESULTS = 30;
const DEFAULT_CONTEXT_CHARS = Number(process.env.GEMINI_CONTEXT_CHARS ?? 400_000);   // ≈100k tokens
const DROP_SCHEMA_KEYS = new Set(['additionalProperties', 'default', '$schema', 'examples', 'title']);

export const GEMINI_PRICING = Object.freeze({
  // $ per million tokens; thinking tokens are billed as output. Cached input
  // (implicit caching on prefix matches) is billed at cacheRead; no write cost.
  'gemini-3.8-flash':      { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
  'gemini-3.7-flash':      { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
  'gemini-3.5-flash-lite': { input: 0.30, output: 2.50, cacheRead: 0.03,  cacheWrite: 0 },
});

export const MEMORY_DECLARATION = Object.freeze({
  name: 'memory',
  description: 'Your long-term memory directory (/memories). Commands: view (a directory or a file, optional view_range [start,end]), create (path + file_text), str_replace (path, old_str, new_str), insert (path, insert_line, insert_text), delete (path), rename (old_path, new_path). Paths start with /memories.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'] },
      path: { type: 'string' },
      file_text: { type: 'string' },
      old_str: { type: 'string' },
      new_str: { type: 'string' },
      insert_line: { type: 'integer' },
      insert_text: { type: 'string' },
      old_path: { type: 'string' },
      new_path: { type: 'string' },
      view_range: { type: 'array', items: { type: 'integer' } },
    },
    required: ['command'],
  },
});

/** Gemini accepts a subset of JSON Schema; drop what it rejects, recursively. */
export function sanitizeSchema(schema) {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (DROP_SCHEMA_KEYS.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') { out.properties = {}; for (const [pk, pv] of Object.entries(v)) out.properties[pk] = sanitizeSchema(pv); continue; }
    if ((k === 'items' || k === 'anyOf' || k === 'oneOf') && v) { out[k] = sanitizeSchema(v); continue; }
    out[k] = v;
  }
  // A property with no type confuses the API; be explicit.
  if (!out.type && !out.anyOf && !out.oneOf && out.properties) out.type = 'object';
  return out;
}

/** Anthropic tool definitions → Gemini functionDeclarations. */
export function toFunctionDeclarations(tools) {
  const decls = [];
  for (const t of tools ?? []) {
    if (!t) continue;
    if (t.type === 'memory_20250818') { decls.push({ ...MEMORY_DECLARATION }); continue; }
    if (!t.name || t.type) continue;   // other server-side tool types have no Gemini equivalent
    decls.push({ name: t.name, description: t.description ?? '', parameters: sanitizeSchema(t.input_schema ?? { type: 'object', properties: {} }) });
  }
  return decls;
}

/** Coerce numeric strings where the schema wants numbers (Gemini sometimes sends "8"). */
export function coerceArgs(args, schema) {
  if (!args || typeof args !== 'object' || !schema?.properties) return args ?? {};
  const out = { ...args };
  for (const [k, spec] of Object.entries(schema.properties)) {
    const v = out[k];
    if (typeof v === 'string' && (spec?.type === 'integer' || spec?.type === 'number') && v.trim() !== '' && Number.isFinite(Number(v))) out[k] = Number(v);
    if (typeof v === 'string' && spec?.type === 'boolean' && /^(true|false)$/i.test(v)) out[k] = /^true$/i.test(v);
  }
  return out;
}

function resultToObject(content) {
  if (content == null) return { output: '' };
  if (typeof content !== 'string') return { output: content };
  const s = content.trim();
  if (s.startsWith('{') || s.startsWith('[')) {
    try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : { output: v }; } catch { /* fall through */ }
  }
  return { output: content };
}

/**
 * Anthropic-shaped history → Gemini contents. `trimmed` receives the number
 * of tool results blanked for size.
 */
export function toContents(messages, { maxChars = DEFAULT_CONTEXT_CHARS, keepToolResults = KEEP_TOOL_RESULTS } = {}) {
  const nameById = new Map();
  for (const m of messages) if (m.role === 'assistant') for (const b of m.content ?? []) if (b?.type === 'tool_use') nameById.set(b.id, b.name);
  // Which tool results may be blanked: all but the newest `keepToolResults`.
  const resultIds = [];
  for (const m of messages) if (m.role === 'user' && Array.isArray(m.content)) for (const b of m.content) if (b?.type === 'tool_result') resultIds.push(b.tool_use_id);
  const total = JSON.stringify(messages).length;
  const blankable = total > maxChars ? new Set(resultIds.slice(0, Math.max(0, resultIds.length - keepToolResults))) : new Set();
  let trimmed = 0;
  const contents = [];
  for (const m of messages) {
    const parts = [];
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }];
    if (m.role === 'assistant') {
      const raw = blocks.find((b) => b?.type === 'gemini_parts');
      if (raw?.parts?.length) { contents.push({ role: 'model', parts: raw.parts }); continue; }
      for (const b of blocks) {
        if (b?.type === 'text' && b.text) parts.push({ text: b.text });
        else if (b?.type === 'tool_use') parts.push({ functionCall: { name: b.name, args: b.input ?? {}, ...(b.id && !b.id.startsWith('call_') ? { id: b.id } : {}) } });
      }
      if (parts.length) contents.push({ role: 'model', parts });
      continue;
    }
    for (const b of blocks) {
      if (b?.type === 'text' && b.text) parts.push({ text: b.text });
      else if (b?.type === 'tool_result') {
        const name = nameById.get(b.tool_use_id) ?? 'tool';
        let response;
        if (blankable.has(b.tool_use_id)) { response = { output: '(older result cleared to save space)' }; trimmed += 1; }
        else response = resultToObject(b.content);
        const fr = { name, response };
        if (b.tool_use_id && !String(b.tool_use_id).startsWith('call_')) fr.id = b.tool_use_id;
        parts.push({ functionResponse: fr });
      }
    }
    if (parts.length) contents.push({ role: 'user', parts });
  }
  return { contents, trimmed };
}

/** Gemini candidate → Anthropic-shaped response (content blocks + stop_reason). */
export function fromCandidate(candidate, { schemasByName = new Map(), seq = 0 } = {}) {
  const parts = candidate?.content?.parts ?? [];
  const content = [];
  let n = seq;
  for (const p of parts) {
    if (p.thought) continue;                      // thought summaries are not shown to the loop
    if (typeof p.text === 'string' && p.text.trim()) content.push({ type: 'text', text: p.text });
    if (p.functionCall) {
      n += 1;
      const id = p.functionCall.id ?? `call_${Date.now().toString(36)}_${n}`;
      content.push({ type: 'tool_use', id, name: p.functionCall.name, input: coerceArgs(p.functionCall.args ?? {}, schemasByName.get(p.functionCall.name)) });
    }
  }
  const toolUse = content.some((b) => b.type === 'tool_use');
  const finish = candidate?.finishReason ?? 'STOP';
  let stop_reason = toolUse ? 'tool_use' : 'end_turn';
  if (finish === 'MAX_TOKENS') stop_reason = 'max_tokens';
  else if (['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY'].includes(finish)) stop_reason = 'refusal';
  // Raw parts (with any thought signatures) ride along for the echo. Every
  // returned call gets its assigned id so the echo matches the response.
  const rawParts = parts.map((p) => (p.functionCall && !p.functionCall.id ? { ...p, functionCall: { ...p.functionCall, id: content.find((b) => b.type === 'tool_use' && b.name === p.functionCall.name && !b._taken && (b._taken = true))?.id } } : p));
  for (const b of content) delete b._taken;
  content.push({ type: 'gemini_parts', parts: rawParts });
  return { content, stop_reason, seq: n };
}

export class GeminiClient {
  constructor({
    apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
    model = 'gemini-3.8-flash',
    effort = 'medium',
    maxTokens = 8000,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = 3,
    contextChars = DEFAULT_CONTEXT_CHARS,
    thinking = process.env.GEMINI_THINKING ?? null,   // low | medium | high | off; default: effort
    fetchImpl = globalThis.fetch,
    log = null,
  } = {}) {
    if (!apiKey) throw new Error('GeminiClient needs GEMINI_API_KEY (or GOOGLE_API_KEY) in the environment');
    // A pasted key with stray quotes, spaces or dots around it is the most
    // common "API key not valid" (2026-09-07: a leading "." cost a restart loop).
    this.apiKey = String(apiKey).trim().replace(/^["'.\s]+|["'.\s]+$/g, '');
    this.model = model;
    this.effort = effort;
    this.maxTokens = maxTokens;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.contextChars = contextChars;
    this.thinking = thinking ?? effort;
    this.fetch = fetchImpl;
    this.log = log;
    this.totals = { turns: 0, usd: 0, input: 0, output: 0, cache_read: 0, cache_create: 0 };
    this._seq = 0;
    this._lastTrimmed = 0;
    this._thinkingRejected = false;
  }

  _thinkingConfig() {
    if (this._thinkingRejected || this.thinking === 'off' || this.thinking === 'none') return null;
    const level = ['low', 'medium', 'high'].includes(String(this.thinking)) ? String(this.thinking) : 'medium';
    return { thinkingLevel: level, includeThoughts: false };
  }

  _buildBody({ system, tools, messages }) {
    const { contents, trimmed } = toContents(messages, { maxChars: this.contextChars });
    const decls = toFunctionDeclarations(tools);
    const body = {
      contents,
      generationConfig: { maxOutputTokens: this.maxTokens, temperature: 0.7 },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (decls.length) { body.tools = [{ functionDeclarations: decls }]; body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } }; }
    const tc = this._thinkingConfig();
    if (tc) body.generationConfig.thinkingConfig = tc;
    return { body, trimmed };
  }

  async _post(body) {
    const url = `${ENDPOINT}/${encodeURIComponent(this.model)}:generateContent`;
    let lastErr = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey }, body: JSON.stringify(body), signal: ctrl.signal });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch {}
        if (res.ok) return json ?? {};
        let msg = json?.error?.message ?? text.slice(0, 300);
        if (res.status === 400 && /API key not valid/i.test(msg)) msg += ' (check GEMINI_API_KEY in .env: a Google AI Studio key looks like AIza… or AQ.…, with nothing before or after it, and the Generative Language API must be enabled for its project)';
        const err = new Error(`gemini ${res.status}: ${msg}`); err.status = res.status; err.body = json;
        // Retry the transient ones; the loop handles the rest.
        if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) { lastErr = err; await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
        throw err;
      } catch (e) {
        if (e.name === 'AbortError') { const err = new Error('gemini request timed out'); err.status = 408; if (attempt < this.maxRetries) { lastErr = err; continue; } throw err; }
        throw e;
      } finally { clearTimeout(timer); }
    }
    throw lastErr ?? new Error('gemini request failed');
  }

  async turn({ system, tools, messages }) {
    const startedAt = Date.now();
    const { body, trimmed } = this._buildBody({ system, tools, messages });
    let json;
    try {
      json = await this._post(body);
    } catch (err) {
      // The thinking field name has changed between Gemini generations; if the
      // API rejects ours, run without it rather than not at all.
      if (err.status === 400 && /thinking/i.test(err.message) && body.generationConfig?.thinkingConfig && !this._thinkingRejected) {
        this._thinkingRejected = true;
        this.log?.warn?.('gemini_thinking_config_rejected', { msg: err.message });
        delete body.generationConfig.thinkingConfig;
        try { json = await this._post(body); } catch (e2) { this.log?.warn?.('model_call_failed', { model: this.model, status: e2?.status ?? null, msg: e2?.message, latency_ms: Date.now() - startedAt }); throw e2; }
      } else {
        this.log?.warn?.('model_call_failed', { model: this.model, status: err?.status ?? null, msg: err?.message, latency_ms: Date.now() - startedAt });
        throw err;
      }
    }
    const latencyMs = Date.now() - startedAt;
    const candidate = json?.candidates?.[0] ?? null;
    if (!candidate) {
      const block = json?.promptFeedback?.blockReason;
      const err = new Error(block ? `gemini blocked the prompt: ${block}` : 'gemini returned no candidates'); err.status = 400;
      throw err;
    }
    const schemasByName = new Map((tools ?? []).filter((t) => t?.name && t.input_schema).map((t) => [t.name, t.input_schema]));
    const { content, stop_reason, seq } = fromCandidate(candidate, { schemasByName, seq: this._seq });
    this._seq = seq;
    const um = json.usageMetadata ?? {};
    const cached = um.cachedContentTokenCount ?? 0;
    const usage = {
      input_tokens: Math.max(0, (um.promptTokenCount ?? 0) - cached),
      output_tokens: (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0),
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    };
    const usd = geminiCost(usage, this.model);
    this.totals.turns += 1;
    this.totals.usd = Math.round((this.totals.usd + usd) * 1e6) / 1e6;
    this.totals.input += usage.input_tokens; this.totals.output += usage.output_tokens; this.totals.cache_read += cached;
    const response = { content, stop_reason, usage, model: this.model };
    // Tell the loop when client-side trimming changed, so it re-shows the focus card.
    if (trimmed !== this._lastTrimmed) { response.context_management = { applied_edits: [{ type: 'client_clear_tool_uses', cleared: trimmed }] }; this._lastTrimmed = trimmed; }
    this.log?.info?.('model_turn', {
      model: this.model, stop: stop_reason, input: usage.input_tokens, output: usage.output_tokens, cache_read: cached, cache_create: 0,
      thoughts: um.thoughtsTokenCount ?? 0, usd, total_usd: this.totals.usd, latency_ms: latencyMs, context_edits: response.context_management ? 1 : 0, trimmed_results: trimmed || undefined,
    });
    return { response, usage, usd, latencyMs };
  }
}

export function geminiCost(usage, model) {
  const p = GEMINI_PRICING[model] ?? GEMINI_PRICING['gemini-3.8-flash'];
  const usd = ((usage.input_tokens ?? 0) * p.input + (usage.output_tokens ?? 0) * p.output + (usage.cache_read_input_tokens ?? 0) * p.cacheRead) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

export function isGeminiModel(model) { return /^gemini/i.test(String(model ?? '')); }
