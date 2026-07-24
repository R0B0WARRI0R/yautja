# Task 6 Brief — Retry Engine

**Source plan:** `D:\Yautja\proyectos-pendientes\2026-07-15-yautja-error-contract-plan.md`
**Repo:** `D:\Yautja` (branch: main)
**Spec:** `D:\Yautja\proyectos-pendientes\yautja-error-contract-1.0.md`
**Ledger:** `D:\Yautja\.superpowers\sdd\error-contract-progress.md`
**Prior task:** Task 5 (commit `1fc8a99`)

## Scene-setting

You are implementing Task 6: the Retry Engine. It takes a `RetryPolicy` and decides whether to retry, what backoff delay to use, and what the next escalation strategy is. This is used by the recovery machine (Task 7) to wrap tool execution.

Three backoff kinds: `exponential_jitter` (default), `fixed`, `linear`. The engine must respect both `retry_on` (allowlist) and `never_retry_on` (denylist) — `never_retry_on` wins.

## Files

- Create: `src/doctrine/retry-engine.ts`
- Create: `tests/doctrine/retry-engine.test.ts`

## Interfaces

- **Consumes:** nothing beyond standard libs
- **Produces:**
  - `BackoffPolicy` interface (kind, base_ms, max_ms)
  - `RetryPolicy` interface (policy_id, max_attempts, backoff, retry_on, never_retry_on, escalation)
  - `calculateBackoff(policy, attempt)` — pure function
  - `RetryEngine` class with `shouldRetry(code, attempt)`, `nextEscalation(attempt)`, `getDelay(attempt)`
  - `DEFAULT_RETRY_POLICIES` const map with 4 policies: act.click, act.type, act.navigate, default

## Step 1: Write failing tests

Create `tests/doctrine/retry-engine.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { RetryEngine, calculateBackoff, type RetryPolicy } from '../../src/doctrine/retry-engine.js';

describe('Retry Engine', () => {
  const samplePolicy: RetryPolicy = {
    policy_id: 'act.click.v1',
    max_attempts: 3,
    backoff: { kind: 'exponential_jitter', base_ms: 100, max_ms: 1000 },
    retry_on: ['YJ.ACT.DOM_TARGET_STALE', 'YJ.NET.REQUEST_TIMEOUT'],
    never_retry_on: ['YJ.OPSEC.ANOMALY_RISK_ELEVATED', 'YJ.ACT.ACTION_NOT_IDEMPOTENT'],
    escalation: ['RETRY_SAME', 'REOBSERVE_THEN_RETRY', 'ROLLBACK_TO_CHECKPOINT', 'ABORT'],
  };

  describe('calculateBackoff', () => {
    it('returns base_ms for attempt 1', () => {
      const delay = calculateBackoff(samplePolicy.backoff, 1);
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThanOrEqual(200); // base + jitter
    });

    it('exponentially increases', () => {
      const d1 = calculateBackoff(samplePolicy.backoff, 1);
      const d2 = calculateBackoff(samplePolicy.backoff, 2);
      const d3 = calculateBackoff(samplePolicy.backoff, 3);
      expect(d2).toBeGreaterThan(d1 * 0.5);
      expect(d3).toBeGreaterThan(d2 * 0.5);
    });

    it('respects max_ms cap', () => {
      const delay = calculateBackoff(samplePolicy.backoff, 10);
      expect(delay).toBeLessThanOrEqual(1000);
    });
  });

  describe('RetryEngine.shouldRetry', () => {
    const engine = new RetryEngine(samplePolicy);

    it('allows retry for code in retry_on', () => {
      expect(engine.shouldRetry('YJ.ACT.DOM_TARGET_STALE', 1)).toBe(true);
    });

    it('denies retry for code in never_retry_on', () => {
      expect(engine.shouldRetry('YJ.OPSEC.ANOMALY_RISK_ELEVATED', 1)).toBe(false);
    });

    it('denies retry when max_attempts exceeded', () => {
      expect(engine.shouldRetry('YJ.NET.REQUEST_TIMEOUT', 3)).toBe(false);
    });

    it('denies retry for codes not in retry_on', () => {
      expect(engine.shouldRetry('YJ.PROTOCOL.INVALID_ARGUMENT', 1)).toBe(false);
    });
  });

  describe('RetryEngine.nextEscalation', () => {
    const engine = new RetryEngine(samplePolicy);

    it('returns first escalation for attempt 1', () => {
      expect(engine.nextEscalation(1)).toBe('RETRY_SAME');
    });

    it('returns second escalation for attempt 2', () => {
      expect(engine.nextEscalation(2)).toBe('REOBSERVE_THEN_RETRY');
    });

    it('returns ABORT when escalations exhausted', () => {
      expect(engine.nextEscalation(5)).toBe('ABORT');
    });
  });
});
```

## Step 2: Implement retry-engine.ts

Create `src/doctrine/retry-engine.ts`:

```typescript
export interface BackoffPolicy {
  kind: 'exponential_jitter' | 'fixed' | 'linear';
  base_ms: number;
  max_ms: number;
}

export interface RetryPolicy {
  policy_id: string;
  max_attempts: number;
  backoff: BackoffPolicy;
  retry_on: string[];
  never_retry_on: string[];
  escalation: string[];
}

export function calculateBackoff(policy: BackoffPolicy, attempt: number): number {
  switch (policy.kind) {
    case 'fixed':
      return policy.base_ms;
    case 'linear':
      return Math.min(policy.base_ms * attempt, policy.max_ms);
    case 'exponential_jitter':
    default: {
      const exponential = policy.base_ms * Math.pow(2, attempt - 1);
      const capped = Math.min(exponential, policy.max_ms);
      const jitter = capped * 0.25 * Math.random();
      return Math.floor(capped + jitter);
    }
  }
}

export class RetryEngine {
  private policy: RetryPolicy;

  constructor(policy: RetryPolicy) {
    this.policy = policy;
  }

  shouldRetry(code: string, attempt: number): boolean {
    if (attempt >= this.policy.max_attempts) return false;
    if (this.policy.never_retry_on.includes(code)) return false;
    if (!this.policy.retry_on.includes(code)) return false;
    return true;
  }

  nextEscalation(attempt: number): string {
    const idx = Math.min(attempt - 1, this.policy.escalation.length - 1);
    return this.policy.escalation[idx];
  }

  getDelay(attempt: number): number {
    return calculateBackoff(this.policy.backoff, attempt);
  }
}

export const DEFAULT_RETRY_POLICIES: Record<string, RetryPolicy> = {
  'act.click': {
    policy_id: 'act.click.v1',
    max_attempts: 3,
    backoff: { kind: 'exponential_jitter', base_ms: 250, max_ms: 2000 },
    retry_on: ['YJ.ACT.DOM_TARGET_STALE', 'YJ.ACT.DOM_TARGET_NOT_FOUND'],
    never_retry_on: ['YJ.OPSEC.ANOMALY_RISK_ELEVATED', 'YJ.ACT.ACTION_NOT_IDEMPOTENT'],
    escalation: ['RETRY_SAME', 'REOBSERVE_THEN_RETRY', 'ABORT'],
  },
  'act.type': {
    policy_id: 'act.type.v1',
    max_attempts: 2,
    backoff: { kind: 'exponential_jitter', base_ms: 500, max_ms: 3000 },
    retry_on: ['YJ.ACT.DOM_TARGET_STALE'],
    never_retry_on: ['YJ.ACT.ACTION_NOT_IDEMPOTENT', 'YJ.OPSEC.ANOMALY_RISK_ELEVATED'],
    escalation: ['RETRY_SAME', 'ABORT'],
  },
  'act.navigate': {
    policy_id: 'act.navigate.v1',
    max_attempts: 2,
    backoff: { kind: 'fixed', base_ms: 1000, max_ms: 1000 },
    retry_on: ['YJ.NET.REQUEST_TIMEOUT'],
    never_retry_on: ['YJ.OPSEC.ANOMALY_RISK_ELEVATED'],
    escalation: ['RETRY_SAME', 'ABORT'],
  },
  'default': {
    policy_id: 'default.v1',
    max_attempts: 2,
    backoff: { kind: 'exponential_jitter', base_ms: 500, max_ms: 5000 },
    retry_on: ['YJ.NET.REQUEST_TIMEOUT', 'YJ.CAPTURE.WINDOW_EXPIRED'],
    never_retry_on: ['YJ.OPSEC.ANOMALY_RISK_ELEVATED', 'YJ.POLICY.DOMAIN_PERMISSION_REQUIRED'],
    escalation: ['RETRY_SAME', 'ABORT'],
  },
};
```

## Step 3: Run tests

Run: `npx vitest run tests/doctrine/retry-engine.test.ts`
Expected: PASS (9 tests)

## Step 4: Commit

```bash
cd D:\Yautja
git add src/doctrine/retry-engine.ts tests/doctrine/retry-engine.test.ts
git commit -m "feat(doctrine): add retry engine with backoff policies and escalation ladder"
```

## Report Contract

Write to `D:\Yautja\.superpowers\sdd\error-task-6-report.md`. Return ONLY: status, commit hashes, one-line test summary, concerns.