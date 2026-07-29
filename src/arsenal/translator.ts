import type { Transport } from '../vision/base-sensor.js';
import type { BrowserAction, ActionResult, WaitCondition } from './action-types.js';
import { makeError } from './errors.js';
import { buildKeySequence } from './key-chords.js';
import { waitForUi } from './wait-for-ui.js';
import type { WaitPredicate } from './wait-for-ui.js';
import {
  MAX_BASE64_CHARS,
  buildZoomScript,
  isValidClip,
  isValidRegion,
  normalizeClip,
  planScreenshotAttempts,
} from './screenshot.js';
import { buildResolveRefScript } from '../vision/element-map.js';
import { buildFormInputScript, parseFormInputResult } from './form-input.js';

const DEFAULT_TIMEOUT = 30000;

function mapConditionToPredicate(condition: WaitCondition): WaitPredicate {
  switch (condition.kind) {
    case 'selector':
      return { type: 'selector', selector: condition.selector, state: condition.state ?? 'visible' };
    case 'networkIdle':
      return { type: 'networkIdle', quietMs: condition.idleTimeMs ?? 500 };
    case 'function':
      return { type: 'fn', expression: condition.fn };
    case 'ariaBusy':
      return { type: 'ariaBusy', root: condition.root, value: condition.value ?? false };
    case 'noPulse':
      return { type: 'noPulse', root: condition.root };
    case 'textSettled':
      return { type: 'textSettled', selector: condition.selector, stableMs: condition.stableMs, minLength: condition.minLength };
    case 'urlMatch':
      return { type: 'urlMatch', pattern: condition.pattern };
    default:
      // navigation/timeout are handled before reaching the engine
      return { type: 'timeout', ms: 0 };
  }
}

export class ActionTranslator {
  constructor(private transport: Transport) {}

  async execute(action: BrowserAction): Promise<ActionResult> {
    if (!action || typeof action !== 'object' || !action.type) {
      return errResult('INVALID_ARGUMENT', 'Action must be an object with a "type" field. Example: {type: "navigate", url: "..."}');
    }
    try {
      switch (action.type) {
        // ─── Navigation ───
        case 'navigate': {
          await this.transport.send('Page.navigate', { url: action.url });
          if (action.waitUntil !== 'load') {
            await this.waitForLoad(action.waitUntil ?? 'load');
          }
          return { ok: true };
        }
        case 'goBack':
          await this.transport.send('Page.navigate', { url: 'about:blank' }); // placeholder — real back needs history
          // Actually: use Runtime.evaluate('history.back()')
          await this.transport.send('Runtime.evaluate', { expression: 'history.back()' });
          return { ok: true };
        case 'goForward':
          await this.transport.send('Runtime.evaluate', { expression: 'history.forward()' });
          return { ok: true };
        case 'reload':
          await this.transport.send('Page.reload', { ignoreCache: action.ignoreCache ?? false });
          return { ok: true };

        // ─── Interaction ───
        case 'click':
        case 'doubleClick': {
          const count = action.type === 'doubleClick' ? 2 : action.clickCount ?? 1;
          const button = action.type === 'doubleClick' ? 'left' : action.button ?? 'left';
          let x = 0;
          let y = 0;
          if (action.ref) {
            const point = await this.resolveRef(action.ref);
            if (!point) return errResult('REF_NOT_FOUND', `ref not found or stale: ${action.ref}`);
            x = point.x;
            y = point.y;
          } else {
            if (!action.selector) return errResult('INVALID_ARGUMENT', 'click requires a selector or a ref');
            const node = await this.querySelector(action.selector);
            if (!node) return errResult('SELECTOR_NOT_FOUND', `Element not found: ${action.selector}`);
            await this.transport.send('DOM.focus', { nodeId: node });
          }
          for (let i = 0; i < count; i++) {
            await this.transport.send('Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x, y, button, clickCount: 1,
            });
            await this.transport.send('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x, y, button, clickCount: 1,
            });
          }
          return { ok: true };
        }
        case 'hover': {
          const node = await this.querySelector(action.selector);
          if (!node) return errResult('SELECTOR_NOT_FOUND', `Element not found: ${action.selector}`);
          await this.transport.send('DOM.focus', { nodeId: node });
          return { ok: true };
        }
        case 'focus': {
          if (action.ref) {
            const point = await this.resolveRef(action.ref, { focus: true });
            if (!point) return errResult('REF_NOT_FOUND', `ref not found or stale: ${action.ref}`);
            return { ok: true };
          }
          if (!action.selector) return errResult('INVALID_ARGUMENT', 'focus requires a selector or a ref');
          const node = await this.querySelector(action.selector);
          if (!node) return errResult('SELECTOR_NOT_FOUND', `Element not found: ${action.selector}`);
          await this.transport.send('DOM.focus', { nodeId: node });
          return { ok: true };
        }
        case 'type': {
          if (action.ref) {
            const point = await this.resolveRef(action.ref, { focus: true, clear: action.clearFirst });
            if (!point) return errResult('REF_NOT_FOUND', `ref not found or stale: ${action.ref}`);
          } else {
            if (!action.selector) return errResult('INVALID_ARGUMENT', 'type requires a selector or a ref');
            if (action.clearFirst) {
              await this.transport.send('Runtime.evaluate', {
                expression: `(function(){var el=document.querySelector(${JSON.stringify(action.selector)});if(el){el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));}})()`,
              });
            }
            const node = await this.querySelector(action.selector);
            if (!node) return errResult('SELECTOR_NOT_FOUND', `Element not found: ${action.selector}`);
            await this.transport.send('DOM.focus', { nodeId: node });
          }

          if (action.stealth) {
            for (const char of action.text) {
              const keyCode = char.charCodeAt(0);
              const text = char;
              const key = char === ' ' ? 'Space' : char;
              await this.transport.send('Input.dispatchKeyEvent', {
                type: 'keyDown', key, text, windowsVirtualKeyCode: keyCode,
              });
              await this.transport.send('Input.dispatchKeyEvent', {
                type: 'keyUp', key, text, windowsVirtualKeyCode: keyCode,
              });
              const jitter = 30 + Math.random() * 120;
              await sleep(jitter);
            }
          } else {
            const delay = action.delayMs ?? 0;
            for (const char of action.text) {
              await this.transport.send('Input.insertText', { text: char });
              if (delay > 0) await sleep(delay);
            }
          }
          return { ok: true };
        }
        case 'press': {
          let events;
          try {
            events = buildKeySequence(action.key, action.modifiers);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return errResult('INVALID_ARGUMENT', msg);
          }
          for (const ev of events) {
            await this.transport.send('Input.dispatchKeyEvent', ev);
          }
          return { ok: true };
        }
        case 'select': {
          const js = `(function(){var el=document.querySelector(${JSON.stringify(action.selector)});if(!el)return false;el.value=${JSON.stringify(action.values[0] ?? '')};el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`;
          const result = await this.transport.send('Runtime.evaluate', { expression: js, returnByValue: true });
          if (!result?.result?.value) return errResult('SELECTOR_NOT_FOUND', `Select element not found: ${action.selector}`);
          return { ok: true };
        }
        case 'check': {
          const js = `(function(){var el=document.querySelector(${JSON.stringify(action.selector)});if(!el)return false;el.checked=${action.checked};el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`;
          const result = await this.transport.send('Runtime.evaluate', { expression: js, returnByValue: true });
          if (!result?.result?.value) return errResult('SELECTOR_NOT_FOUND', `Checkbox not found: ${action.selector}`);
          return { ok: true };
        }
        case 'form_input': {
          if (!action.selector && !action.ref) {
            return errResult(
              'INVALID_ARGUMENT',
              'form_input requires a selector or a ref',
              'Usa observe para localizar el campo y pasa su selector o su ref',
            );
          }
          const result = await this.transport.send('Runtime.evaluate', {
            expression: buildFormInputScript({ selector: action.selector, ref: action.ref, value: action.value }),
            returnByValue: true,
          });
          if (result?.exceptionDetails) {
            return errResult('JS_EVALUATION_ERROR', result.exceptionDetails.text || 'form_input evaluation failed');
          }
          const outcome = parseFormInputResult(result?.result?.value);
          if (!outcome.ok) {
            switch (outcome.error) {
              case 'REF_NOT_FOUND':
                return errResult('REF_NOT_FOUND', `ref not found or stale: ${action.ref}`);
              case 'NOT_FOUND':
                return errResult('SELECTOR_NOT_FOUND', `Element not found: ${action.selector ?? action.ref}`);
              case 'NOT_INPUT':
                return errResult(
                  'ELEMENT_NOT_INTERACTABLE',
                  'form_input target is not a form field (no value/contenteditable)',
                  'Usa observe para elegir un input, select, textarea o elemento contenteditable',
                );
              case 'BAD_VALUE':
                return errResult(
                  'INVALID_ARGUMENT',
                  `form_input on ${outcome.inputType} expects a ${outcome.expected} value, got ${typeof action.value}`,
                  `Pasa value como ${outcome.expected} para campos de tipo ${outcome.inputType}`,
                );
              case 'NO_OPTION':
                return errResult(
                  'INVALID_ARGUMENT',
                  `Option not found: ${JSON.stringify(action.value)}. Available: ${outcome.options.join(', ') || '(none)'}`,
                  'Usa uno de los values listados en "Available" o el texto visible exacto de la opción',
                );
            }
          }
          return { ok: true, value: outcome.value };
        }
        case 'scroll': {
          const amt = action.amount ?? 500;
          const dir = action.direction;
          const sel = action.selector ? JSON.stringify(action.selector) : 'null';
          const js = `(function(){var t=${sel}?document.querySelector(${sel}):window;t.scrollBy(${dir==='right'?amt:dir==='left'?-amt:0},${dir==='down'?amt:dir==='up'?-amt:0});})()`;
          await this.transport.send('Runtime.evaluate', { expression: js });
          return { ok: true };
        }

        // ─── JavaScript ───
        case 'evaluate': {
          const result = await this.transport.send('Runtime.evaluate', {
            expression: action.expression,
            returnByValue: action.returnByValue ?? true,
          });
          if (result?.exceptionDetails) {
            return errResult('JS_EVALUATION_ERROR', result.exceptionDetails.text || 'Evaluation failed');
          }
          return { ok: true, value: result?.result?.value };
        }
        case 'evaluateAsync': {
          const result = await this.transport.send('Runtime.evaluate', {
            expression: action.expression,
            awaitPromise: true,
            returnByValue: true,
          });
          if (result?.exceptionDetails) {
            return errResult('JS_EVALUATION_ERROR', result.exceptionDetails.text || 'Async evaluation failed');
          }
          return { ok: true, value: result?.result?.value };
        }

        // ─── Capture ───
        case 'screenshot': {
          if (action.clip !== undefined && !isValidClip(action.clip)) {
            return errResult('INVALID_ARGUMENT', 'screenshot clip must be {x, y, width, height} with width/height > 0');
          }
          const t0 = Date.now();
          let data = '';
          let usedFormat: 'png' | 'jpeg' = action.format ?? 'png';
          let usedQuality: number | undefined;
          for (const attempt of planScreenshotAttempts(action.format ?? 'png', action.quality)) {
            const params: Record<string, any> = {
              format: attempt.format,
              captureBeyondViewport: action.fullPage ?? false,
            };
            if (attempt.format === 'jpeg' && attempt.quality !== undefined) params.quality = attempt.quality;
            if (action.clip) params.clip = normalizeClip(action.clip);
            const result = await this.transport.send('Page.captureScreenshot', params);
            data = typeof result?.data === 'string' ? result.data : '';
            usedFormat = attempt.format;
            usedQuality = attempt.quality;
            if (data.length <= MAX_BASE64_CHARS) break;
          }
          if (data.length > MAX_BASE64_CHARS) {
            return errResult(
              'SCREENSHOT_TOO_LARGE',
              `Screenshot base64 exceeds MAX_BASE64_CHARS (${data.length} > ${MAX_BASE64_CHARS}) even after jpeg downgrade`,
            );
          }
          return {
            ok: true,
            value: data,
            meta: { cdpMs: Date.now() - t0, base64Chars: data.length, format: usedFormat, quality: usedQuality },
          };
        }
        case 'screenshotZoom': {
          if (!isValidRegion(action.region)) {
            return errResult('INVALID_ARGUMENT', 'screenshotZoom region must be {x, y, width, height} with width/height > 0');
          }
          const t0 = Date.now();
          // Full-page PNG capture; the crop runs in-page over this bitmap.
          const full = await this.transport.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          const png = typeof full?.data === 'string' ? full.data : '';
          if (!png) return errResult('CDP_COMMAND_FAILED', 'Page.captureScreenshot returned no data for zoom');
          let data = '';
          let usedFormat: 'png' | 'jpeg' = action.format ?? 'jpeg';
          let usedQuality: number | undefined;
          let evalFailed: string | null = null;
          for (const attempt of planScreenshotAttempts(action.format ?? 'jpeg', action.quality)) {
            const zoom = await this.transport.send('Runtime.evaluate', {
              expression: buildZoomScript(png, action.region, attempt.format, attempt.quality),
              awaitPromise: true,
              returnByValue: true,
            });
            if (zoom?.exceptionDetails) {
              evalFailed = zoom.exceptionDetails.text || 'screenshotZoom crop failed';
              break;
            }
            data = typeof zoom?.result?.value === 'string' ? zoom.result.value : '';
            usedFormat = attempt.format;
            usedQuality = attempt.quality;
            if (data.length <= MAX_BASE64_CHARS) break;
          }
          if (evalFailed) return errResult('JS_EVALUATION_ERROR', evalFailed);
          if (!data) {
            return errResult('JS_EVALUATION_ERROR', 'screenshotZoom produced an empty crop (region outside the viewport?)');
          }
          if (data.length > MAX_BASE64_CHARS) {
            return errResult(
              'SCREENSHOT_TOO_LARGE',
              `Zoom crop base64 exceeds MAX_BASE64_CHARS (${data.length} > ${MAX_BASE64_CHARS}) even after jpeg downgrade`,
            );
          }
          return {
            ok: true,
            value: data,
            meta: { cdpMs: Date.now() - t0, base64Chars: data.length, format: usedFormat, quality: usedQuality, region: action.region },
          };
        }
        case 'saveSnapshot': {
          // MHTML capture
          const result = await this.transport.send('Page.captureSnapshot', { format: 'mhtml' });
          return { ok: true, value: result?.data };
        }

        // ─── Storage ───
        case 'getCookies': {
          const result = await this.transport.send('Network.getCookies', { urls: action.urls });
          return { ok: true, value: result?.cookies };
        }
        case 'setCookie': {
          await this.transport.send('Network.setCookie', {
            name: action.cookie.name,
            value: action.cookie.value,
            domain: action.cookie.domain,
            path: action.cookie.path ?? '/',
            secure: action.cookie.secure ?? false,
            httpOnly: action.cookie.httpOnly ?? false,
          });
          return { ok: true };
        }
        case 'deleteCookies': {
          await this.transport.send('Network.deleteCookies', {
            name: action.filter.name ?? '',
            domain: action.filter.domain,
            path: action.filter.path,
          });
          return { ok: true };
        }
        case 'getLocalStorage': {
          const js = action.key
            ? `localStorage.getItem(${JSON.stringify(action.key)})`
            : `JSON.stringify(localStorage)`;
          const result = await this.transport.send('Runtime.evaluate', { expression: js, returnByValue: true });
          return { ok: true, value: result?.result?.value };
        }
        case 'setLocalStorage': {
          const js = `localStorage.setItem(${JSON.stringify(action.key)}, ${JSON.stringify(action.value)})`;
          await this.transport.send('Runtime.evaluate', { expression: js });
          return { ok: true };
        }
        case 'clearStorage': {
          if (action.storageType === 'local' || action.storageType === 'all') {
            await this.transport.send('Runtime.evaluate', { expression: 'localStorage.clear()' });
          }
          if (action.storageType === 'session' || action.storageType === 'all') {
            await this.transport.send('Runtime.evaluate', { expression: 'sessionStorage.clear()' });
          }
          return { ok: true };
        }

        // ─── Inspection (delegate to caller) ───
        case 'inspect':
        case 'observe':
        case 'diff':
          return { ok: true, value: { delegate: true, action } };

        // ─── Wait ───
        case 'wait': {
          const timeout = action.timeoutMs ?? DEFAULT_TIMEOUT;
          const result = await this.waitFor(action.condition, timeout);
          if (!result) return errResult('TIMEOUT', `Wait condition not met within ${timeout}ms`);
          return { ok: true };
        }

        default:
          return errResult('UNSUPPORTED_ACTION', `Unknown action type: ${(action as any).type}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Enlace degradado (watchdog del ExtensionServer): conservar el tipo
      // para que el caller vea EXTENSION_LINK_DEGRADED y no un CDP genérico.
      if ((e as { code?: string })?.code === 'EXTENSION_LINK_DEGRADED') {
        return errResult('EXTENSION_LINK_DEGRADED', msg);
      }
      return errResult('CDP_COMMAND_FAILED', msg);
    }
  }

  // ─── Helpers ────────────────────────────────────────────────

  /**
   * Resuelve un ref del element map in-page: valida que el elemento sigue en
   * el documento, hace scrollIntoView y devuelve el centro del rect. Null si
   * el ref es desconocido o stale (el script lo purga in-page en ese caso).
   */
  private async resolveRef(
    ref: string,
    options: { focus?: boolean; clear?: boolean } = {},
  ): Promise<{ x: number; y: number } | null> {
    const result = await this.transport.send('Runtime.evaluate', {
      expression: buildResolveRefScript(ref, options),
      returnByValue: true,
    });
    const raw = result?.result?.value;
    if (typeof raw !== 'string') return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed?.ok === true ? { x: parsed.x, y: parsed.y } : null;
    } catch {
      return null;
    }
  }

  private async querySelector(selector: string): Promise<number | null> {
    const doc = await this.transport.send('DOM.getDocument', { depth: 0 });
    const rootId = doc?.root?.nodeId;
    if (!rootId) return null;
    const result = await this.transport.send('DOM.querySelector', {
      nodeId: rootId,
      selector,
    });
    return result?.nodeId ?? null;
  }

  private async waitForLoad(_until: string): Promise<void> {
    // Simplified: just wait a bit for load
    await sleep(1000);
  }

  private async waitFor(condition: WaitCondition, timeoutMs: number): Promise<boolean> {
    // Legacy stubs kept for compatibility: 'navigation' has no previous-URL
    // tracking at this layer, and 'timeout' is a plain delay by definition.
    if (condition.kind === 'navigation') {
      await sleep(500);
      return true;
    }
    if (condition.kind === 'timeout') {
      await sleep(condition.ms);
      return true;
    }
    // Everything else goes through the P12 waitForUi engine. networkIdle
    // without a pending-request provider degrades to a quiet sleep (same as
    // the old stub); the MCP `waitFor` tool wires the real Thermal counter.
    const predicate = mapConditionToPredicate(condition);
    const result = await waitForUi(
      { transport: this.transport },
      { anyOf: [predicate], timeoutMs, pollMs: 200 },
    );
    return result.matched !== 'timeout';
  }
}

function errResult(type: Parameters<typeof makeError>[0], message: string, hint?: string): ActionResult {
  return { ok: false, error: makeError(type, message, hint) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}