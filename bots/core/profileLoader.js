import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.resolve(__dirname, '..', 'profiles');

/**
 * Loads a YAML profile from bots/profiles/<name>.yaml and returns it with
 * defaults merged in. Throws if the file is missing or required fields
 * aren't present.
 */
/** Lists the basenames of all *.yaml files in bots/profiles/. */
export function listProfileNames() {
  try {
    return fs.readdirSync(PROFILES_DIR)
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => f.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Load a profile by its filename stem (preferred) OR by its
 * `username:` field (fallback). The orchestrator spawns bots by
 * username, which doesn't always match the YAML filename — e.g.
 * `test_bot_1.yaml` has `username: TestBot1`. This lookup makes both
 * work without renaming test fixtures.
 */
export function loadProfile(name) {
  let file = path.join(PROFILES_DIR, `${name}.yaml`);
  if (!fs.existsSync(file)) {
    // Fallback: scan all yamls for one whose username matches.
    const match = findProfileByUsername(name);
    if (!match) throw new Error(`profile not found: ${file} (also no file with username=${name})`);
    file = match;
  }
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = yaml.load(raw) ?? {};

  if (!parsed.username) {
    throw new Error(`profile ${name} missing required field: username`);
  }

  return {
    username: parsed.username,
    archetype: parsed.archetype ?? 'generic',
    skill_tier: parsed.skill_tier ?? 1,
    voice: parsed.voice ?? {},
    host: parsed.host ?? 'localhost',
    port: parsed.port ?? 25565,
    version: parsed.version ?? '1.8.9',
    auth: parsed.auth ?? 'offline',
    redis: {
      host: parsed.redis?.host ?? 'localhost',
      port: parsed.redis?.port ?? 6379,
      password: parsed.redis?.password ?? undefined,
      db: parsed.redis?.db ?? 0,
      channels: {
        events:    parsed.redis?.channels?.events    ?? 'mc:events',
        commands:  parsed.redis?.channels?.commands  ?? 'mc:commands',
        responses: parsed.redis?.channels?.responses ?? 'mc:responses',
      },
    },
    spawn: parsed.spawn ?? { x: 0, y: 64, z: 0 },
    combat: parsed.combat ?? {},
    ambition: clampUnit(parsed.ambition ?? 0.5),
    faction_preferences: parsed.faction_preferences ?? {},
    backstory: parsed.backstory ?? '',
    values: parsed.values ?? {},
    schedule: normalizeSchedule(parsed.schedule),
  };
}

function clampUnit(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function findProfileByUsername(username) {
  let dir;
  try { dir = fs.readdirSync(PROFILES_DIR); } catch { return null; }
  for (const f of dir) {
    if (!f.endsWith('.yaml')) continue;
    try {
      const raw = fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8');
      const p = yaml.load(raw);
      if (p?.username === username) return path.join(PROFILES_DIR, f);
    } catch { /* skip unreadable */ }
  }
  return null;
}

function normalizeSchedule(raw) {
  const s = raw ?? {};
  const primary = s.primary_hours ?? [18, 23];
  const secondary = s.secondary_hours ?? [14, 18];
  const sessionMin = s.session_minutes ?? [30, 120];
  return {
    primary_hours: Array.isArray(primary) && primary.length === 2 ? primary : [18, 23],
    secondary_hours: Array.isArray(secondary) && secondary.length === 2 ? secondary : [14, 18],
    session_minutes: Array.isArray(sessionMin) && sessionMin.length === 2 ? sessionMin : [30, 120],
    weekend_boost: s.weekend_boost !== false,  // default true
    always_online: s.always_online === true,
  };
}
