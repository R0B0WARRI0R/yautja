# Task 7 Review

**Spec compliance:** ❌
**Code quality:** fix-required
**Findings:** 2 (1 medium, 1 low)

| Severity | Finding | Action |
|---|---|---|
| medium | `tsc --noEmit` reports 4 errors in `src/doctrine/recovery-machine.ts` that did not exist at baseline `891e937`. Errors introduced by this commit: (a) `EvidenceMeta` declared but never used (TS6196, line 1); (b) generic `ExecuteOptions<T>` referenced without a type argument at lines 112, 124, 145 (TS2314). The brief itself contained these defects and the implementer reproduced them verbatim without running `tsc`. `package.json` defines `lint` as `tsc --noEmit` and `build` as `tsc`, so both fail. The 55/55 vitest pass does not catch this because vitest transforms via esbuild and ignores strict-mode tsc checks. | Fix: remove `EvidenceMeta` from the line-1 import; give the private `makeOperation`/`makeState`/`makeError` parameters a concrete type (e.g. `ExecuteOptions<unknown>`) or default the generic to `unknown`. Re-run `npm run lint` to confirm 0 errors. |
| low | Implementer report claims "Concerns: None." but did not actually run `tsc`. The doctrine project gates on `tsc --noEmit` for `lint` and on `tsc` for `build`; tsc must be part of the standard verification step before claiming a task complete. | Process fix: report template should require `npm run lint` (or `npx tsc --noEmit`) output be captured before declaring done. |

## Verification trail

- `tests/doctrine/recovery-machine.test.ts`: 6/6 pass in 1.15s.
- Full doctrine regression: **55/55 pass** across 8 test files (no regressions).
- `npx tsc --noEmit` against baseline `891e937` (with the new file temporarily removed): **0 errors**.
- `npx tsc --noEmit` against `ca963ad`: **4 errors** (listed above).
- `git show --stat ca963ad`: only the two expected files added (+286 lines).
- Commit message follows Conventional Commits (`feat(doctrine): ...`).
- ESM `.js` extensions present in all imports. No `any`, no `@ts-ignore`.

## Critical-review items

| Item | Verdict |
|---|---|
| PREFLIGHT contamination check precedes idempotency cache check | ✅ Lines 44–47 run before lines 49–53 |
| Idempotency cache hit returns cached result without calling `fn` | ✅ Test 6 passes; `fn` called once |
| Result cached after retry succeeds | ✅ COMMIT path at lines 75–86 caches when `idempotency_key` is set |
| `verify()` failure treated as `YJ.ACT.DOM_TARGET_STALE` | ✅ Lines 66–73 |
| `lastErrorCode ?? 'YJ.NET.REQUEST_TIMEOUT'` fallback on exhausted retries | ✅ Line 109 |
| `operation_id` generated once and reused across attempts | ✅ Generated at line 56, reused in `makeOperation`/`makeError` calls |

The runtime behaviour is correct — every test in the brief passes and the doctrine suite shows no regressions. The failure is purely in static type checking: the brief itself contains two type errors that the implementer transcribed without verifying against `tsc`.

**Verdict:** fix-required