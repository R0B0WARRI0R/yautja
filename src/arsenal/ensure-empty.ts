/**
 * ensureEmpty (P11) — framework-compatible input clearing.
 *
 * The algorithm runs as a single in-page script (atomic from the agent's
 * point of view, no CDP round-trips between read/clean/verify):
 *
 *   auto (default):
 *     1. Triple-check read (value / innerText / textContent).
 *     2. If clean → done (wasClean).
 *     3. selectNodeContents|el.select() + execCommand('delete') + InputEvent.
 *     4. Re-check. If still dirty → force (native value setter / innerHTML='')
 *        as last resort, + InputEvent.
 *   execCommand: only step 3. selectAll: alias of execCommand (selection-based).
 *   force: only the force path.
 *
 * The script is exported so tests can execute it against a fake DOM.
 */

export interface Transport {
  send(method: string, params?: Record<string, any>): Promise<any>;
}

export type EnsureEmptyStrategy = 'auto' | 'execCommand' | 'selectAll' | 'force';

import { REDACTED_VALUE } from '../vision/redaction.js';

export interface EnsureEmptyResult {
  found: boolean;
  wasClean: boolean;
  afterClean: boolean;
  strategyUsed: string;
  selectorResolved: string;
  /**
   * Residual content found before cleaning (truncated to 500 chars).
   * Sensitive fields (password/hidden/OTP/CC autocomplete) are replaced
   * by REDACTED_VALUE — never the real value.
   */
  residual: string;
}

export function buildEnsureEmptyScript(selector: string, strategy: EnsureEmptyStrategy): string {
  return `(() => {
  const sel = ${JSON.stringify(selector)};
  const strategy = ${JSON.stringify(strategy)};
  const el = document.querySelector(sel);
  if (!el) return JSON.stringify({ found: false });
  // Sensitive-field detector — keep in sync with src/vision/redaction.ts.
  // The residual (previous content) must never leak a password/OTP/CC value.
  const sensitive = (() => {
    const t = String(el.type || (el.getAttribute ? el.getAttribute('type') : '') || '').toLowerCase();
    if (t === 'password' || t === 'hidden') return true;
    const ac = String((el.getAttribute ? el.getAttribute('autocomplete') : '') || '').toLowerCase();
    if (!ac) return false;
    const tokens = ['current-password','new-password','one-time-code','cc-number','cc-csc','cc-exp','cc-exp-month','cc-exp-year'];
    return tokens.some((tok) => ac.indexOf(tok) !== -1);
  })();
  const isCE = () => el.isContentEditable || el.getAttribute('contenteditable') === 'true';
  const read = () => {
    if (isCE()) return (el.innerText || el.textContent || '');
    if (el.value !== undefined) return String(el.value);
    return (el.textContent || '');
  };
  const fireInput = () => {
    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    } catch (e) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  const before = read();
  const wasClean = before.trim() === '';
  if (wasClean) return JSON.stringify({ found: true, wasClean: true, afterClean: true, strategyUsed: 'none', residual: '', sensitive });
  let strategyUsed = 'none';
  const tryExecCommand = () => {
    try { el.focus(); } catch (e) {}
    try {
      if (isCE()) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(range);
      } else if (el.select) {
        el.select();
      }
    } catch (e) {}
    document.execCommand('delete');
    fireInput();
    strategyUsed = 'execCommand';
  };
  const tryForce = () => {
    if (isCE()) {
      el.innerHTML = '';
      el.textContent = '';
    } else if (el.value !== undefined) {
      // React-compatible: use the native value setter so framework
      // state picks up the change via the input event.
      let proto = null;
      try {
        proto = (typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement)
          ? HTMLTextAreaElement.prototype
          : (typeof HTMLInputElement !== 'undefined' ? HTMLInputElement.prototype : null);
      } catch (e) {}
      const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
      if (desc && desc.set) desc.set.call(el, ''); else el.value = '';
    } else {
      el.textContent = '';
    }
    fireInput();
    strategyUsed = 'force';
  };
  if (strategy === 'force') {
    tryForce();
  } else {
    tryExecCommand();
    if (strategy === 'auto' && read().trim() !== '') tryForce();
  }
  const after = read();
  return JSON.stringify({
    found: true,
    wasClean: false,
    afterClean: after.trim() === '',
    strategyUsed,
    // Redact in-page too: a sensitive residual must not even cross the
    // Runtime.evaluate boundary. Keep in sync with REDACTED_VALUE in
    // src/vision/redaction.ts.
    residual: sensitive ? '[value redacted]' : before.slice(0, 500),
    sensitive,
  });
})()`;
}

export async function ensureEmpty(
  transport: Transport,
  selector: string,
  strategy: EnsureEmptyStrategy = 'auto',
): Promise<EnsureEmptyResult> {
  const r = await transport.send('Runtime.evaluate', {
    expression: buildEnsureEmptyScript(selector, strategy),
    returnByValue: true,
  });
  const raw = r?.result?.value;
  if (typeof raw !== 'string' || raw === '') {
    return { found: false, wasClean: false, afterClean: false, strategyUsed: 'none', selectorResolved: selector, residual: '' };
  }
  try {
    const parsed = JSON.parse(raw);
    // Fuga evitada: si el campo es sensible (password/hidden/autocomplete
    // de password/OTP/tarjeta), el residual nunca sale en claro.
    const residual = parsed.sensitive === true
      ? REDACTED_VALUE
      : typeof parsed.residual === 'string'
        ? parsed.residual
        : '';
    return {
      found: !!parsed.found,
      wasClean: !!parsed.wasClean,
      afterClean: !!parsed.afterClean,
      strategyUsed: parsed.strategyUsed ?? 'none',
      selectorResolved: selector,
      residual,
    };
  } catch {
    return { found: false, wasClean: false, afterClean: false, strategyUsed: 'none', selectorResolved: selector, residual: '' };
  }
}
