# Task 5 Review

## A. Spec compliance: ✅ PASS

All 9 spec items verified against the implementation:

- `resolveUserDir()` exported (`src/macros/loader.ts:65`)
- Honors `process.env.YAUTJA_USER_DIR` first, then falls back to `path.join(process.env.APPDATA || process.env.HOME || '/tmp', '.yautja-macros')` (`loader.ts:66-67`)
- `loadUserMacros(runner: MacroRunner): Promise<LoadResult>` exported (`loader.ts:70`)
- Cache-busting via `importMacro(full, true)` which appends `?v=${stat.mtimeMs}` (`loader.ts:91` → `:23`)
- Registered with `runner.register(def, 'user', full)` — full path is the third arg (`loader.ts:97`)
- Hidden files skipped: `f.endsWith('.js') && !f.startsWith('.')` (`loader.ts:83`)
- Directory auto-created: `if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })` (`loader.ts:75`)
- 4 new tests added in `describe('loadUserMacros', ...)` (`tests/macros/loader.test.ts:85-128`), matching brief exactly (loads with cache-bust, skips hidden files, creates dir if missing, skips malformed file)
- `loadBuiltins` and other pre-existing code untouched — diff shows only line 60+ appended

## B. Code quality: ✅ APPROVED

All 7 code-quality criteria satisfied:

- `path.join` used consistently (lines 67, 89); no `path.resolve(URL.pathname)` pattern (Task 4's bug absent)
- `fs.mkdirSync(dir, { recursive: true })` gated by `!fs.existsSync(dir)` (line 75)
- Cache-bust uses `stat.mtimeMs`, not `Date.now()` — survives process restart for unchanged files (`loader.ts:23`)
- Per-file try/catch with fail-soft: catch writes stderr and pushes to `result.skipped` (lines 88-102); outer mkdir error is also fail-soft (lines 74-79)
- `runner.register(def, 'user', full)` — file path as third arg matches `MacroRunner` contract (`loader.ts:97`)
- `YAUTJA_USER_DIR` override checked in `resolveUserDir` only (line 66), not duplicated in `loadUserMacros`
- Mirrors `site-memory.ts:11` pattern exactly: `path.join(process.env.APPDATA || process.env.HOME || '/tmp', '.yautja-macros')` (loader.ts:67)

## Verification

```
$ npx vitest run tests/macros/loader.test.ts
RUN v2.1.9 D:/Yautja

[Yautja] builtin macro broken.js: invalid shape
[Yautja] user macro bad.js: syntax
 ✓ tests/macros/loader.test.ts (8 tests) 59ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Duration  831ms
```

```
$ npx tsc --noEmit
tsc: 0 errors
```

## Issues

- [Critical] None
- [Important] None
- [Minor] Both modified files (`loader.ts`, `loader.test.ts`) lack a trailing newline (per `\ No newline at end of file` in diff). Cosmetic only; not a code-quality blocker and matches the brief verbatim. Optionally fix in a future sweep.

## Verdict

APPROVED