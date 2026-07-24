# Task 9 Brief — Wire into Arsenal + Barrel Exports + Recovery Stats Tool

**Source plan:** `D:\Yautja\proyectos-pendientes\2026-07-15-yautja-error-contract-plan.md`
**Repo:** `D:\Yautja` (branch: main)
**Spec:** `D:\Yautja\proyectos-pendientes\yautja-error-contract-1.0.md`
**Ledger:** `D:\Yautja\.superpowers\sdd\error-contract-progress.md`
**Prior task:** Task 8 (commit `5b36895`)

## Scene-setting

You are implementing Task 9: the integration step. This task wires the doctrine module into the existing Yautja codebase:

1. **Barrel exports** — `src/doctrine/index.ts` re-exports everything for consumers
2. **`arsenalToDoctrine()` function** — added to `src/arsenal/errors.ts` so legacy code can convert to new format
3. **`yautja_recovery_stats` tool stub** — `src/tools/recovery-stats.ts` exposes telemetry as an MCP tool

**CRITICAL — Task 7's lesson learned:** run `npx tsc --noEmit` before claiming done. vitest's esbuild transform hides type errors. Standard verification:

```bash
cd D:\Yautja
npx tsc --noEmit
npx vitest run tests/doctrine/
```

Both must pass.

**Note on barrel exports:** `src/doctrine/index.ts` re-exports all 11 files. Some have internal types (like `RegistryEntry` in idempotency.ts) that are NOT exported. The barrel's `export *` will surface only the explicitly exported names. Check for naming conflicts between files (e.g., if two files both export a `Config` interface).

**Note on the arsenalToDoctrine() function:** the brief adds it as a top-level function (not a method on `ArsenalError`). Existing `makeError` factory should remain unchanged.

## Files

- Create: `src/doctrine/index.ts`
- Create: `src/tools/recovery-stats.ts`
- Modify: `src/arsenal/errors.ts` (add `arsenalToDoctrine` function and its imports)

The brief lists `src/arsenal/action-types.ts` as "modified (alias ActionResult → YautjaResponse)" but the plan does not actually show any code change there. The existing `ActionResult` type has the right shape — leave `action-types.ts` untouched.

## Step 1: Create barrel export

Create `src/doctrine/index.ts`:

```typescript
export * from './types.js';
export * from './schemas.js';
export * from './registry.js';
export * from './ids.js';
export * from './idempotency.js';
export * from './state-integrity.js';
export * from './classifier.js';
export * from './retry-engine.js';
export * from './recovery-machine.js';
export * from './trace-store.js';
export * from './telemetry.js';
```

## Step 2: Add arsenalToDoctrine() to arsenal/errors.ts

Append to the END of `src/arsenal/errors.ts` (do NOT modify the existing `ArsenalErrorType`, `ArsenalError`, or `makeError`):

```typescript
import { classifyLegacyError } from '../doctrine/classifier.js';
import type { YautjaError } from '../doctrine/types.js';

export function arsenalToDoctrine(err: ArsenalError): YautjaError {
  return classifyLegacyError(err);
}
```

## Step 3: Create recovery-stats tool

Create `src/tools/recovery-stats.ts`:

```typescript
import type { TelemetryCollector, QueryFilter, OutcomeStats } from '../doctrine/telemetry.js';

export interface RecoveryStatsInput {
  code?: string;
  strategy?: string;
  since?: number;
}

export interface RecoveryStatsOutput {
  stats: OutcomeStats;
  recent_outcomes: number;
}

export function createRecoveryStatsTool(telemetry: TelemetryCollector) {
  return function recoveryStats(input: RecoveryStatsInput): RecoveryStatsOutput {
    const filter: QueryFilter = {
      code: input.code,
      strategy: input.strategy,
      since: input.since,
    };
    return {
      stats: telemetry.stats(filter),
      recent_outcomes: telemetry.query(filter).slice(-10).length,
    };
  };
}
```

## Step 4: Verify

```bash
cd D:\Yautja
npx tsc --noEmit
npx vitest run tests/doctrine/
```

Expected: tsc 0 errors; all existing doctrine tests pass (no regressions).

## Step 5: Commit

```bash
git add src/doctrine/index.ts src/tools/recovery-stats.ts src/arsenal/errors.ts
git commit -m "feat(doctrine): wire into arsenal, add barrel exports and recovery-stats tool"
```

## Report Contract

Write to `D:\Yautja\.superpowers\sdd\error-task-9-report.md`. Return ONLY:
1. Status
2. Commit hashes + messages
3. One-line test summary (must include "tsc 0 errors" AND test count)
4. Concerns list (or "none")

## Working directory

Operate from `D:\Yautja`. Use bash via `bash` (Git Bash on Windows).

Begin by reading `D:\Yautja\.superpowers\sdd\error-task-9-brief.md` in full.