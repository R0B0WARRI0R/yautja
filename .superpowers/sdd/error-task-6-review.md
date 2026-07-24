# Task 6 Review

## Critical fix verification (Concern #1)

The implementer's diagnosis is **correct and the fix is minimal**:

- Brief formula `Math.floor(capped + jitter)` returns `[capped, 1.25 * capped]`. When `exponential >= max_ms`, `capped == max_ms`, so the return range is `[max_ms, 1.25 * max_ms]` — exceeds cap.
- For `base_ms=100, max_ms=1000, attempt=10`: brief would yield `[1000, 1250)` → fails `expect(delay).toBeLessThanOrEqual(1000)`. Implementer's reported 1244 confirms.
- Diff shows `return Math.min(Math.floor(capped + jitter), policy.max_ms)` — single-token change wrapping the existing return.
- Non-capped attempts (attempt 1, 2, 3 with base_ms=100, max_ms=1000): exponential = 100/200/400, all below cap → jitter range unchanged → exponential growth and "returns base_ms for attempt 1" test still pass.
- Verdict: minimal, correct, preserves spec intent. Concern #1 is a legitimate brief typo, not a redesign.

## Spec compliance

| Requirement | Status | Evidence |
|---|---|---|
| `src/doctrine/retry-engine.ts` created | ✅ | diff: 89 lines new file |
| `tests/doctrine/retry-engine.test.ts` created | ✅ | diff: 70 lines new file |
| `BackoffPolicy` interface exported | ✅ | line 1 of diff |
| `RetryPolicy` interface exported | ✅ | line 7 of diff |
| `calculateBackoff()` exported | ✅ | line 15 of diff |
| `RetryEngine` class exported | ✅ | line 31 of diff |
| `DEFAULT_RETRY_POLICIES` const exported | ✅ | line 59 of diff |
| 4 keys: `act.click`, `act.type`, `act.navigate`, `default` | ✅ | all present |
| 10 tests pass | ✅ | 3 + 4 + 3 = 10 in test file; report confirms `10/10 retry-engine tests pass`, full suite `49 tests across 7 files` green |
| `calculateBackoff` exponential_jitter respects max_ms cap | ✅ | `Math.min(..., policy.max_ms)` applied |
| `shouldRetry`: max_attempts exceeded → false | ✅ | `if (attempt >= this.policy.max_attempts) return false` |
| `shouldRetry`: never_retry_on wins over retry_on | ✅ | never_retry_on check precedes retry_on check |
| `shouldRetry`: not in retry_on → false | ✅ | `if (!this.policy.retry_on.includes(code)) return false` |
| `nextEscalation`: attempt 1 → first, capped to last | ✅ | `idx = Math.min(attempt - 1, length - 1)` |
| ESM `.js` extensions in imports | ✅ | test imports `'../../src/doctrine/retry-engine.js'` |
| No `any`, no `@ts-ignore` | ✅ | grep of diff: neither present |
| Conventional commit | ✅ | `feat(doctrine): add retry engine with backoff policies and escalation ladder` (commit `891e937`) |

## Code quality

- Clean separation: pure function + stateful class + data table.
- `getDelay()` delegates to `calculateBackoff` — no duplication.
- `nextEscalation` cap uses `Math.min` with `length - 1` — correct boundary, safe for empty arrays would throw but spec guarantees non-empty escalation.
- Fix is the minimal possible change (one wrapper).
- Brief typo on test count (9 vs 10) handled correctly — implementer ran all defined tests.

## Findings

**Spec compliance:** ✅
**Code quality:** approved
**Findings:** 1 (informational)

| Severity | Finding | Action |
|---|---|---|
| info | When `exponential >= max_ms`, the post-jitter clamp effectively zeros out the jitter (any positive jitter is clamped to max_ms). A more principled formula would reserve headroom for jitter: `const capped = Math.min(exponential, max_ms - jitter)` or `Math.min(exponential, max_ms) * (1 - 0.25 * Math.random())` style. Not required by any test, but worth revisiting if jitter diversity at the cap becomes desirable in Task 7 (recovery machine) or later. | none — document for Task 7 implementer if jitter-at-cap matters downstream |

**Verdict:** approved