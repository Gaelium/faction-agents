/**
 * Dashboard — ANSI CLI view of the fleet, with a zoom view per bot.
 *
 *   new Dashboard({ spawner, health, scheduler, tracker, getProfile, getBudget }).start()
 *
 * Fleet view (redraws every 2 s):
 *
 *   AI Factions  3/3 online  up 01:23:45  redis OK   session $1.42 ($2.10/h)  24h $6.80  budget $20/day (34%)
 *
 *     USER          ARCH      FACTION   UP     $      $/H   T/H  TOOLS D  LAST TOOL                 FOCUS
 *   > Rook_Vantis   diplomat  Vantis    41:12  0.52   0.76  48   40/36 0  mine coal_ore ×16 ok 32s   Claim the house chunk…
 *     oatmeal_ollie farmer    Vantis    38:02  0.48   0.75  52   31/29 0  farm tend ok 41s           Wheat farm by the…
 *   --- recent chat --- / --- recent events --- / --- crashes ---
 *   ↑↓ select · enter zoom · b back · q quit
 *
 * Bot view: the same header line for that bot, its focus card, the goals it
 * wrote in plans.md, its journal, the last 15 tool calls with results, its
 * last thoughts, events (damage, deaths, faction, sales) and chat.
 *
 * No blessed dep — ANSI escape codes only. Keyboard needs a TTY; without
 * one the fleet view just renders.
 */

import { EventEmitter } from 'node:events';

const CSI = '\x1b[';
const CLEAR = CSI + '2J' + CSI + 'H';
const RESET = CSI + '0m';
const BOLD = CSI + '1m';
const DIM = CSI + '2m';
const GREEN = CSI + '32m';
const YELLOW = CSI + '33m';
const RED = CSI + '31m';
const CYAN = CSI + '36m';
const MAGENTA = CSI + '35m';

const REFRESH_MS = 2000;
const CHAT_MAX = 8;
const CRASH_MAX = 5;
const EVENTS_MAX = 8;

export class Dashboard extends EventEmitter {
  constructor({ spawner, health, scheduler, tracker = null, getProfile, getBudget = null, orchestratorStart = Date.now(), out = process.stdout, input = process.stdin, webUrl = null }) {
    super();
    this.webUrl = webUrl;
    this.spawner = spawner;
    this.health = health;
    this.scheduler = scheduler;
    this.tracker = tracker;
    this.getProfile = getProfile;
    this.getBudget = getBudget;
    this.orchestratorStart = orchestratorStart;
    this.out = out;
    this.input = input;
    this.chatFeed = [];
    this.crashFeed = [];
    this.redisOk = false;
    this.timer = null;
    this.view = 'fleet';       // 'fleet' | 'bot'
    this.selected = 0;
    this.zoomed = null;        // username in bot view
    this._rawMode = false;

    spawner.on('exit', (user, info) => this._onBotExit(user, info));
    if (health) health.on('crash', (user, info) => this._onCrash(user, info));
  }

  setRedisOk(ok) { this.redisOk = !!ok; }

  recordChat({ sender, message, channel = 'global', ts = Date.now() }) {
    this.chatFeed.unshift({ ts, sender, message, channel });
    if (this.chatFeed.length > CHAT_MAX * 2) this.chatFeed.length = CHAT_MAX * 2;
  }

  start() {
    if (this.timer) return;
    this._attachKeys();
    this.out.write(CLEAR);
    this.timer = setInterval(() => this.render(), REFRESH_MS);
    if (this.timer.unref) this.timer.unref();
    this.render();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this._detachKeys();
  }

  // ---------- keyboard ----------

  _attachKeys() {
    const inp = this.input;
    if (!inp || !inp.isTTY || typeof inp.setRawMode !== 'function') return;
    try { inp.setRawMode(true); this._rawMode = true; } catch { return; }
    inp.resume();
    inp.setEncoding('utf8');
    this._onKey = (key) => this.handleKey(key);
    inp.on('data', this._onKey);
  }

  _detachKeys() {
    const inp = this.input;
    if (this._onKey && inp) inp.off('data', this._onKey);
    if (this._rawMode) { try { inp.setRawMode(false); } catch {} this._rawMode = false; }
    try { inp?.pause?.(); } catch {}
  }

  /** Public so tests can drive it. Returns what changed. */
  handleKey(key) {
    const names = this._roster();
    if (key === '' || key === 'q') { this.emit('quit'); return 'quit'; }
    if (key === '[A' || key === 'k') { this.selected = Math.max(0, this.selected - 1); this.render(); return 'up'; }
    if (key === '[B' || key === 'j') { this.selected = Math.min(Math.max(0, names.length - 1), this.selected + 1); this.render(); return 'down'; }
    if (/^[1-9]$/.test(key)) { const n = Number(key) - 1; if (n < names.length) { this.selected = n; this.zoomed = names[n]; this.view = 'bot'; } this.render(); return 'zoom'; }
    if (key === '\r' || key === '\n' || key === '\t' || key === 'l') {
      if (this.view === 'fleet' && names.length) { this.zoomed = names[Math.min(this.selected, names.length - 1)]; this.view = 'bot'; }
      this.render(); return 'zoom';
    }
    if (key === '' || key === 'b' || key === 'h') { this.view = 'fleet'; this.zoomed = null; this.render(); return 'back'; }
    if (key === 'r') { this.render(); return 'refresh'; }
    return null;
  }

  // ---------- feeds ----------

  _onBotExit(user, info) {
    if (info.code === 0 || info.killReason) return;
    this.crashFeed.unshift({ ts: Date.now(), user, code: info.code, signal: info.signal, retries: null });
    if (this.crashFeed.length > CRASH_MAX) this.crashFeed.length = CRASH_MAX;
  }

  _onCrash(user, info) {
    this.crashFeed = this.crashFeed.filter((c) => c.user !== user || Date.now() - c.ts > 500);
    this.crashFeed.unshift({ ts: Date.now(), user, code: info.code, signal: info.signal, retries: info.crashes });
    if (this.crashFeed.length > CRASH_MAX) this.crashFeed.length = CRASH_MAX;
  }

  // ---------- data ----------

  /** Online bots first (sorted), then tracked-but-offline ones. */
  _roster() {
    const online = this.spawner.onlineUsernames().sort();
    const tracked = this.tracker ? this.tracker.tracked().filter((u) => !online.includes(u)).sort() : [];
    return [...online, ...tracked];
  }

  _row(user, now) {
    const rec = this.spawner.getRecord(user);
    const st = this.tracker?.botState(user) ?? null;
    const p = rec?.profile ?? this.getProfile?.(user) ?? null;
    const online = !!rec;
    const startedAt = rec?.startedAt ?? st?.session?.startedAt ?? null;
    // Offline: rate over the session's own length, not the time since it started.
    const endTs = online ? now : (st?.lastTs ?? now);
    const upMs = startedAt ? Math.max(0, (online ? now : endTs) - startedAt) : 0;
    const hours = Math.max(upMs / 3_600_000, 1 / 60);
    return {
      user, online, archetype: p?.archetype ?? st?.session?.archetype ?? '-', faction: st?.faction ?? '-',
      upMs, usd: st?.usd ?? 0, usdPerH: st ? st.usd / hours : 0, turnsPerH: st ? st.turns / hours : 0,
      tools: st?.toolCalls ?? 0, toolsOk: st?.toolsOk ?? 0, deaths: st?.deaths ?? 0,
      lastTool: st?.lastTool ?? null, focus: st?.focus ?? null, st, profile: p,
    };
  }

  // ---------- rendering ----------

  render() {
    const width = Math.max(80, this.out.columns ?? 120);
    const lines = this.view === 'bot' && this.zoomed ? this.renderBot(this.zoomed, width) : this.renderFleet(width);
    this.out.write(CLEAR + lines.map((l) => clip(l, width)).join('\n') + '\n');
  }

  _header(now) {
    const onlineCount = this.spawner.onlineCount();
    const target = this.scheduler ? `${this.scheduler.min}-${this.scheduler.max}` : '?';
    const uptime = fmtDuration(now - this.orchestratorStart);
    const redisColor = this.redisOk ? GREEN : RED;
    const totals = this.tracker?.fleetTotals?.() ?? null;
    const hours = Math.max((now - this.orchestratorStart) / 3_600_000, 1 / 60);
    const budget = this.getBudget?.() ?? null;
    let money = '';
    if (totals) money = `   session ${BOLD}$${totals.usd.toFixed(2)}${RESET} ($${(totals.usd / hours).toFixed(2)}/h)`;
    if (budget) {
      const pct = budget.perDay ? Math.round((budget.spent24h / budget.perDay) * 100) : null;
      const color = budget.paused ? RED : pct != null && pct >= 80 ? YELLOW : GREEN;
      money += `   24h $${budget.spent24h.toFixed(2)}`;
      if (budget.perDay) money += `   budget ${color}$${budget.perDay}/day (${pct}%)${budget.paused ? ' PAUSED' : ''}${RESET}`;
      if (budget.projectedPerDay != null) money += `   proj $${budget.projectedPerDay.toFixed(0)}/day`;
    }
    const web = this.webUrl ? `   web ${CYAN}${this.webUrl}${RESET}` : '';
    return `${BOLD}AI Factions${RESET}  ${onlineCount}/${target} online   up ${uptime}   redis ${redisColor}${this.redisOk ? 'OK' : 'DOWN'}${RESET}${money}${web}`;
  }

  renderFleet(width) {
    const now = Date.now();
    const lines = [this._header(now), ''];
    const focusW = Math.max(16, width - 110);
    lines.push(DIM + ['  ', pad('USER', 14), pad('ARCH', 9), pad('FACTION', 10), pad('UP', 6), pad('$', 6), pad('$/H', 5), pad('T/H', 4), pad('TOOLS', 6), pad('D', 2), pad('LAST TOOL', 36), 'FOCUS'].join(' ') + RESET);
    const names = this._roster();
    if (this.selected >= names.length) this.selected = Math.max(0, names.length - 1);
    names.forEach((user, idx) => {
      const r = this._row(user, now);
      const sel = idx === this.selected ? `${CYAN}>${RESET} ` : '  ';
      const nameCol = r.online ? pad(user, 14) : DIM + pad(user, 14) + RESET;
      const last = r.lastTool ? `${r.lastTool.summary} ${statusColor(r.lastTool.status)}${r.lastTool.status}${RESET}${r.lastTool.elapsed_ms != null ? ' ' + fmtSecs(r.lastTool.elapsed_ms) : ''}` : DIM + (r.online ? '(starting)' : '(offline)') + RESET;
      lines.push([
        sel, nameCol, pad(r.archetype, 9), pad(r.faction, 10), pad(r.online ? fmtMinSec(r.upMs / 1000) : '-', 6),
        pad(r.usd.toFixed(2), 6), pad(r.usdPerH.toFixed(2), 5), pad(String(Math.round(r.turnsPerH)), 4), pad(`${r.tools}/${r.toolsOk}`, 6),
        pad(String(r.deaths), 2), padAnsi(last, 36), truncate(r.focus ?? '', focusW),
      ].join(' '));
    });
    if (!names.length) lines.push(DIM + '  (no bots yet)' + RESET);
    lines.push('');

    // Chat: the redis feed plus what tracked bots said.
    const chat = [...this.chatFeed];
    for (const u of names) for (const c of this.tracker?.botState(u)?.recentChat ?? []) if (c.dir === 'out') chat.push({ ts: c.ts, sender: c.from, message: c.text, channel: c.to === 'public' ? 'global' : 'private' });
    const seen = new Set();
    const merged = chat.sort((a, b) => b.ts - a.ts).filter((m) => { const k = `${m.sender}|${m.message}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, CHAT_MAX);
    lines.push(DIM + '--- recent chat ---' + RESET);
    if (!merged.length) lines.push(DIM + '  (silent)' + RESET);
    for (const m of merged) lines.push(`[${fmtClock(m.ts)}] ${CYAN}${m.sender}${RESET}${m.channel === 'private' ? ' (msg)' : ''}: ${m.message}`);
    lines.push('');

    // Events across the fleet.
    const events = [];
    for (const u of names) for (const e of this.tracker?.botState(u)?.recentEvents ?? []) events.push({ ...e, user: u });
    events.sort((a, b) => b.ts - a.ts);
    lines.push(DIM + '--- recent events ---' + RESET);
    if (!events.length) lines.push(DIM + '  (none)' + RESET);
    for (const e of events.slice(0, EVENTS_MAX)) lines.push(`[${fmtClock(e.ts)}] ${MAGENTA}${e.user}${RESET} ${e.text}`);
    lines.push('');

    lines.push(DIM + '--- crashes ---' + RESET);
    if (!this.crashFeed.length) lines.push(DIM + '  (none)' + RESET);
    for (const c of this.crashFeed) lines.push(`[${fmtClock(c.ts)}] ${RED}${c.user}${RESET} exit${c.signal ? ` signal=${c.signal}` : ` code=${c.code}`}${c.retries != null ? ` (${c.retries} crashes)` : ''}`);
    lines.push('');
    lines.push(DIM + '↑/↓ or j/k select · enter zoom · 1-9 jump · b back · q quit' + RESET);
    return lines;
  }

  renderBot(user, width) {
    const now = Date.now();
    const r = this._row(user, now);
    const st = r.st;
    const p = r.profile;
    const lines = [this._header(now), ''];
    const model = st?.session ? `${st.session.model ?? '?'}/${st.session.effort ?? '?'}` : '?';
    lines.push(`${BOLD}${user}${RESET} · ${r.archetype}${p?.skill_tier != null ? ` tier ${p.skill_tier}` : ''} · ${model} · ${r.online ? `${GREEN}online${RESET} ${fmtDuration(r.upMs)}` : `${DIM}offline${RESET}${st?.lastTs ? ` (last seen ${fmtClock(st.lastTs)})` : ''}`}`);
    if (st) {
      lines.push(`session ${BOLD}$${st.usd.toFixed(2)}${RESET} ($${r.usdPerH.toFixed(2)}/h)${st.pastUsd ? ` · earlier sessions $${st.pastUsd.toFixed(2)}` : ''} · ${st.turns} turns (${Math.round(r.turnsPerH)}/h) · ${st.toolCalls} tools (${st.toolsOk} ok, ${st.toolsFailed} failed, ${st.interrupts} interrupted) · ${st.deaths} deaths · context edits ${st.contextEdits}`);
      lines.push(`faction ${st.faction ?? '-'} · home ${st.home ? `${st.home.x},${st.home.y},${st.home.z}` : '-'} · money ${st.money != null ? '$' + Math.round(st.money) : '?'} · scripts run ${st.scripts.run} (ok ${st.scripts.ok}) · skills saved ${st.scripts.saved}, used ${st.scripts.used}`);
    } else {
      lines.push(DIM + 'no transcript yet' + RESET);
    }
    lines.push('');
    lines.push(`${BOLD}FOCUS${RESET}${st?.focusAt ? DIM + ` (set ${fmtClock(st.focusAt)})` + RESET : ''}`);
    lines.push(...wrap(st?.focus ?? '(none)', width - 2).map((l) => '  ' + l));
    lines.push('');
    const goals = this.tracker?.goals?.(user) ?? { plans: [], journal: [] };
    lines.push(`${BOLD}STANDING GOALS${RESET} ${DIM}(plans.md)${RESET}`);
    if (!goals.plans.length) lines.push(DIM + '  (none written yet)' + RESET);
    for (const l of goals.plans) lines.push('  ' + truncate(l, width - 4));
    lines.push('');
    lines.push(`${BOLD}JOURNAL${RESET} ${DIM}(latest last)${RESET}`);
    if (!goals.journal.length) lines.push(DIM + '  (empty)' + RESET);
    for (const l of goals.journal) lines.push('  ' + truncate(l, width - 4));
    lines.push('');
    lines.push(`${BOLD}RECENT ACTIVITY${RESET} ${DIM}(latest last)${RESET}`);
    const tools = (st?.recentTools ?? []).slice(-15);
    if (!tools.length) lines.push(DIM + '  (nothing yet)' + RESET);
    for (const t of tools) {
      const why = t.status === 'ok' ? '' : ` ${t.reason ?? ''}${t.by ? ' by ' + t.by : ''}`;
      lines.push(`  [${fmtClock(t.ts, true)}] ${padAnsi(t.summary, 44)} ${statusColor(t.status)}${t.status}${RESET}${why}${t.elapsed_ms != null && t.elapsed_ms >= 1000 ? DIM + ' ' + fmtSecs(t.elapsed_ms) + RESET : ''}`);
    }
    lines.push('');
    lines.push(`${BOLD}THOUGHTS${RESET}`);
    const thoughts = (st?.recentThoughts ?? []).slice(-5);
    if (!thoughts.length) lines.push(DIM + '  (none)' + RESET);
    for (const t of thoughts) lines.push(`  [${fmtClock(t.ts, true)}] ${truncate(t.text, width - 14)}`);
    lines.push('');
    lines.push(`${BOLD}EVENTS${RESET}`);
    const events = (st?.recentEvents ?? []).slice(-8);
    if (!events.length) lines.push(DIM + '  (none)' + RESET);
    for (const e of events) lines.push(`  [${fmtClock(e.ts, true)}] ${truncate(e.text, width - 14)}`);
    lines.push('');
    lines.push(`${BOLD}CHAT${RESET}`);
    const chat = (st?.recentChat ?? []).slice(-8);
    if (!chat.length) lines.push(DIM + '  (silent)' + RESET);
    for (const c of chat) lines.push(`  [${fmtClock(c.ts, true)}] ${c.dir === 'out' ? `${CYAN}${user}${RESET} → ${c.to ?? 'public'}` : `${YELLOW}<${c.from}>${RESET}`}: ${truncate(c.text, width - 30)}`);
    lines.push('');
    lines.push(DIM + 'b/esc back · ↑/↓ next bot · q quit' + RESET);
    return lines;
  }
}

// ---------- formatting ----------

function statusColor(s) { return s === 'ok' ? GREEN : s === 'failed' ? RED : s === 'interrupted' ? YELLOW : DIM; }
function stripAnsi(s) { return String(s ?? '').replace(/\x1b\[[0-9;]*m/g, ''); }
function pad(s, n) { const str = String(s ?? ''); return str.length >= n ? str.slice(0, Math.max(0, n - 1)) + ' ' : str + ' '.repeat(n - str.length); }
function padAnsi(s, n) { const plain = stripAnsi(s); if (plain.length >= n) return truncate(plain, n - 1) + ' '; return s + ' '.repeat(n - plain.length); }
function truncate(s, n) { const str = String(s ?? '').replace(/\s+/g, ' '); return str.length > n ? str.slice(0, Math.max(0, n - 1)) + '…' : str; }
function clip(line, width) {
  // Cut a rendered line at `width` visible characters, keeping escape codes intact.
  let visible = 0; let out = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b') { const m = /^\x1b\[[0-9;]*m/.exec(line.slice(i)); if (m) { out += m[0]; i += m[0].length - 1; continue; } }
    if (visible >= width - 1) break;
    out += line[i]; visible += 1;
  }
  return out + RESET;
}
function wrap(text, width) {
  const words = String(text ?? '').replace(/\s+/g, ' ').split(' ');
  const lines = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > width) { lines.push(cur.trim()); cur = w; } else cur = (cur + ' ' + w); }
  if (cur.trim()) lines.push(cur.trim());
  return lines.length ? lines : [''];
}
function fmtDuration(ms) { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
function fmtMinSec(s) { s = Math.max(0, Math.floor(s)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
function fmtSecs(ms) { return ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`; }
function fmtClock(ts, seconds = false) { const d = new Date(ts); const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; return seconds ? `${hm}:${String(d.getSeconds()).padStart(2, '0')}` : hm; }
