/**
 * loop.js — the brain's loop. The only sequencer in the process.
 *
 *   messages → model → tool calls → run (serially for actuators, in
 *   parallel for reads) → tool results + [events] + [now] → messages …
 *
 * Append-only history: nothing ever edits an earlier turn. Cancellation
 * flows one way: nerves.arm(token) before an actuator runs, the tool
 * returns `interrupted` if the token fires, the loop disarms. Idle turns
 * (no tool call) back off 5 → 30 s so a chatty model cannot burn money.
 */

import { CancelToken, cancellableSleep } from './cancel.js';
import { validateInput } from './tools/index.js';
import { statusLine } from './tools/perceive.js';

// Tools that only read; three turns of nothing but these earns a nudge.
const READ_ONLY_TOOLS = new Set(['look', 'scan', 'inventory', 'recipes', 'blueprints', 'skills', 'board', 'jobs', 'memory', 'survey_site']);

const DEFAULTS = Object.freeze({
  idleBackoffMs: [5000, 10000, 20000, 30000],
  maxTurns: Number(process.env.AGENT_MAX_TURNS ?? 600),
  maxUsd: Number(process.env.AGENT_MAX_USD ?? 5),
  focusReminderEvery: 12,
  sessionReminderEvery: 20,
  resultCharCap: 2400,
  respawnWaitMs: 30_000,
  toolHardCapMs: 15 * 60_000,
  modelRetryDelayMs: 15_000,
  modelMaxConsecutiveErrors: 5,
});

export class AgentLoop {
  constructor({ model, tools, nerves, bot, log = null, transcript = null, state, system, opts = {} }) {
    this.model = model;
    this.tools = tools;            // { definitions, byName }
    this.nerves = nerves;
    this.bot = bot;
    this.log = log;
    this.transcript = transcript;
    this.state = state;            // shared mutable: focus, home, lastBuild, stop, spawn
    this.system = system;
    this.opts = { ...DEFAULTS, ...opts };
    this.messages = [];
    this.turn = 0;
    this.stopReason = null;
    this._stopToken = new CancelToken();
    this._current = null;
    this._contextEdited = null;
    this.stats = { contextEdits: 0 };
    this.startedAt = Date.now();
  }

  stop(reason = 'stopped') {
    if (this.stopReason) return;
    this.stopReason = reason;
    this.log?.info?.('agent_stop', { reason });
    try { this._current?.cancel?.('shutdown', { reason }); } catch {}
    try { this.nerves?.cancelCurrent?.('shutdown', { reason }); } catch {}
    this._stopToken.cancel('shutdown');
  }

  async run(bootstrapText) {
    this._pushUser([{ type: 'text', text: bootstrapText }]);
    let idleStreak = 0;
    let modelErrors = 0;

    while (!this.stopReason && !this.state.stop) {
      if (this.turn >= this.opts.maxTurns) { this.stop('max_turns'); break; }
      if ((this.model.totals?.usd ?? 0) >= this.opts.maxUsd) { this.stop('budget_exhausted'); break; }

      let res;
      try {
        res = await this.model.turn({ system: this.system, tools: this.tools.definitions, messages: this.messages });
        modelErrors = 0;
      } catch (err) {
        modelErrors += 1;
        const status = err?.status ?? err?.statusCode ?? null;
        const fatal = status === 400 || status === 401 || status === 403 || status === 404;
        if (fatal || modelErrors >= this.opts.modelMaxConsecutiveErrors) {
          this.log?.error?.('agent_model_fatal', { status, msg: err?.message, errors: modelErrors });
          this.stop(`model_error:${status ?? err?.message}`);
          break;
        }
        this.log?.warn?.('agent_model_retry', { status, msg: err?.message, in_ms: this.opts.modelRetryDelayMs });
        await cancellableSleep(this.opts.modelRetryDelayMs, this._stopToken);
        continue;
      }

      const { response, usage, usd, latencyMs } = res;
      this.turn += 1;
      const toolUses = (response.content ?? []).filter((b) => b.type === 'tool_use');
      const text = (response.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
      // Append the FULL content: thinking blocks and any compaction block
      // must round-trip verbatim (the API replaces compacted history with it).
      this.messages.push({ role: 'assistant', content: response.content });
      this.transcript?.message('assistant', response.content);
      this.transcript?.turn({ n: this.turn, usage, usd, latencyMs, stopReason: response.stop_reason, tools: toolUses.map((t) => t.name), text });
      if (text) this.log?.info?.('agent_thought', { turn: this.turn, text: text.slice(0, 300) });
      // Context was edited or compacted: re-show the focus card and home on
      // the next user turn so the plan survives whatever the summary kept.
      const edits = response.context_management?.applied_edits ?? [];
      const compacted = (response.content ?? []).some((b) => b.type === 'compaction');
      if (edits.length || compacted) {
        this._contextEdited = { edits: edits.map((e) => e.type), compacted };
        this.stats.contextEdits += 1;
        this.log?.info?.('agent_context_edited', { turn: this.turn, edits: edits.map((e) => e.type), compacted });
        this.transcript?.event('context_edited', { turn: this.turn, edits, compacted });
      }

      if (response.stop_reason === 'refusal') {
        this.log?.warn?.('agent_refusal', { turn: this.turn, details: response.stop_details ?? null });
        this._pushUser([{ type: 'text', text: '(That request was declined by the model provider. Carry on playing normally.)' + this._trailer() }]);
        continue;
      }

      if (response.stop_reason === 'model_context_window_exceeded') {
        this.log?.warn?.('agent_context_window_exceeded', { turn: this.turn });
      }

      if (!toolUses.length) {
        if (this.state.stop) break;
        const delay = this.opts.idleBackoffMs[Math.min(idleStreak, this.opts.idleBackoffMs.length - 1)];
        idleStreak += 1;
        const cut = response.stop_reason === 'max_tokens' || response.stop_reason === 'model_context_window_exceeded';
        this.log?.info?.('agent_idle', { turn: this.turn, delay_ms: delay, streak: idleStreak, cut });
        await cancellableSleep(delay, this._stopToken);
        if (this.stopReason) break;
        const head = cut
          ? '(Your last message was cut off by the length limit. Be brief and call a tool.)'
          : `(idle ${Math.round(delay / 1000)}s, no tool called. Use wait to idle on purpose.)`;
        this._pushUser([{ type: 'text', text: head + this._trailer() }]);
        continue;
      }
      idleStreak = 0;

      const results = await this._runTools(toolUses);
      this._noteInspection(toolUses);
      if (this.stopReason && !this.state.stop) break;
      const content = [...results, { type: 'text', text: this._trailer().trim() }];
      this._pushUser(content);
      if (this.state.stop) { this.stop(this.state.stop); break; }
    }

    if (!this.stopReason) this.stop(this.state.stop ?? 'ended');
    return { reason: this.stopReason, turns: this.turn, usd: this.model.totals?.usd ?? 0, minutes: Math.round((Date.now() - this.startedAt) / 6000) / 10 };
  }

  // ---------- tools ----------

  async _runTools(toolUses) {
    const reads = []; const acts = [];
    for (const tu of toolUses) {
      const meta = this.tools.byName.get(tu.name);
      if (meta?.parallelSafe) reads.push(tu); else acts.push(tu);
    }
    const out = new Map();
    await Promise.all(reads.map(async (tu) => out.set(tu.id, await this._runOne(tu))));
    for (const tu of acts) {
      if (this.stopReason) { out.set(tu.id, this._result(tu, { status: 'failed', reason: 'session_ending' }, 0, true)); continue; }
      out.set(tu.id, await this._runOne(tu));
    }
    return toolUses.map((tu) => out.get(tu.id));
  }

  async _runOne(tu) {
    const meta = this.tools.byName.get(tu.name);
    const startedAt = Date.now();
    if (!meta) return this._result(tu, { status: 'unsupported', reason: 'unknown_tool', known: [...this.tools.byName.keys()] }, 0, true);
    const input = tu.input && typeof tu.input === 'object' ? tu.input : {};
    const problems = meta.schema ? validateInput(meta.schema, input) : [];
    if (problems.length) return this._result(tu, { status: 'failed', reason: 'bad_input', problems }, 0, true);

    const cancel = new CancelToken();
    let result;
    if (!meta.parallelSafe) {
      const alive = await this._ensureAlive();
      if (!alive) return this._result(tu, { status: 'failed', reason: 'dead', hint: 'waiting to respawn' }, Date.now() - startedAt, true);
      this._current = cancel;
      const interruptOn = Array.isArray(input.interrupt_on) ? input.interrupt_on : meta.defaultInterrupts;
      this.nerves?.arm?.({ interruptOn, cancel, uninterruptible: meta.uninterruptible ?? false });
    }
    const hardCap = setTimeout(() => cancel.cancel('hard_timeout'), this.opts.toolHardCapMs);
    try {
      const { interrupt_on: _omit, ...clean } = input;
      result = await meta.handler(clean, { cancel, log: this.log, deps: null });
    } catch (e) {
      this.log?.warn?.('agent_tool_threw', { tool: tu.name, msg: e?.message });
      result = { status: 'failed', reason: 'exception:' + (e?.message ?? 'unknown') };
    } finally {
      clearTimeout(hardCap);
      if (!meta.parallelSafe) { this.nerves?.disarm?.(); this._current = null; }
    }
    const elapsedMs = Date.now() - startedAt;
    return this._result(tu, result, elapsedMs, result?.status === 'failed' || result?.status === 'unsupported');
  }

  _result(tu, result, elapsedMs, isError = false) {
    const payload = { ...(result ?? { status: 'failed', reason: 'no_result' }), elapsed_s: Math.round(elapsedMs / 100) / 10 };
    // The memory tool speaks plain text, like the reference implementation.
    let text = tu.name === 'memory' && typeof payload.text === 'string' ? payload.text : safeJson(payload);
    if (text.length > this.opts.resultCharCap) text = text.slice(0, this.opts.resultCharCap) + '…(truncated)';
    this.transcript?.tool({ name: tu.name, input: tu.input, result: payload, elapsedMs });
    this.log?.info?.('agent_tool', { tool: tu.name, status: payload.status, reason: payload.reason ?? null, by: payload.by ?? null, elapsed_ms: elapsedMs });
    const block = { type: 'tool_result', tool_use_id: tu.id, content: text };
    if (isError) block.is_error = true;
    return block;
  }

  async _ensureAlive() {
    const bot = this.bot;
    const dead = () => (typeof bot.health === 'number' && bot.health <= 0) || !bot.entity;
    if (!dead()) return true;
    this.log?.info?.('agent_wait_respawn');
    const deadline = Date.now() + this.opts.respawnWaitMs;
    while (Date.now() < deadline && !this.stopReason) {
      await cancellableSleep(500, this._stopToken);
      if (!dead() && bot.entity?.position) { await cancellableSleep(1500, this._stopToken); return true; }
    }
    return !dead();
  }

  // ---------- context blocks ----------

  _pushUser(content) {
    this.messages.push({ role: 'user', content });
    this.transcript?.message('user', content);
  }

  /** [events] + [focus] reminders + [now] status, appended after tool results. */
  /** Count consecutive turns that only looked around; the trailer nudges past three. */
  _noteInspection(toolUses) {
    const readOnly = (tu) => READ_ONLY_TOOLS.has(tu.name) || (tu.name === 'run_script' && !/tools\./.test(String(tu.input?.code ?? '')));
    if (toolUses.length && toolUses.every(readOnly)) this._inspectStreak = (this._inspectStreak ?? 0) + 1;
    else this._inspectStreak = 0;
  }

  _trailer() {
    const lines = [];
    if ((this._inspectStreak ?? 0) >= 3) {
      lines.push(`[pace] ${this._inspectStreak} turns of looking without acting. You know enough: do the next real thing (mine, goto, craft, build, farm, store, sell, or a script that calls tools).`);
    }
    const drained = this.nerves?.drain?.() ?? { events: [], summary: [] };
    if (drained.events.length || drained.summary.length) {
      lines.push('[events]');
      for (const ev of drained.events.slice(-12)) lines.push('- ' + formatEvent(ev));
      for (const s of drained.summary) lines.push('- ' + s);
    }
    if (this._contextEdited) {
      const what = this._contextEdited.compacted ? 'older history was compacted into a summary' : 'older tool results were cleared';
      lines.push(`[context] ${what}. Your durable facts are in /memories (memory tool) and below.`);
      if (this.state.focus) lines.push(`[focus card] ${this.state.focus}`);
      if (this.state.home) lines.push(`[home] ${safeJson({ x: this.state.home.x, y: this.state.home.y, z: this.state.home.z, inside: this.state.home.inside, chest: this.state.home.chest })}`);
      this._contextEdited = null;
    } else if (this.state.focus && this.turn > 0 && this.turn % this.opts.focusReminderEvery === 0) {
      lines.push(`[focus card] ${this.state.focus}`);
    }
    if (this.turn > 0 && this.turn % this.opts.sessionReminderEvery === 0) {
      lines.push(`[session] ${Math.round((Date.now() - this.startedAt) / 60000)} min played this login`);
    }
    // Two speeds of thinking: nudge toward the strategist every ~30 min of
    // play (or after 40 turns with no think at all), never more often.
    const sinceThink = this.state.lastThinkAt ? Date.now() - this.state.lastThinkAt : Date.now() - this.startedAt;
    const sinceNudge = this._lastStrategyNudgeAt ? Date.now() - this._lastStrategyNudgeAt : Infinity;
    if (this.tools.byName.has('think') && sinceThink > 30 * 60_000 && sinceNudge > 30 * 60_000 && this.turn >= 20) {
      this._lastStrategyNudgeAt = Date.now();
      lines.push(`[strategy] ${this.state.lastThinkAt ? Math.round(sinceThink / 60000) + ' min since your last think' : 'you have not used think this session'}; before the next big decision, consider it.`);
    }
    try { lines.push(`[now] ${statusLine(this.bot, this.nerves)}`); } catch {}
    return lines.length ? '\n' + lines.join('\n') : '';
  }
}

export function formatEvent(ev) {
  switch (ev.kind) {
    case 'damage': {
      const who = ev.attacker ? ` by ${ev.attacker}` : '';
      const amt = ev.amount != null ? ` -${ev.amount}` : '';
      const low = ev.low_hp ? ' LOW HP: heal, flee, or fight now' : '';
      return `damage (${ev.cause ?? 'unknown'}${who})${amt} → hp ${ev.hp ?? '?'}${ev.pos ? ` at ${ev.pos.x},${ev.pos.y},${ev.pos.z}` : ''}${low}`;
    }
    case 'chat_mention': return `chat: <${ev.from}> ${ev.text}`;
    case 'whisper': return `whisper from ${ev.from}: ${ev.text}`;
    case 'mob_near': return `${ev.mob} ${ev.distance}b ${ev.dir}`;
    case 'player_near': return `player ${ev.player} ${ev.distance}b ${ev.dir}`;
    case 'hunger': return `hungry: food ${ev.food}${ev.has_food ? '' : ' and you carry no food'}`;
    case 'job_done': return `job ${ev.job_id} ready: ${ev.count} ${ev.item} in the furnace at ${ev.furnace?.x},${ev.furnace?.y},${ev.furnace?.z} (smelt_collect)`;
    case 'dusk': {
      const kit = `${ev.torches ?? 0} torches, ${ev.armor ?? 0} armor pieces${ev.sword ? ', a sword' : ', no sword'}`;
      const ready = (ev.torches ?? 0) >= 8 && (ev.armor ?? 0) >= 2 && ev.sword;
      return ready
        ? `dusk: night falls and mobs spawn in the dark. You have ${kit}: light_area around home first, then keep working (mine underground with torches, smelt, craft, farm by torchlight, sell, plan). Fight one mob at a time; two or more, get inside`
        : `dusk: night falls and mobs spawn in the dark. You have ${kit}: not enough for a night outside. Get inside now and work indoors (craft, smelt, sort, plan, notes); make torches and armor your first job at dawn`;
    }
    case 'dawn': return 'dawn: the sun is up; surface mobs burn';
    case 'faction_member': return `faction: ${ev.player} joined ${ev.faction ?? 'your faction'}; their power now counts. They are a recruit and cannot build on faction land until you run f rank ${ev.player} member. Then f power, f claim at your house, f sethome`;
    case 'faction_denied': return `${ev.faction} does not allow you to ${ev.perm} here: you are a recruit on faction land. Ask the leader in chat to run f rank <you> member, and work somewhere else meanwhile; retrying will not help`;
    case 'faction_invite': return `faction invite: ${ev.from ? ev.from + ' invited you to ' : 'you were invited to '}${ev.faction} (f join ${ev.faction} to accept; check board first)`;
    case 'death': return `YOU DIED${ev.killer ? ` (killed by ${ev.killer})` : ''}${ev.pos ? ` at ${ev.pos.x},${ev.pos.y},${ev.pos.z}` : ''}; you respawn at spawn with an empty inventory unless drops are recovered`;
    default: return `${ev.kind}: ${safeJson({ ...ev, kind: undefined, ts: undefined, tier: undefined })}`;
  }
}

function safeJson(obj) {
  try { return JSON.stringify(obj, (k, v) => (v === undefined ? undefined : v)); }
  catch { return String(obj); }
}
