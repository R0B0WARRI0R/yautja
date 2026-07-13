# Task 2 Review

**Task:** MacroRunner registry (register / unregister / list / get)
**Reviewer:** minimax-coding-plan/MiniMax-M3
**Date:** 2026-07-13

## Verification results

| Check | Command | Result |
|---|---|---|
| Type-check | `npx tsc --noEmit` | 0 errors (exit 0, no output) |
| Tests | `npx vitest run tests/macros/runner.test.ts` | 5/5 passed in 4ms |

## A. Spec compliance: ✅ PASS

- **Class export**: `MacroRunner` exported with exactly the 4 brief methods (`register`, `unregister`, `get`, `list`).
- **Out-of-scope methods**: `run`, `registerUserMacro`, `deleteUserMacro` correctly **not** present. Those belong to Tasks 3+.
- **Test count**: 5 tests, exactly matching the brief, in the right order:
  1. registers a macro and lists it as builtin by default
  2. registers with argsSchema and reports hasArgs=true
  3. get returns the entry; unknown returns undefined
  4. unregister removes and returns true; false if absent
  5. re-registering same name overwrites
- **Contract match**: `import` statement, `registry` field, and all 4 public methods are byte-identical to the brief's contract block. `toSummary` body matches verbatim, including the `if (def.timeoutMs !== undefined) summary.timeoutMs = def.timeoutMs;` guard.
- **Files**: only the two new files were created. No modifications to `types.ts` or any other file. ✅
- **TDD evidence**: report documents the red→green cycle (test fails with `Cannot find module '../../src/macros/runner.js'` → implementation → pass). ✅

## B. Code quality: ✅ APPROVED

### Deviation assessment: `void this.host;` in constructor

**Severity: Minor — defensible workaround, no fix required.**

Analysis of the deviation:

1. **Constraint conflict**: The brief specifies `constructor(private readonly host: HelmetLike) {}` AND requires "TypeScript strict — every variable used". Under `tsconfig.json` (`strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true`, lines 9-11), an unused private parameter-property fails with `TS6138: Property 'host' is declared but its value is never read`. Task 3 will use `host`; Task 2 cannot.

2. **Alternatives evaluated**:

   | Option | Cost | Verdict |
   |---|---|---|
   | **`void this.host;` (chosen)** | 1 line in constructor | Minimum cost. Preserves exact field name and visibility Task 3 needs. Standard TS idiom for "reserved for future use." |
   | `_host` underscore prefix | Doesn't silence `TS6138` under the project's config (TS only respects the underscore convention for parameters, not parameter-properties, without `// @ts-expect-error`). Forces Task 3 to rename → gratuitous churn. | Worse. |
   | Drop field from Task 2 | Constructor signature differs from brief. `new MacroRunner(host)` calls from tests in subsequent tasks would break against Task 2's signature. Forces a contract change between Tasks 2 and 3 → review-time churn. | Worse. |
   | Relax `noUnusedLocals` project-wide | Affects every file. Mass scope creep. | Far worse. |
   | `// @ts-expect-error` comment | Same line count, but signals "wrong code" to future readers — wrong message. | Worse. |

3. **Future-proofing**: When Task 3 adds `run`, the implementation will read `this.host` and the `void this.host;` line becomes dead. Task 3 should delete it as part of its diff. That's a one-line removal — expected churn, not a hack.

4. **No API change**: Field name, type, and visibility are exactly what Task 3 needs. No test changes needed downstream.

### Other quality observations

- **Test structure**: Each `it()` has a single concern and a descriptive name that reads as a behavioral spec. ✅
- **`sampleDef` reuse**: declared once as a module constant, used by 4 of 5 tests. ✅
- **`beforeEach`**: properly resets `runner` for each test. ✅
- **`makeMockCtx` is defined but unused** in Task 2's tests. This is forward-looking scaffolding for Task 3 and is part of the brief's "exact content" block, so it's spec, not drift. Tests are excluded from `tsc`'s include path (`tsconfig.json` line 23), so `noUnusedLocals` does not flag it. Acceptable.
- **`toSummary` `exactOptionalPropertyTypes` handling**: `tsconfig.json` line 14 has `exactOptionalPropertyTypes: false`, so the `if (def.timeoutMs !== undefined)` guard is not strictly required. However, it's a forward-compatibility hedge that costs nothing — keeping it is fine.
- **Naming**: `MacroRunner` PascalCase, `runner.ts` kebab-case. ✅
- **No file modifications outside scope**: Task 1's `types.ts` untouched. ✅

## Issues

- [Critical] *(none)*
- [Important] *(none)*
- [Minor] `void this.host;` deviation from literal brief — already documented, justified, and approved above. Task 3 should remove this line when `host` becomes read.
- [Minor] Neither file ends with a trailing newline (per `git diff` "No newline at end of file" on both blobs). Cosmetic; no enforcement in the project.

## Verdict

**APPROVED**

Spec is met (with one minimal, well-documented, constraint-mandated deviation). Code quality is clean. Both verification commands pass. No fixes required. Ready for Task 3.