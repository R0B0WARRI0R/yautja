# Yautja — Phase 6 Implementation Spec

## Context

Phases 1-5 DONE. 236 tests passing. Five sensors + WorkingMemory implemented.

Phase 6 builds the **Targeting** layer — the attention router. This is the core intelligence of Yautja: given an LLM's question and the current browser state, decide WHAT to show and HOW MUCH.

## Modules

1. `src/targeting/relevance.ts` — keyword matrix + scoring algorithm
2. `src/targeting/strategies/query.ts` — query-based attention
3. `src/targeting/strategies/anomaly.ts` — anomaly-based attention
4. `src/targeting/strategies/diff.ts` — change-based attention (post-action)
5. `src/targeting/strategies/overview.ts` — exploratory high-level view
6. `src/targeting/router.ts` — main router that composes strategies
7. `src/targeting/observation.ts` — observation types + builder
8. `tests/targeting/relevance.test.ts`
9. `tests/targeting/router.test.ts`

## Module 1: Relevance Scoring

**File:** `src/targeting/relevance.ts`

Determines which sensor domains are relevant to a given question.

```typescript
export type SensorDomain = 'network' | 'dom' | 'console' | 'performance' | 'security';

interface KeywordEntry {
  words: string[];
  weight: number;
}

const DOMAIN_KEYWORDS: Record<SensorDomain, KeywordEntry[]> = {
  network: [
    { words: ['slow', 'lento', 'latency', 'timeout', 'request', 'api', 'cors', 'xhr', 'fetch', 'ajax', 'loading', 'cargando', 'download', 'descarga', 'bandwidth', 'transfer', 'tamaño', 'size'], weight: 1.0 },
    { words: ['failed', 'error', 'falló', '404', '500', '503', 'blocked', 'bloqueado'], weight: 1.2 },
    { words: ['websocket', 'sse', 'streaming', 'real-time', 'realtime'], weight: 1.0 },
  ],
  dom: [
    { words: ['click', 'button', 'form', 'input', 'type', 'escribir', 'interact', 'element', 'select', 'dropdown'], weight: 1.0 },
    { words: ['layout', 'css', 'style', 'visible', 'hidden', 'oculto', 'display'], weight: 0.9 },
    { words: ['modal', 'dialog', 'popup', 'menu', 'navigation', 'nav'], weight: 0.9 },
    { words: ['content', 'text', 'heading', 'title', 'structure', 'estructura', 'page', 'página'], weight: 0.7 },
  ],
  console: [
    { words: ['error', 'warning', 'log', 'console', 'exception', 'crash', 'bug', 'broken', 'roto', 'fallo'], weight: 1.0 },
    { words: ['deprecated', 'obsoleto', 'stack', 'trace', 'traceback'], weight: 0.9 },
    { words: ['uncaught', 'undefined', 'null', 'nan', 'typeerror', 'referenceerror'], weight: 1.1 },
  ],
  performance: [
    { words: ['slow', 'lento', 'fast', 'rápido', 'performance', 'rendimiento', 'optimize', 'optimizar', 'speed', 'velocidad'], weight: 1.0 },
    { words: ['memory', 'memoria', 'leak', 'heap', 'gc', 'garbage'], weight: 1.0 },
    { words: ['cpu', 'thread', 'blocking', 'jank', 'freeze', 'colgado', 'hang'], weight: 1.0 },
    { words: ['layout', 'reflow', 'repaint', 'render', 'fps', 'animation', 'animación'], weight: 0.9 },
    { words: ['load time', 'tti', 'fcp', 'lcp', 'metric', 'métrica'], weight: 0.8 },
  ],
  security: [
    { words: ['security', 'seguridad', 'secure', 'insecure', 'vulnerable', 'csp', 'mixed content', 'mezclado'], weight: 1.0 },
    { words: ['certificate', 'certificado', 'ssl', 'tls', 'https', 'http'], weight: 0.9 },
    { words: ['xss', 'injection', 'cors', 'csrf', 'auth', 'token', 'cookie'], weight: 1.0 },
    { words: ['tracking', 'third-party', 'terceros', 'fingerprint', 'huella'], weight: 0.8 },
  ],
};

export function scoreDomain(question: string, domain: SensorDomain): number {
  const normalized = question.toLowerCase();
  const entries = DOMAIN_KEYWORDS[domain];
  let score = 0;
  for (const entry of entries) {
    for (const word of entry.words) {
      if (normalized.includes(word)) {
        score = Math.max(score, entry.weight);
      }
    }
  }
  return score;
}

export function selectDomains(question: string, threshold = 0.5): SensorDomain[] {
  const allDomains: SensorDomain[] = ['network', 'dom', 'console', 'performance', 'security'];
  const scored = allDomains
    .map((d) => ({ domain: d, score: scoreDomain(question, d) }))
    .filter((s) => s.score >= threshold)
    .sort((a, b) => b.score - a.score);
  return scored.map((s) => s.domain);
}

export function getTopDomain(question: string): SensorDomain | null {
  const domains = selectDomains(question);
  return domains[0] ?? null;
}
```

## Module 2: Observation Types + Builder

**File:** `src/targeting/observation.ts`

```typescript
import type { BrowserState, StateDiff } from '../memory/browser-state.js';
import type { SensorDomain } from './relevance.js';
import type { Anomaly } from '../vision/base-sensor.js';

export type ObservationKind = 'overview' | 'domain_focused' | 'diff' | 'anomaly' | 'composite';

export interface Observation {
  kind: ObservationKind;
  domains: SensorDomain[];
  text: string;               // formatted text for LLM consumption
  tokenEstimate: number;
  timestamp: number;
}

export interface ObservationSpec {
  question: string;
  state: BrowserState;
  diff?: StateDiff | null;
  anomalies?: Anomaly[];
  maxTokens?: number;
}

const CHARS_PER_TOKEN = 4;
const RESERVE_FOR_ACTIONS = 500;
const MIN_SECTION_TOKENS = 100;

export function buildObservation(spec: ObservationSpec): Observation {
  const maxTokens = spec.maxTokens ?? 8000;
  const lines: string[] = [];
  let usedTokens = 0;

  const header = `[BROWSER STATE @ ${new Date(spec.state.timestamp).toISOString()}]\n`;
  lines.push(header);
  usedTokens += estimateTokens(header);

  // Priority 1: anomalies (always included)
  if (spec.anomalies && spec.anomalies.length > 0) {
    const anomalyText = formatAnomalies(spec.anomalies);
    const cost = estimateTokens(anomalyText);
    lines.push(anomalyText);
    usedTokens += cost;
  }

  // Priority 2: domains by relevance
  const domains = selectDomains(spec.question);
  const isOverview = domains.length === 0 || (domains.length === 5 && scoreDomain(spec.question, 'network') < 0.5);

  if (isOverview) {
    const remaining = maxTokens - usedTokens - RESERVE_FOR_ACTIONS;
    const overviewText = formatOverview(spec.state, remaining);
    lines.push(overviewText);
    usedTokens += estimateTokens(overviewText);
    return {
      kind: 'overview',
      domains: ['network', 'dom', 'console', 'performance', 'security'],
      text: lines.join('\n'),
      tokenEstimate: usedTokens,
      timestamp: Date.now(),
    };
  }

  // Domain-focused: show relevant domains with detail
  for (const domain of domains) {
    const remaining = maxTokens - usedTokens - RESERVE_FOR_ACTIONS;
    if (remaining < MIN_SECTION_TOKENS) {
      lines.push(`  (... more data available, use inspect('${domain}') for detail)`);
      break;
    }
    const domainText = formatDomain(domain, spec.state, remaining);
    const cost = estimateTokens(domainText);
    lines.push(domainText);
    usedTokens += cost;
  }

  // Priority 3: diff (if recent action)
  if (spec.diff && usedTokens < maxTokens * 0.8 && spec.diff.fields.length > 0) {
    const diffText = formatDiff(spec.diff);
    lines.push(diffText);
    usedTokens += estimateTokens(diffText);
  }

  return {
    kind: spec.anomalies && spec.anomalies.length > 0 && domains.length > 0 ? 'composite' : 'domain_focused',
    domains,
    text: lines.join('\n'),
    tokenEstimate: usedTokens,
    timestamp: Date.now(),
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function formatAnomalies(anomalies: Anomaly[]): string {
  const lines: string[] = ['⚠ ANOMALIES:'];
  for (const a of anomalies.slice(0, 10)) {
    const icon = a.severity === 'critical' ? '[!]' : a.severity === 'warning' ? '[~]' : '[i]';
    lines.push(`${icon} ${a.domain}: ${a.message}`);
  }
  return lines.join('\n') + '\n';
}

function formatOverview(state: BrowserState, budget: number): string {
  const lines: string[] = [];
  lines.push(`URL: ${state.url}`);
  lines.push(`Title: ${state.title}`);
  lines.push(`Page type: ${state.dom.semantic.pageType}`);
  lines.push('');
  lines.push(`Network: ${state.network.total} requests (${state.network.completed} ok, ${state.network.failed} failed)`);
  if (state.network.slow.length > 0) lines.push(`  Slow: ${state.network.slow.length} requests`);
  lines.push(`Console: ${state.console.errors.length} errors, ${state.console.warnings.length} warnings`);
  lines.push(`Performance: ${state.performance.jsHeapUsedMB}MB heap, ${state.performance.domNodes} DOM nodes`);
  lines.push(`Security: ${state.security.state} (${state.security.totalThreats} threats)`);
  lines.push(`Interactive: ${state.dom.interactive.total} elements (${state.dom.interactive.buttons.length} buttons)`);
  return lines.join('\n');
}

function formatDomain(domain: SensorDomain, state: BrowserState, budget: number): string {
  const lines: string[] = [];
  const header = `\n--- ${domain.toUpperCase()} ---`;
  lines.push(header);

  switch (domain) {
    case 'network': {
      const n = state.network;
      lines.push(`Total: ${n.total} | Completed: ${n.completed} | Failed: ${n.failed} | Pending: ${n.pending}`);
      if (n.slow.length > 0) {
        lines.push('Slow:');
        for (const t of n.slow.slice(0, 5)) {
          lines.push(`  ${(t.durationMs + 'ms').padEnd(8)} ${t.request.method} ${t.request.url.substring(0, 60)}`);
        }
      }
      if (n.failedRequests.length > 0) {
        lines.push('Failed:');
        for (const t of n.failedRequests.slice(0, 5)) {
          lines.push(`  ${t.error?.errorText || '??'}  ${t.request.url.substring(0, 60)}`);
        }
      }
      break;
    }
    case 'dom': {
      const d = state.dom;
      lines.push(`Type: ${d.semantic.pageType} | Title: ${d.semantic.title}`);
      lines.push(`Interactive: ${d.interactive.total} (${d.interactive.buttons.length} buttons, ${d.interactive.links.length} links, ${d.interactive.inputs.length} inputs)`);
      if (d.interactive.buttons.length > 0) {
        lines.push('Buttons:');
        for (const b of d.interactive.buttons.slice(0, 8)) {
          if (b.visible) lines.push(`  [${b.tag}] "${b.text}" → ${b.selector.substring(0, 50)}`);
        }
      }
      break;
    }
    case 'console': {
      const c = state.console;
      lines.push(`Total: ${c.total} | Errors: ${c.errors.length} | Warnings: ${c.warnings.length}`);
      if (c.errors.length > 0) {
        lines.push('Errors:');
        for (const e of c.errors.slice(0, 5)) {
          lines.push(`  ${e.text.substring(0, 80)}${e.count > 1 ? ' (x' + e.count + ')' : ''}`);
        }
      }
      break;
    }
    case 'performance': {
      const p = state.performance;
      lines.push(`Heap: ${p.jsHeapUsedMB}MB / ${p.jsHeapTotalMB}MB (${p.jsHeapTrend})`);
      lines.push(`DOM nodes: ${p.domNodes} | Layouts: ${p.layoutCount} | Style recalc: ${p.recalcStyleCount}`);
      lines.push(`Script: ${p.scriptDurationMs}ms | Task: ${p.taskDurationMs}ms`);
      break;
    }
    case 'security': {
      const s = state.security;
      lines.push(`State: ${s.state} | Scheme: ${s.schemeIsCryptographic ? 'HTTPS' : 'HTTP'}`);
      lines.push(`Threats: ${s.totalThreats} | Mixed content: ${s.mixedContentRequests} | CSP: ${s.cspViolations} | Cert errors: ${s.certificateErrors}`);
      if (s.explanations.length > 0) {
        for (const e of s.explanations.slice(0, 3)) {
          lines.push(`  ${e.title}: ${e.summary}`);
        }
      }
      break;
    }
  }

  return lines.join('\n');
}

function formatDiff(diff: StateDiff): string {
  const lines: string[] = ['\n--- CHANGES SINCE LAST ACTION ---'];
  if (diff.network.requestsDelta !== 0) lines.push(`  Requests: ${diff.network.requestsDelta > 0 ? '+' : ''}${diff.network.requestsDelta}`);
  if (diff.network.failedDelta !== 0) lines.push(`  Failed: ${diff.network.failedDelta > 0 ? '+' : ''}${diff.network.failedDelta}`);
  if (diff.console.errorsDelta !== 0) lines.push(`  Console errors: ${diff.console.errorsDelta > 0 ? '+' : ''}${diff.console.errorsDelta}`);
  if (diff.performance.heapDeltaMB !== 0) lines.push(`  Heap: ${diff.performance.heapDeltaMB > 0 ? '+' : ''}${diff.performance.heapDeltaMB}MB`);
  if (diff.security.stateChanged) lines.push(`  Security: ${diff.security.oldState} → ${diff.security.newState}`);
  if (diff.dom.pageTypeChanged) lines.push(`  Page type: ${diff.dom.oldPageType} → ${diff.dom.newPageType}`);
  return lines.join('\n');
}
```

**IMPORTANT:** `observation.ts` imports `selectDomains` and `scoreDomain` from `./relevance.js`. Add those imports at the top.

## Module 3: Attention Strategies

Each strategy is a simple function that produces part of the observation.

**File:** `src/targeting/strategies/query.ts`

```typescript
import type { BrowserState } from '../../memory/browser-state.js';
import type { SensorDomain } from '../relevance.js';
import { selectDomains } from '../relevance.js';
import { formatDomain } from '../observation.js';

export function queryAttention(question: string, state: BrowserState, maxTokens: number): { domains: SensorDomain[]; text: string } {
  const domains = selectDomains(question);
  const lines: string[] = [];
  for (const domain of domains) {
    lines.push(formatDomain(domain, state, maxTokens / domains.length));
  }
  return { domains, text: lines.join('\n') };
}
```

**File:** `src/targeting/strategies/anomaly.ts`

```typescript
import type { Anomaly } from '../../vision/base-sensor.js';

export function anomalyAttention(anomalies: Anomaly[]): { text: string; count: number } {
  if (anomalies.length === 0) return { text: '', count: 0 };
  const lines: string[] = ['⚠ ANOMALIES DETECTED:'];
  const critical = anomalies.filter((a) => a.severity === 'critical');
  const warnings = anomalies.filter((a) => a.severity === 'warning');
  for (const a of critical.slice(0, 5)) lines.push(`[!] ${a.domain}: ${a.message}`);
  for (const a of warnings.slice(0, 5)) lines.push(`[~] ${a.domain}: ${a.message}`);
  return { text: lines.join('\n'), count: anomalies.length };
}
```

**File:** `src/targeting/strategies/diff.ts`

```typescript
import type { StateDiff } from '../../memory/browser-state.js';

export function diffAttention(diff: StateDiff): { text: string; hasChanges: boolean } {
  if (diff.fields.length === 0) return { text: '', hasChanges: false };
  const lines: string[] = ['--- CHANGES ---'];
  if (diff.network.requestsDelta !== 0) lines.push(`Network requests: ${diff.network.requestsDelta > 0 ? '+' : ''}${diff.network.requestsDelta}`);
  if (diff.network.newFailed > 0) lines.push(`New failures: ${diff.network.newFailed}`);
  if (diff.console.errorsDelta > 0) lines.push(`New errors: +${diff.console.errorsDelta}`);
  if (diff.performance.heapDeltaMB !== 0) lines.push(`Heap: ${diff.performance.heapDeltaMB > 0 ? '+' : ''}${diff.performance.heapDeltaMB}MB`);
  if (diff.security.stateChanged) lines.push(`Security: ${diff.security.oldState} → ${diff.security.newState}`);
  if (diff.dom.pageTypeChanged) lines.push(`Page changed: ${diff.dom.oldPageType} → ${diff.dom.newPageType}`);
  return { text: lines.join('\n'), hasChanges: true };
}
```

**File:** `src/targeting/strategies/overview.ts`

```typescript
import type { BrowserState } from '../../memory/browser-state.js';

export function overviewAttention(state: BrowserState): string {
  const lines: string[] = ['--- OVERVIEW ---'];
  lines.push(`${state.dom.semantic.pageType} | ${state.url}`);
  lines.push(`Network: ${state.network.total} req (${state.network.failed} failed) | Console: ${state.console.errors.length} err | Heap: ${state.performance.jsHeapUsedMB}MB | Security: ${state.security.state}`);
  lines.push(`Interactive: ${state.dom.interactive.total} elements (${state.dom.interactive.buttons.length} buttons)`);
  return lines.join('\n');
}
```

## Module 4: Attention Router

**File:** `src/targeting/router.ts`

```typescript
import type { BrowserState, StateDiff } from '../memory/browser-state.js';
import type { Anomaly } from '../vision/base-sensor.js';
import type { Observation } from './observation.js';
import { buildObservation, type ObservationSpec } from './observation.js';
import { selectDomains, scoreDomain } from './relevance.js';
import { anomalyAttention } from './strategies/anomaly.js';
import { diffAttention } from './strategies/diff.js';
import { overviewAttention } from './strategies/overview.js';

export interface RouterContext {
  lastActionTime?: number;
  beforeState?: BrowserState;
}

export class AttentionRouter {
  private anomalyThreshold = 0.5;

  /**
   * Produce an observation for the LLM based on its question.
   */
  observe(
    question: string,
    state: BrowserState,
    anomalies: Anomaly[],
    diff?: StateDiff | null,
    ctx?: RouterContext,
    maxTokens?: number,
  ): Observation {
    // Determine if this is a diff-context (recent action)
    const isPostAction = ctx?.lastActionTime != null && (Date.now() - ctx.lastActionTime) < 10000;
    const hasAnomalies = anomalies.length > 0;
    const hasDiff = isPostAction && diff && diff.fields.length > 0;

    // Build the full observation via the builder
    return buildObservation({
      question,
      state,
      diff: hasDiff ? diff : null,
      anomalies: hasAnomalies ? anomalies : undefined,
      maxTokens,
    });
  }

  /**
   * Quick check: is this question generic (no specific domain)?
   */
  isGenericQuestion(question: string): boolean {
    const domains = selectDomains(question);
    return domains.length === 0 || (domains.length === 5 && scoreDomain(question, 'network') < this.anomalyThreshold);
  }
}
```

## Implementation Notes

1. **`observation.ts`** is the heaviest file — it contains all the formatting logic. The `formatDomain`, `formatOverview`, `formatAnomalies`, and `formatDiff` functions are internal (not exported). Only `buildObservation`, `Observation`, and `ObservationSpec` are exported.

2. **Token estimation** uses a simple heuristic: `chars / 4 ≈ tokens`. This is approximate but sufficient for budgeting.

3. **The router composes strategies** but delegates actual formatting to `buildObservation`. The strategies (query, anomaly, diff, overview) are available as standalone functions for testing and custom composition.

4. **Import chains:** observation.ts imports from relevance.ts. Strategies import from observation.ts and relevance.ts. Router imports from all.

5. **No `any` in exported types.** CDP data that flows through is typed via the sensor summaries.

6. **Strategy files are thin** — they contain one exported function each. This makes them independently testable and composable.

## Test cases

### relevance.test.ts

```
- scoreDomain returns 0 for unrelated question
- scoreDomain returns >0 for "why is this slow" → performance
- scoreDomain returns >0 for "what errors" → console
- scoreDomain returns >0 for "security issues" → security
- scoreDomain handles bilingual keywords (lento, error, memoria)
- scoreDomain: "blocked" gets higher weight (1.2) for network
- scoreDomain: "typeerror" gets higher weight (1.1) for console
- selectDomains returns sorted by score descending
- selectDomains returns empty for completely unrelated question
- selectDomains threshold filters low-scoring domains
- getTopDomain returns highest scoring domain
- getTopDomain returns null for unrelated question
```

### router.test.ts

```
- observe returns overview for generic question ("what is on this page?")
- observe returns domain_focused for specific question ("why is this slow?")
- observe includes anomalies when present
- observe includes diff when post-action context provided
- observe omits diff when no recent action
- observe respects maxTokens budget
- observe truncates with inspect hint when budget exceeded
- isGenericQuestion returns true for "what is here?"
- isGenericQuestion returns false for "why is network slow?"
- query attention shows relevant domains only
- anomaly attention shows critical first
- diff attention shows changed fields
- overview shows all domains at high level
- formatDomain network shows slow and failed requests
- formatDomain dom shows buttons and page type
- formatDomain console shows errors with dedup count
- formatDomain performance shows heap and metrics
- formatDomain security shows state and threats
```

## Deliverables

1. `src/targeting/relevance.ts`
2. `src/targeting/observation.ts`
3. `src/targeting/strategies/query.ts`
4. `src/targeting/strategies/anomaly.ts`
5. `src/targeting/strategies/diff.ts`
6. `src/targeting/strategies/overview.ts`
7. `src/targeting/router.ts`
8. `tests/targeting/relevance.test.ts`
9. `tests/targeting/router.test.ts`

After writing: `cd D:\Yautja && npx vitest run && npm run lint`
Report full output.
