/**
 * cancel.js — the one cancellation primitive every tool honors.
 *
 * A tool call gets a fresh CancelToken. The nerves layer (reflexes,
 * armed interrupts) cancels it with a reason; the running tool's
 * `onCancel` hook stops the underlying mineflayer handle, and the tool
 * returns `{ status: 'interrupted', by: reason }` so the brain sees
 * exactly why it lost the turn. Nothing else in the harness may start
 * an action while a token is live.
 */
export class CancelToken {
  constructor() {
    this.cancelled = false;
    this.reason = null;
    this.detail = null;
    this._fns = [];
  }

  cancel(reason = 'cancelled', detail = null) {
    if (this.cancelled) return;
    this.cancelled = true;
    this.reason = reason;
    this.detail = detail;
    for (const fn of this._fns) {
      try { fn(reason, detail); } catch { /* listener errors never block cancel */ }
    }
    this._fns = [];
  }

  /** Register a hook; fires immediately if already cancelled. Returns an unsubscribe. */
  onCancel(fn) {
    if (typeof fn !== 'function') return () => {};
    if (this.cancelled) {
      try { fn(this.reason, this.detail); } catch {}
      return () => {};
    }
    this._fns.push(fn);
    return () => {
      const i = this._fns.indexOf(fn);
      if (i >= 0) this._fns.splice(i, 1);
    };
  }

  get isCancelled() { return this.cancelled; }
}

/**
 * Await a `{ stop, done }` handle (the primitive/activity convention used
 * throughout tactical/ and building/) while honoring a CancelToken.
 * Resolves with whatever `done` resolved with; if the token fired first
 * the handle was stopped and the raw result carries reason 'cancelled'.
 */
export async function awaitHandle(handle, cancel) {
  if (!handle) return { success: false, reason: 'no_handle' };
  const off = cancel?.onCancel?.(() => { try { handle.stop?.(); } catch {} }) ?? (() => {});
  try {
    return await handle.done;
  } finally {
    off();
  }
}

/** Sleep that resolves early (with false) when the token cancels. */
export function cancellableSleep(ms, cancel) {
  return new Promise((resolve) => {
    if (cancel?.cancelled) return resolve(false);
    const timer = setTimeout(() => { off(); resolve(true); }, ms);
    const off = cancel?.onCancel?.(() => { clearTimeout(timer); resolve(false); }) ?? (() => {});
  });
}
