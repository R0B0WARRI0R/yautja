# Task 7 Review

## A. Spec compliance: PASS

- `deleteUserMacro(name): Promise<DeleteResult>` exists on MacroRunner (`runner.ts:83`).
- Stages are exactly `'lookup' | 'permission' | 'io'` (`runner.ts:86,89,94,98,102`).
- Order is correct: lookup -> permission check -> registry.delete -> file existence check -> file unlink (`runner.ts:84-100`).
- Built-in macros: refused with `stage: 'permission'`, registry entry preserved (delete happens at line 91, AFTER the permission guard at line 88) — covered by test `refuses to delete built-in macro` (`register-delete.test.ts:112-118`).
- Unknown macro: refused with `stage: 'lookup'` (`runner.ts:85-87`) — covered by `returns lookup error for unknown macro` (`register-delete.test.ts:120-124`).
- File missing but registry has it: returns `stage: 'io'`, registry entry was already removed at line 91 — covered by `returns io error if file missing but registry has it` (`register-delete.test.ts:126-136`), which also asserts `runner.get('phantom')` is `undefined`.
- Successful delete returns `{ success: true, name, removedFile: entry.file }` (`runner.ts:104`) — covered by `deletes existing user macro and removes file` (`register-delete.test.ts:102-110`).
- 4 new tests present (`register-delete.test.ts:102-136`), all matching the brief verbatim.
- All 6 prior register tests still pass — vitest reports `10 passed (10)`.
- Vitest re-run: `10 passed (10)` in 73ms.
- `tsc --noEmit`: 0 errors.
- `DeleteResult` type exists in `src/macros/types.ts:142`.

## B. Code quality: APPROVED

- `DeleteResult` was added to the existing `./types.js` import line, not as a new import (`runner.ts:4`: `import type { RegisterResult, DeleteResult } from './types.js';`).
- Error wrapping is consistent with the rest of the file (template-literal form matches `run()` at `runner.ts:130`).
- `fs.existsSync(entry.file)` precedes `fs.unlinkSync(entry.file)`, so the missing-file case returns the right `io` stage rather than throwing (`runner.ts:97-100`).
- `this.registry.delete(name)` runs BEFORE any fs operation (`runner.ts:91` before `runner.ts:97`), so a crash in fs cannot leave a dangling registry entry.
- The `file missing` test explicitly asserts `runner.get('phantom')` is `undefined` after the io error (`register-delete.test.ts:135`) — confirms the registry-cleanup ordering.
- The phantom test directly exercises the io stage by manually registering a user entry with a non-existent path (`register-delete.test.ts:127-131`).

## Issues: 0
## Verdict: APPROVED
