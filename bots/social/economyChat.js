/**
 * economyChat — parse server chat for economy feedback and feed it into the
 * bot's state. The server grants `/sell hand`, `/balance`, and `/baltop`;
 * mineflayer already surfaces every line via `bot.on('messagestr')`, but
 * nothing read them, so sells never updated the balance, ACCUMULATE_MONEY
 * never progressed, and the sell verifier couldn't confirm.
 *
 * Three signals:
 *   • sell echo   → emit a LOCAL `economy_transaction` (recipient = me, +amount)
 *                   so factions (balance), projects (ACCUMULATE_MONEY) and
 *                   social (mood/relationships) all react via existing wiring.
 *   • /balance    → factions.setBalance(amount)  — ground truth, overrides the
 *                   running tally between polls.
 *   • /baltop     → worldModel.setBaltop({ rank })  — drives the wealth goal.
 *
 * The regexes are deliberately tolerant and EXPORTED so formats can be tuned
 * after observing real server output (every parse is logged).
 */

const num = (s) => Number(String(s).replace(/[,\s]/g, ''));

// Tune these against the live server's message formats.
export const ECONOMY_PATTERNS = {
  // "Sold 64 Wheat for $320.00 (5.00 each)" / "You sold ... for $320"
  sell: /\bsold\b[^$]*\$\s*([\d,]+(?:\.\d+)?)/i,
  // "Balance: $5,000.00" / "Your balance is $5000"
  balance: /\bbal(?:ance)?\b[^$]*\$\s*([\d,]+(?:\.\d+)?)/i,
  // Own line in /baltop output: "#3 MyName $5,000" / "3. MyName ..."
  baltopSelfRank: null,    // built per-username in parseEconomyMessage
  // "You are ranked #3" / "Your rank: 3"
  baltopRanked: /\brank(?:ed)?\b[^#\d]*#?\s*(\d+)/i,
};

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Parse one chat line. Returns one of:
 *   { kind:'sell',    amount:Number }
 *   { kind:'balance', amount:Number }
 *   { kind:'baltop',  rank:Number }
 *   null
 * Sell is checked first so a "sold … for $" line is never mis-read as balance.
 */
export function parseEconomyMessage(text, { username = null } = {}) {
  if (!text) return null;
  // Strip Minecraft section-sign color codes defensively.
  const clean = String(text).replace(/§./g, '').trim();

  let m = ECONOMY_PATTERNS.sell.exec(clean);
  if (m) return { kind: 'sell', amount: num(m[1]) };

  m = ECONOMY_PATTERNS.balance.exec(clean);
  if (m) return { kind: 'balance', amount: num(m[1]) };

  if (username) {
    const selfRe = new RegExp(`#?\\s*(\\d+)[).\\s]+${escapeRe(username)}\\b`, 'i');
    m = selfRe.exec(clean);
    if (m) return { kind: 'baltop', rank: Number(m[1]) };
  }
  m = ECONOMY_PATTERNS.baltopRanked.exec(clean);
  if (m) return { kind: 'baltop', rank: Number(m[1]) };

  return null;
}

/**
 * Wire the parser to a live bot. Returns a detach() function.
 *   attachEconomyChat({ bot, bus, factions, worldModel, profile, log })
 */
export function attachEconomyChat({ bot, bus = null, factions = null, worldModel = null, profile = null, log = null }) {
  if (!bot?.on) return () => {};
  const me = profile?.username ?? bot.username ?? null;

  const onMsg = (msg) => {
    const text = typeof msg?.toString === 'function' ? msg.toString() : String(msg ?? '');
    let parsed;
    try { parsed = parseEconomyMessage(text, { username: me }); }
    catch { return; }
    if (!parsed) return;

    if (parsed.kind === 'sell' && parsed.amount > 0) {
      log?.info?.('economy_sell_parsed', { amount: parsed.amount });
      // Local-only economy_transaction: reuse existing consumers (factions
      // balance, projects ACCUMULATE_MONEY, mood). recipient = me so the
      // projects matcher (recipient===me && amount>0) fires.
      try {
        bus?.emitLocal?.({
          event: 'economy_transaction',
          player: me, recipient: me,
          amount: parsed.amount, reason: 'sell:hand',
          ts: Date.now(),
        });
      } catch (e) { log?.debug?.('economy_emit_err', { msg: e.message }); }
    } else if (parsed.kind === 'balance') {
      log?.info?.('economy_balance_parsed', { balance: parsed.amount });
      try { factions?.setBalance?.(parsed.amount); } catch (e) { log?.debug?.('economy_setbal_err', { msg: e.message }); }
    } else if (parsed.kind === 'baltop') {
      log?.info?.('economy_baltop_parsed', { rank: parsed.rank });
      try { worldModel?.setBaltop?.({ rank: parsed.rank, ts: Date.now() }); }
      catch (e) { log?.debug?.('economy_baltop_err', { msg: e.message }); }
    }
  };

  bot.on('messagestr', onMsg);
  return () => { try { bot.removeListener('messagestr', onMsg); } catch {} };
}
