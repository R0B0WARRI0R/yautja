# Task 4 Fix Report

## Status
DONE

## Change
- `src/macros/loader.ts`: import `fileURLToPath` from `'url'`; replace `path.resolve(new URL('.', import.meta.url).pathname, '..', 'macros')` with `path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'macros')`. Cross-platform safe: no Windows drive-relative leak.

## Verification
- tsc --noEmit: 0 errors
- vitest loader.test.ts: 4/4 pass

## Brief also updated
yes — `task-4-brief.md` lines 35 and 48 (import + contract `resolveBuiltinDir`) now match the corrected implementation.