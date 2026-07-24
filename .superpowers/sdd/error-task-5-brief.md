# Task 5 Brief — Legacy Error Classifier (Shim)

**Source plan:** `D:\Yautja\proyectos-pendientes\2026-07-15-yautja-error-contract-plan.md`
**Repo:** `D:\Yautja` (branch: main)
**Spec:** `D:\Yautja\proyectos-pendientes\yautja-error-contract-1.0.md`
**Ledger:** `D:\Yautja\.superpowers\sdd\error-contract-progress.md`
**Prior task:** Task 4 (commit `17b741d`)

## Scene-setting

You are implementing Task 5: a shim that maps the legacy `ArsenalError` system (in `src/arsenal/errors.ts`) to the new `YJ.*` codes from Task 2. This is migration Phase 1 — it lets existing tools be gradually upgraded while the new doctrine runs alongside.

The legacy system has 14 error types (SELECTOR_NOT_FOUND, TIMEOUT, etc.). You create a `classifyLegacyError()` function that takes a legacy `ArsenalError` and returns a new `YautjaError` with the correct mapping.

## Files

- Create: `src/doctrine/classifier.ts`
- Create: `tests/doctrine/classifier.test.ts`

## Interfaces

- **Consumes:** `ArsenalError`, `ArsenalErrorType` from `../arsenal/errors.js`; `YautjaError` from `./types.js`; `toYautjaError` from `./registry.js` (Task 2)
- **Produces:** `classifyLegacyError(legacy: ArsenalError): YautjaError` function

## Step 1: Write failing tests

Create `tests/doctrine/classifier.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { classifyLegacyError } from '../../src/doctrine/classifier.js';
import { makeError } from '../../src/arsenal/errors.js';

describe('Legacy error classifier', () => {
  it('maps SELECTOR_NOT_FOUND to YJ.ACT.DOM_TARGET_NOT_FOUND', () => {
    const legacy = makeError('SELECTOR_NOT_FOUND', 'Element not found');
    const yj = classifyLegacyError(legacy);
    expect(yj.code).toBe('YJ.ACT.DOM_TARGET_NOT_FOUND');
    expect(yj.severity).toBe('recoverable');
    expect(yj.retryable).toBe(true);
  });

  it('maps NAVIGATION_TIMEOUT to YJ.NET.REQUEST_TIMEOUT', () => {
    const legacy = makeError('NAVIGATION_TIMEOUT', 'Timeout');
    const yj = classifyLegacyError(legacy);
    expect(yj.code).toBe('YJ.NET.REQUEST_TIMEOUT');
  });

  it('maps TIMEOUT to YJ.NET.REQUEST_TIMEOUT', () => {
    const legacy = makeError('TIMEOUT', 'Timed out');
    const yj = classifyLegacyError(legacy);
    expect(yj.code).toBe('YJ.NET.REQUEST_TIMEOUT');
  });

  it('maps INVALID_ARGUMENT to YJ.PROTOCOL.INVALID_ARGUMENT', () => {
    const legacy = makeError('INVALID_ARGUMENT', 'Bad arg');
    const yj = classifyLegacyError(legacy);
    expect(yj.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
  });

  it('maps PERMISSION_DENIED to YJ.POLICY.DOMAIN_PERMISSION_REQUIRED', () => {
    const legacy = makeError('PERMISSION_DENIED', 'No access');
    const yj = classifyLegacyError(legacy);
    expect(yj.code).toBe('YJ.POLICY.DOMAIN_PERMISSION_REQUIRED');
  });

  it('maps UNKNOWN_ERROR to YJ.PROTOCOL.INVALID_ARGUMENT with LEGACY note', () => {
    const legacy = makeError('UNKNOWN_ERROR', '???');
    const yj = classifyLegacyError(legacy);
    expect(yj.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
    expect(yj.agent_summary).toContain('LEGACY_ERROR_UNCLASSIFIED');
  });

  it('preserves original message in override', () => {
    const legacy = makeError('SELECTOR_NOT_FOUND', 'Custom selector .foo failed');
    const yj = classifyLegacyError(legacy);
    expect(yj.message).toContain('Custom selector .foo failed');
  });
});
```

## Step 2: Implement classifier.ts

Create `src/doctrine/classifier.ts`:

```typescript
import type { ArsenalError, ArsenalErrorType } from '../arsenal/errors.js';
import type { YautjaError } from './types.js';
import { toYautjaError } from './registry.js';

const LEGACY_MAP: Record<ArsenalErrorType, string> = {
  SELECTOR_NOT_FOUND: 'YJ.ACT.DOM_TARGET_NOT_FOUND',
  SELECTOR_NOT_VISIBLE: 'YJ.ACT.DOM_TARGET_NOT_FOUND',
  ELEMENT_NOT_INTERACTABLE: 'YJ.ACT.DOM_TARGET_STALE',
  NAVIGATION_TIMEOUT: 'YJ.NET.REQUEST_TIMEOUT',
  JS_EVALUATION_ERROR: 'YJ.PROTOCOL.INVALID_ARGUMENT',
  ACTION_PRECONDITION: 'YJ.PROTOCOL.INVALID_ARGUMENT',
  CDP_COMMAND_FAILED: 'YJ.NET.REQUEST_TIMEOUT',
  NOT_CONNECTED: 'YJ.NET.SESSION_STATE_UNKNOWN',
  TIMEOUT: 'YJ.NET.REQUEST_TIMEOUT',
  INVALID_ARGUMENT: 'YJ.PROTOCOL.INVALID_ARGUMENT',
  UNSUPPORTED_ACTION: 'YJ.PROTOCOL.INVALID_ARGUMENT',
  STORAGE_ERROR: 'YJ.NET.SESSION_STATE_UNKNOWN',
  PERMISSION_DENIED: 'YJ.POLICY.DOMAIN_PERMISSION_REQUIRED',
  UNKNOWN_ERROR: 'YJ.PROTOCOL.INVALID_ARGUMENT',
};

export function classifyLegacyError(legacy: ArsenalError): YautjaError {
  const targetCode = LEGACY_MAP[legacy.type] ?? 'YJ.PROTOCOL.INVALID_ARGUMENT';
  const isUnclassified = legacy.type === 'UNKNOWN_ERROR';

  return toYautjaError(targetCode, {
    message: legacy.message,
    agent_summary: isUnclassified
      ? `LEGACY_ERROR_UNCLASSIFIED: original type was UNKNOWN_ERROR. ${legacy.recoveryHint ?? 'Inspect the error message for clues.'}`
      : undefined,
  });
}
```

## Step 3: Run tests

Run: `npx vitest run tests/doctrine/classifier.test.ts`
Expected: PASS (7 tests)

## Step 4: Commit

```bash
cd D:\Yautja
git add src/doctrine/classifier.ts tests/doctrine/classifier.test.ts
git commit -m "feat(doctrine): add legacy ArsenalError classifier shim for migration Phase 1"
```

## Report Contract

Write to `D:\Yautja\.superpowers\sdd\error-task-5-report.md`. Return ONLY: status, commit hashes, one-line test summary, concerns.