# Task 1 Brief — Types, Schemas, and Dependencies

**Source plan:** `D:\Yautja\proyectos-pendientes\2026-07-15-yautja-error-contract-plan.md`
**Repo:** `D:\Yautja` (git initialized, branch: main)
**Spec:** `D:\Yautja\proyectos-pendientes\yautja-error-contract-1.0.md`
**Ledger:** `D:\Yautja\.superpowers\sdd\error-contract-progress.md`

## Scene-setting

You are implementing Task 1 of the Yautja Error Contract v1.0. This is the foundational task — all other tasks depend on the types and schemas you create here. The rest of the project (Tasks 2-10) builds on top of the YautjaResponse envelope, Severity enum, and YautjaError interface you define in this task.

The Yautja repo is at `D:\Yautja`. It uses TypeScript 5.7 (strict, ESM modules with `.js` extensions in imports), vitest 2.1 for testing, and follows a themed directory structure (arsenal/, vision/, helmet.ts, etc.). The new error contract will live in a new `src/doctrine/` directory.

The existing arsenal has a simpler error system at `src/arsenal/errors.ts` with 14 flat error types. You are NOT modifying that file in this task — Task 5 will add a shim that maps between the two systems.

## Files

- Create: `src/doctrine/types.ts`
- Create: `src/doctrine/schemas.ts`
- Create: `tests/doctrine/types.test.ts`
- Modify: `package.json` (add zod, ulid)

## Interfaces

- **Consumes:** nothing (foundational)
- **Produces:**
  - `YautjaResponse<T>` — discriminated union of success/failure envelope
  - `YautjaError` — structured error object
  - `OperationMeta` — operation tracking fields
  - `StateMeta` — session/tab state tracking
  - `EvidenceMeta` — proof artifacts
  - `ContextMeta` — token usage tracking
  - `RecoveryHint` — recovery strategy recommendation
  - `Severity` — enum: 'correctable' | 'transient' | 'recoverable' | 'approval_required' | 'terminal'
  - `StateIntegrity` — enum: 'unknown' | 'known' | 'corrupted' | 'restored' | 'contaminated'
  - `SchemaVersion` — literal type '1.0'
  - `success<T>()` and `failure()` constructor functions

## Step 1: Install dependencies

```bash
cd D:\Yautja
npm install zod ulid
npm install -D @types/ulid
```

Expected: package.json gains `zod` and `ulid` in dependencies, `@types/ulid` in devDependencies. `node_modules/zod/` and `node_modules/ulid/` directories exist.

## Step 2: Write the failing type tests

Create `tests/doctrine/types.test.ts`:

```typescript
import { describe, it, expectTypeOf } from 'vitest';
import type {
  YautjaResponse,
  YautjaError,
  OperationMeta,
  StateMeta,
  EvidenceMeta,
  ContextMeta,
  Severity,
  StateIntegrity,
} from '../../src/doctrine/types.js';

describe('YautjaResponse types', () => {
  it('success response has ok:true and result', () => {
    type S = YautjaResponse<string>;
    const ok: S = {
      ok: true,
      result: 'hello',
      operation: {
        tool: 'yautja_act',
        action_type: 'click',
        operation_id: 'op_01J',
        trace_id: 'tr_01J',
        attempt: 1,
        max_attempts: 3,
        idempotency_key: null,
      },
      state: {
        session_id: 'ses_1',
        tab_id: 1,
        origin: 'https://example.com',
        checkpoint_id: null,
        state_integrity: 'known',
      },
      evidence: {
        snapshot_after: 'resource://yautja/traces/tr_01J/dom/1',
        redacted: true,
        redaction_policy: ['secrets'],
      },
      context: {
        consumed_tokens_estimate: 100,
        available_window_tokens: 8000,
        confidence: 'medium',
      },
      schema_version: '1.0',
    };
    expectTypeOf(ok.ok).toEqualTypeOf<true>();
    expectTypeOf(ok.result).toEqualTypeOf<string>();
  });

  it('error response has ok:false and error with code', () => {
    type E = YautjaResponse<never>;
    const err: E = {
      ok: false,
      error: {
        code: 'YJ.ACT.DOM_TARGET_STALE',
        introduced_in: '1.0',
        category: 'action',
        severity: 'recoverable',
        retryable: true,
        retry_strategy: 'REOBSERVE_THEN_RETRY',
        user_confirmation_required: false,
        message: 'Target changed',
        agent_summary: 'Re-observe and resolve selector again',
        recovery: {
          allowed: ['REOBSERVE_THEN_RETRY', 'ROLLBACK_TO_CHECKPOINT', 'ABORT'],
          recommended: 'REOBSERVE_THEN_RETRY',
          next_tool_call: null,
        },
      },
      operation: {
        tool: 'yautja_act',
        action_type: 'click',
        operation_id: 'op_01J',
        trace_id: 'tr_01J',
        attempt: 2,
        max_attempts: 3,
        idempotency_key: null,
      },
      state: {
        session_id: 'ses_1',
        tab_id: 1,
        origin: 'https://example.com',
        checkpoint_id: null,
        state_integrity: 'corrupted',
      },
      evidence: {
        snapshot_before: 'resource://yautja/traces/tr_01J/dom/1',
        snapshot_after: 'resource://yautja/traces/tr_01J/dom/2',
        redacted: true,
        redaction_policy: ['secrets'],
      },
      context: {
        consumed_tokens_estimate: 200,
        available_window_tokens: 7800,
        confidence: 'medium',
      },
      schema_version: '1.0',
    };
    expectTypeOf(err.ok).toEqualTypeOf<false>();
    expectTypeOf(err.error.code).toEqualTypeOf<string>();
  });

  it('Severity has exactly 5 values', () => {
    const severities: Severity[] = [
      'correctable',
      'transient',
      'recoverable',
      'approval_required',
      'terminal',
    ];
    expectTypeOf(severities).toEqualTypeOf<Severity[]>();
  });

  it('StateIntegrity has exactly 5 values', () => {
    const states: StateIntegrity[] = [
      'unknown',
      'known',
      'corrupted',
      'restored',
      'contaminated',
    ];
    expectTypeOf(states).toEqualTypeOf<StateIntegrity[]>();
  });
});
```

## Step 3: Run test to verify it fails

Run: `npx vitest run tests/doctrine/types.test.ts`
Expected: FAIL with "Cannot find module '../../src/doctrine/types.js'"

## Step 4: Implement types.ts

Create `src/doctrine/types.ts`:

```typescript
export const SCHEMA_VERSION = '1.0' as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

export type Severity =
  | 'correctable'
  | 'transient'
  | 'recoverable'
  | 'approval_required'
  | 'terminal';

export type StateIntegrity =
  | 'unknown'
  | 'known'
  | 'corrupted'
  | 'restored'
  | 'contaminated';

export type ErrorCategory =
  | 'protocol'
  | 'action'
  | 'capture'
  | 'net'
  | 'policy'
  | 'opsec';

export type RetryStrategy =
  | 'RETRY_SAME'
  | 'REOBSERVE_THEN_RETRY'
  | 'ROLLBACK_TO_CHECKPOINT'
  | 'REQUEST_APPROVAL'
  | 'ABORT';

export type RedactionCategory = 'secrets' | 'pii' | 'sensitive_dom' | 'none';

export type TokenConfidence = 'high' | 'medium' | 'low';

export interface RecoveryHint {
  allowed: RetryStrategy[];
  recommended: RetryStrategy;
  next_tool_call: {
    name: string;
    arguments: Record<string, unknown>;
  } | null;
}

export interface YautjaError {
  code: string;
  introduced_in: string;
  category: ErrorCategory;
  severity: Severity;
  retryable: boolean;
  retry_strategy: RetryStrategy;
  user_confirmation_required: boolean;
  message: string;
  agent_summary: string;
  recovery: RecoveryHint;
}

export interface OperationMeta {
  tool: string;
  action_type: string;
  operation_id: string;
  trace_id: string;
  attempt: number;
  max_attempts: number;
  idempotency_key: string | null;
}

export interface StateMeta {
  session_id: string;
  tab_id: number;
  origin: string;
  url_before?: string;
  url_after?: string;
  checkpoint_id: string | null;
  state_integrity: StateIntegrity;
}

export interface EvidenceMeta {
  snapshot_before?: string;
  snapshot_after?: string;
  target_fingerprint_before?: string;
  target_fingerprint_after?: string;
  network_window?: string;
  redacted: boolean;
  redaction_policy: RedactionCategory[];
}

export interface ContextMeta {
  consumed_tokens_estimate: number;
  available_window_tokens: number;
  confidence: TokenConfidence;
}

export interface YautjaResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error?: YautjaError;
  operation: OperationMeta;
  state: StateMeta;
  evidence: EvidenceMeta;
  context: ContextMeta;
  schema_version: SchemaVersion;
}

export function success<T>(
  result: T,
  meta: {
    operation: OperationMeta;
    state: StateMeta;
    evidence?: Partial<EvidenceMeta>;
    context: ContextMeta;
  },
): YautjaResponse<T> {
  return {
    ok: true,
    result,
    operation: meta.operation,
    state: meta.state,
    evidence: {
      redacted: true,
      redaction_policy: ['secrets'],
      ...meta.evidence,
    },
    context: meta.context,
    schema_version: SCHEMA_VERSION,
  };
}

export function failure(
  error: YautjaError,
  meta: {
    operation: OperationMeta;
    state: StateMeta;
    evidence?: Partial<EvidenceMeta>;
    context: ContextMeta;
  },
): YautjaResponse<never> {
  return {
    ok: false,
    error,
    operation: meta.operation,
    state: meta.state,
    evidence: {
      redacted: true,
      redaction_policy: ['secrets'],
      ...meta.evidence,
    },
    context: meta.context,
    schema_version: SCHEMA_VERSION,
  };
}
```

## Step 5: Implement schemas.ts (zod runtime validation)

Create `src/doctrine/schemas.ts`:

```typescript
import { z } from 'zod';

export const severitySchema = z.enum([
  'correctable', 'transient', 'recoverable', 'approval_required', 'terminal',
]);

export const stateIntegritySchema = z.enum([
  'unknown', 'known', 'corrupted', 'restored', 'contaminated',
]);

export const errorCategorySchema = z.enum([
  'protocol', 'action', 'capture', 'net', 'policy', 'opsec',
]);

export const retryStrategySchema = z.enum([
  'RETRY_SAME', 'REOBSERVE_THEN_RETRY', 'ROLLBACK_TO_CHECKPOINT',
  'REQUEST_APPROVAL', 'ABORT',
]);

export const yautjaErrorSchema = z.object({
  code: z.string().regex(/^YJ\.[A-Z]+(\.[A-Z_]+)+$/),
  introduced_in: z.string().regex(/^\d+\.\d+$/),
  category: errorCategorySchema,
  severity: severitySchema,
  retryable: z.boolean(),
  retry_strategy: retryStrategySchema,
  user_confirmation_required: z.boolean(),
  message: z.string(),
  agent_summary: z.string(),
  recovery: z.object({
    allowed: z.array(retryStrategySchema),
    recommended: retryStrategySchema,
    next_tool_call: z.object({
      name: z.string(),
      arguments: z.record(z.unknown()),
    }).nullable(),
  }),
});

export const operationMetaSchema = z.object({
  tool: z.string(),
  action_type: z.string(),
  operation_id: z.string(),
  trace_id: z.string(),
  attempt: z.number().int().positive(),
  max_attempts: z.number().int().positive(),
  idempotency_key: z.string().nullable(),
});

export const stateMetaSchema = z.object({
  session_id: z.string(),
  tab_id: z.number().int(),
  origin: z.string(),
  url_before: z.string().optional(),
  url_after: z.string().optional(),
  checkpoint_id: z.string().nullable(),
  state_integrity: stateIntegritySchema,
});

export const evidenceMetaSchema = z.object({
  snapshot_before: z.string().optional(),
  snapshot_after: z.string().optional(),
  target_fingerprint_before: z.string().optional(),
  target_fingerprint_after: z.string().optional(),
  network_window: z.string().optional(),
  redacted: z.boolean(),
  redaction_policy: z.array(z.enum(['secrets', 'pii', 'sensitive_dom', 'none'])),
});

export const contextMetaSchema = z.object({
  consumed_tokens_estimate: z.number().int().nonnegative(),
  available_window_tokens: z.number().int().nonnegative(),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const yautjaResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: yautjaErrorSchema.optional(),
  operation: operationMetaSchema,
  state: stateMetaSchema,
  evidence: evidenceMetaSchema,
  context: contextMetaSchema,
  schema_version: z.literal('1.0'),
});
```

## Step 6: Run tests to verify they pass

Run: `npx vitest run tests/doctrine/types.test.ts`
Expected: PASS (4 tests)

If tests fail with TypeScript errors (e.g., "Cannot find name 'describe'"), it means vitest globals are not enabled. Add `"types": ["vitest/globals"]` to tsconfig.json compilerOptions if needed.

## Step 7: Commit

```bash
cd D:\Yautja
git add src/doctrine/types.ts src/doctrine/schemas.ts tests/doctrine/types.test.ts package.json package-lock.json
git commit -m "feat(doctrine): add YautjaResponse types and zod schemas"
```

## Report Contract

Write your final report to `D:\Yautja\.superpowers\sdd\error-task-1-report.md` with this structure:

```markdown
# Task 1 Report

**Status:** DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

**Commits:**
- <hash7> <message>

**Test summary:**
- Tests: <passed>/<total> (vitest run)
- tsc --noEmit: 0 errors

**Self-review:**
- [what you checked]
- [what you found — if anything]

**Concerns (if any):**
- [observations about the work, NOT new questions for me]
```

Return ONLY:
1. Status (one of the four)
2. Commit hashes + messages (one-line each)
3. One-line test summary
4. List of concerns (or "none")
