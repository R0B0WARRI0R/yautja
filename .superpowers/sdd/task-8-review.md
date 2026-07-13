# Task 8 Review

## A. Spec compliance: ✅ PASS

All 6 surgical edits applied at correct locations in `src/helmet.ts`:

| # | Location | Spec | Implementation |
|---|---|---|---|
| 1 | Imports (L27-29) | `MacroRunner`, `loadBuiltins`, `loadUserMacros` | ✅ All present, `.js` extensions |
| 2 | Field (L91) | `private macroRunner: MacroRunner;` | ✅ |
| 3 | Constructor (L125) | `new MacroRunner(...)` with cast | ✅ `this as unknown as HelmetLike` |
| 4 | `start()` (L177-186) | fail-soft try/catch + stderr | ✅ Both loaders called, stderr on error |
| 5 | `handleToolCall` (L752-765) | 4 cases before `default:` | ✅ macro_list, macro_run, macro_register, macro_delete |
| 6 | `MCP_TOOLS` (L1262-1302) | 4 entries | ✅ All 4 with correct schemas |

**Schemas verified:**
- `macro_register`: properties `{name, source, overwrite}`, required `['name', 'source']`, `overwrite === true` default ✅
- `macro_run`: properties `{name, args, timeoutMs}`, required `['name']` ✅
- `macro_list`, `macro_delete`: matching spec ✅

**Integration test file:** `tests/macros/helmet-integration.test.ts` covers 4 cases as specified:
1. `tools/list` includes all 4 macro names ✅
2. `macro_list` returns array ✅
3. `macro_run` on unknown returns lookup error ✅
4. `macro_register` with invalid name returns validation error ✅

**Verified by independent test runs:**
- `npx vitest run tests/macros/helmet-integration.test.ts` → 4/4 pass (89ms)
- `npx vitest run tests/macros/` → 35/35 pass (loader=8, register-delete=10, runner=13, helmet-integration=4)
- `npx tsc --noEmit` → 0 errors

## B. Code quality: ⚠️ NEEDS_FIXES

### Concern 1 — Test harness fix (JUSTIFIED)
The brief's literal `spawn()`/`send()` was structurally broken. Independently verified by reading the brief lines 204-217:
- `spawn()` did NOT monkey-patch `process.stdin` before `h.serveMCP()` (brief L204-213). `serveMCP` calls `createInterface({ input: process.stdin, output: process.stderr })` at helmet.ts:293 — without monkey-patching, the readline listener binds to the real `process.stdin`, so the test's mock stdin emits never reach the handler.
- `spawn()` restored `process.stdout.write = orig` BEFORE tests ran (brief L211). helmet.ts:775 calls `process.stdout.write(...)` in `sendMCP` — once stdout.write is restored, output goes to real stdout, not to `out[]`.
- `send()` was synchronous (brief L215-217); the MCP handler at helmet.ts:295 is `async`. By the time the test reads `out[]`, the async handler hasn't run yet.

The implementer's fix (Object.defineProperty on stdin BEFORE serveMCP, stdout.write NOT restored until afterEach, async send with polling) **exactly mirrors the pattern in `tests/helmet.test.ts:80-118`**. The 4 test bodies are semantically identical to the brief's intent.

### Concern 2 — `this as unknown as HelmetLike` cast (DEFERRED — Important)
**DIAGNOSIS CONFIRMED.** I read `src/macros/types.ts:79-110` and `src/helmet.ts:64-155` independently:

`HelmetLike` declares 28 methods, including `openTab`, `switchTab`, `closeTab`, `findElement`, `findClick`, `findType`, `smartType`, `techScan`, `stealthCheck`, `stealthEnable`, `stealthDisable`, `interceptEnable`, `interceptAddRule`, `interceptDisable`, `interceptLog`, `captureList`, `captureRequest`, `captureResponse`, `osintHarvest`, `netIntel`, `gqlQuery`, `siteMemory`, `siteMemoryClear`, `wsWatch`, `wsFrames`.

`Helmet`'s actual instance methods (helmet.ts:64-806): `start`, `stop`, `isReady`, `attachToActiveTab`, `listTabs`, `ensureAttached`, `reattach`, `observe`, `act`, `inspect`, `diff`, `serveMCP`, `gatherState`. The methods named in `HelmetLike` exist ONLY as `case` arms in `handleToolCall` (lines 365-528 for `openTab`/`switchTab`/`closeTab`/`findElement`/etc., lines 540-564 for tech/stealth, etc.) — **NOT as instance methods on `Helmet`**.

The comment at types.ts:77 ("Helmet implicitly satisfies this — listed here for type-checking") is incorrect.

**Runtime safety:**
- In the integration tests: SAFE because both `macro_run 'ghost'` (runner.ts:128-131) and `macro_register 'Bad!'` (runner.ts:33-35) return early at lookup/validation BEFORE `buildCtx()` is called. `buildCtx` (runner.ts:208-244) is the only place that constructs lambdas like `openTab: (u) => h.openTab(u)`, which would throw at invocation.
- In real macro execution: **UNSAFE.** Any macro whose `run(args, ctx)` calls `ctx.openTab()`, `ctx.findElement()`, `ctx.smartType()`, etc. will throw `TypeError: h.openTab is not a function` at runtime. The cast silences TypeScript but cannot prevent the runtime failure.

**Verdict on cast:** Acceptable as a **deferred fix** within Task 8's scope (the brief specified `new MacroRunner(this)` literally; resolving the type mismatch requires either adding ~25 stub methods to Helmet that delegate to `handleToolCall`, or restructuring `HelmetLike` to a structural duck-type, or refactoring `MacroRunner` to take individual callables). All three options are larger than Task 8's "6 surgical edits" budget. **However**, this MUST be tracked as a follow-up task — macros that touch any `ctx.*` method will fail at runtime, which is the entire purpose of the macro system.

### Concern 3 — Pre-existing 16 failures (IMPLEMENTER'S VERIFICATION INACCURATE)

**Confirmed pre-existing:** `npx vitest run tests/helmet.test.ts` in isolation → 16 failures, all `this.server.setNetworkCaptureCallback is not a function` (the mock at helmet.test.ts:32-67 doesn't include `setNetworkCaptureCallback`). These predate Task 8 and are unchanged.

**Implementer's claim of "0 new failures" is INCORRECT.**

When I ran the FULL suite (`npx vitest run`), I observed:
- `tests/helmet.test.ts` — 16 failed (unchanged, pre-existing) ✅
- `tests/macros/helmet-integration.test.ts` — **4 NEW FAILURES** (race condition)
- Total: **2 failed files (17), 20 failed tests (439), 419 passed**

The 4 new failures in helmet-integration are reproducible: running both files together (`npx vitest run tests/helmet.test.ts tests/macros/helmet-integration.test.ts`) also produces 20 failures (16 + 4).

**Root cause: test parallelism conflict on `process.stdout`.**

`tests/helmet.test.ts:91-92` uses `Object.defineProperty(process, 'stdout', { value: writable, configurable: true })` — replaces the entire `process.stdout` object.

`tests/macros/helmet-integration.test.ts:35-36` uses `Object.defineProperty(process, 'stdin', ...)` then `process.stdout.write = capture` — overrides the `write` METHOD on whatever `process.stdout` currently is.

In vitest's default thread pool, both files share the same Node.js process globals. The execution order between file-level `beforeEach` hooks is non-deterministic:
- If `helmet-integration` runs first: it captures the real `process.stdout.write` into a closure over its local `out[]`. ✅ Works.
- If `helmet.test.ts` runs first: it replaces `process.stdout` with its Writable. Then `helmet-integration`'s spawn modifies `process.stdout.write` on the Writable. Helmet's `sendMCP` (helmet.ts:775) calls `process.stdout.write(...)` which now goes to helmet.test.ts's Writable, NOT to helmet-integration's `out[]`. helmet-integration reads `out[]`, finds it empty/stale, fails. ❌

The implementer got lucky in their run; my run exhibited the race. The implementer's full-suite claim of 423 passed is unverifiable — the result depends on file scheduling.

This violates the brief's Step 6 ("Expected: ALL pre-existing tests still pass") — running `npx vitest run` now produces a different number of failures depending on race outcome.

**Severity:** Important — not a Helmet code regression, but the regression check command (`npx vitest run`) is no longer deterministic. Future contributors will see flickering failure counts.

## Concern 2 adjudication (CRITICAL):
- **Diagnosis confirmed:** YES — `HelmetLike` declares 28 methods that exist only as `handleToolCall` cases on Helmet, not as instance methods.
- **Cast acceptable as deferred fix:** YES, with caveats — runtime macros using `ctx.openTab`/etc. will throw `TypeError` until either Helmet gains the missing instance methods, or HelmetLike is restructured.
- **Severity:** **Important** (not Critical) — does not block Task 8 (tests don't exercise ctx methods, code compiles, wiring is correct) but MUST be tracked as follow-up Task 9 or similar.

## Issues

### Critical
None.

### Important
1. **Test isolation race condition (helmet-integration.test.ts).** When `npx vitest run` is executed, helmet-integration.test.ts may fail 4/4 depending on test scheduling. The implementer's reported full-suite result (423 passed, 16 failed) is not reproducible — my run shows 419 passed, 20 failed. The test harness uses `process.stdout.write = capture` (method override) while helmet.test.ts uses `Object.defineProperty(process, 'stdout', ...)` (object replacement); these conflict in vitest's default thread pool. **Fix:** switch helmet-integration to the same pattern as helmet.test.ts (`Object.defineProperty(process, 'stdout', { value: writable, configurable: true })`), or use `vi.spyOn(process.stdout, 'write')`, or run the macros integration tests with `--pool=forks` / `--isolate`.

2. **`HelmetLike` ↔ `Helmet` type mismatch (deferred from Task 1 brief bug).** The cast `this as unknown as HelmetLike` compiles but is type-unsafe at runtime: any macro whose `run(args, ctx)` calls `ctx.openTab`, `ctx.findElement`, `ctx.smartType`, etc. will throw `TypeError: h.openTab is not a function`. Task 1's types.ts incorrectly assumed Helmet structurally satisfies HelmetLike. **Fix:** out of scope for Task 8, requires either adding stub methods to Helmet or refactoring HelmetLike/ctx. **File as Task 9.**

### Minor
1. **Implementer's claim of "+4 new passes, 0 new failures" is unverifiable.** Their full-suite run was lucky (race condition favored helmet-integration). My reproduction shows the test is flaky. Not a code issue per se — the brief's spec compliance is correct — but the regression check is no longer deterministic.

2. **Loader stderr noise during full-suite run.** Lines like `[Yautja] builtin macro broken.js: invalid shape` and `[Yautja] user macro bad.js: syntax` are emitted by `loader.test.ts` (testing invalid macro paths). They are expected test output but visible in full-suite stderr. Cosmetic.

## Verdict

**FIX_REQUIRED**

The Helmet code (spec compliance, code quality, minimal-edits discipline) is solid. The 6 surgical edits are exactly what the brief specified, the integration test bodies verify the correct wiring, and `tsc --noEmit` is clean.

However, the regression check (`npx vitest run`) is no longer reliable due to a test isolation race between helmet-integration.test.ts and helmet.test.ts — Task 8 introduces a NEW flaky failure mode (4 failures that come and go based on file scheduling). The implementer's claim of "0 new failures" doesn't match my reproduction (20 failures total, vs. their 16). This needs to be fixed before Task 8 can be approved.

The cast on `MacroRunner` is acceptable as a deferred fix but needs a follow-up issue filed.

**Required fix before approval:**
- Change `tests/macros/helmet-integration.test.ts:35-36` to use `Object.defineProperty(process, 'stdout', { value: writable, configurable: true })` matching `tests/helmet.test.ts:91-92` pattern. Verify `npx vitest run` returns deterministic 16 failures (helmet.test.ts only).

**Recommended follow-up tasks (not blocking):**
- Task 9: Resolve `HelmetLike` ↔ `Helmet` mismatch. Either add stub instance methods to Helmet that delegate to `handleToolCall`, or restructure `HelmetLike`/`MacroContext` so the cast becomes safe. Track with `// TODO(macros-task9)` comment at helmet.ts:125.