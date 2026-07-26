# Yautja — Bio-Helmet for Browser-Hunting LLMs

**Spec v1.0** | 2026-07-09

## Problem

An LLM wants to understand and control a browser. CDP produces a firehose of data — thousands of network events, megabytes of DOM, continuous console output, gigabyte traces. The LLM has a limited context window. It cannot see everything.

Existing solutions (Puppeteer, Playwright, chrome_devtools_mcp.py, browser-use) expose raw CDP commands as tools. The LLM must know which command to call, receives raw data, has no state between commands, and no concept of what's relevant.

## Solution

Yautja is a **sensory cortex** between CDP and the LLM. Named after the Predator's bio-helmet — the device that takes raw sensory input and filters it into tactical vision.

The LLM is the hunter. Yautja is its helmet.

## Architecture — 5 Layers

```
LLM (MiniMax M3 / any model with tool-use)
  ↕ questions ↔ actions
┌─────────────────────────────────────────────┐
│ 5. NEURAL-LINK    tools.ts · context.ts      │  Exposes capabilities to LLM
│ 4. ARSENAL        translator.ts              │  Intent → CDP commands
│ 3. TARGETING      router.ts · strategies/    │  Decides WHAT to show LLM
│ 2. MEMORY         browser-state.ts           │  Rolling browser state
│ 1. VISION         thermal · em · audio ·     │  Stream processors (CDP events)
│                   motion · threat            │
│ 0. CONNECTION     cdp-session.ts             │  Playwright CDP session
└─────────────────────────────────────────────┘
  ↕
Browser (CDP :9222)
```

## Layer 0 — Connection

Playwright CDP session. Provides reliable WebSocket, reconnection, multi-tab.

```typescript
class CDPSessionManager {
  async connect(cdpUrl: string): Promise<void>
  async enableDomains(domains: string[]): Promise<void>
  on(event: string, handler: (params: any) => void): void
  async send(method: string, params?: any): Promise<any>
}
```

## Layer 1 — Vision (Sensors)

Five stream processors. Push-based: process events continuously, not on-demand. Each has a bounded rolling buffer.

### Base

```typescript
abstract class BaseSensor<TEvent, TSummary> {
  protected buffer: RollingBuffer<TEvent>;
  subscribe(session: CDPSession): void
  summarize(query?: SensorQuery): TSummary
  getAnomalies(): Anomaly[]
}
```

### Thermal (Network)

Tracks complete request lifecycle via state machine (9 states: pending, redirecting, receiving, completed, failed, serviced_by_sw, preflight, cached, data_url). Correlates redirect chains. Detects streaming responses. Classifies third-party. Separates API calls from assets.

Summaries: slow requests, failures, third-party, active streams, API calls, total transfer.

### EM (DOM)

Four semantic views:
- **Semantic**: page type detection (login, dashboard, article, form, search, chat, settings, error), title, headings, main content
- **Interactive**: buttons, links, inputs, forms, modals, nav menus — with stable IDs, selectors, visibility
- **Structural**: depth, node count, iframes, shadow roots, canvases
- **Mutations**: added/removed nodes, attribute changes, text changes, hotspots

Shadow DOM via `DOM.getShadowRoots`. Iframes via separate execution contexts.

### Audio (Console)

Errors, warnings, logs. Deduplication of repeated messages within time window. Classifies: TypeError, CORS, deprecation, uncaught.

### Motion (Performance)

Performance metrics polling (TaskDuration, ScriptDuration, LayoutDuration, JSHeapUsedSize, Nodes, LayoutCount). Long task detection. Layout thrashing detection.

### Threat (Security)

Security state (secure/insecure/broken). Mixed content. CSP violations. Certificate errors. Tracks via `Security.securityStateChanged` + blocked network requests.

## Layer 2 — Memory (Working State)

```typescript
interface BrowserState {
  url: string;
  title: string;
  readyState: 'loading' | 'interactive' | 'complete';
  timestamp: number;
  network: NetworkSummary;
  dom: DOMSummary;
  console: ConsoleSummary;
  performance: PerformanceSummary;
  security: SecuritySummary;
}

class WorkingMemory {
  private current: BrowserState;
  private history: RollingBuffer<BrowserState>;  // max 10 snapshots
  update(partial: Partial<BrowserState>): void
  snapshot(): BrowserState
  diff(before: BrowserState, after: BrowserState): StateDiff
}
```

## Layer 3 — Targeting (Attention Router)

Decides what to show the LLM based on its question. Keyword matrix + relevance scoring.

```typescript
class AttentionRouter {
  observe(question: string, memory: WorkingMemory, ctx?: ActionContext): Observation
}
```

Four strategies, composable:

| Strategy | Trigger | Output |
|---|---|---|
| QueryAttention | Specific question | Only relevant domains, focused detail |
| AnomalyAttention | Unusual event detected | Proactive alert |
| DiffAttention | After an action | What changed |
| OverviewAttention | Generic exploration | High-level all domains |

Relevance algorithm: domain-keyword matrix with weights. Score per domain per question. Threshold 0.5. Below threshold → overview.

Anomaly rules (configurable): error spikes, failure rates, latency thresholds, heap pressure, security issues.

## Layer 4 — Arsenal (Actions)

55 actions in 10 categories as discriminated union:

Navigation (4) · Interaction (12) · JavaScript (2) · Capture (3) · Network Control (4) · Storage (8) · Debugging (6) · Device Emulation (6) · Inspection (4) · Tab Management (4) · Wait (2)

Actions are type-safe and exhaustive. Translator maps each to CDP commands.

Error handling: 14-type taxonomy with severity (transient/recoverable/fatal) and auto-retry for transient.

## Layer 5 — Neural-Link (LLM Interface)

Two modes:
- **Tools**: 4 tools — `observe`, `act`, `inspect`, `diff`. LLM doesn't need to know 55 actions or 50 CDP commands.
- **Context**: Auto-inject browser observation before each LLM turn.

Observation builder: token-budget aware. Prioritizes anomalies → relevant domains → diff. Graceful truncation with `inspect` hint.

Live streaming: push-based event subscription with debounce and filtering.

## Cortex Lifecycle

```typescript
type CortexState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'idle' }        // sensors active, no action in progress
  | { status: 'acting' }      // action executing
  | { status: 'navigating' }  // page loading
  | { status: 'error'; recoverable: boolean };
```

Actions serialize (one at a time). Inspect is non-blocking (reads memory). After each action: `waitForStabilization` (network idle 500ms, DOM stable 300ms, max 5s timeout).

## Configuration

Layered config with defaults. All buffer sizes, thresholds, timeouts explicitly defined and overridable at runtime.

Key defaults: network buffer 200, DOM interactive max 50, console max 100, observation max 8000 tokens, long task threshold 50ms, slow request threshold 2000ms.

## Testing

Three levels:
- **Unit**: Each component isolated, CDP event replay from recorded sessions
- **Integration**: Full cortex with real browser
- **E2E**: LLM + cortex + browser, real questions

CDP recorder captures real sessions as JSON fixtures for deterministic replay.

## Package Structure

```
yautja/
├── src/
│   ├── connection/
│   │   └── cdp-session.ts
│   ├── vision/
│   │   ├── base-sensor.ts
│   │   ├── thermal.ts        (network)
│   │   ├── em.ts             (dom)
│   │   ├── audio.ts          (console)
│   │   ├── motion.ts         (performance)
│   │   └── threat.ts         (security)
│   ├── memory/
│   │   ├── browser-state.ts
│   │   ├── rolling-buffer.ts
│   │   └── state-history.ts
│   ├── targeting/
│   │   ├── router.ts
│   │   ├── relevance.ts
│   │   └── strategies/
│   │       ├── query.ts
│   │       ├── anomaly.ts
│   │       ├── diff.ts
│   │       └── overview.ts
│   ├── arsenal/
│   │   ├── action-types.ts
│   │   ├── translator.ts
│   │   └── errors.ts
│   ├── neural-link/
│   │   ├── tools.ts
│   │   ├── context-builder.ts
│   │   └── observation.ts
│   ├── config.ts
│   └── helmet.ts             (orchestrator)
├── tests/
├── package.json
└── tsconfig.json
```

## Implementation Phases

| Phase | Module | Deps | Complexity |
|---|---|---|---|
| 1 | connection/ + memory/rolling-buffer.ts | None | Low |
| 2 | vision/base-sensor.ts + vision/thermal.ts | 1 | Medium |
| 3 | vision/audio.ts + vision/em.ts | 1 | Medium |
| 4 | vision/motion.ts + vision/threat.ts | 1 | Medium |
| 5 | memory/browser-state.ts + state-history.ts | 2-4 | Low |
| 6 | targeting/ (router + strategies + relevance) | 5 | High |
| 7 | arsenal/ (translator + action-types + errors) | 1 | Medium |
| 8 | neural-link/ (tools + context + observation) | 5-7 | Low |
| 9 | helmet.ts (orchestrator) + config.ts | All | Medium |

Each phase: spec → MiniMax M3 implements → test against real browser → iterate.

---

## Addendum 2026-07-26 (v0.2.0 — roadmap P10–P18)

New layers on top of the original 5:

```
6. DOCTRINE   error contract (YautjaResponse envelope, 23 YJ.* codes),
              recovery machine, gates P0–P4, site profiles, backends
7. ECONOMIC   quota/budget view per domain (passive, OPSEC-safe)
```

- **Envelope:** every MCP tool response is a `YautjaResponse` (schema 1.0). Native for ~40 tools; legacy shim for the rest (kill-switch `YAUTJA_LEGACY_SHIM=0`).
- **Input atomicity:** type = transaction (RecoveryMachine) with ensureEmpty, verify, rollback, anti blind-retry.
- **Declarative waits:** wait-for-ui engine (networkIdle real via Thermal, textSettled, ariaBusy…); extractAnswer settled+chunked.
- **Policy in the helmet:** site profiles (JSON) enforce intercept/stealth/quota/captcha per domain; session gates P0–P4 for browserFetch; tab identity verified (TabRegistry).
- **Trusted gestures:** trustedClick / trustedFileChooser (isTrusted real), typed CAPABILITY_MISSING, never fake success.
- **Resources:** MCP resources/list|read over traces + evidence (TTL 7d GC); canonical layout `%APPDATA%/.yautja/{sessions,evidence,har,traces,snapshots,profiles}`.
- **Backends:** delegate router (yautja native / chrome-devtools / superapi) via `~/.yautja/backends.json`.

See `docs/envelope-migration-tracker.md`, `docs/capture-modes.md`, `docs/CHANGELOG.md`.
