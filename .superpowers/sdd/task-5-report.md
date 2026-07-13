# Task 5 Report

## Status: DONE

## Test output

### RED phase (after appending tests, before implementation)
```
RUN v2.1.9 D:/Yautja

[Yautja] builtin macro broken.js: invalid shape
 ❯ tests/macros/loader.test.ts (8 tests | 4 failed) 44ms
   × loadUserMacros > loads .js file with cache-busting query param 7ms
     → loadUserMacros is not a function
   × loadUserMacros > skips hidden files (starting with .) 2ms
     → loadUserMacros is not a function
   × loadUserMacros > creates user dir if missing, loads nothing 1ms
     → loadUserMacros is not a function
   × loadUserMacros > skips malformed file, records in skipped 2ms
     → loadUserMacros is not a function

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯

FAIL tests/macros/loader.test.ts > loadUserMacros > loads .js file with cache-busting query param
TypeError: loadUserMacros is not a function
 ❯ tests/macros/loader.test.ts:101:26

[...3 more identical "loadUserMacros is not a function" failures...]

 Test Files  1 failed (1)
      Tests  4 failed | 4 passed (8)
   Duration  688ms
```
Confirmed: 4 existing pass + 4 new FAIL with `loadUserMacros is not a function` (runtime), exactly as expected.

### GREEN phase (after appending implementation)
```
RUN v2.1.9 D:/Yautja

[Yautja] builtin macro broken.js: invalid shape
[Yautja] user macro bad.js: syntax
 ✓ tests/macros/loader.test.ts (8 tests) 49ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Start at  20:13:12
   Duration  671ms
```

## Compile

```
$ npx tsc --noEmit
(no output)
```
0 errors.

## Files modified
- src/macros/loader.ts (appended: `resolveUserDir` + `loadUserMacros` after existing `loadBuiltins`)
- tests/macros/loader.test.ts (appended: import line updated to include `loadUserMacros`; new `describe('loadUserMacros', ...)` block with 4 tests added after the `loadBuiltins` block)

No other files modified. `loadBuiltins` and all earlier code untouched.

## Concerns

None. Implementation matches the brief's contract exactly:
- `resolveUserDir` honours `process.env.YAUTJA_USER_DIR` override, then `APPDATA || HOME || /tmp`.
- `loadUserMacros` creates the dir if missing, filters out dotfiles, uses `importMacro(full, true)` for cache-busting (`?v=mtimeMs`), validates via `isValidMacro`, registers with `runner.register(def, 'user', full)`, and logs parse/import failures to stderr.
- Existing `loadBuiltins` was not modified.
