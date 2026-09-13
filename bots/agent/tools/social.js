/**
 * social.js — say, command. `say` goes through the profile's VoiceFilter
 * (typos, caps-when-tilted, catchphrases) and a rate limit so the bot
 * reads like a player. `command` is the generic slash-command escape
 * hatch that returns whatever the server replied.
 */

import { ok, fail } from './result.js';

const MIN_GAP_MS = 1500;
const MAX_PER_MINUTE = 6;

export function socialTools(deps) {
  const { bot, voice, log, state } = deps;
  const sent = [];

  const say = {
    name: 'say',
    description: 'Say something in chat (public), or privately to a player with `to`. Keep it short, casual, in character; most turns need no chat. Rate-limited like a real player.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', maxLength: 100 }, to: { type: 'string', description: 'player name for a private /msg' } },
      required: ['text'], additionalProperties: false,
    },
    parallelSafe: true,
    async handler({ text, to }) {
      const now = Date.now();
      while (sent.length && now - sent[0] > 60_000) sent.shift();
      if (sent.length >= MAX_PER_MINUTE) return fail('rate_limited', { retry_in_s: Math.ceil((60_000 - (now - sent[0])) / 1000) });
      if (sent.length && now - sent[sent.length - 1] < MIN_GAP_MS) {
        await new Promise((r) => setTimeout(r, MIN_GAP_MS - (now - sent[sent.length - 1])));
      }
      let line = String(text ?? '').replace(/\s+/g, ' ').trim();
      if (!line) return fail('empty');
      if (line.startsWith('/')) return fail('use_command_tool');
      try { line = voice?.apply?.(line, { mood: state?.mood ?? 'neutral' }) ?? line; } catch {}
      line = line.slice(0, 100);
      try {
        if (to) bot.chat(`/msg ${to} ${line}`.slice(0, 256));
        else bot.chat(line);
      } catch (e) { return fail('chat_failed', { msg: e.message }); }
      sent.push(Date.now());
      log?.info?.('agent_say', { to: to ?? null, text: line });
      return ok({ said: line, to: to ?? 'public' });
    },
  };

  const command = {
    name: 'command',
    description: 'Run a server slash command and return what the server replied within ~1.5 s. Examples: kit starter, sethome, home, spawn, balance, baltop, sell hand, f create <name>, f who, f map, msg <player> <text>. Do not include the leading slash.',
    input_schema: {
      type: 'object',
      properties: { cmd: { type: 'string', maxLength: 200 } },
      required: ['cmd'], additionalProperties: false,
    },
    parallelSafe: false,
    async handler({ cmd }) {
      const clean = String(cmd ?? '').replace(/^\//, '').trim();
      if (!clean) return fail('empty');
      const replies = [];
      const onMsg = (msg) => { try { const s = String(msg ?? '').trim(); if (s) replies.push(s.slice(0, 200)); } catch {} };
      bot.on('messagestr', onMsg);
      try {
        bot.chat(`/${clean}`.slice(0, 256));
        await new Promise((r) => setTimeout(r, 1500));
      } catch (e) {
        bot.removeListener('messagestr', onMsg);
        return fail('command_failed', { msg: e.message });
      }
      bot.removeListener('messagestr', onMsg);
      log?.info?.('agent_command', { cmd: clean, replies: replies.slice(0, 4) });
      const denied = replies.some((r) => /do not have access|no permission|unknown command/i.test(r));
      if (/^sethome\b/.test(clean) && !denied && state) state.home = roundedPos(bot);
      return ok({ cmd: clean, replies: replies.slice(0, 6), denied });
    },
  };

  return [say, command];
}

function roundedPos(bot) {
  const p = bot.entity?.position;
  return p ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } : null;
}
