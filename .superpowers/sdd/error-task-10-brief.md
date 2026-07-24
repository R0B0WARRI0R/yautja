# Task 10 Brief — Integration Test Scenarios (12 MVP codes)

**Source plan:** `D:\Yautja\proyectos-pendientes\2026-07-15-yautja-error-contract-plan.md`
**Repo:** `D:\Yautja` (branch: main)
**Spec:** `D:\Yautja\proyectos-pendientes\yautja-error-contract-1.0.md`
**Ledger:** `D:\Yautja\.superpowers\sdd\error-contract-progress.md`
**Prior task:** Task 9 (commit `3f9b7d6`)

## Scene-setting

You are implementing Task 10: the final integration test suite. This generates one test per MVP code (12 codes) plus 3 behavioral tests (terminal no-retry, transient max-attempts, recoverable then success).

**CRITICAL — Task 7's lesson learned:** run `npx tsc --noEmit` before claiming done. vitest's esbuild transform hides type errors. Standard verification:

```bash
cd D:\Yautja
npx tsc --noEmit
npx vitest run tests/doctrine/integration/
npx vitest run
```

All must pass.

## Files

- Create: `tests/doctrine/integration/scenarios.test.ts`

## Step 1: Write integration tests

Create the directory and file `tests/doctrine/integration/scenarios.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { RecoveryMachine } from '../../../src/doctrine/recovery-machine.js';
import { StateIntegrityTracker } from '../../../src/doctrine/state-integrity.js';
import { IdempotencyRegistry } from '../../../src/doctrine/idempotency.js';
import { TelemetryCollector } from '../../../src/doctrine/telemetry.js';
import { DEFAULT_RETRY_POLICIES } from '../../../src/doctrine/retry-engine.js';
import { MVP_CODES } from '../../../src/doctrine/registry.js';

function setupMachine() {
  const tracker = new StateIntegrityTracker('ses_integration');
  const idem = new IdempotencyRegistry({ defaultTtlMs: 60000 });
  const telemetry = new TelemetryCollector();
  tracker.markKnown('cp_init');
  const machine = new RecoveryMachine({
    tracker, idempotency: idem, policies: DEFAULT_RETRY_POLICIES,
  });
  return { machine, tracker, idem, telemetry };
}

describe('Integration: all 12 MVP error codes', () => {
  for (const def of MVP_CODES) {
    it(`${def.code} (${def.severity}) is producible and classified`, async () => {
      const { machine } = setupMachine();

      const result = await machine.execute({
        tool: 'yautja_act',
        action_type: 'click',
        policy_key: 'act.click',
        trace_id: 'tr_integration',
        fn: async () => ({ error: { code: def.code } }),
        verify: async () => true,
      });

      expect(result.ok).toBe(false);
      if (!result.ok && result.error) {
        expect(result.error.code).toBe(def.code);
        expect(result.error.severity).toBe(def.severity);
        expect(result.error.retryable).toBe(def.retryable);
        expect(result.error.category).toBe(def.category);
        expect(result.error.introduced_in).toBe('1.0');
        expect(result.error.message).toBeTruthy();
        expect(result.error.agent_summary).toBeTruthy();
        expect(result.error.recovery.allowed.length).toBeGreaterThan(0);
        expect(result.error.recovery.recommended).toBeTruthy();
      }
    });
  }

  it('terminal code does not retry (1 call only)', async () => {
    const { machine } = setupMachine();
    let calls = 0;
    const result = await machine.execute({
      tool: 'yautja_act',
      action_type: 'click',
      policy_key: 'act.click',
      trace_id: 'tr_term',
      fn: async () => {
        calls++;
        return { error: { code: 'YJ.OPSEC.ANOMALY_RISK_ELEVATED' } };
      },
      verify: async () => true,
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('transient code retries up to max_attempts', async () => {
    const { machine } = setupMachine();
    let calls = 0;
    await machine.execute({
      tool: 'yautja_act',
      action_type: 'click',
      policy_key: 'default',
      trace_id: 'tr_transient',
      fn: async () => {
        calls++;
        return { error: { code: 'YJ.NET.REQUEST_TIMEOUT' } };
      },
      verify: async () => true,
    });
    expect(calls).toBe(2);
  });

  it('recoverable code retries then can succeed', async () => {
    const { machine } = setupMachine();
    let calls = 0;
    const result = await machine.execute({
      tool: 'yautja_act',
      action_type: 'click',
      policy_key: 'act.click',
      trace_id: 'tr_recover',
      fn: async () => {
        calls++;
        if (calls < 2) return { error: { code: 'YJ.ACT.DOM_TARGET_STALE' } };
        return { value: 'success' };
      },
      verify: async () => true,
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });
});
```

## Step 2: Run integration tests

```bash
cd D:\Yautja
npx tsc --noEmit
npx vitest run tests/doctrine/integration/
```

Expected: tsc 0 errors; 15 tests pass (12 codes + 3 behavioral).

## Step 3: Run full suite

```bash
npx vitest run
```

Expected: ALL pass.

## Step 4: Commit

```bash
git add tests/doctrine/integration/scenarios.test.ts
git commit -m "test(doctrine): integration scenarios for all 12 MVP error codes"
```

## Report Contract

Write to `D:\Yautja\.superpowers\sdd\error-task-10-report.md`. Return ONLY:
1. Status
2. Commit hashes + messages
3. One-line test summary (must include "tsc 0 errors" AND test count)
4. Concerns list (or "none")

## Working directory

Operate from `D:\Yautja`. Use bash via `bash` (Git Bash on Windows).

Begin by reading `D:\Yautja\.superpowers\sdd\error-task-10-brief.md` in full.