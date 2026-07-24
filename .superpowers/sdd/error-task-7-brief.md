# Task 7 Brief — Recovery Machine

**Source plan:** `D:\Yautja\proyectos-pendientes\2026-07-15-yautja-error-contract-plan.md`
**Repo:** `D:\Yautja` (branch: main)
**Spec:** `D:\Yautja\proyectos-pendientes\yautja-error-contract-1.0.md`
**Ledger:** `D:\Yautja\.superpowers\sdd\error-contract-progress.md`
**Prior task:** Task 6 (commit `891e937`)

## Scene-setting

You are implementing Task 7: the RecoveryMachine class. This is the orchestrator that wraps any tool execution in the PREFLIGHT → EXECUTE → VERIFY → COMMIT state machine. It uses ALL the previous tasks:

- Task 1: YautjaResponse types
- Task 2: toYautjaError / lookupCode
- Task 3: IdempotencyRegistry (cache hits)
- Task 4: StateIntegrityTracker (block when contaminated)
- Task 5: classifyLegacyError (optional, not used in the test path)
- Task 6: RetryEngine (decide retry, backoff, escalation)

This is the most complex task. Read carefully and follow the brief's code exactly.

## Files

- Create: `src/doctrine/recovery-machine.ts`
- Create: `tests/doctrine/recovery-machine.test.ts`

## Interfaces

- **Consumes:** All previous task outputs
- **Produces:** `RecoveryMachine` class with `execute<T>(opts: ExecuteOptions<T>): Promise<YautjaResponse<T>>` method

## Step 1: Write failing tests

Create `tests/doctrine/recovery-machine.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { RecoveryMachine } from '../../src/doctrine/recovery-machine.js';
import { StateIntegrityTracker } from '../../src/doctrine/state-integrity.js';
import { IdempotencyRegistry } from '../../src/doctrine/idempotency.js';
import { DEFAULT_RETRY_POLICIES } from '../../src/doctrine/retry-engine.js';

describe('RecoveryMachine', () => {
  function setup() {
    const tracker = new StateIntegrityTracker('ses_test');
    const idem = new IdempotencyRegistry({ defaultTtlMs: 60000 });
    const machine = new RecoveryMachine({
      tracker,
      idempotency: idem,
      policies: DEFAULT_RETRY_POLICIES,
    });
    return { machine, tracker, idem };
  }

  it('returns success for a passing operation', async () => {
    const { machine } = setup();
    const result = await machine.execute({
      tool: 'yautja_act',
      action_type: 'click',
      policy_key: 'act.click',
      trace_id: 'tr_test',
      fn: async () => ({ value: 'clicked' }),
      verify: async () => true,
    });
    expect(result.ok).toBe(true);
    expect(result.result).toBe('clicked');
    expect(result.operation.attempt).toBe(1);
  });

  it('retries on recoverable error then succeeds', async () => {
    const { machine } = setup();
    let calls = 0;
    const result = await machine.execute({
      tool: 'yautja_act',
      action_type: 'click',
      policy_key: 'act.click',
      trace_id: 'tr_test',
      fn: async () => {
        calls++;
        if (calls === 1) {
          return { error: { code: 'YJ.ACT.DOM_TARGET_STALE' } };
        }
        return { value: 'clicked' };
      },
      verify: async () => true,
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('aborts on terminal error', async () => {
    const { machine } = setup();
    const result = await machine.execute({
      tool: 'yautja_act',
      action_type: 'click',
      policy_key: 'act.click',
      trace_id: 'tr_test',
      fn: async () => ({ error: { code: 'YJ.OPSEC.ANOMALY_RISK_ELEVATED' } }),
      verify: async () => true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error!.code).toBe('YJ.OPSEC.ANOMALY_RISK_ELEVATED');
      expect(result.error!.severity).toBe('terminal');
    }
  });

  it('respects max_attempts', async () => {
    const { machine } = setup();
    let calls = 0;
    const result = await machine.execute({
      tool: 'yautja_act',
      action_type: 'click',
      policy_key: 'act.click',
      trace_id: 'tr_test',
      fn: async () => {
        calls++;
        return { error: { code: 'YJ.ACT.DOM_TARGET_STALE' } };
      },
      verify: async () => true,
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(3); // max_attempts for act.click
  });

  it('blocks when state is contaminated', async () => {
    const { machine, tracker } = setup();
    tracker.markContaminated('test contamination');
    const result = await machine.execute({
      tool: 'yautja_act',
      action_type: 'click',
      policy_key: 'act.click',
      trace_id: 'tr_test',
      fn: async () => ({ value: 'should not reach' }),
      verify: async () => true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error!.code).toBe('YJ.OPSEC.ANOMALY_RISK_ELEVATED');
    }
  });

  it('returns cached result for same idempotency_key', async () => {
    const { machine } = setup();
    const fn = vi.fn(async () => ({ value: 'first' }));
    const opts = {
      tool: 'yautja_act',
      action_type: 'click',
      policy_key: 'act.click',
      trace_id: 'tr_test',
      idempotency_key: 'ik_test_1',
      fn,
      verify: async () => true,
    };
    const r1 = await machine.execute(opts);
    const r2 = await machine.execute(opts);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1); // not called second time
  });
});
```

## Step 2: Implement recovery-machine.ts

Create `src/doctrine/recovery-machine.ts`:

```typescript
import type { YautjaResponse, OperationMeta, StateMeta, EvidenceMeta, ContextMeta } from './types.js';
import { failure, success } from './types.js';
import { toYautjaError, lookupCode } from './registry.js';
import { RetryEngine, type RetryPolicy } from './retry-engine.js';
import type { StateIntegrityTracker } from './state-integrity.js';
import type { IdempotencyRegistry } from './idempotency.js';
import { generateOperationId } from './ids.js';

type ExecResult<T> =
  | { value: T }
  | { error: { code: string; message?: string } };

export interface ExecuteOptions<T> {
  tool: string;
  action_type: string;
  policy_key: string;
  trace_id: string;
  idempotency_key?: string | null;
  fn: () => Promise<ExecResult<T>>;
  verify?: (result: T) => Promise<boolean>;
  session_id?: string;
  tab_id?: number;
  origin?: string;
}

export interface RecoveryMachineConfig {
  tracker: StateIntegrityTracker;
  idempotency: IdempotencyRegistry;
  policies: Record<string, RetryPolicy>;
  agent_context_window?: number;
}

export class RecoveryMachine {
  private config: RecoveryMachineConfig;

  constructor(config: RecoveryMachineConfig) {
    this.config = config;
  }

  async execute<T>(opts: ExecuteOptions<T>): Promise<YautjaResponse<T>> {
    const policy = this.config.policies[opts.policy_key] ?? this.config.policies['default'];
    const engine = new RetryEngine(policy);

    // PREFLIGHT: check contaminated state
    if (this.config.tracker.current() === 'contaminated') {
      return this.makeError('YJ.OPSEC.ANOMALY_RISK_ELEVATED', opts, 1, policy.max_attempts);
    }

    // PREFLIGHT: check idempotency cache
    if (opts.idempotency_key) {
      const cached = this.config.idempotency.get<T>(opts.idempotency_key);
      if (cached) return cached;
    }

    // EXECUTE with retries
    const operation_id = generateOperationId();
    let lastErrorCode: string | null = null;

    for (let attempt = 1; attempt <= policy.max_attempts; attempt++) {
      this.config.tracker.beginOperation();

      const execResult = await opts.fn();

      if ('value' in execResult) {
        // VERIFY
        if (opts.verify && !(await opts.verify(execResult.value))) {
          lastErrorCode = 'YJ.ACT.DOM_TARGET_STALE';
          if (engine.shouldRetry(lastErrorCode, attempt)) {
            await this.delay(engine.getDelay(attempt));
            continue;
          }
          return this.makeError(lastErrorCode, opts, attempt, policy.max_attempts, operation_id);
        }

        // COMMIT
        const response = success(execResult.value, {
          operation: this.makeOperation(opts, attempt, policy.max_attempts, operation_id),
          state: this.makeState(opts),
          context: this.makeContext(0),
        });

        if (opts.idempotency_key) {
          this.config.idempotency.set(opts.idempotency_key, response);
        }

        return response;
      }

      // Error case
      lastErrorCode = execResult.error.code;
      const def = lookupCode(lastErrorCode);

      if (!def || !engine.shouldRetry(lastErrorCode, attempt)) {
        const yjError = toYautjaError(lastErrorCode, {
          message: execResult.error.message,
        });
        return failure(yjError, {
          operation: this.makeOperation(opts, attempt, policy.max_attempts, operation_id),
          state: this.makeState(opts),
          context: this.makeContext(0),
        });
      }

      // Retry with backoff
      await this.delay(engine.getDelay(attempt));
    }

    // Exhausted retries
    return this.makeError(lastErrorCode ?? 'YJ.NET.REQUEST_TIMEOUT', opts, policy.max_attempts, policy.max_attempts, operation_id);
  }

  private makeOperation(opts: ExecuteOptions, attempt: number, maxAttempts: number, opId: string): OperationMeta {
    return {
      tool: opts.tool,
      action_type: opts.action_type,
      operation_id: opId,
      trace_id: opts.trace_id,
      attempt,
      max_attempts: maxAttempts,
      idempotency_key: opts.idempotency_key ?? null,
    };
  }

  private makeState(opts: ExecuteOptions): StateMeta {
    return {
      session_id: opts.session_id ?? this.config.tracker.session_id(),
      tab_id: opts.tab_id ?? 0,
      origin: opts.origin ?? '',
      checkpoint_id: this.config.tracker.checkpoint(),
      state_integrity: this.config.tracker.current(),
    };
  }

  private makeContext(consumedTokens: number): ContextMeta {
    const window = this.config.agent_context_window ?? 128000;
    return {
      consumed_tokens_estimate: consumedTokens,
      available_window_tokens: Math.max(0, window - consumedTokens),
      confidence: 'low',
    };
  }

  private makeError(
    code: string,
    opts: ExecuteOptions,
    attempt: number,
    maxAttempts: number,
    operation_id?: string,
  ): YautjaResponse<never> {
    const yjError = toYautjaError(code);
    return failure(yjError, {
      operation: this.makeOperation(opts, attempt, maxAttempts, operation_id ?? generateOperationId()),
      state: this.makeState(opts),
      context: this.makeContext(0),
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

## Step 3: Run tests

Run: `npx vitest run tests/doctrine/recovery-machine.test.ts`
Expected: PASS (6 tests)

## Step 4: Commit

```bash
cd D:\Yautja
git add src/doctrine/recovery-machine.ts tests/doctrine/recovery-machine.test.ts
git commit -m "feat(doctrine): add recovery machine (PREFLIGHT→EXECUTE→VERIFY→COMMIT)"
```

## Report Contract

Write to `D:\Yautja\.superpowers\sdd\error-task-7-report.md`. Return ONLY: status, commit hashes, one-line test summary, concerns.