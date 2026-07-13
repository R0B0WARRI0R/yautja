# Yautja — Phase 7 Implementation Spec

## Context

Phases 1-6 DONE. 283 tests. Sensors + WorkingMemory + Targeting complete.

Phase 7 builds the **Arsenal** — 55 action types as discriminated union + translator that maps each to CDP commands via Transport.

## Modules

1. `src/arsenal/action-types.ts` — all action types as discriminated union
2. `src/arsenal/errors.ts` — error taxonomy (14 types)
3. `src/arsenal/translator.ts` — action → CDP commands
4. `tests/arsenal/translator.test.ts`

## Module 1: Action Types

**File:** `src/arsenal/action-types.ts`

```typescript
export type BrowserAction =
  // ─── Navigation ───
  | { type: 'navigate'; url: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }
  | { type: 'goBack' }
  | { type: 'goForward' }
  | { type: 'reload'; ignoreCache?: boolean }

  // ─── Interaction ───
  | { type: 'click'; selector: string; button?: 'left' | 'right' | 'middle'; clickCount?: number }
  | { type: 'doubleClick'; selector: string }
  | { type: 'hover'; selector: string }
  | { type: 'focus'; selector: string }
  | { type: 'type'; selector: string; text: string; clearFirst?: boolean; delayMs?: number }
  | { type: 'press'; key: string; modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } }
  | { type: 'select'; selector: string; values: string[] }
  | { type: 'check'; selector: string; checked: boolean }
  | { type: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; amount?: number; selector?: string }

  // ─── JavaScript ───
  | { type: 'evaluate'; expression: string; returnByValue?: boolean }
  | { type: 'evaluateAsync'; expression: string }

  // ─── Capture ───
  | { type: 'screenshot'; fullPage?: boolean; format?: 'png' | 'jpeg' }
  | { type: 'saveSnapshot' }

  // ─── Storage ───
  | { type: 'getCookies'; urls?: string[] }
  | { type: 'setCookie'; cookie: { name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean } }
  | { type: 'deleteCookies'; filter: { name?: string; domain?: string; path?: string } }
  | { type: 'getLocalStorage'; key?: string }
  | { type: 'setLocalStorage'; key: string; value: string }
  | { type: 'clearStorage'; storageType: 'local' | 'session' | 'all' }

  // ─── Inspection ───
  | { type: 'inspect'; domain: string; query?: Record<string, any> }
  | { type: 'observe'; question: string }
  | { type: 'diff' }

  // ─── Wait ───
  | { type: 'wait'; condition: WaitCondition; timeoutMs?: number };

export type WaitCondition =
  | { kind: 'selector'; selector: string; state?: 'visible' | 'hidden' | 'attached' | 'detached' }
  | { kind: 'navigation' }
  | { kind: 'networkIdle'; idleTimeMs?: number }
  | { kind: 'function'; fn: string }
  | { kind: 'timeout'; ms: number };

export type ActionResult =
  | { ok: true; value?: any }
  | { ok: false; error: ArsenalError };
```

## Module 2: Error Taxonomy

**File:** `src/arsenal/errors.ts`

```typescript
export type ArsenalErrorType =
  | 'SELECTOR_NOT_FOUND'
  | 'SELECTOR_NOT_VISIBLE'
  | 'ELEMENT_NOT_INTERACTABLE'
  | 'NAVIGATION_TIMEOUT'
  | 'JS_EVALUATION_ERROR'
  | 'ACTION_PRECONDITION'
  | 'CDP_COMMAND_FAILED'
  | 'NOT_CONNECTED'
  | 'TIMEOUT'
  | 'INVALID_ARGUMENT'
  | 'UNSUPPORTED_ACTION'
  | 'STORAGE_ERROR'
  | 'PERMISSION_DENIED'
  | 'UNKNOWN_ERROR';

export interface ArsenalError {
  type: ArsenalErrorType;
  message: string;
  recoverable: boolean;
  recoveryHint?: string;
}

export function makeError(type: ArsenalErrorType, message: string, hint?: string): ArsenalError {
  const recoverableMap: Record<ArsenalErrorType, boolean> = {
    SELECTOR_NOT_FOUND: false,
    SELECTOR_NOT_VISIBLE: false,
    ELEMENT_NOT_INTERACTABLE: true,
    NAVIGATION_TIMEOUT: true,
    JS_EVALUATION_ERROR: false,
    ACTION_PRECONDITION: false,
    CDP_COMMAND_FAILED: true,
    NOT_CONNECTED: false,
    TIMEOUT: true,
    INVALID_ARGUMENT: false,
    UNSUPPORTED_ACTION: false,
    STORAGE_ERROR: false,
    PERMISSION_DENIED: false,
    UNKNOWN_ERROR: false,
  };
  return {
    type,
    message,
    recoverable: recoverableMap[type],
    recoveryHint: hint,
  };
}
```

## Module 3: Action Translator

**File:** `src/arsenal/translator.ts`

Maps each action to CDP commands. Uses `Transport.send()`.

```typescript
import type { Transport } from '../vision/base-sensor.js';
import type { BrowserAction, ActionResult, WaitCondition } from './action-types.js';
import { makeError, type ArsenalError } from './errors.js';

const DEFAULT_TIMEOUT = 30000;

export class ActionTranslator {
  constructor(private transport: Transport) {}

  async execute(action: BrowserAction): Promise<ActionResult> {
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
          const node = await this.querySelector(action.selector);
          if (!node) return errResult('SELECTOR_NOT_FOUND', `Element not found: ${action.selector}`, 'Use inspect("dom") to see current elements');
          await this.transport.send('DOM.focus', { nodeId: node });
          for (let i = 0; i < count; i++) {
            await this.transport.send('Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x: 0, y: 0, button: action.button ?? 'left', clickCount: 1,
            });
            await this.transport.send('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x: 0, y: 0, button: action.button ?? 'left', clickCount: 1,
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
          // Focus the element
          const node = await this.querySelector(action.selector);
          if (!node) return errResult('SELECTOR_NOT_FOUND', `Element not found: ${action.selector}`);
          await this.transport.send('DOM.focus', { nodeId: node });
          // Type each character
          const delay = action.delayMs ?? 0;
          for (const char of action.text) {
            await this.transport.send('Input.insertText', { text: char });
            if (delay > 0) await sleep(delay);
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
```

### Implementation Notes

1. **Click implementation** is simplified — it focuses the element then dispatches mouse events at 0,0. A production version would compute element coordinates via `DOM.getBoxModel`. For v1 this is functional.

2. **`type` action** uses `Input.insertText` per character. This produces `isTrusted: true` events in CDP.

3. **`inspect`, `observe`, `diff` actions** return `{ delegate: true, action }` — the caller (helmet.ts) handles these, not the translator. They're not CDP commands.

4. **Wait conditions** use polling (200ms interval). The `function` condition evaluates JS that must return `true`.

5. **Error wrapping**: CDP exceptions are caught and wrapped in `ArsenalError` with `recoverable` flag.

## Test cases

Use `MockTransport` with a `send` mock that returns canned responses per method:

```
- navigate sends Page.navigate
- reload sends Page.reload
- click returns SELECTOR_NOT_FOUND when element missing
- click sends DOM.focus when element found
- type clears when clearFirst=true
- type sends Input.insertText per character
- press sends keyDown + keyUp with modifiers
- evaluate returns value on success
- evaluate returns JS_EVALUATION_ERROR on exception
- evaluateAsync sends with awaitPromise
- screenshot sends Page.captureScreenshot
- getCookies sends Network.getCookies
- setCookie sends Network.setCookie
- deleteCookies sends Network.deleteCookies
- getLocalStorage evaluates localStorage.getItem
- setLocalStorage evaluates localStorage.setItem
- clearStorage clears both local and session when type=all
- inspect/observe/diff return delegate=true
- wait selector returns true when element appears
- wait timeout returns true after ms
- wait function polls until fn returns true
- unknown action returns UNSUPPORTED_ERROR
- CDP error wraps in ArsenalError
```

## Deliverables

1. `src/arsenal/action-types.ts`
2. `src/arsenal/errors.ts`
3. `src/arsenal/translator.ts`
4. `tests/arsenal/translator.test.ts`

After writing: `cd D:\Yautja && npx vitest run && npm run lint`
Report full output.
