/**
 * Trusted file chooser (P16) — attach files the way SPAs accept them.
 *
 * Path A (selector IS an <input type=file>): DOM.setFileInputFiles —
 * trusted by design (simulates user selection, no dialog needed).
 *
 * Path B (selector is a trigger button): Page.setInterceptFileChooserDialog
 * → trustedClick the trigger → Page.fileChooserOpened → setFileInputFiles
 * with the backendNodeId from the event.
 *
 * If the backend lacks any step (no Page file chooser intercept, no DOM
 * domain, no event channel), the result is a typed capability failure —
 * never a fake success (P16 hard rule).
 */

import { trustedClick } from './trusted-input.js';
import type { Transport } from './trusted-input.js';

export interface FileChooserDeps {
  send: Transport['send'];
  /** CDP event subscription, if the backend supports it (required for path B). */
  on?: (event: string, handler: (params: any) => void) => () => void;
}

export type FileChooserResult =
  | { ok: true; path: 'direct' | 'chooser'; filesAttached: number }
  | { ok: false; code: 'YJ.ACT.DOM_TARGET_NOT_FOUND' | 'YJ.PROTOCOL.CAPABILITY_MISSING'; detail: string };

export function buildIsFileInputScript(selector: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  return { tag: el.tagName, type: (el.getAttribute('type') || '').toLowerCase() };
})()`;
}

export async function trustedFileChooser(
  deps: FileChooserDeps,
  opts: { selector: string; files: string[]; timeoutMs?: number },
): Promise<FileChooserResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;

  // What kind of element is the selector?
  const info = await deps.send('Runtime.evaluate', {
    expression: buildIsFileInputScript(opts.selector),
    returnByValue: true,
  }).catch(() => null);
  const el = info?.result?.value;
  if (!el) {
    return { ok: false, code: 'YJ.ACT.DOM_TARGET_NOT_FOUND', detail: `Element not found: ${opts.selector}` };
  }

  // ─── Path A: direct file input ──────────────────────────────
  if (el.tag === 'INPUT' && el.type === 'file') {
    try {
      const doc = await deps.send('DOM.getDocument', { depth: 1 });
      const rootId = doc?.root?.nodeId;
      const q = await deps.send('DOM.querySelector', { nodeId: rootId, selector: opts.selector });
      const nodeId = q?.nodeId;
      if (!nodeId) {
        return { ok: false, code: 'YJ.ACT.DOM_TARGET_NOT_FOUND', detail: `File input not in DOM domain: ${opts.selector}` };
      }
      await deps.send('DOM.setFileInputFiles', { nodeId, files: opts.files });
      return { ok: true, path: 'direct', filesAttached: opts.files.length };
    } catch (e: any) {
      return { ok: false, code: 'YJ.PROTOCOL.CAPABILITY_MISSING', detail: `DOM.setFileInputFiles unsupported: ${e?.message ?? e}` };
    }
  }

  // ─── Path B: trigger button + file chooser intercept ────────
  if (!deps.on) {
    return { ok: false, code: 'YJ.PROTOCOL.CAPABILITY_MISSING', detail: 'Backend has no CDP event channel for fileChooserOpened' };
  }
  let unsub: (() => void) | undefined;
  try {
    await deps.send('Page.enable').catch(() => {});
    await deps.send('Page.setInterceptFileChooserDialog', { enabled: true });
  } catch (e: any) {
    return { ok: false, code: 'YJ.PROTOCOL.CAPABILITY_MISSING', detail: `Page.setInterceptFileChooserDialog unsupported: ${e?.message ?? e}` };
  }

  try {
    const chooserOpened = new Promise<any>((resolve) => {
      unsub = deps.on!('Page.fileChooserOpened', (params: any) => resolve(params));
    });
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));

    const click = await trustedClick({ send: deps.send }, { selector: opts.selector });
    if (!click.ok) {
      return { ok: false, code: 'YJ.ACT.DOM_TARGET_NOT_FOUND', detail: click.detail ?? 'Trigger not clickable' };
    }

    const event = await Promise.race([chooserOpened, timeout]);
    if (!event) {
      return { ok: false, code: 'YJ.PROTOCOL.CAPABILITY_MISSING', detail: `No fileChooserOpened within ${timeoutMs}ms after trusted click` };
    }
    const backendNodeId = event.backendNodeId;
    if (!backendNodeId) {
      return { ok: false, code: 'YJ.PROTOCOL.CAPABILITY_MISSING', detail: 'fileChooserOpened without backendNodeId' };
    }
    await deps.send('DOM.setFileInputFiles', { backendNodeId, files: opts.files });
    return { ok: true, path: 'chooser', filesAttached: opts.files.length };
  } catch (e: any) {
    return { ok: false, code: 'YJ.PROTOCOL.CAPABILITY_MISSING', detail: e?.message ?? 'file chooser flow failed' };
  } finally {
    try { unsub?.(); } catch {}
    try { await deps.send('Page.setInterceptFileChooserDialog', { enabled: false }); } catch {}
  }
}
