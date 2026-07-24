# Task 8 Brief — Trace Store + Telemetry

**Source plan:** `D:\Yautja\proyectos-pendientes\2026-07-15-yautja-error-contract-plan.md`
**Repo:** `D:\Yautja` (branch: main)
**Spec:** `D:\Yautja\proyectos-pendientes\yautja-error-contract-1.0.md`
**Ledger:** `D:\Yautja\.superpowers\sdd\error-contract-progress.md`
**Prior task:** Task 7 (commits `ca963ad` + `f5f9829`)

## Scene-setting

You are implementing Task 8: two modules that complement each other.

1. **TraceStore** — filesystem-based storage for DOM snapshots, network windows, screenshots. Uses the `resource://yautja/traces/...` URI pattern.
2. **TelemetryCollector** — in-memory recorder for `RecoveryOutcome` events. Provides `query()` and `stats()` for the `yautja_recovery_stats` tool (Task 9).

**Important: this task uses filesystem operations.** Tests create a temp directory and clean it up after. On Windows, use `path.join` correctly and ensure paths are absolute.

**Important: run `npx tsc --noEmit` before reporting done.** Task 7's reviewer found that vitest pass does NOT catch tsc errors. Always verify with tsc.

## Files

- Create: `src/doctrine/trace-store.ts`
- Create: `src/doctrine/telemetry.ts`
- Create: `tests/doctrine/trace-store.test.ts`
- Create: `tests/doctrine/telemetry.test.ts`

## Step 1: Write failing tests for trace store

Create `tests/doctrine/trace-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TraceStore } from '../../src/doctrine/trace-store.js';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = join(process.cwd(), 'tests', 'tmp-traces');

describe('TraceStore', () => {
  let store: TraceStore;

  beforeEach(() => {
    store = new TraceStore({ rootDir: TEST_DIR, ttlDays: 7 });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('saves and reads a DOM snapshot', async () => {
    const uri = await store.saveDomSnapshot('tr_test', 1, '<html>snapshot</html>');
    expect(uri).toBe(`resource://yautja/traces/tr_test/dom/1`);
    const content = await store.readResource(uri);
    expect(content).toBe('<html>snapshot</html>');
  });

  it('saves and reads network window', async () => {
    const uri = await store.saveNetworkWindow('tr_test', '[{"url":"http://x"}]');
    expect(uri).toContain('network');
    const content = await store.readResource(uri);
    expect(content).toContain('http://x');
  });

  it('returns null for non-existent resource', async () => {
    const content = await store.readResource('resource://yautja/traces/tr_bogus/dom/999');
    expect(content).toBeNull();
  });

  it('lists traces for cleanup', () => {
    const expired = store.findExpired(0);
    expect(Array.isArray(expired)).toBe(true);
  });
});
```

## Step 2: Implement trace-store.ts

Create `src/doctrine/trace-store.ts`:

```typescript
import { mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface TraceStoreConfig {
  rootDir: string;
  ttlDays: number;
}

export class TraceStore {
  private config: TraceStoreConfig;

  constructor(config: TraceStoreConfig) {
    this.config = config;
  }

  async saveDomSnapshot(traceId: string, snapshotId: number, content: string): Promise<string> {
    const dir = join(this.config.rootDir, traceId, 'dom');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${snapshotId}.json`);
    await writeFile(filePath, content, 'utf-8');
    return `resource://yautja/traces/${traceId}/dom/${snapshotId}`;
  }

  async saveNetworkWindow(traceId: string, content: string): Promise<string> {
    const dir = join(this.config.rootDir, traceId);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'network.json');
    await writeFile(filePath, content, 'utf-8');
    return `resource://yautja/traces/${traceId}/network`;
  }

  async saveScreenshot(traceId: string, snapshotId: number, base64Png: string): Promise<string> {
    const dir = join(this.config.rootDir, traceId, 'screenshot');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${snapshotId}.png`);
    await writeFile(filePath, Buffer.from(base64Png, 'base64'));
    return `resource://yautja/traces/${traceId}/screenshot/${snapshotId}`;
  }

  async readResource(uri: string): Promise<string | null> {
    const path = this.uriToPath(uri);
    if (!path) return null;
    try {
      return await readFile(path, 'utf-8');
    } catch {
      return null;
    }
  }

  findExpired(ttlDays?: number): string[] {
    const ttl = ttlDays ?? this.config.ttlDays;
    const cutoff = Date.now() - ttl * 24 * 60 * 60 * 1000;
    const expired: string[] = [];
    return expired;
  }

  async purgeTrace(traceId: string): Promise<void> {
    const dir = join(this.config.rootDir, traceId);
    await rm(dir, { recursive: true, force: true });
  }

  private uriToPath(uri: string): string | null {
    const match = uri.match(/^resource:\/\/yautja\/traces\/([^/]+)\/(.+)$/);
    if (!match) return null;
    const [, traceId, rest] = match;
    if (rest === 'network') {
      return join(this.config.rootDir, traceId, 'network.json');
    }
    const parts = rest.split('/');
    const fileName = parts[0] === 'dom' ? `${parts[1]}.json` : `${parts[1]}.png`;
    return join(this.config.rootDir, traceId, parts[0], fileName);
  }
}
```

Note: The `findExpired` method is a stub per the brief (it returns an empty array). Real implementation reads directories. Tests only check that the method exists and returns an array.

## Step 3: Write failing tests for telemetry

Create `tests/doctrine/telemetry.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { TelemetryCollector, type RecoveryOutcome } from '../../src/doctrine/telemetry.js';

describe('TelemetryCollector', () => {
  let telemetry: TelemetryCollector;

  beforeEach(() => {
    telemetry = new TelemetryCollector();
  });

  it('records a recovery outcome', () => {
    telemetry.record({
      trace_id: 'tr_1',
      operation_id: 'op_1',
      original_error_code: 'YJ.ACT.DOM_TARGET_STALE',
      recovery_strategy: 'REOBSERVE_THEN_RETRY',
      attempts: 2,
      outcome: 'recovered',
      time_to_recover_ms: 500,
      context_cost_delta_tokens: 200,
      deviated_from_recommendation: false,
    });
    expect(telemetry.count()).toBe(1);
  });

  it('queries outcomes by error code', () => {
    telemetry.record({
      trace_id: 'tr_1', operation_id: 'op_1',
      original_error_code: 'YJ.ACT.DOM_TARGET_STALE',
      recovery_strategy: 'REOBSERVE_THEN_RETRY', attempts: 2,
      outcome: 'recovered', time_to_recover_ms: 500,
      context_cost_delta_tokens: 200, deviated_from_recommendation: false,
    });
    telemetry.record({
      trace_id: 'tr_2', operation_id: 'op_2',
      original_error_code: 'YJ.NET.REQUEST_TIMEOUT',
      recovery_strategy: 'RETRY_SAME', attempts: 3,
      outcome: 'failed', time_to_recover_ms: 3000,
      context_cost_delta_tokens: 0, deviated_from_recommendation: false,
    });
    const staleOutcomes = telemetry.query({ code: 'YJ.ACT.DOM_TARGET_STALE' });
    expect(staleOutcomes).toHaveLength(1);
    expect(staleOutcomes[0].outcome).toBe('recovered');
  });

  it('computes recovery success rate', () => {
    for (let i = 0; i < 4; i++) {
      telemetry.record({
        trace_id: `tr_${i}`, operation_id: `op_${i}`,
        original_error_code: 'YJ.ACT.DOM_TARGET_STALE',
        recovery_strategy: 'REOBSERVE_THEN_RETRY', attempts: 2,
        outcome: i < 3 ? 'recovered' : 'failed',
        time_to_recover_ms: 500, context_cost_delta_tokens: 100,
        deviated_from_recommendation: false,
      });
    }
    const stats = telemetry.stats({ code: 'YJ.ACT.DOM_TARGET_STALE' });
    expect(stats.total).toBe(4);
    expect(stats.recovered).toBe(3);
    expect(stats.successRate).toBe(0.75);
  });
});
```

## Step 4: Implement telemetry.ts

Create `src/doctrine/telemetry.ts`:

```typescript
export interface RecoveryOutcome {
  trace_id: string;
  operation_id: string;
  original_error_code: string;
  recovery_strategy: string;
  attempts: number;
  outcome: 'recovered' | 'recovered_with_degradation' | 'failed' | 'deviated';
  time_to_recover_ms: number;
  context_cost_delta_tokens: number;
  deviated_from_recommendation: boolean;
}

export interface OutcomeStats {
  total: number;
  recovered: number;
  failed: number;
  deviated: number;
  successRate: number;
  avgTimeToRecoverMs: number;
  avgContextCostTokens: number;
}

export interface QueryFilter {
  code?: string;
  strategy?: string;
  tool?: string;
  since?: number;
}

export class TelemetryCollector {
  private outcomes: RecoveryOutcome[] = [];

  record(outcome: RecoveryOutcome): void {
    this.outcomes.push(outcome);
  }

  count(): number {
    return this.outcomes.length;
  }

  query(filter: QueryFilter): RecoveryOutcome[] {
    return this.outcomes.filter(o => {
      if (filter.code && o.original_error_code !== filter.code) return false;
      if (filter.strategy && o.recovery_strategy !== filter.strategy) return false;
      if (filter.since && o.trace_id < `tr_${filter.since}`) return false;
      return true;
    });
  }

  stats(filter: QueryFilter): OutcomeStats {
    const filtered = this.query(filter);
    if (filtered.length === 0) {
      return {
        total: 0, recovered: 0, failed: 0, deviated: 0,
        successRate: 0, avgTimeToRecoverMs: 0, avgContextCostTokens: 0,
      };
    }
    const recovered = filtered.filter(o => o.outcome === 'recovered' || o.outcome === 'recovered_with_degradation').length;
    const failed = filtered.filter(o => o.outcome === 'failed').length;
    const deviated = filtered.filter(o => o.outcome === 'deviated').length;
    const avgTime = filtered.reduce((s, o) => s + o.time_to_recover_ms, 0) / filtered.length;
    const avgCost = filtered.reduce((s, o) => s + o.context_cost_delta_tokens, 0) / filtered.length;
    return {
      total: filtered.length,
      recovered,
      failed,
      deviated,
      successRate: recovered / filtered.length,
      avgTimeToRecoverMs: Math.round(avgTime),
      avgContextCostTokens: Math.round(avgCost),
    };
  }

  clear(): void {
    this.outcomes = [];
  }
}
```

## Step 5: Run all Task 8 tests

```bash
cd D:\Yautja
npx tsc --noEmit  # REQUIRED — vitest doesn't catch tsc errors
npx vitest run tests/doctrine/trace-store.test.ts tests/doctrine/telemetry.test.ts
```

Expected: tsc 0 errors; 7 tests pass (4 trace-store + 3 telemetry).

## Step 6: Commit

```bash
git add src/doctrine/trace-store.ts src/doctrine/telemetry.ts tests/doctrine/trace-store.test.ts tests/doctrine/telemetry.test.ts
git commit -m "feat(doctrine): add trace store (filesystem) and telemetry collector"
```

## Report Contract

Write to `D:\Yautja\.superpowers\sdd\error-task-8-report.md`. Return ONLY: status, commit hashes, one-line test summary (must include tsc result), concerns.