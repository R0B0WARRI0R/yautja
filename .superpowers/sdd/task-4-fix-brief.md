# Task 4 Fix Brief — Windows path bug in resolveBuiltinDir

**Source:** Review of Task 4 (`D:\Yautja\.superpowers\sdd\task-4-review.md`)
**Severity:** Important (Windows path resolution bug)

## Bug

In `D:\Yautja\src\macros\loader.ts`:

```typescript
function resolveBuiltinDir(): string {
  if (process.env.YAUTJA_BUILTIN_DIR) return process.env.YAUTJA_BUILTIN_DIR;
  return path.resolve(new URL('.', import.meta.url).pathname, '..', 'macros');
}
```

On Windows, `new URL('.', import.meta.url).pathname` returns `/D:/Yautja/dist/macros/`. `path.resolve()` treats the leading `/` as drive-relative → produces `C:\D:\Yautja\dist\macros` (cwd-dependent, malformed).

This is masked in tests because `process.env.YAUTJA_BUILTIN_DIR` is always set in `beforeEach`, so the env branch returns before the URL branch executes. Production boot on Windows would fail.

## Fix

Replace `new URL('.', import.meta.url).pathname` with `path.dirname(fileURLToPath(import.meta.url))`:

```typescript
import { pathToFileURL } from 'url';
// also import: fileURLToPath from 'url' — already covered by adding to existing import

function resolveBuiltinDir(): string {
  if (process.env.YAUTJA_BUILTIN_DIR) return process.env.YAUTJA_BUILTIN_DIR;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'macros');
}
```

## Files to modify

- `D:\Yautja\src\macros\loader.ts` — apply the one-line fix
- `D:\Yautja\.superpowers\sdd\task-4-brief.md` — update the contract block to reflect the corrected implementation (so the bug does not regress)

## Verification

- `cd D:\Yautja && npx tsc --noEmit` → 0 errors
- `cd D:\Yautja && npx vitest run tests/macros/loader.test.ts` → 4/4 pass

## Report Contract

Write to `D:\Yautja\.superpowers\sdd\task-4-fix-report.md`:

```
# Task 4 Fix Report

## Status
DONE

## Change
[diff summary]

## Verification
- tsc --noEmit: 0 errors
- vitest loader.test.ts: 4/4 pass

## Brief also updated
[yes/no, with line range]
```

Reply:
```
STATUS: DONE
CHANGE: <one-line summary>
TSC: 0 errors
TESTS: 4/4 pass
BRIEF_UPDATED: yes/no
```

## Constraints

- **Minimal change**: only the path resolution. Do NOT touch other code.
- **Update the brief** so future tasks don't regress.
- Do not commit. Controller handles git after re-review.

## Model

`minimax-coding-plan/MiniMax-M3` (project default)