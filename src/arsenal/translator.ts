import type { Transport } from '../vision/base-sensor.js';
import type { BrowserAction, ActionResult, WaitCondition } from './action-types.js';
import { makeError } from './errors.js';

const DEFAULT_TIMEOUT = 30000;

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
          const node = await this.querySelector(action.selector);
          if (!node) return errResult('SELECTOR_NOT_FOUND', `Element not found: ${action.selector}`, 'Use inspect("dom") to see current elements');
          await this.transport.send('DOM.focus', { nodeId: node });
          for (let i = 0; i < count; i++) {
            await this.transport.send('Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x: 0, y: 0, button, clickCount: 1,
            });
            await this.transport.send('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x: 0, y: 0, button, clickCount: 1,
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
          const node = await this.querySelector(action.selector);
          if (!node) return errResult('SELECTOR_NOT_FOUND', `Element not found: ${action.selector}`);
          await this.transport.send('DOM.focus', { nodeId: node });
          return { ok: true };
        }
        case 'type': {
          if (action.clearFirst) {
            await this.transport.send('Runtime.evaluate', {
              expression: `(function(){var el=document.querySelector(${JSON.stringify(action.selector)});if(el){el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));}})()`,
            });
          }
          const node = await this.querySelector(action.selector);
          if (!node) return errResult('SELECTOR_NOT_FOUND', `Element not found: ${action.selector}`);
          await this.transport.send('DOM.focus', { nodeId: node });

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
          const mods = action.modifiers ?? {};
          const keyMap: Record<string, number> = { ctrl: 2, shift: 1, alt: 4, meta: 8 };
          let modifiers = 0;
          for (const [k, v] of Object.entries(mods)) {
            if (v && k in keyMap) modifiers |= keyMap[k]!;
          }
          await this.transport.send('Input.dispatchKeyEvent', {
            type: 'keyDown', key: action.key, modifiers,
          });
          await this.transport.send('Input.dispatchKeyEvent', {
            type: 'keyUp', key: action.key, modifiers,
          });
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
            return errResult('JS_EVALUATION_ERROR', result.exceptionDetails.text || 'Evaluation failed', 'Check expression syntax');
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
          const result = await this.transport.send('Page.captureScreenshot', {
            format: action.format ?? 'png',
            captureBeyondViewport: action.fullPage ?? false,
          });
          return { ok: true, value: result?.data };
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
      return errResult('CDP_COMMAND_FAILED', msg);
    }
  }

  // ─── Helpers ────────────────────────────────────────────────

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
    const deadline = Date.now() + timeoutMs;
    const interval = 200;

    while (Date.now() < deadline) {
      switch (condition.kind) {
        case 'selector': {
          const node = await this.querySelector(condition.selector);
          if (condition.state === 'hidden' || condition.state === 'detached') {
            if (!node) return true;
          } else {
            if (node) return true;
          }
          break;
        }
        case 'navigation': {
          // Check if URL is stable
          await sleep(500);
          return true;
        }
        case 'networkIdle': {
          await sleep(condition.idleTimeMs ?? 500);
          return true;
        }
        case 'function': {
          const result = await this.transport.send('Runtime.evaluate', {
            expression: condition.fn,
            returnByValue: true,
          });
          if (result?.result?.value === true) return true;
          break;
        }
        case 'timeout': {
          await sleep(condition.ms);
          return true;
        }
      }
      await sleep(interval);
    }
    return false;
  }
}

function errResult(type: Parameters<typeof makeError>[0], message: string, hint?: string): ActionResult {
  return { ok: false, error: makeError(type, message, hint) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}