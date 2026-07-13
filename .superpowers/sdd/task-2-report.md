# Task 2 Report — MacroRunner registry (register/unregister/list/get)

**Task:** 2 of Yautja Macros feature
**Repo:** `D:\Yautja`
**Predecessor:** Task 1 (`src/macros/types.ts`) — untouched
**Date:** 2026-07-13

## Status

DONE_WITH_CONCERNS

Concern: one minimal deviation from the brief's literal "implementation contract" block — see "Deviation" section below. Required to satisfy the brief's own constraint "TypeScript strict — every variable used" given the project's `noUnusedLocals` + `noUnusedParameters` settings.

## Test output

`npx vitest run tests/macros/runner.test.ts`

```
 RUN  v2.1.9 D:/Yautja

 ✓ tests/macros/runner.test.ts (5 tests) 4ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Duration  577ms
```

**5/5 tests pass.**

TDD cycle executed:
1. Wrote test file → ran → RED: `Cannot find module '../../src/macros/runner.js'` (feature missing, as predicted).
2. Wrote implementation → ran → GREEN: 5/5 pass.
3. Initial `tsc --noEmit` flagged `Property 'host' is declared but its value is never read`. Applied minimal fix (see Deviation). Re-ran tests → still 5/5 pass. Re-ran `tsc --noEmit` → 0 errors.

## Compile output

`npx tsc --noEmit`

```
(no output)
EXITCODE=0
```

**0 errors.**

## Files created

- `D:\Yautja\src\macros\runner.ts` (1055 bytes) — `MacroRunner` class with registry and 4 basic ops
- `D:\Yautja\tests\macros\runner.test.ts` (3193 bytes) — 5 tests covering register / list / hasArgs / get / unregister / overwrite

## Files modified

None. Task 1's `src\macros\types.ts` was not touched.

## Deviation from brief

The brief's "implementation contract" block (lines 32-36) shows:
```typescript
constructor(private readonly host: HelmetLike) {}
```

Under the project's `strict` + `noUnusedLocals` + `noUnusedParameters` config, this triggers `TS6138: Property 'host' is declared but its value is never read` because Task 2 does not use `host` (Task 3's `run` will).

Applied fix — single line in constructor:
```typescript
constructor(private readonly host: HelmetLike) {
  void this.host;
}
```

- Preserves the exact `host` field name and visibility that Task 3 will use.
- Zero behavior change.
- Satisfies `noUnusedLocals`.
- No new public API, no signature changes.

If the controller prefers, alternatives are: prefix with underscore (`_host`), drop the field entirely (Task 3 will add it), or relax `noUnusedLocals` project-wide. The applied `void this.host;` was chosen as the smallest possible patch consistent with both the brief's API shape and the brief's "TypeScript strict" constraint.

## Constraints honored

- TDD strictly: test failed for the right reason before implementation existed.
- No modifications to existing files.
- `run`, `registerUserMacro`, `deleteUserMacro` not implemented (reserved for Tasks 3 and beyond).
- No package installs.
- No git commit (controller handles after review).