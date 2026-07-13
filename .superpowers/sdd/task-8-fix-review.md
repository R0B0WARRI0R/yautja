# Task 8 Fix Review

## A. Spec compliance: PASS

All 7 verification points from the brief met:

| # | Requirement | Evidence | Status |
|---|---|---|---|
| 1 | `Object.defineProperty(process, 'stdout', ...)` matching `helmet.test.ts:91-92` | helmet-integration.test.ts:42 uses `Object.defineProperty(process, 'stdout', { value: capturedStream, configurable: true })` — identical shape to helmet.test.ts:92 | PASS |
| 2 | `Writable` imported from 'stream' | helmet-integration.test.ts:2: `import { Readable, Writable } from 'stream';` — used at L33–38 to build capturedStream | PASS |
| 3 | Both `process.stdin` and `process.stdout` restored in teardown | teardown() at L48–51 restores both via `Object.defineProperty` to `origStdin`/`origStdout` captured in spawn() at L39–40 | PASS |
| 4 | 4 test bodies (it() blocks) semantically identical | L77–104: identical assertions, params, and structure to Task 8's verified wiring tests. No plumbing leaked into assertions. | PASS |
| 5 | **CRITICAL: `npx vitest run` → EXACTLY 16 failures (not 20)** | Empirically verified: `1 failed | 16 passed (17)` files, `16 failed | 423 passed (439)` tests — matches baseline `fa8539c` | PASS |
| 6 | Integration test in isolation: 4/4 pass | Empirically verified: `1 passed (1)` files, `4 passed (4)` tests (73ms) | PASS |
| 7 | `npx tsc --noEmit` clean | Empirically verified: exit code 0, 0 errors | PASS |

**Pattern parity (helmet.test.ts:91-92 vs helmet-integration.test.ts:41-42):**
- helmet.test.ts:91: `Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });`
- helmet-integration.test.ts:41: `Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });`
- helmet.test.ts:92: `Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });`
- helmet-integration.test.ts:42: `Object.defineProperty(process, 'stdout', { value: capturedStream, configurable: true });`

All four lines structurally identical, differing only in the value bound (named `stdin`/`stdout` vs locally-scoped `stdin`/`capturedStream`).

## B. Code quality: APPROVED

**Strengths:**
- Module-level `origStdin`/`origStdout` capture is explicit (L27–28) — avoids the brief's pseudocode bug of capturing `origStdout` inside `spawn()` only.
- `spawn()` returns `{ h, stdin, out }` tuple — caller binds via destructuring in `beforeEach`, clean.
- `teardown()` is a separate function called from `afterEach` — single-responsibility, testable in isolation.
- `send()` async with polling at L53–62 — correct pattern for the async MCP handler at helmet.ts:295; throws clear error on timeout instead of silently reading stale `out[]`.
- `Writable` write handler is minimal and correct: pushes `chunk.toString()`, immediately calls `callback()` (no backpressure — appropriate for a test capture stream).
- No unused imports, no shadowing, no `any` leakage beyond what's already in the surrounding code.

**Notable deviation from brief (POSITIVE):**
The brief's "AFTER" pseudocode (fix-brief.md L62–63) shows `Object.defineProperty(process, 'stdout', { value: origStdout, ... })` called **inside** `spawn()`, immediately after `h.serveMCP()`. This is the same bug the original Task 8 implementer hit (Task 8 report L55–57): restoring stdout before tests run means `sendMCP` output goes to real stdout, not `out[]`.

The fix implementer correctly moved the restore into `teardown()` (called from `afterEach`), keeping the captured stream alive for the test duration. This matches `helmet.test.ts:96–104` exactly. The deviation is a **correct engineering response** to a brief-level defect, not a bug.

## Race resolved

**YES — empirically verified.**

Full suite output:
```
Test Files  1 failed | 16 passed (17)
     Tests  16 failed | 423 passed (439)
```

- **16 failures**: all in `tests/helmet.test.ts` (pre-existing, unrelated mock missing `setNetworkCaptureCallback` — confirmed by Task 8 review L59).
- **423 passed**: 419 pre-existing + 4 new (the integration tests).
- **Net delta vs baseline `fa8539c`**: +4 passes, 0 new failures.

This is deterministic — the same pattern is now used in both files, so vitest's default thread pool no longer races on `process.stdout`.

## Issues

### Critical
None.

### Important
None.

### Minor
1. **teardown() ordering differs from helmet.test.ts.** helmet.test.ts L102–103 restores stdin first, then stdout. helmet-integration.test.ts L49–50 restores stdout first, then stdin. Functionally equivalent (both properties are independent), but stylistic inconsistency. Not a defect.

2. **File is untracked in git.** `tests/macros/helmet-integration.test.ts` shows as untracked in `git status`. `git diff fa8539c -- tests/macros/helmet-integration.test.ts` returns empty (file did not exist at `fa8539c`; it was added by Task 8, never committed). The `task-8-fix-diff.txt` referenced in the review brief does not exist. Not a code defect, but the brief's diff-source-of-truth is missing — the actual diff is "the entire file is the fix".

3. **No `task-8-fix-diff.txt` artifact.** The brief instructed the implementer to produce `D:\Yautja\.superpowers\sdd\task-8-fix-diff.txt`. This file does not exist. Reviewer was forced to rely on `git diff fa8539c` (which yielded nothing due to file being untracked) plus direct file inspection. Not blocking — but documentation hygiene.

4. **Brief's "AFTER" pseudocode has a known latent bug** (restore inside `spawn()` immediately after `serveMCP()`). The implementer correctly deviated, but the brief itself is incorrect and could mislead future contributors. Recommendation: update `task-8-fix-brief.md` to show `teardown()` + `afterEach` pattern explicitly.

## Verdict

**APPROVED**

All 7 verification criteria pass empirically:
- Integration isolated: 4/4 pass
- Full suite: 16 failures (matching baseline, NOT 20)
- tsc: 0 errors
- Spec items 1–4 confirmed by code inspection + cross-reference with `helmet.test.ts:91–92`

The race condition documented in the original Task 8 review is fully resolved. The implementer correctly identified and fixed a latent bug in the brief's own pseudocode (restoring stdout inside `spawn()` instead of in teardown), demonstrating sound engineering judgment. The fix is minimal (only plumbing changed), surgical (no `src/helmet.ts` modifications, no test body changes), and aligned with the established pattern in `tests/helmet.test.ts`.