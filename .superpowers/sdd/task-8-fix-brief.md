# Task 8 Fix Brief — Test isolation race condition

**Source:** Review of Task 8 (`D:\Yautja\.superpowers\sdd\task-8-review.md`)
**Severity:** Important (test passes in isolation, fails when run with full suite)

## Bug

In `D:\Yautja\tests\macros\helmet-integration.test.ts:35-36`, the current spawn helper captures `process.stdout.write`:

```typescript
const orig = process.stdout.write.bind(process.stdout);
process.stdout.write = ((c: any) => { out.push(c.toString()); return true; }) as any;
const h = new Helmet({ port: 9999 });
h.serveMCP();
process.stdout.write = orig;
```

This monkey-patches `process.stdout.write` directly. `tests/helmet.test.ts` uses a different pattern:

```typescript
Object.defineProperty(process, 'stdout', { value: newStream, configurable: true });
```

When both test files run in vitest's default thread pool:
1. `helmet.test.ts` defines a property on `process.stdout` (configurable: true)
2. `helmet-integration.test.ts` assigns to `process.stdout.write` directly
3. The two patterns conflict — the second to load sees a different `process.stdout` shape
4. Result: 4 race-dependent new failures (16 → 20) that the implementer's "0 new failures" claim doesn't match

## Fix

Replace the spawn helper in `tests/macros/helmet-integration.test.ts` to use the `Object.defineProperty(process, 'stdout', ...)` pattern matching `tests/helmet.test.ts:91-92`.

Concrete change:

```typescript
// BEFORE:
function spawn() {
  const stdin = new Readable({ read() {} });
  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: any) => { out.push(c.toString()); return true; }) as any;
  const h = new Helmet({ port: 9999 });
  h.serveMCP();
  process.stdout.write = orig;
  return { h, stdin, out };
}

// AFTER:
function spawn() {
  const stdin = new Readable({ read() {} });
  const out: string[] = [];
  const capturedStream = new Writable({
    write(chunk, encoding, callback) {
      out.push(chunk.toString());
      callback();
    },
  });
  const origStdout = process.stdout;
  Object.defineProperty(process, 'stdout', { value: capturedStream, configurable: true });
  const h = new Helmet({ port: 9999 });
  h.serveMCP();
  Object.defineProperty(process, 'stdout', { value: origStdout, configurable: true });
  return { h, stdin, out };
}
```

Also add `import { Writable } from 'stream';` to the imports at the top of the file.

Update `send()` to use `stdin.push()` not `stdin.emit()` — matches `helmet.test.ts` pattern. Make send and the tests async with polling, matching helmet.test.ts.

The 4 test bodies (assertions, expected values) MUST remain semantically identical — only the harness plumbing changes.

## Files to modify

- `D:\Yautja\tests\macros\helmet-integration.test.ts` — fix spawn/send helpers only, do NOT change test bodies

## Verification

Critical: must run the FULL vitest suite, not just the integration test in isolation.

- `cd D:\Yautja && npx vitest run tests/macros/helmet-integration.test.ts` → expect 4/4 pass
- `cd D:\Yautja && npx vitest run` → expect EXACTLY 16 failures (the pre-existing `helmet.test.ts` ones), NOT 20. The 4 integration tests should pass alongside.
- `cd D:\Yautja && npx tsc --noEmit` → 0 errors

If the fix is correct, the total failure count should match the baseline `fa8539c` state (16 pre-existing failures, no new failures introduced).

## Report Contract

Write to `D:\Yautja\.superpowers\sdd\task-8-fix-report.md`:

```
# Task 8 Fix Report

## Status
DONE

## Change
[description of spawn/send refactor]

## Verification
- Integration test in isolation: 4/4 pass
- Full suite: <X> failures (should be exactly 16, matching baseline)
- tsc: 0 errors

## Race condition resolved
[yes — confirmed by full-suite run]
```

Reply:
```
STATUS: DONE
CHANGE: <summary>
INTEGRATION_ISOLATED: 4/4 pass
FULL_SUITE_FAILURES: <X — should be 16>
TSC: 0 errors
```

## Constraints

- **ONLY change the harness plumbing**. The 4 test bodies (it() blocks with assertions) MUST remain semantically identical.
- Do NOT touch `src/helmet.ts` or any other file.
- Do not commit.

## Model

`minimax-coding-plan/MiniMax-M3` (project default)