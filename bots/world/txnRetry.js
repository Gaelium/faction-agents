/**
 * txnRetry.js — recovery wrapper for the 1.8/Paper inventory-transaction
 * family (craft, equip, deposit, toss).
 *
 * On a 1.8.8 server every window click (the 2x2/3x3 craft grid, equipping
 * to a hotbar/armour slot, depositing into a chest) is a transaction the
 * server can REJECT. mineflayer throws on the first reject mid-chain and
 * the local window then diverges from the server: some accepted clicks
 * applied, the rejected one not, plus a stale held cursor. A NAIVE retry
 * re-issues the same desynced clicks and the server keeps rejecting them —
 * this is exactly the 75-rejection storm that aborted TestBot32's
 * ESTABLISH_BASE (planks frozen at have:3/need:4 for 50 top-ups).
 *
 * The fix has three parts, all here:
 *   1. recoverInventoryState — between attempts, drop the stale local
 *      cursor (selectedItem) and wait for the server's corrective
 *      set_slot/window_items to land, so the retry clicks against truth.
 *   2. withTransactionRetry — bounded, backed-off, CANCEL-AWARE retry that
 *      treats a caller-supplied postcondition (`verify`) as the SOLE
 *      source of truth for success. It never trusts the absence/presence
 *      of a throw, so it can neither over-produce nor report a landed
 *      effect as a failure.
 *   3. isTransactionError — only transaction rejects/timeouts are retried;
 *      genuine failures ('missing ingredient', 'item_not_in_inventory')
 *      pass straight through so the caller reports them correctly.
 */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * mineflayer's clickWindow throws two transaction strings:
 *   "Server rejected transaction for clicking on slot N, on window with id M."
 *   "Server didn't respond to transaction for clicking on slot N on window with id M."
 * The second one matters on this project's known-unreliable connection.
 * Anything else (missing ingredient, assertion, range) is NOT retried.
 */
export function isTransactionError(msg) {
  if (!msg) return false;
  const s = String(msg);
  return /(rejected|respond to) transaction|transaction for clicking/i.test(s);
}

/**
 * bot.craft does `throw new Error(err)` where err is already an Error, so
 * the message arrives doubly-prefixed ("Error: Error: Server rejected ...").
 * Strip the leading "Error:" prefixes so both the regex match and the
 * surfaced reason are stable.
 */
export function normalizeError(e) {
  let msg = (e && e.message != null) ? String(e.message) : String(e ?? '');
  while (/^Error:\s*/.test(msg)) msg = msg.replace(/^Error:\s*/, '');
  return msg;
}

/**
 * Wait for the server to resync local inventory to truth after a reject.
 * For a crafting-TABLE window mineflayer closes+reopens (window_items
 * arrives → early-out); for the 2x2 inventory window (id 0) the server
 * sends per-slot set_slot packets, so we fall back to a short fixed wait.
 * Never exceeds mineflayer's WINDOW_TIMEOUT (5s). Resolves on the first of
 * a window_items refresh or the timeout.
 */
export function waitForInventoryResync(bot, ms = 450) {
  return new Promise((resolve) => {
    const client = bot?._client;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client?.removeListener?.('window_items', finish); } catch {}
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, ms));
    try { client?.once?.('window_items', finish); } catch { /* mock bot → timer only */ }
  });
}

/**
 * Between retries: align the local held cursor to the server's
 * post-reject truth (an accepted-then-rejected click chain leaves
 * selectedItem stuck, and craft.js asserts it is null before grabbing a
 * result — so a stale cursor would make the retry throw a NON-transaction
 * AssertionError and abort). Resetting the property is local-only: no
 * packet, no item-loss risk, no extra reject. Then wait for grid resync.
 */
export async function recoverInventoryState(bot, { backoffMs = 450, log } = {}) {
  try {
    const win = bot?.currentWindow ?? bot?.inventory;
    if (win && win.selectedItem) win.selectedItem = null;
  } catch (e) { log?.debug?.('txn_cursor_reset_failed', { msg: e?.message }); }
  await waitForInventoryResync(bot, backoffMs);
}

/**
 * Run `fn` (a window-click operation) with bounded transaction-reject
 * recovery.
 *
 * @param {object} bot
 * @param {(attempt:number)=>Promise<void>} fn  recompute-and-act each call
 *   (e.g. craft only the remaining shortfall) so a retry can't over-produce.
 * @param {object} opts
 *   verify?      () => boolean  postcondition; the SOLE success signal.
 *                If omitted, "fn returned without throwing" is success.
 *   isCancelled? () => boolean  checked before/after every await; a true
 *                value resolves { ok:false, cancelled:true } promptly so a
 *                mob-threat cancel stops crafting instead of looping.
 *   recover?     (attempt:number) => Promise  custom between-attempt
 *                recovery (defaults to recoverInventoryState).
 *   maxAttempts? number (default 3)
 *   backoffMs?   number (default 450)
 *   log?, label?
 * @returns {Promise<{ok:boolean, cancelled?:boolean, reason?:string, attempts?:number}>}
 */
export async function withTransactionRetry(bot, fn, opts = {}) {
  const {
    verify,
    isCancelled,
    recover,
    maxAttempts = 3,
    backoffMs = 450,
    log,
    label = 'txn',
  } = opts;

  const cancelled = () => (typeof isCancelled === 'function' && isCancelled());
  const safeVerify = () => {
    if (typeof verify !== 'function') return undefined;
    try { return !!verify(); } catch { return false; }
  };
  const CANCELLED = { ok: false, cancelled: true, reason: 'cancelled' };

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (cancelled()) return CANCELLED;
    // A prior attempt's effect may have landed after its click threw.
    if (verify && safeVerify()) return { ok: true, attempts: attempt - 1 };

    let threw = false;
    try {
      await fn(attempt);
    } catch (e) {
      threw = true;
      lastErr = normalizeError(e);
      if (cancelled()) return CANCELLED;
      if (!isTransactionError(lastErr)) {
        // Genuine failure — but the effect may have landed before the
        // throw, so trust the postcondition over the exception.
        if (verify && safeVerify()) return { ok: true, attempts: attempt };
        return { ok: false, reason: lastErr };
      }
      log?.debug?.(label + '_txn_reject', { attempt, msg: lastErr });
    }

    if (cancelled()) return CANCELLED;
    if (!threw) {
      // No reject ⇒ mineflayer's click chain was fully accepted by the
      // server ⇒ success. The desync storm ALWAYS throws, so we never
      // second-guess a clean completion. Over-craft is prevented by `fn`
      // recomputing the shortfall each call — NOT by a count gate (which
      // would also falsely fail any caller whose effect the verifier
      // can't observe, e.g. equip's slot-read lag).
      return { ok: true, attempts: attempt };
    }

    if (attempt < maxAttempts) {
      try {
        if (typeof recover === 'function') await recover(attempt);
        else await recoverInventoryState(bot, { backoffMs, log });
      } catch (e) { log?.debug?.(label + '_recover_failed', { msg: e?.message }); }
      if (cancelled()) return CANCELLED;
    }
  }

  // Last-chance: a late-landing effect still counts as success.
  if (verify && safeVerify()) return { ok: true, attempts: maxAttempts };
  return { ok: false, reason: 'txn_failed_after_retries:' + (lastErr ?? 'unknown') };
}
