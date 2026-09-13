/**
 * args.js — command-line options for the orchestrator (pure, testable).
 *
 *   --only a,b,c        roster: only these profiles, kept online (always_online)
 *   --respect-schedule  with --only, still honour each profile's hours
 *   --target n | n,m    how many bots online (min,max); default 6,12 or roster size with --only
 *   --budget usd        fleet ceiling per rolling 24 h; spawning pauses above it
 *   --budget-action x   pause (default) | kill: what to do when the ceiling is hit
 *   --session min,max   override session length in minutes for every profile
 *   --web [port]        local web dashboard (default on, port 4545); --no-web turns it off
 *   --dry / --once / --no-dashboard / --status-json   as before
 */

export function parseArgs(argv, env = {}) {
  const out = {
    only: null, respectSchedule: false, target: null, budget: null, budgetAction: 'pause', session: null,
    dry: false, once: false, noDashboard: false, statusJson: true, web: 4545,
  };
  const take = (i) => (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : null);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes('=') ? a.split(/=(.*)/s) : [a, null];
    const value = () => inline ?? take(i);
    switch (flag) {
      case '--only': out.only = String(value() ?? '').split(',').map((s) => s.trim()).filter(Boolean); if (!inline) i++; break;
      case '--respect-schedule': out.respectSchedule = true; break;
      case '--target': { const v = String(value() ?? ''); if (!inline) i++; const [a1, b1] = v.split(',').map((n) => Number(n)); if (Number.isFinite(a1)) out.target = [a1, Number.isFinite(b1) ? b1 : a1]; break; }
      case '--budget': { const v = Number(value()); if (!inline) i++; if (Number.isFinite(v) && v > 0) out.budget = v; break; }
      case '--budget-action': { const v = String(value() ?? 'pause'); if (!inline) i++; out.budgetAction = v === 'kill' ? 'kill' : 'pause'; break; }
      case '--session': { const v = String(value() ?? ''); if (!inline) i++; const [a1, b1] = v.split(',').map((n) => Number(n)); if (Number.isFinite(a1) && a1 > 0) out.session = [a1, Number.isFinite(b1) && b1 >= a1 ? b1 : a1]; break; }
      case '--dry': out.dry = true; break;
      case '--once': out.once = true; break;
      case '--no-dashboard': out.noDashboard = true; break;
      case '--status-json': out.statusJson = true; break;
      case '--no-status-json': out.statusJson = false; break;
      case '--web': { const v = value(); if (v != null && !inline) i++; const n = Number(v); if (Number.isFinite(n) && n > 0) out.web = n; break; }
      case '--no-web': out.web = null; break;
      default: break;
    }
  }
  if (out.budget == null && Number.isFinite(Number(env.FLEET_MAX_USD_PER_DAY)) && Number(env.FLEET_MAX_USD_PER_DAY) > 0) out.budget = Number(env.FLEET_MAX_USD_PER_DAY);
  if (env.FLEET_BUDGET_ACTION === 'kill') out.budgetAction = 'kill';
  return out;
}

/** Apply the roster and session overrides to loaded profiles (in memory only). */
export function applyRoster(profiles, opts) {
  let list = profiles;
  if (opts.only?.length) {
    const want = new Set(opts.only.map((s) => s.toLowerCase()));
    list = profiles.filter((p) => want.has(String(p.username).toLowerCase()));
    if (!opts.respectSchedule) for (const p of list) p.schedule = { ...(p.schedule ?? {}), always_online: true };
  }
  if (opts.session) for (const p of list) p.schedule = { ...(p.schedule ?? {}), session_minutes: [...opts.session] };
  const target = opts.target ?? (opts.only?.length ? [list.length, list.length] : [6, 12]);
  return { profiles: list, target };
}
