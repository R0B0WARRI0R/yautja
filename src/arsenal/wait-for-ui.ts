/**
 * waitForUi (P12) — declarative waits instead of blind sleeps.
 *
 * Shared engine used by:
 *   - the MCP `waitFor` tool (helmet, with real network activity from Thermal)
 *   - `act({type:'wait'})` legacy conditions (translator, transport-only)
 *   - `extractAnswer waitUntil:'settled'`
 *   - `smartType waitReady`
 *
 * Stateless predicates (selector, urlMatch, ariaBusy, noPulse, fn) are
 * evaluated each poll. Stateful predicates (textSettled, networkIdle) keep
 * their own tracker across polls:
 *   - textSettled matches when the text has not changed for `stableMs`
 *     (and meets `minLength`) — the "stream finished" signal.
 *   - networkIdle matches when the pending-request count has been 0 for
 *     `quietMs`. Without a `getPendingRequests` provider (translator
 *     legacy path) it degrades to a plain quietMs sleep — same behavior as
 *     the old stub, but explicit and documented.
 *   - streamSettled (P17 fase A) installs a 2-phase MutationObserver in the
 *     page ONCE (watch-stream.ts) and then only reads its published flag —
 *     moves the per-poll DOM-text snapshot work into the page; the motor
 *     itself pays only a cheap flag read per poll while the in-page
 *     observer + silence timer carry the cost.
 */

import { buildStreamWatchScript, STREAM_WATCH_READ_EXPR, parseStreamWatchState } from './watch-stream.js';

export interface Transport {
  send(method: string, params?: Record<string, any>): Promise<any>;
}

export type SubmitSignal =
  | { kind: 'ariaLabel'; value: string }
  | { kind: 'iconContains'; value: string }
  | { kind: 'classContains'; value: string }
  | { kind: 'disabled'; value: boolean };

export type WaitPredicate =
  | { type: 'selector'; selector: string; state?: 'attached' | 'visible' | 'hidden' | 'detached' }
  | { type: 'urlMatch'; pattern: string }
  | { type: 'ariaBusy'; root?: string; value: boolean }
  | { type: 'noPulse'; root?: string }
  | { type: 'networkIdle'; quietMs: number }
  | { type: 'textSettled'; selector: string; stableMs: number; minLength?: number }
  | { type: 'streamSettled'; selector: string; silenceMs: number; minLength?: number }
  | { type: 'fn'; expression: string }
  | { type: 'timeout'; ms: number }
  | {
      type: 'submitState';
      selector: string;
      state: 'idle' | 'streaming';
      signals: SubmitSignal[];
    };

export interface WaitForUiDeps {
  transport: Transport;
  getPendingRequests?: () => number;
}

export interface WaitForUiOptions {
  anyOf?: WaitPredicate[];
  allOf?: WaitPredicate[];
  timeoutMs?: number;
  pollMs?: number;
}

export interface WaitForUiResult {
  matched: 'anyOf' | 'allOf' | 'timeout';
  which?: number;
  elapsedMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Checker = () => Promise<boolean>;

async function evaluate(deps: WaitForUiDeps, expression: string): Promise<any> {
  try {
    const r = await deps.transport.send('Runtime.evaluate', { expression, returnByValue: true });
    return r?.result?.value;
  } catch {
    return undefined;
  }
}

function buildChecker(pred: WaitPredicate, deps: WaitForUiDeps, start: number): Checker {
  switch (pred.type) {
    case 'selector': {
      const state = pred.state ?? 'visible';
      const script = `(() => { const el = document.querySelector(${JSON.stringify(pred.selector)}); const st = ${JSON.stringify(state)}; if (st === 'attached') return !!el; if (st === 'detached') return !el; const vis = !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); if (st === 'visible') return vis; return !el || !vis; })()`;
      return async () => (await evaluate(deps, script)) === true;
    }
    case 'urlMatch': {
      let re: RegExp | null = null;
      try { re = new RegExp(pred.pattern); } catch { return async () => false; }
      return async () => {
        const href = await evaluate(deps, 'location.href');
        return typeof href === 'string' && re!.test(href);
      };
    }
    case 'ariaBusy': {
      const rootExpr = pred.root
        ? `document.querySelector(${JSON.stringify(pred.root)})`
        : 'document.body';
      const script = `(() => { const root = ${rootExpr}; if (!root) return null; return { rootBusy: root.getAttribute('aria-busy'), descendantBusy: !!root.querySelector('[aria-busy="true"]') }; })()`;
      return async () => {
        const v = await evaluate(deps, script);
        if (!v) return pred.value === false; // no root → treat as "not busy"
        const busy = v.rootBusy === 'true' || v.descendantBusy;
        return busy === pred.value;
      };
    }
    case 'noPulse': {
      const rootExpr = pred.root
        ? `document.querySelector(${JSON.stringify(pred.root)})`
        : 'document.body';
      const script = `(() => { const root = ${rootExpr}; if (!root) return true; if (root.classList && root.classList.contains('animate-pulse')) return false; return !root.querySelector('.animate-pulse'); })()`;
      return async () => (await evaluate(deps, script)) === true;
    }
    case 'networkIdle': {
      if (!deps.getPendingRequests) {
        // Legacy degradation: no activity provider → plain quiet sleep.
        let fired = false;
        return async () => {
          if (fired) return true;
          await sleep(pred.quietMs);
          fired = true;
          return true;
        };
      }
      let lastBusyAt = start;
      return async () => {
        const pending = deps.getPendingRequests!();
        const now = Date.now();
        if (pending > 0) {
          lastBusyAt = now;
          return false;
        }
        return now - lastBusyAt >= pred.quietMs;
      };
    }
    case 'textSettled': {
      const script = `(() => { const el = document.querySelector(${JSON.stringify(pred.selector)}); if (!el) return null; return el.innerText || el.textContent || (el.value !== undefined ? String(el.value) : '') || ''; })()`;
      let lastText: string | null = null;
      let lastChangeAt = start;
      const minLength = pred.minLength ?? 0;
      return async () => {
        const v = await evaluate(deps, script);
        const text = typeof v === 'string' ? v : '';
        const now = Date.now();
        if (text !== lastText) {
          lastText = text;
          lastChangeAt = now;
          return false;
        }
        if (text.length < Math.max(minLength, 1)) return false; // empty never "settles" (stream not started); use fn to wait for empty
        return now - lastChangeAt >= pred.stableMs;
      };
    }
    case 'fn': {
      return async () => {
        const v = await evaluate(deps, pred.expression);
        return !!v;
      };
    }
    case 'timeout': {
      let firedAt = 0;
      return async () => {
        if (firedAt === 0) firedAt = Date.now() + pred.ms;
        return Date.now() >= firedAt;
      };
    }
    case 'streamSettled': {
      const installScript = buildStreamWatchScript({
        selector: pred.selector,
        silenceMs: pred.silenceMs,
        minLength: pred.minLength,
      });
      let installed = false;
      return async () => {
        if (!installed) {
          // Install once: on success the page keeps its own observer running
          // and publishing to window.__yautjaStream; on failure (page not
          // ready yet) we retry on the next poll.
          const v = await evaluate(deps, installScript);
          if (!v || typeof v !== 'object') return false;
          installed = true;
        }
        const flag = await evaluate(deps, STREAM_WATCH_READ_EXPR);
        const st = parseStreamWatchState(flag);
        return !!st && st.armed && st.done;
      };
    }
    case 'submitState': {
      const signals = Array.isArray(pred.signals) ? pred.signals : [];
      const script = `(() => { const el = document.querySelector(${JSON.stringify(pred.selector)}); if (!el) return { found: false }; return { found: true, ariaLabel: el.getAttribute('aria-label') || null, innerHTML: el.innerHTML || '', className: typeof el.className === 'string' ? el.className : '', disabled: el.disabled !== undefined ? !!el.disabled : el.getAttribute('disabled') !== null }; })()`;
      return async () => {
        const v = await evaluate(deps, script);
        if (!v || !v.found) return false;
        return signals.some((s) => {
          switch (s.kind) {
            case 'ariaLabel': return v.ariaLabel === s.value;
            case 'iconContains': return (v.innerHTML || '').includes(s.value);
            case 'classContains': return (v.className || '').includes(s.value);
            case 'disabled': return v.disabled === s.value;
            default: return false;
          }
        });
      };
    }
  }
}

export async function waitForUi(deps: WaitForUiDeps, opts: WaitForUiOptions): Promise<WaitForUiResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const deadline = start + timeoutMs;

  const allOf = (opts.allOf ?? []).map((p) => buildChecker(p, deps, start));
  const anyOf = (opts.anyOf ?? []).map((p) => buildChecker(p, deps, start));

  // Vacuous case: no predicates → nothing to wait for.
  if (allOf.length === 0 && anyOf.length === 0) {
    return { matched: 'allOf', elapsedMs: 0 };
  }

  while (Date.now() < deadline) {
    if (allOf.length > 0) {
      let allOk = true;
      for (const check of allOf) {
        if (!(await check())) { allOk = false; break; }
      }
      if (allOk) return { matched: 'allOf', elapsedMs: Date.now() - start };
    }
    for (let i = 0; i < anyOf.length; i++) {
      if (await anyOf[i]!()) {
        return { matched: 'anyOf', which: i, elapsedMs: Date.now() - start };
      }
    }
    await sleep(pollMs);
  }
  return { matched: 'timeout', elapsedMs: Date.now() - start };
}
