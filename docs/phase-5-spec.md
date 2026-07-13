# Yautja — Phase 5 Implementation Spec

## Context

Phases 1-4 DONE. 200 tests passing. Five sensors implemented: Thermal, EM, Audio, Motion, Threat. All extend `BaseSensor` with async `summarize()`.

Phase 5 builds the **Working Memory** — the hippocampus that aggregates all 5 sensors into a single `BrowserState` snapshot and maintains a rolling history.

## Modules

1. `src/memory/browser-state.ts` — types + `WorkingMemory` class
2. `src/memory/state-history.ts` — rolling history of state snapshots with diff
3. `tests/memory/browser-state.test.ts`

## Module 1: BrowserState types

**File:** `src/memory/browser-state.ts`

```typescript
import type { NetworkSummary } from '../vision/thermal.js';
import type { DOMSummary } from '../vision/em.js';
import type { ConsoleSummary } from '../vision/audio.js';
import type { PerformanceSummary } from '../vision/motion.js';
import type { SecuritySummary } from '../vision/threat.js';

export interface BrowserState {
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

export interface StateDiff {
  fields: string[];
  network: {
    requestsDelta: number;
    completedDelta: number;
    failedDelta: number;
    newSlow: number;
    newFailed: number;
  };
  console: {
    errorsDelta: number;
    warningsDelta: number;
  };
  performance: {
    heapDeltaMB: number;
    domNodesDelta: number;
  };
  security: {
    threatsDelta: number;
    stateChanged: boolean;
    oldState?: string;
    newState?: string;
  };
  dom: {
    pageTypeChanged: boolean;
    oldPageType?: string;
    newPageType?: string;
    interactiveElementsDelta: number;
  };
}
```

## Module 2: WorkingMemory class

**File:** `src/memory/browser-state.ts` (same file)

```typescript
import { RollingBuffer } from './rolling-buffer.js';

export class WorkingMemory {
  private current: BrowserState | null = null;
  private history: RollingBuffer<BrowserState>;
  private maxSnapshots: number;

  constructor(maxSnapshots = 10) {
    this.history = new RollingBuffer(maxSnapshots);
    this.maxSnapshots = maxSnapshots;
  }

  /**
   * Build a new BrowserState from sensor summaries.
   * The caller provides all 5 sensor summaries + page metadata.
   */
  update(state: BrowserState): void {
    if (this.current) {
      this.history.push(this.current);
    }
    this.current = state;
  }

  /**
   * Get the current state snapshot.
   * Returns null if no state has been set yet.
   */
  snapshot(): BrowserState | null {
    return this.current;
  }

  /**
   * Get the previous N states (oldest to newest).
   */
  getHistory(): BrowserState[] {
    return this.history.toArray();
  }

  /**
   * Compute a diff between two states.
   * If no arguments, diffs current vs the most recent history entry.
   */
  diff(before?: BrowserState, after?: BrowserState): StateDiff | null {
    const a = before ?? this.history.last() ?? null;
    const b = after ?? this.current;
    if (!a || !b) return null;
    return computeDiff(a, b);
  }

  clear(): void {
    this.current = null;
    this.history.clear();
  }

  get size(): number {
    return (this.current ? 1 : 0) + this.history.length;
  }
}
```

### computeDiff function

```typescript
function computeDiff(before: BrowserState, after: BrowserState): StateDiff {
  const fields: string[] = [];

  if (before.url !== after.url) fields.push('url');
  if (before.title !== after.title) fields.push('title');
  if (before.readyState !== after.readyState) fields.push('readyState');

  const networkBefore = before.network;
  const networkAfter = after.network;

  const requestsDelta = networkAfter.total - networkBefore.total;
  const completedDelta = networkAfter.completed - networkBefore.completed;
  const failedDelta = networkAfter.failed - networkBefore.failed;
  const newSlow = Math.max(0, networkAfter.slow.length - networkBefore.slow.length);
  const newFailed = Math.max(0, networkAfter.failedRequests.length - networkBefore.failedRequests.length);

  if (requestsDelta !== 0) fields.push('network.total');
  if (completedDelta !== 0) fields.push('network.completed');
  if (failedDelta !== 0) fields.push('network.failed');

  const errorsDelta = after.console.errors.length - before.console.errors.length;
  const warningsDelta = after.console.warnings.length - before.console.warnings.length;
  if (errorsDelta !== 0) fields.push('console.errors');
  if (warningsDelta !== 0) fields.push('console.warnings');

  const heapDeltaMB = Math.round((after.performance.jsHeapUsedMB - before.performance.jsHeapUsedMB) * 10) / 10;
  const domNodesDelta = after.performance.domNodes - before.performance.domNodes;
  if (heapDeltaMB !== 0) fields.push('performance.heap');
  if (domNodesDelta !== 0) fields.push('performance.domNodes');

  const threatsDelta = after.security.totalThreats - before.security.totalThreats;
  const stateChanged = before.security.state !== after.security.state;
  if (threatsDelta !== 0) fields.push('security.threats');
  if (stateChanged) fields.push('security.state');

  const pageTypeChanged = before.dom.semantic.pageType !== after.dom.semantic.pageType;
  const interactiveElementsDelta = after.dom.interactive.total - before.dom.interactive.total;
  if (pageTypeChanged) fields.push('dom.pageType');
  if (interactiveElementsDelta !== 0) fields.push('dom.interactive');

  return {
    fields,
    network: { requestsDelta, completedDelta, failedDelta, newSlow, newFailed },
    console: { errorsDelta, warningsDelta },
    performance: { heapDeltaMB, domNodesDelta },
    security: {
      threatsDelta,
      stateChanged,
      oldState: stateChanged ? before.security.state : undefined,
      newState: stateChanged ? after.security.state : undefined,
    },
    dom: {
      pageTypeChanged,
      oldPageType: pageTypeChanged ? before.dom.semantic.pageType : undefined,
      newPageType: pageTypeChanged ? after.dom.semantic.pageType : undefined,
      interactiveElementsDelta,
    },
  };
}
```

## Module 3: StateHistory (optional helper)

The RollingBuffer already serves as the history. `WorkingMemory.getHistory()` returns `this.history.toArray()`. No separate class needed — keep it in browser-state.ts.

## Implementation Notes

1. `BrowserState` is a **plain data object** — no methods, just fields. The caller (helmet.ts in Phase 9) constructs it from sensor summaries.

2. `WorkingMemory.update()` pushes the previous current state to history before setting the new one. This maintains a rolling window of past states.

3. `diff()` with no arguments compares the current state against the most recent history entry. This is the common case (what changed since last snapshot).

4. `computeDiff` only tracks **deltas** (counts changed), not individual items. The actual new items can be found by comparing the full arrays if needed.

5. `fields` array in `StateDiff` lists which top-level fields changed, for quick scanning.

6. The `StateDiff` type must handle the case where sensor summaries have arrays (like `network.slow`, `console.errors`). The diff tracks array LENGTH changes, not element-level diffs.

## Test cases

```
WorkingMemory:
- update sets current state
- snapshot returns current state (null before first update)
- update pushes previous state to history
- getHistory returns oldest-to-newest array
- history respects maxSnapshots (eviction)
- diff with no args compares current vs last history entry
- diff with explicit before/after args
- diff returns null when no history exists
- diff returns null when no current state
- diff detects url change
- diff detects title change
- diff detects network request count change
- diff detects console error count change
- diff detects heap change
- diff detects security state change
- diff detects page type change
- diff detects interactive elements change
- diff fields array lists all changed fields
- clear resets everything
- size returns correct count (current + history)
- handles 5 sensor summaries in a realistic BrowserState

computeDiff edge cases:
- identical states produce all-zero deltas and empty fields
- negative deltas (items removed) tracked correctly
- large delta values don't overflow
```

## Deliverables

1. `src/memory/browser-state.ts`
2. `tests/memory/browser-state.test.ts`

After writing: `cd D:\Yautja && npx vitest run && npm run lint`
Report full output.
