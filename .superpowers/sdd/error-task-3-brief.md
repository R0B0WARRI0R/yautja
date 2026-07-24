# Task 3 Brief — ID Generation + Idempotency Registry

**Source plan:** `D:\Yautja\proyectos-pendientes\2026-07-15-yautja-error-contract-plan.md`
**Repo:** `D:\Yautja` (git initialized, branch: main)
**Spec:** `D:\Yautja\proyectos-pendientes\yautja-error-contract-1.0.md`
**Ledger:** `D:\Yautja\.superpowers\sdd\error-contract-progress.md`
**Prior task:** Task 2 (commit `1b99371`) added the error code registry.

## Scene-setting

You are implementing Task 3 of the Yautja Error Contract v1.0. You add two things:

1. **ID generators** — wrapper functions around the `ulid` library that produce prefixed IDs (trace_id, operation_id, idempotency_key)
2. **IdempotencyRegistry** — a TTL-based key-value cache that stores `YautjaResponse` results keyed by idempotency_key, used by the recovery machine (Task 7) to short-circuit duplicate operations

The `ulid` library is already installed (Task 1). The `YautjaResponse` type is in place (Task 1).

## Files

- Create: `src/doctrine/ids.ts`
- Create: `src/doctrine/idempotency.ts`
- Create: `tests/doctrine/ids.test.ts`
- Create: `tests/doctrine/idempotency.test.ts`

## Interfaces

- **Consumes:** `ulid` from npm; `YautjaResponse` from `src/doctrine/types.js`
- **Produces:**
  - `generateTraceId()` — returns `tr_<ULID>`
  - `generateOperationId()` — returns `op_<ULID>`
  - `generateIdempotencyKey()` — returns `ik_<ULID>`
  - `IdempotencyConfig` — `{ defaultTtlMs: number }`
  - `IdempotencyRegistry` class with: `get(key)`, `set(key, result, ttlMs?)`, `purge()`, `size()`, `clear()`

## Step 1: Write failing tests for IDs

Create `tests/doctrine/ids.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { generateTraceId, generateOperationId, generateIdempotencyKey } from '../../src/doctrine/ids.js';

describe('ID generators', () => {
  it('trace_id starts with tr_ prefix', () => {
    const id = generateTraceId();
    expect(id).toMatch(/^tr_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('operation_id starts with op_ prefix', () => {
    const id = generateOperationId();
    expect(id).toMatch(/^op_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('idempotency_key starts with ik_ prefix', () => {
    const key = generateIdempotencyKey();
    expect(key).toMatch(/^ik_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('two calls produce different IDs', () => {
    expect(generateOperationId()).not.toBe(generateOperationId());
  });
});
```

## Step 2: Implement ids.ts

Create `src/doctrine/ids.ts`:

```typescript
import { ulid } from 'ulid';

export function generateTraceId(): string {
  return `tr_${ulid()}`;
}

export function generateOperationId(): string {
  return `op_${ulid()}`;
}

export function generateIdempotencyKey(): string {
  return `ik_${ulid()}`;
}
```

## Step 3: Write failing tests for idempotency

Create `tests/doctrine/idempotency.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { IdempotencyRegistry } from '../../src/doctrine/idempotency.js';

describe('IdempotencyRegistry', () => {
  let registry: IdempotencyRegistry;

  beforeEach(() => {
    registry = new IdempotencyRegistry({ defaultTtlMs: 1000 });
  });

  it('returns undefined for unknown key', () => {
    expect(registry.get('ik_unknown')).toBeUndefined();
  });

  it('stores and retrieves a result', () => {
    const key = 'ik_123';
    const result = { ok: true as const, result: 'cached' };
    registry.set(key, result);
    expect(registry.get(key)).toEqual(result);
  });

  it('expires entries after TTL', async () => {
    const key = 'ik_expired';
    registry.set(key, { ok: true, result: 'old' });
    await new Promise(r => setTimeout(r, 1100));
    expect(registry.get(key)).toBeUndefined();
  });

  it('supports custom TTL per entry', async () => {
    const key = 'ik_custom';
    registry.set(key, { ok: true, result: 'data' }, 100);
    await new Promise(r => setTimeout(r, 150));
    expect(registry.get(key)).toBeUndefined();
  });

  it('purges expired entries on cleanup', () => {
    // Set expired entry by manipulating internal clock
    registry.set('ik_old', { ok: true, result: 'x' }, -1);
    registry.set('ik_fresh', { ok: true, result: 'y' });
    registry.purge();
    expect(registry.get('ik_old')).toBeUndefined();
    expect(registry.get('ik_fresh')).toBeDefined();
  });
});
```

## Step 4: Implement idempotency.ts

Create `src/doctrine/idempotency.ts`:

```typescript
import type { YautjaResponse } from './types.js';

interface RegistryEntry<T = unknown> {
  result: YautjaResponse<T>;
  expiresAt: number;
}

export interface IdempotencyConfig {
  defaultTtlMs: number;
}

export class IdempotencyRegistry {
  private entries = new Map<string, RegistryEntry>();
  private config: IdempotencyConfig;

  constructor(config: IdempotencyConfig) {
    this.config = config;
  }

  get<T = unknown>(key: string): YautjaResponse<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.result as YautjaResponse<T>;
  }

  set<T = unknown>(
    key: string,
    result: YautjaResponse<T>,
    ttlMs?: number,
  ): void {
    const ttl = ttlMs ?? this.config.defaultTtlMs;
    this.entries.set(key, {
      result: result as YautjaResponse<unknown>,
      expiresAt: Date.now() + ttl,
    });
  }

  purge(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now > entry.expiresAt) {
        this.entries.delete(key);
      }
    }
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
```

## Step 5: Run all tests

Run: `npx vitest run tests/doctrine/ids.test.ts tests/doctrine/idempotency.test.ts`
Expected: PASS (9 tests total)

## Step 6: Commit

```bash
cd D:\Yautja
git add src/doctrine/ids.ts src/doctrine/idempotency.ts tests/doctrine/ids.test.ts tests/doctrine/idempotency.test.ts
git commit -m "feat(doctrine): add ULID generators and idempotency registry with TTL"
```

## Report Contract

Write to `D:\Yautja\.superpowers\sdd\error-task-3-report.md`:

```markdown
# Task 3 Report

**Status:** DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

**Commits:**
- <hash7> <message>

**Test summary:**
- Tests: <passed>/<total>
- tsc --noEmit: 0 errors

**Self-review:**
- [what you checked]

**Concerns:**
- [observations, not new questions]
```

Return ONLY:
1. Status
2. Commit hashes + messages
3. One-line test summary
4. List of concerns (or "none")