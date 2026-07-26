/**
 * Type transaction (P11) — begin → write → verify → optional submit → commit|rollback.
 *
 * Orchestration returns the ExecResult shape consumed by the doctrine
 * RecoveryMachine (`{ value } | { error }`); the RecoveryMachine owns
 * retries, the envelope, and state-integrity bookkeeping. This module owns
 * the input-specific steps:
 *
 *   PREFLIGHT  anti-retry block check + ensureEmpty (clearFirst)
 *   EXECUTE    CE: execCommand('insertText') one-shot
 *              input: focus + Input.insertText one-shot, or stealth key
 *              events only when text is short (<= STEALTH_CHAR_LIMIT) —
 *              char-by-char at 30-150ms jitter is unviable for 2-8k prompts
 *   VERIFY     DOM read-back must equal the typed text (before submit —
 *              chat UIs clear the box on submit)
 *   SUBMIT     Enter (page KeyboardEvent for CE, CDP key events for input)
 *   ROLLBACK   ensureEmpty + failure recorded → YJ.ACT.TYPE_PARTIAL
 *   COMMIT     retry block cleared
 *
 * Anti blind-retry rule: a recent TYPE_PARTIAL on (tabId, selector) blocks
 * a new type ONLY when the caller skips ensureEmpty (clearFirst: false).
 * With clearFirst on (default) the box is cleaned first, so the doctrine
 * retry loop is allowed to run.
 */

import { ensureEmpty } from './ensure-empty.js';
import type { InputSessionMemory } from '../memory/input-session.js';

export interface Transport {
  send(method: string, params?: Record<string, any>): Promise<any>;
}

export const STEALTH_CHAR_LIMIT = 80;
export const SUBMIT_EFFECT_WAIT_MS = 300;

export interface TypeTxDeps {
  transport: Transport;
  inputSession: InputSessionMemory;
  tabId: number;
}

export interface TypeTxOptions {
  selector: string;
  text: string;
  submit: boolean;
  stealth: boolean;
  transactional: boolean;
  verify: boolean;
  clearFirst: boolean;
  onPartial: 'rollback' | 'leave' | 'error';
  isContentEditable: boolean;
}

export interface TypeTxResult {
  selector: string;
  typed: boolean;
  verified: boolean;
  submitted: boolean;
  rolledBack: boolean;
  stealthUsed: boolean;
  cleaned: boolean;
}

export type TypeTxExecResult =
  | { value: TypeTxResult }
  | { error: { code: string; message?: string } };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readInputValue(transport: Transport, sel: string): Promise<string | null> {
  const r = await transport.send('Runtime.evaluate', {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') return el.innerText || el.textContent || ''; return el.value !== undefined ? String(el.value) : (el.textContent || ''); })()`,
    returnByValue: true,
  });
  const v = r?.result?.value;
  return typeof v === 'string' ? v : null;
}

async function typeContentEditable(transport: Transport, sel: string, text: string): Promise<boolean> {
  const r = await transport.send('Runtime.evaluate', {
    expression: `(async () => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'no element'; el.focus(); await new Promise(r => setTimeout(r, 50)); document.execCommand('insertText', false, ${JSON.stringify(text)}); return 'ok'; })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  return r?.result?.value === 'ok';
}

async function typeInput(transport: Transport, sel: string, text: string, stealth: boolean): Promise<boolean> {
  const focus = await transport.send('Runtime.evaluate', {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.focus(); return document.activeElement === el; })()`,
    returnByValue: true,
  });
  if (!focus?.result?.value) return false;
  if (stealth) {
    for (const char of text) {
      const keyCode = char.charCodeAt(0);
      const key = char === ' ' ? 'Space' : char;
      await transport.send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: char, windowsVirtualKeyCode: keyCode });
      await transport.send('Input.dispatchKeyEvent', { type: 'keyUp', key, text: char, windowsVirtualKeyCode: keyCode });
      await sleep(30 + Math.random() * 120);
    }
  } else {
    // One-shot insert: viable for long prompts, unlike char-by-char.
    await transport.send('Input.insertText', { text });
  }
  return true;
}

async function submitContentEditable(transport: Transport, sel: string): Promise<boolean> {
  const r = await transport.send('Runtime.evaluate', {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',code:'Enter',keyCode:13,which:13,charCode:13,bubbles:true,cancelable:true,composed:true})); return true; })()`,
    returnByValue: true,
  });
  return r?.result?.value === true;
}

async function submitInput(transport: Transport): Promise<boolean> {
  await transport.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13 });
  await transport.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
  return true;
}

export async function runTypeTransaction(deps: TypeTxDeps, opts: TypeTxOptions): Promise<TypeTxExecResult> {
  const { transport, inputSession, tabId } = deps;
  const sel = opts.selector;

  // PREFLIGHT: anti blind-retry — only blocks when the caller skips the clean.
  if (opts.transactional && !opts.clearFirst && inputSession.isBlocked(tabId, sel)) {
    return {
      error: {
        code: 'YJ.ACT.TYPE_RETRY_BLOCKED',
        message: `Retry blocked for ${sel}: TYPE_PARTIAL within the last 30s. Call ensureEmpty first (or reload the tab).`,
      },
    };
  }

  // PREFLIGHT: ensureEmpty
  let cleaned = false;
  if (opts.clearFirst) {
    const clean = await ensureEmpty(transport, sel, 'auto');
    if (!clean.found) {
      return { error: { code: 'YJ.ACT.DOM_TARGET_NOT_FOUND', message: `Element not found: ${sel}` } };
    }
    if (!clean.afterClean) {
      inputSession.recordFailure(tabId, sel, 'YJ.ACT.INPUT_NOT_CLEARABLE');
      return { error: { code: 'YJ.ACT.INPUT_NOT_CLEARABLE', message: `Input still has residual content after auto clean: ${sel}` } };
    }
    cleaned = !clean.wasClean;
  }

  // EXECUTE
  const stealthUsed = opts.stealth && !opts.isContentEditable && opts.text.length <= STEALTH_CHAR_LIMIT;
  const typeOk = opts.isContentEditable
    ? await typeContentEditable(transport, sel, opts.text)
    : await typeInput(transport, sel, opts.text, stealthUsed);
  if (!typeOk) {
    inputSession.recordFailure(tabId, sel, 'YJ.ACT.TYPE_REJECTED');
    return { error: { code: 'YJ.ACT.TYPE_REJECTED', message: `Element rejected typed input: ${sel}` } };
  }

  // VERIFY (before submit — chat UIs clear the box on submit)
  let verified = false;
  let rolledBack = false;
  if (opts.verify) {
    verified = (await readInputValue(transport, sel))?.trim() === opts.text.trim();
    if (!verified && opts.onPartial !== 'leave') {
      if (opts.onPartial === 'rollback') {
        const rb = await ensureEmpty(transport, sel, 'auto');
        rolledBack = rb.afterClean;
      }
      inputSession.recordFailure(tabId, sel, 'YJ.ACT.TYPE_PARTIAL');
      return {
        error: {
          code: 'YJ.ACT.TYPE_PARTIAL',
          message: `DOM does not contain the typed text after write on ${sel}${rolledBack ? ' (rolled back)' : ''}.`,
        },
      };
    }
  }

  // SUBMIT
  let submitted = false;
  if (opts.submit) {
    submitted = opts.isContentEditable
      ? await submitContentEditable(transport, sel)
      : await submitInput(transport);
    if (submitted && opts.verify && opts.text.trim() !== '') {
      await sleep(SUBMIT_EFFECT_WAIT_MS);
      const after = await readInputValue(transport, sel);
      if (after !== null && after.trim() === opts.text.trim()) {
        return {
          error: {
            code: 'YJ.ACT.SUBMIT_NO_EFFECT',
            message: 'Enter had no observable effect; input still contains the typed text. Use findClick on the send button.',
          },
        };
      }
    }
  }

  // COMMIT
  inputSession.clear(tabId, sel);
  return { value: { selector: sel, typed: true, verified, submitted, rolledBack, stealthUsed, cleaned } };
}
