# Task 5 Brief — User macro loading at boot + resolveUserDir

**Source plan:** `D:\Yautja\docs\superpowers\plans\2026-07-13-yautja-macros.md`
**Repo:** `D:\Yautja` (baseline before this task: `1a86467`)
**Predecessor:** Task 4 (`loadBuiltins`) — committed and reviewed clean.

## Scene-setting

Task 5 extends `loader.ts` with `loadUserMacros` (boot scan of user directory) and `resolveUserDir` (Windows-safe path resolution). Mirrors the `SiteMemory` pattern at `src/memory/site-memory.ts:11`.

User dir path: `path.join(process.env.APPDATA || process.env.HOME || '/tmp', '.yautja-macros')`. Test override: `process.env.YAUTJA_USER_DIR`.

## Files

- Modify: `D:\Yautja\src\macros\loader.ts` (append `resolveUserDir` + `loadUserMacros`)
- Modify: `D:\Yautja\tests\macros\loader.test.ts` (append new describe block)
- Create: none

## Implementation contract

### `src/macros/loader.ts` — append to existing file

```typescript
export function resolveUserDir(): string {
  if (process.env.YAUTJA_USER_DIR) return process.env.YAUTJA_USER_DIR;
  return path.join(process.env.APPDATA || process.env.HOME || '/tmp', '.yautja-macros');
}

export async function loadUserMacros(runner: MacroRunner): Promise<LoadResult> {
  const dir = resolveUserDir();
  const result: LoadResult = { loaded: [], skipped: [] };

  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    process.stderr.write(`[Yautja] cannot create user macro dir ${dir}: ${err}\n`);
    return result;
  }

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.startsWith('.'));
  } catch {
    return result;
  }

  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const def = await importMacro(full, true);
      if (!isValidMacro(def)) {
        process.stderr.write(`[Yautja] user macro ${f}: invalid shape\n`);
        result.skipped.push(f);
        continue;
      }
      runner.register(def, 'user', full);
      result.loaded.push(def.name);
    } catch (err) {
      process.stderr.write(`[Yautja] user macro ${f}: ${err instanceof Error ? err.message : String(err)}\n`);
      result.skipped.push(f);
    }
  }
  return result;
}
```

### `tests/macros/loader.test.ts` — append this describe block at the end

```typescript
describe('loadUserMacros', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yautja-user-'));
    process.env.YAUTJA_USER_DIR = dir;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.YAUTJA_USER_DIR;
  });

  it('loads .js file with cache-busting query param', async () => {
    fs.writeFileSync(path.join(dir, 'scrape.js'), `
      export default { name: 'scrape', description: 'scrapes', async run() { return 'data'; } };
    `);
    const runner = new MacroRunner(mockCtx as any);
    const result = await loadUserMacros(runner);
    expect(result.loaded).toEqual(['scrape']);
    expect(runner.get('scrape')?.source).toBe('user');
    expect(runner.get('scrape')?.file).toBe(path.join(dir, 'scrape.js'));
  });

  it('skips hidden files (starting with .)', async () => {
    fs.writeFileSync(path.join(dir, '.hidden.js'), `export default {};`);
    const runner = new MacroRunner(mockCtx as any);
    const result = await loadUserMacros(runner);
    expect(result.loaded).toEqual([]);
  });

  it('creates user dir if missing, loads nothing', async () => {
    process.env.YAUTJA_USER_DIR = path.join(dir, 'newdir');
    const runner = new MacroRunner(mockCtx as any);
    const result = await loadUserMacros(runner);
    expect(result.loaded).toEqual([]);
    expect(fs.existsSync(process.env.YAUTJA_USER_DIR!)).toBe(true);
  });

  it('skips malformed file, records in skipped', async () => {
    fs.writeFileSync(path.join(dir, 'bad.js'), `throw new Error('syntax');`);
    const runner = new MacroRunner(mockCtx as any);
    const result = await loadUserMacros(runner);
    expect(result.skipped).toEqual(['bad.js']);
  });
});
```

## Steps

### Step 1: Append the new tests first (TDD)

Use **Edit** to append the `describe('loadUserMacros', ...)` block at the end of `tests/macros/loader.test.ts`.

### Step 2: Run tests to verify new ones fail, existing still pass

Run: `cd D:\Yautja && npx vitest run tests/macros/loader.test.ts`

Expected: 4 existing pass, 4 new FAIL with `loadUserMacros is not a function`.

### Step 3: Append the implementation

Use **Edit** to append `resolveUserDir` and `loadUserMacros` to the end of `src/macros/loader.ts` (after the existing `loadBuiltins`).

### Step 4: Run tests to verify all pass

Run: `cd D:\Yautja && npx vitest run tests/macros/loader.test.ts`

Expected: 8 tests pass.

### Step 5: Type-check

Run: `cd D:\Yautja && npx tsc --noEmit`

Expected: 0 errors.

### Step 6: Do NOT commit

## Report Contract

Write to `D:\Yautja\.superpowers\sdd\task-5-report.md`:

```
# Task 5 Report

## Status: <DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED>

## Test output
[vitest output]

## Compile
[tsc output]

## Files modified
- src/macros/loader.ts (appended)
- tests/macros/loader.test.ts (appended)

## Concerns
[none | details]
```

Reply:
```
STATUS: <...>
TESTS: 8/8 pass
COMPILE: 0 errors
FILES: src/macros/loader.ts (appended), tests/macros/loader.test.ts (appended)
CONCERNS: <none | details>
```

## Constraints reminder

- TDD: append tests first
- Use **Edit** to extend existing files
- `resolveUserDir` mirrors `SiteMemory` pattern (process.env.APPDATA || HOME || /tmp)
- `loadUserMacros` uses cache-busting import (`?v=mtimeMs`) for hot-reload safety
- User files are registered with `runner.register(def, 'user', full)` — full path is the third arg
- DO NOT modify `loadBuiltins` or any existing code

## Model

`minimax-coding-plan/MiniMax-M3` (project default)