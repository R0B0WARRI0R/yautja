# Task 4 Report

## Status: DONE

## Test output

```
 RUN  v2.1.9 D:/Yautja

[Yautja] builtin macro broken.js: invalid shape
 ✓ tests/macros/loader.test.ts (4 tests) 31ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  19:58:08
   Duration  694ms (transform 86ms, setup 0ms, collect 96ms, tests 31ms, environment 0ms, prepare 173ms)
```

The stderr line `[Yautja] builtin macro broken.js: invalid shape` is the **expected fail-soft warning** emitted by test 3 ("records malformed file in skipped, continues loading others"), which asserts `broken.js` ends up in `result.skipped`. No other stderr noise.

## TDD trace

1. RED: `Failed to load url ../../src/macros/loader.js (resolved id: ../../src/macros/loader.js) in D:/Yautja/tests/macros/loader.test.ts. Does the file exist?` — 0 tests collected, suite failed at import.
2. GREEN: After creating `src/macros/loader.ts`, all 4 tests passed.

## Compile output

```
$ npx tsc --noEmit
(no output — 0 errors)
```

## Files created

- `src/macros/loader.ts` — exports `loadBuiltins`, `LoadResult`; module-scope helpers `resolveBuiltinDir`, `importMacro`, `isValidMacro`; constant `BUILTIN_EXCLUDES`. **No** `resolveUserDir` or `loadUserMacros` (deferred to Task 5 per brief).
- `tests/macros/loader.test.ts` — 4 tests: (1) loads valid macro, (2) excludes framework files, (3) skip-on-malformed, (4) silent skip on missing dir.

## Constraints verified

- TDD strictly: test-first RED → implement → GREEN.
- `Write` used for initial file creation; `Edit` used to append test cases (XML tool-content limit required incremental builds — files are byte-identical to brief content).
- TS strict: `noUnusedLocals` / `noUnusedParameters` enabled in tsconfig; `cacheBust` parameter on `importMacro` is used inside the `if` branch — TS strict accepts unused-by-conditional params in this shape because it is referenced (brief's contract).
- No `resolveUserDir` / `loadUserMacros` added.
- No git commit performed.
- No package installs.

## Concerns

None.