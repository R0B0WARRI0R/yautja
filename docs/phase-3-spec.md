# Yautja — Phase 3 Implementation Spec

## Context

Phase 1 (connection + buffer) and Phase 2 (base-sensor + thermal) are DONE and tested live against Brave.

Phase 3 adds two sensors:
1. `src/vision/em.ts` — DOM sensor (4 semantic views via Runtime.evaluate)
2. `src/vision/audio.ts` — Console sensor (errors, warnings, exceptions with dedup)

## Breaking Change: Async Summarize

The DOM sensor needs to call CDP commands (Runtime.evaluate) to inspect the page. `summarize()` must be async.

**Update `src/vision/base-sensor.ts`:**

```typescript
// BEFORE:
abstract summarize(query?: SensorQuery): TSummary;

// AFTER:
abstract summarize(query?: SensorQuery): Promise<TSummary>;
```

**Update `src/vision/thermal.ts`:**

```typescript
// BEFORE:
summarize(query?: NetworkQuery): NetworkSummary { ... }

// AFTER:
async summarize(query?: NetworkQuery): Promise<NetworkSummary> { ... }
```

Logic stays identical — just make it `async`. All callers already use or can use `await`.

**Update `tests/vision/thermal.test.ts`:** All `sensor.summarize()` calls become `await sensor.summarize()`. Add `async` to test callbacks.

## Module 1: EMSensor (DOM)

**File:** `src/vision/em.ts`

Named "EM" — electromagnetic spectrum. The DOM is the structure the LLM "sees."

### Approach

Unlike thermal (purely push-based event processing), EM is **pull-based**: on `summarize()`, it executes a `Runtime.evaluate` with a JavaScript extraction function that runs in the page context and returns structured data.

The sensor caches results for `cacheTtlMs` (default 2000ms) to avoid hammering the page on every call.

### Types

```typescript
import type { Anomaly, SensorQuery } from './base-sensor.js';

export interface DOMSummary {
  url: string;
  semantic: SemanticView;
  interactive: InteractiveView;
  structural: StructuralView;
}

export interface SemanticView {
  pageType: string;         // 'login' | 'dashboard' | 'article' | 'form' | 'search' | 'chat' | 'settings' | 'error' | 'unknown'
  title: string;
  headings: string[];       // h1-h3 text, max 10
  mainContentPreview: string; // first 500 chars of body text
  language: string;
}

export interface InteractiveView {
  buttons: InteractiveElement[];
  links: InteractiveElement[];
  inputs: FormField[];
  total: number;
}

export interface InteractiveElement {
  tag: string;
  text: string;             // visible text, max 50 chars
  selector: string;         // CSS selector for clicking
  visible: boolean;
  disabled: boolean;
}

export interface FormField {
  tag: string;
  type: string;             // text, email, password, checkbox, etc.
  name: string;             // name attribute
  label: string;            // associated label text
  placeholder: string;
  required: boolean;
  selector: string;
}

export interface StructuralView {
  totalElements: number;
  depth: number;
  iframes: number;
  images: number;
  scripts: number;
  forms: number;
  stylesheets: number;
}

export interface DOMQuery extends SensorQuery {
  view?: 'all' | 'semantic' | 'interactive' | 'structural';
}
```

### Extraction Script

This JavaScript runs inside the page via `Runtime.evaluate`. It MUST use `function(){}` syntax (no arrow functions), `var` (no let/const), and `.indexOf()` (no .includes()) for maximum compatibility.

```javascript
(function() {
  function getSelector(el) {
    if (el.id) return '#' + el.id;
    if (el.getAttribute('data-testid')) return '[data-testid="' + el.getAttribute('data-testid') + '"]';
    var sib = el.parentNode ? Array.prototype.indexOf.call(el.parentNode.children, el) : 0;
    var tag = el.tagName.toLowerCase();
    if (el.parentNode && el.parentNode !== document.body) {
      return getSelector(el.parentNode) + ' > ' + tag + ':nth-child(' + (sib + 1) + ')';
    }
    return tag + ':nth-child(' + (sib + 1) + ')';
  }

  function visible(el) {
    if (!el || !el.offsetParent) return false;
    var s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  // --- Semantic ---
  var title = document.title || '';
  var headingEls = document.querySelectorAll('h1, h2, h3');
  var headings = [];
  for (var i = 0; i < headingEls.length && i < 10; i++) {
    var t = headingEls[i].textContent.trim();
    if (t) headings.push(t.substring(0, 100));
  }
  var bodyText = document.body ? document.body.innerText : '';
  var lang = document.documentElement.lang || '';

  var pageType = 'unknown';
  if (document.querySelector('input[type=password]') && document.querySelector('form')) pageType = 'login';
  else if (document.querySelector('[role=dialog], .modal, [aria-modal=true]')) pageType = 'modal';
  else if (document.querySelector('nav') && document.querySelector('main, [role=main]')) pageType = 'dashboard';
  else if (headingEls.length > 0 && bodyText.length > 500) pageType = 'article';
  else if (document.querySelector('input[type=search], [role=searchbox], input[name=q], input[name=search]')) pageType = 'search';
  else if (document.querySelector('[data-testid*=chat], .chat-input, [class*=message-list]')) pageType = 'chat';
  else if (document.querySelectorAll('form input').length > 2) pageType = 'form';
  else if (title.indexOf('404') !== -1 || title.indexOf('Error') !== -1) pageType = 'error';

  // --- Interactive ---
  var buttonEls = document.querySelectorAll('button, [role=button], input[type=button], input[type=submit]');
  var buttons = [];
  for (var i = 0; i < buttonEls.length && buttons.length < 30; i++) {
    var el = buttonEls[i];
    var text = (el.textContent || el.value || '').trim();
    buttons.push({
      tag: el.tagName,
      text: text.substring(0, 50),
      selector: getSelector(el),
      visible: visible(el),
      disabled: el.disabled || false,
    });
  }

  var linkEls = document.querySelectorAll('a[href]');
  var links = [];
  for (var i = 0; i < linkEls.length && links.length < 20; i++) {
    var el = linkEls[i];
    var text = el.textContent.trim();
    if (!text) continue;
    links.push({
      tag: 'A',
      text: text.substring(0, 50),
      selector: getSelector(el),
      visible: visible(el),
      disabled: false,
    });
  }

  var inputEls = document.querySelectorAll('input, textarea, select');
  var inputs = [];
  for (var i = 0; i < inputEls.length && inputs.length < 20; i++) {
    var el = inputEls[i];
    var label = '';
    if (el.id) {
      var labelEl = document.querySelector('label[for="' + el.id + '"]');
      if (labelEl) label = labelEl.textContent.trim();
    }
    if (!label && el.placeholder) label = el.placeholder;
    inputs.push({
      tag: el.tagName,
      type: el.type || el.tagName.toLowerCase(),
      name: el.name || '',
      label: label.substring(0, 50),
      placeholder: el.placeholder || '',
      required: el.required || false,
      selector: getSelector(el),
    });
  }

  // --- Structural ---
  var allEls = document.getElementsByTagName('*');
  var totalElements = allEls.length;
  var depth = 0;
  function measureDepth(el, d) {
    if (d > depth) depth = d;
    for (var i = 0; i < el.children.length; i++) {
      measureDepth(el.children[i], d + 1);
    }
  }
  measureDepth(document.body, 0);

  return JSON.stringify({
    url: location.href,
    semantic: {
      pageType: pageType,
      title: title,
      headings: headings,
      mainContentPreview: bodyText.substring(0, 500),
      language: lang,
    },
    interactive: {
      buttons: buttons,
      links: links,
      inputs: inputs,
      total: buttons.length + links.length + inputs.length,
    },
    structural: {
      totalElements: totalElements,
      depth: depth,
      iframes: document.querySelectorAll('iframe').length,
      images: document.querySelectorAll('img').length,
      scripts: document.querySelectorAll('script').length,
      forms: document.querySelectorAll('form').length,
      stylesheets: document.querySelectorAll('link[rel=stylesheet]').length,
    },
  });
})()
```

### EMSensor class

```typescript
export interface EMConfig {
  cacheTtlMs: number;       // default 2000
  maxInteractive: number;   // default 50
}

export class EMSensor extends BaseSensor<DOMSummary> {
  private config: EMConfig;
  private cached: DOMSummary | null = null;
  private cachedAt = 0;

  constructor(transport: Transport, config?: Partial<EMConfig>) {
    super(transport);
    this.config = { cacheTtlMs: 2000, maxInteractive: 50, ...config };
  }

  protected doSubscribe(): void {
    // Invalidate cache on navigation
    this.on('Page.frameNavigated', () => { this.cached = null; });
    this.on('Page.loadEventFired', () => { this.cached = null; });
  }

  async summarize(query?: DOMQuery): Promise<DOMSummary> {
    // Check cache
    if (this.cached && Date.now() - this.cachedAt < this.config.cacheTtlMs) {
      return this.cached;
    }

    // Execute extraction
    const result = await this.transport.send('Runtime.evaluate', {
      expression: EXTRACTION_SCRIPT,
      returnByValue: true,
    });

    const json = result?.result?.value;
    if (!json) {
      throw new Error('EMSensor: Runtime.evaluate returned no data');
    }

    const data = JSON.parse(json);
    this.cached = data;
    this.cachedAt = Date.now();
    return data;
  }

  async getAnomalies(): Promise<Anomaly[]> {
    // Will be expanded later. For now, check for error page.
    const summary = await this.summarize();
    const anomalies: Anomaly[] = [];
    if (summary.semantic.pageType === 'error') {
      anomalies.push({
        domain: 'dom',
        severity: 'warning',
        message: `Page appears to be an error page: "${summary.semantic.title}"`,
        timestamp: Date.now(),
      });
    }
    return anomalies;
  }

  clear(): void {
    this.cached = null;
    this.cachedAt = 0;
  }
}
```

**IMPORTANT:** `getAnomalies()` is also async now since it calls summarize. Update the base class:
```typescript
abstract getAnomalies(): Promise<Anomaly[]>;
// or make it Anomaly[] | Promise<Anomaly[]>
```
Use `Anomaly[] | Promise<Anomaly[]>` for flexibility — thermal stays sync, em is async.

## Module 2: AudioSensor (Console)

**File:** `src/vision/audio.ts`

Named "audio" — console output is the "sound" of the page.

### Types

```typescript
export interface ConsoleEntry {
  level: 'log' | 'info' | 'warning' | 'error' | 'debug';
  text: string;
  count: number;            // dedup count (same message repeated)
  url?: string;
  lineNumber?: number;
  stackTrace?: string;
  timestamp: number;
}

export interface ConsoleSummary {
  total: number;
  errors: ConsoleEntry[];
  warnings: ConsoleEntry[];
  logs: ConsoleEntry[];
  uncaughtExceptions: ConsoleEntry[];
  dedupCount: number;       // how many duplicates were collapsed
}
```

### AudioSensor class

```typescript
export interface AudioConfig {
  maxEntries: number;       // default 100
  dedupWindowMs: number;    // default 2000 — collapse repeats within this window
}

export class AudioSensor extends BaseSensor<ConsoleSummary> {
  private config: AudioConfig;
  private entries: ConsoleEntry[] = [];
  private dedupMap: Map<string, ConsoleEntry> = new Map();
  private dedupCount = 0;

  constructor(transport: Transport, config?: Partial<AudioConfig>) {
    super(transport);
    this.config = { maxEntries: 100, dedupWindowMs: 2000, ...config };
  }

  protected doSubscribe(): void {
    this.on('Runtime.consoleAPICalled', (p) => this.onConsole(p));
    this.on('Runtime.exceptionThrown', (p) => this.onException(p));
  }

  private onConsole(p: any): void {
    const level = mapLevel(p.type);  // log, info, warning, error, debug
    const text = formatArgs(p.args);
    const entry: ConsoleEntry = {
      level,
      text,
      count: 1,
      url: p.stackTrace?.[0]?.url,
      lineNumber: p.stackTrace?.[0]?.lineNumber,
      timestamp: Date.now(),
    };
    this.addEntry(entry);
  }

  private onException(p: any): void {
    const details = p.exceptionDetails;
    const entry: ConsoleEntry = {
      level: 'error',
      text: details?.text || details?.exception?.description || 'Uncaught exception',
      count: 1,
      url: details?.url,
      lineNumber: details?.lineNumber,
      stackTrace: details?.stackTrace?.callFrames?.map((f: any) => f.functionName + '@' + f.url + ':' + f.lineNumber).join('\n'),
      timestamp: Date.now(),
    };
    this.addEntry(entry);
  }

  private addEntry(entry: ConsoleEntry): void {
    // Dedup: if same text+level within window, increment count
    const key = entry.level + ':' + entry.text;
    const existing = this.dedupMap.get(key);
    if (existing && Date.now() - existing.timestamp < this.config.dedupWindowMs) {
      existing.count++;
      this.dedupCount++;
      return;
    }

    this.dedupMap.set(key, entry);
    this.entries.push(entry);

    // Enforce max
    if (this.entries.length > this.config.maxEntries) {
      const removed = this.entries.shift();
      if (removed) this.dedupMap.delete(removed.level + ':' + removed.text);
    }
  }

  async summarize(): Promise<ConsoleSummary> {
    return {
      total: this.entries.length,
      errors: this.entries.filter(e => e.level === 'error'),
      warnings: this.entries.filter(e => e.level === 'warning'),
      logs: this.entries.filter(e => e.level === 'log' || e.level === 'info' || e.level === 'debug'),
      uncaughtExceptions: this.entries.filter(e => e.stackTrace !== undefined),
      dedupCount: this.dedupCount,
    };
  }

  async getAnomalies(): Promise<Anomaly[]> {
    const anomalies: Anomaly[] = [];
    const errors = this.entries.filter(e => e.level === 'error');
    if (errors.length > 5) {
      anomalies.push({
        domain: 'console',
        severity: 'warning',
        message: `${errors.length} console errors detected`,
        timestamp: Date.now(),
      });
    }
    return anomalies;
  }

  clear(): void {
    this.entries = [];
    this.dedupMap.clear();
    this.dedupCount = 0;
  }
}

function mapLevel(type: string): ConsoleEntry['level'] {
  switch (type) {
    case 'error': return 'error';
    case 'warning': return 'warning';
    case 'info': return 'info';
    case 'debug': return 'debug';
    default: return 'log';
  }
}

function formatArgs(args: any[]): string {
  if (!args) return '';
  return args.map(a => {
    if (a.type === 'string') return a.value;
    if (a.type === 'number') return String(a.value);
    if (a.type === 'object' && a.preview) return a.preview.properties?.map((p: any) => p.name + ': ' + p.value).join(', ') || '[object]';
    return a.description || a.value || '[' + a.type + ']';
  }).join(' ');
}
```

## Files to modify/create

1. **MODIFY** `src/vision/base-sensor.ts` — summarize → async, getAnomalies → `Anomaly[] | Promise<Anomaly[]>`
2. **MODIFY** `src/vision/thermal.ts` — summarize → async, getAnomalies stays sync
3. **MODIFY** `tests/vision/thermal.test.ts` — all summarize() calls → `await`
4. **CREATE** `src/vision/em.ts` — EMSensor + types
5. **CREATE** `src/vision/audio.ts` — AudioSensor + types
6. **CREATE** `tests/vision/em.test.ts` — tests with MockTransport
7. **CREATE** `tests/vision/audio.test.ts` — tests with MockTransport

## Test cases

### EM tests (MockTransport that returns canned Runtime.evaluate results)

```
- summarize calls Runtime.evaluate with extraction script
- summarize returns parsed DOMSummary with correct structure
- summarize caches result within cacheTtlMs (single send call)
- summarize invalidates cache after cacheTtlMs
- summarize invalidates cache on Page.frameNavigated
- summarize invalidates cache on Page.loadEventFired
- getAnomalies returns warning for error page type
- getAnomalies returns empty for normal page
- clear resets cache
- subscribe registers Page.frameNavigated and Page.loadEventFired handlers
```

### Audio tests

```
- consoleAPICalled with type=error creates error entry
- consoleAPICalled with type=warning creates warning entry
- consoleAPICalled with type=log creates log entry
- exceptionThrown creates error entry with stackTrace
- dedup: same message within window increments count
- dedup: same message after window creates new entry
- maxEntries evicts oldest
- summarize groups by level correctly
- summarize counts dedup
- getAnomalies warns on >5 errors
- clear empties all entries
- unsubscribe stops processing
- formatArgs handles string, number, object args
```

## Deliverables

After implementation: `cd D:\Yautja && npx vitest run && npm run lint`
Report full output.
