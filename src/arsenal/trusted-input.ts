/**
 * Trusted input (P16) — gestures that SPAs verify with `event.isTrusted`.
 *
 * CDP `Input.dispatchMouseEvent` goes through the real input pipeline, so
 * the resulting DOM events are trusted — unlike `el.click()` or synthetic
 * dispatchEvent, which anti-fraud code (Gemini uploads, payment widgets)
 * rejects. If the backend cannot dispatch, the caller gets a typed
 * failure, never a fake success.
 */

export interface Transport {
  send(method: string, params?: Record<string, any>): Promise<any>;
}

export interface TrustedClickOptions {
  selector: string;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
}

export type TrustedResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'dispatch_failed'; detail?: string };

/** Compute the click point (element center, in viewport coordinates). */
export function buildClickPointScript(selector: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;
}

export async function trustedClick(transport: Transport, opts: TrustedClickOptions): Promise<TrustedResult> {
  const point = await transport.send('Runtime.evaluate', {
    expression: buildClickPointScript(opts.selector),
    returnByValue: true,
  }).catch(() => null);
  const p = point?.result?.value;
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') {
    return { ok: false, reason: 'not_found', detail: `Element not found or not visible: ${opts.selector}` };
  }

  const button = opts.button ?? 'left';
  const clickCount = opts.clickCount ?? 1;
  try {
    for (let i = 0; i < clickCount; i++) {
      await transport.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: p.x, y: p.y, button, clickCount: i + 1,
      });
      await transport.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: p.x, y: p.y, button, clickCount: i + 1,
      });
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: 'dispatch_failed', detail: e?.message ?? 'Input.dispatchMouseEvent failed' };
  }
}
