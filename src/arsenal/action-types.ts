import type { ArsenalError } from './errors.js';

export type WaitCondition =
  | { kind: 'selector'; selector: string; state?: 'visible' | 'hidden' | 'attached' | 'detached' }
  | { kind: 'navigation' }
  | { kind: 'networkIdle'; idleTimeMs?: number }
  | { kind: 'function'; fn: string }
  | { kind: 'timeout'; ms: number }
  // P12 predicates (routed through the waitForUi engine)
  | { kind: 'ariaBusy'; root?: string; value?: boolean }
  | { kind: 'noPulse'; root?: string }
  | { kind: 'textSettled'; selector: string; stableMs: number; minLength?: number }
  | { kind: 'urlMatch'; pattern: string };

export type BrowserAction =
  | { type: 'navigate'; url: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }
  | { type: 'goBack' }
  | { type: 'goForward' }
  | { type: 'reload'; ignoreCache?: boolean }
  | { type: 'click'; selector?: string; ref?: string; button?: 'left' | 'right' | 'middle'; clickCount?: number }
  | { type: 'doubleClick'; selector?: string; ref?: string }
  | { type: 'hover'; selector: string }
  | { type: 'focus'; selector?: string; ref?: string }
  | { type: 'type'; selector?: string; ref?: string; text: string; clearFirst?: boolean; delayMs?: number; stealth?: boolean }
  | { type: 'form_input'; selector?: string; ref?: string; value: string | boolean | number }
  | { type: 'press'; key: string; modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } }
  | { type: 'select'; selector: string; values: string[] }
  | { type: 'check'; selector: string; checked: boolean }
  | { type: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; amount?: number; selector?: string }
  | { type: 'evaluate'; expression: string; returnByValue?: boolean }
  | { type: 'evaluateAsync'; expression: string }
  | { type: 'screenshot'; fullPage?: boolean; format?: 'png' | 'jpeg'; quality?: number; clip?: { x: number; y: number; width: number; height: number; scale?: number } }
  | { type: 'screenshotZoom'; region: { x: number; y: number; width: number; height: number }; format?: 'png' | 'jpeg'; quality?: number }
  | { type: 'saveSnapshot' }
  | { type: 'getCookies'; urls?: string[] }
  | { type: 'setCookie'; cookie: { name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean } }
  | { type: 'deleteCookies'; filter: { name?: string; domain?: string; path?: string } }
  | { type: 'getLocalStorage'; key?: string }
  | { type: 'setLocalStorage'; key: string; value: string }
  | { type: 'clearStorage'; storageType: 'local' | 'session' | 'all' }
  | { type: 'inspect'; domain: string; query?: Record<string, any> }
  | { type: 'observe'; question: string }
  | { type: 'diff' }
  | { type: 'wait'; condition: WaitCondition; timeoutMs?: number };

export type ActionResult =
  | { ok: true; value?: any; meta?: Record<string, any> }
  | { ok: false; error: ArsenalError };