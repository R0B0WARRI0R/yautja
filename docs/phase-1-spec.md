# Yautja — Phase 1 Implementation Spec

## Context

Yautja is a sensory cortex between Chrome DevTools Protocol (CDP) and an LLM.
Read `D:\Yautja\docs\SPEC.md` for full architecture context.

Phase 1 implements two foundational modules with zero external dependencies
(except playwright for CDP):

1. `src/memory/rolling-buffer.ts` — generic bounded buffer
2. `src/connection/cdp-session.ts` — Playwright CDP session wrapper

## Module 1: RollingBuffer

**File:** `src/memory/rolling-buffer.ts`

A generic FIFO buffer with a maximum size. When full, pushing a new item
evicts the oldest. This is used by every sensor and the working memory.

### Interface

```typescript
export class RollingBuffer<T> {
  /**
   * @param maxSize Maximum items to retain. Must be > 0.
   */
  constructor(maxSize: number);

  /**
   * Add an item to the end of the buffer.
   * If buffer is full, the oldest item is evicted.
   * @returns The evicted item, or undefined if nothing was evicted.
   */
  push(item: T): T | undefined;

  /**
   * @returns The oldest item (front of buffer), or undefined if empty.
   * Does NOT remove it.
   */
  peek(): T | undefined;

  /**
   * @returns The newest item (back of buffer), or undefined if empty.
   * Does NOT remove it.
   */
  last(): T | undefined;

  /** Current number of items in the buffer. */
  get length(): number;

  /** Maximum capacity. */
  get capacity(): number;

  /** True if length === capacity. */
  isFull(): boolean;

  /** True if length === 0. */
  isEmpty(): boolean;

  /**
   * Remove and return the oldest item.
   * @returns The removed item, or undefined if empty.
   */
  shift(): T | undefined;

  /** Remove all items. */
  clear(): void;

  /**
   * Returns a NEW array snapshot of current items (oldest to newest).
   * Mutating the returned array does NOT affect the buffer.
   */
  toArray(): T[];

  /**
   * Returns items matching the predicate (oldest to newest).
   * Does NOT modify the buffer.
   */
  filter(predicate: (item: T, index: number) => boolean): T[];

  /**
   * Find the first item matching the predicate.
   * Returns undefined if not found.
   */
  find(predicate: (item: T, index: number) => boolean): T | undefined;

  /**
   * Call fn for each item (oldest to newest).
   */
  forEach(fn: (item: T, index: number) => void): void;
}
```

### Implementation Requirements

- Use a typed array or circular buffer internally. A simple approach: maintain
  an internal `T[]` and shift when capacity exceeded. A circular buffer is
  more performant but either is acceptable.
- `constructor` must throw `RangeError` if `maxSize <= 0`.
- All methods must be O(1) for push/peek/last/shift, or O(n) for toArray/filter/forEach.
  If using a plain array with shift(), document that push is O(n) due to shift cost.
- Must be generic: `RollingBuffer<number>`, `RollingBuffer<string>`, `RollingBuffer<MyObject>`.

## Module 2: CDPSessionManager

**File:** `src/connection/cdp-session.ts`

Wraps Playwright's CDP session. Provides connection lifecycle, domain
management, event subscription, and command execution.

### Imports

```typescript
import { chromium, type Browser, type BrowserContext, type Page, type CDPSession } from 'playwright';
```

### Interface

```typescript
export interface ConnectionInfo {
  connected: boolean;
  browserVersion?: string;
  cdpUrl: string;
  activeDomains: string[];
  tabUrl?: string;
  tabId?: string;
}

export interface SendOptions {
  timeoutMs?: number;  // default 30000
}

export class CDPSessionManager {
  /**
   * Connect to a browser via CDP.
   * Uses chromium.connectOverCDP() to attach to an existing browser.
   * @param cdpUrl CDP WebSocket URL, e.g. 'ws://localhost:9222' or http endpoint.
   */
  async connect(cdpUrl: string): Promise<void>;

  /**
   * Disconnect from the browser. Cleans up all listeners.
   * Safe to call multiple times.
   */
  async disconnect(): Promise<void>;

  /** True if connected and session is active. */
  isConnected(): boolean;

  /**
   * Enable CDP domains. Idempotent — enabling an already-enabled domain is a no-op.
   * @param domains e.g. ['Network', 'DOM', 'Console', 'Performance', 'Security']
   */
  async enableDomains(domains: string[]): Promise<void>;

  /**
   * Disable CDP domains. Idempotent.
   */
  async disableDomains(domains: string[]): Promise<void>;

  /**
   * Subscribe to a CDP event.
   * @param event Full event name, e.g. 'Network.requestWillBeSent'
   * @param handler Called when the event fires.
   * @returns An unsubscribe function. Call it to remove the listener.
   */
  on(event: string, handler: (params: any) => void): () => void;

  /**
   * Subscribe to a CDP event. Auto-unsubscribes after first fire.
   */
  once(event: string, handler: (params: any) => void): () => void;

  /**
   * Remove a specific event handler.
   */
  off(event: string, handler: (params: any) => void): void;

  /**
   * Send a CDP command and await the response.
   * @param method Full method name, e.g. 'Network.getResponseBody'
   * @param params Optional parameters object.
   * @param options Optional timeout override.
   * @returns The result object from CDP.
   * @throws Error if not connected, timeout exceeded, or CDP returns error.
   */
  async send(
    method: string,
    params?: Record<string, any>,
    options?: SendOptions,
  ): Promise<any>;

  /**
   * Get current connection metadata.
   */
  getInfo(): ConnectionInfo;

  /**
   * Switch to a different tab/page by URL pattern or index.
   * Creates a new CDP session for that page.
   * @param match URL substring to match, or numeric index.
   */
  async switchTab(match: string | number): Promise<void>;

  /**
   * Get a snapshot of available tabs.
   */
  async listTabs(): Promise<TabInfo[]>;
}

export interface TabInfo {
  url: string;
  title: string;
  index: number;
  active: boolean;
}
```

### Implementation Requirements

**connect(cdpUrl):**
- Use `chromium.connectOverCDP(cdpUrl)` to attach to an existing browser.
- Get the default browser context.
- Get the first page (or the active page) and create a CDP session via
  `page.context().newCDPSession(page)`.
- Store the browser, context, page, and CDPSession internally.
- If no pages exist, create one via `context.newPage()`.
- Set `connected = true`.
- Throw descriptive Error if connection fails (wrong URL, browser not running, etc).

**disconnect():**
- Detach the CDP session.
- Close the browser connection (NOT the browser itself — we attached, we don't own it).
  Use `browser.close()` only if we created it. For `connectOverCDP`, just close the
  context/session.
- Clear all event listeners.
- Set `connected = false`.
- Must be idempotent (safe to call when already disconnected).

**enableDomains(domains):**
- For each domain, call `session.send(domain + '.enable')`.
- Track enabled domains in a Set. Skip already-enabled.
- Catch errors: if a domain doesn't exist, throw Error with the domain name.

**on(event, handler):**
- Register handler on the CDPSession: `session.on(event, handler)`.
- Track in an internal Map for cleanup.
- Return an unsubscribe function that calls `this.off(event, handler)`.

**send(method, params, options):**
- Check `isConnected()`. Throw if not.
- Delegate to `session.send(method, params)`.
- Playwright's CDPSession.send already has timeout handling.
  If `options.timeoutMs` is provided, wrap in a `Promise.race` with a timeout.
- On error, throw with descriptive message including the method name.

**switchTab(match):**
- Get all pages from the browser context.
- If match is a string: find the page whose URL contains the match.
- If match is a number: use pages[match].
- Detach old CDP session. Create new one for the target page.
- Re-enable all previously enabled domains on the new session.
- Re-attach all event listeners to the new session.

**Error handling:**
- All public methods should check `isConnected()` first.
- Errors should be descriptive: include what failed and why.
- Use standard Error class (not custom error types yet — those come in Phase 7).

## Tests

**File:** `tests/memory/rolling-buffer.test.ts`
**File:** `tests/connection/cdp-session.test.ts`

Use vitest (`import { describe, it, expect, vi } from 'vitest'`).

### RollingBuffer tests

```
- constructor: stores maxSize, throws on <= 0
- push: adds items, returns undefined until full
- push when full: evicts oldest, returns evicted item
- peek: returns oldest without removing
- last: returns newest without removing
- length: tracks correctly
- capacity: returns maxSize
- isFull / isEmpty: correct states
- shift: removes and returns oldest
- clear: empties the buffer
- toArray: returns snapshot in order (oldest to newest)
- filter: returns matching items
- find: returns first match or undefined
- forEach: iterates in order
- generic: works with objects, not just primitives
- mutation safety: toArray result does not affect internal state
```

### CDPSessionManager tests

CDPSessionManager requires a real browser, so unit tests should mock Playwright:

```
- connect: calls chromium.connectOverCDP with correct URL
- connect: throws on invalid URL
- isConnected: false before connect, true after, false after disconnect
- disconnect: idempotent
- enableDomains: calls session.send for each domain
- enableDomains: skips already-enabled domains (idempotent)
- enableDomains: throws on unknown domain
- on: returns unsubscribe function
- on: handler receives event params
- off: removes handler
- once: auto-unsubscribes after first event
- send: delegates to session.send with correct method and params
- send: throws when not connected
- getInfo: returns correct ConnectionInfo
```

Mock Playwright's `chromium.connectOverCDP` to return a fake browser/context/page/session.
Use `vi.mock('playwright', ...)` or inject dependencies.

## Style

- TypeScript strict mode (enforced by tsconfig.json)
- No `any` in YOUR interfaces (CDP params can be `any` — they come from Playwright)
- No unused variables or parameters
- No comments unless explaining non-obvious logic
- ESM imports (`import { X } from 'y'`)
- Export all public types and classes

## Deliverables

MiniMax M3 must produce:
1. `src/memory/rolling-buffer.ts`
2. `src/connection/cdp-session.ts`
3. `tests/memory/rolling-buffer.test.ts`
4. `tests/connection/cdp-session.test.ts`

After writing, run: `cd D:\Yautja && npm install && npx vitest run`
Report the test results.
