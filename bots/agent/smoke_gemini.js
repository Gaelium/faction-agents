#!/usr/bin/env node
/**
 * smoke_gemini.js — one real round trip through the Gemini adapter:
 * a tool call, a tool result, a final answer. Needs GEMINI_API_KEY.
 *
 *   node --env-file=.env bots/agent/smoke_gemini.js [model]
 */
import { ModelClient } from './model.js';

const model = process.argv[2] ?? process.env.AGENT_MODEL ?? 'gemini-3.8-flash';
const client = new ModelClient({ model, effort: 'low', log: { info: (e, f) => console.log(e, JSON.stringify(f)), warn: (e, f) => console.warn(e, JSON.stringify(f)) } });
const tools = [{ name: 'look', description: 'Look around: returns your position and what is near.', input_schema: { type: 'object', properties: { radius: { type: 'integer', minimum: 1, maximum: 32, default: 8 } }, additionalProperties: false } }];
const messages = [{ role: 'user', content: [{ type: 'text', text: 'You just logged in. Look around, then tell me in one short sentence where you are.' }] }];
const t1 = await client.turn({ system: 'You are a Minecraft player. Use the look tool before answering.', tools, messages });
console.log('turn 1 stop:', t1.response.stop_reason, 'blocks:', t1.response.content.map((b) => b.type).join(','), 'usd:', t1.usd);
const call = t1.response.content.find((b) => b.type === 'tool_use');
if (!call) { console.log('the model did not call the tool; reply:', t1.response.content.find((b) => b.type === 'text')?.text); process.exit(2); }
messages.push({ role: 'assistant', content: t1.response.content });
messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify({ status: 'ok', pos: { x: 512, y: 64, z: 220 }, nearby_blocks: ['grass', 'oak_log'], mobs: ['cow 6b N'] }) }, { type: 'text', text: '[now] pos 512,64,220 · hp 20/20 · day' }] });
const t2 = await client.turn({ system: 'You are a Minecraft player. Use the look tool before answering.', tools, messages });
console.log('turn 2 stop:', t2.response.stop_reason, 'reply:', t2.response.content.find((b) => b.type === 'text')?.text ?? '(none)', 'usd:', t2.usd);
console.log('total usd for the round trip:', client.totals.usd, '| thinking rejected:', !!client.gemini?._thinkingRejected);
