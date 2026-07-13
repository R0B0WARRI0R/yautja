# Task 7 Brief — deleteUserMacro: remove file + unregister

**Source plan:** `D:\Yautja\docs\superpowers\plans\2026-07-13-yautja-macros.md`
**Repo:** `D:\Yautja` (baseline before this task: `6b3a4b6`)
**Predecessors:** Tasks 1-6 — committed and reviewed clean.

## Scene-setting

Task 7 adds `deleteUserMacro` to `MacroRunner`. Mirrors `registerUserMacro`'s structure:
1. Lookup in registry
2. Refuse built-in (permission error)
3. Remove from registry first (so a crash in fs doesn't leave dangling entry)
4. Check file exists
5. Unlink file

The same `tests/macros/register-delete.test.ts` file gets 4 new tests appended.

## Files

- Modify: `D:\Yautja\src\macros\runner.ts` (add method)
- Modify: `D:\Yautja\tests\macros\register-delete.test.ts` (append 4 tests)
- Create: none

## Implementation contract

### `src/macros/runner.ts` — add this method to class

```typescript
async deleteUserMacro(name: string): Promise<DeleteResult> {
  const entry = this.registry.get(name);
  if (!entry) {
    return { success: false, error: `unknown macro: ${name}`, stage: 'lookup' };
  }
  if (entry.source === 'builtin') {
    return { success: false, error: `cannot delete built-in macro: ${name}`, stage: 'permission' };
  }
  this.registry.delete(name);

  if (!entry.file) {
    return { success: false, error: `macro ${name} has no source file`, stage: 'io' };
  }
  try {
    if (!fs.existsSync(entry.file)) {
      return { success: false, error: `file not found: ${entry.file}`, stage: 'io' };
    }
    fs.unlinkSync(entry.file);
  } catch (err) {
    return { success: false, error: `delete failed: ${err}`, stage: 'io' };
  }
  return { success: true, name, removedFile: entry.file };
}
```

Add `DeleteResult` to imports at top:
```typescript
import type { DeleteResult } from './types.js';
```

### Append to `tests/macros/register-delete.test.ts`

```typescript
describe('MacroRunner.deleteUserMacro', () => {
  let dir: string;
  let runner: MacroRunner;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yautja-del-'));
    process.env.YAUTJA_USER_DIR = dir;
    runner = new MacroRunner(mockCtx as any);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.YAUTJA_USER_DIR;
  });

  it('deletes existing user macro and removes file', async () => {
    await runner.registerUserMacro('demo', `export default { name: 'demo', description: 'd', async run() { return 1; } };`);
    expect(fs.existsSync(path.join(dir, 'demo.js'))).toBe(true);

    const r = await runner.deleteUserMacro('demo');
    expect(r.success).toBe(true);
    if (r.success) expect(fs.existsSync(r.removedFile)).toBe(false);
    expect(runner.get('demo')).toBeUndefined();
  });

  it('refuses to delete built-in macro', async () => {
    runner.register({ name: 'builtin1', description: 'b', async run() { return 0; } }, 'builtin');
    const r = await runner.deleteUserMacro('builtin1');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.stage).toBe('permission');
    expect(runner.get('builtin1')).toBeDefined();
  });

  it('returns lookup error for unknown macro', async () => {
    const r = await runner.deleteUserMacro('ghost');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.stage).toBe('lookup');
  });

  it('returns io error if file missing but registry has it', async () => {
    runner.register(
      { name: 'phantom', description: 'p', async run() { return 0; } },
      'user',
      path.join(dir, 'phantom.js'),
    );
    const r = await runner.deleteUserMacro('phantom');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.stage).toBe('io');
    expect(runner.get('phantom')).toBeUndefined();
  });
});
```

## Steps

### Step 1: Append the new tests first (TDD)

Use **Edit** to append the `describe('MacroRunner.deleteUserMacro', ...)` block at the end of `tests/macros/register-delete.test.ts`.

### Step 2: Run tests to verify new ones fail, old ones still pass

Run: `cd D:\Yautja && npx vitest run tests/macros/register-delete.test.ts`

Expected: 6 existing pass, 4 new FAIL with "deleteUserMacro is not a function".

### Step 3: Modify `src/macros/runner.ts`

Use **Edit** to:
- Add `DeleteResult` to the existing import line from `./types.js`
- Add the `deleteUserMacro` method to the class body

### Step 4: Run tests to verify all pass

Run: `cd D:\Yautja && npx vitest run tests/macros/register-delete.test.ts`

Expected: 10 tests pass (6 register + 4 delete).

### Step 5: Type-check

Run: `cd D:\Yautja && npx tsc --noEmit`

Expected: 0 errors.

### Step 6: Do NOT commit

## Report Contract

Write to `D:\Yautja\.superpowers\sdd\task-7-report.md`:

```
# Task 7 Report

## Status: <...>

## Test output
[vitest output]

## Compile
[tsc output]

## Files modified
- src/macros/runner.ts (added imports + method)
- tests/macros/register-delete.test.ts (appended)

## Concerns
[none | details]
```

Reply:
```
STATUS: <...>
TESTS: 10/10 pass
COMPILE: 0 errors
FILES: src/macros/runner.ts (modified), tests/macros/register-delete.test.ts (appended)
CONCERNS: <none | details>
```

## Constraints reminder

- TDD: tests first.
- Use **Edit** for both files.
- Stages: `'lookup' | 'permission' | 'io'`.
- Registry removal BEFORE file operations (so a crash doesn't leave dangling entry).
- Do not commit.

## Model

`minimax-coding-plan/MiniMax-M3` (project default)