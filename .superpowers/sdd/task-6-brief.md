# Task 6 Brief — registerUserMacro: write file, import, validate shape

**Source plan:** `D:\Yautja\docs\superpowers\plans\2026-07-13-yautja-macros.md`
**Repo:** `D:\Yautja` (baseline before this task: `b0134b4`)
**Predecessors:** Tasks 1-5 — committed and reviewed clean.

## Scene-setting

Task 6 adds the `registerUserMacro` method to `MacroRunner`. This is the hot path: the LLM agent calls `macro_register` MCP tool which delegates to this method. It must:
1. Validate the macro name against `MACRO_NAME_PATTERN`
2. Check for existing user macros (refuse unless `overwrite=true`)
3. Write the source atomically (write to `.tmp`, rename)
4. Dynamic-import the file with cache-busting (`?v=Date.now()`)
5. Validate the imported module's `default` export shape
6. Verify `def.name === name` (filename matches in-source name)
7. Register in the runner and return success

Task 7 adds `deleteUserMacro`. Task 8 wires everything into Helmet.

## Files

- Modify: `D:\Yautja\src\macros\runner.ts` (extend imports + add method)
- Create: `D:\Yautja\tests\macros\register-delete.test.ts`
- Modify: none

## Interfaces (consumed from Tasks 1-5)

Existing imports in `runner.ts`: `HelmetLike, MacroDef, MacroRegistryEntry, MacroSource, MacroSummary, ArgsSchema, MacroContext, RunResult, DEFAULT_MACRO_TIMEOUT_MS`.

**New imports needed:**
- `RegisterResult` from `./types.js`
- `MACRO_NAME_PATTERN` from `./types.js`
- `resolveUserDir` from `./loader.js`
- `fs`, `path`, `pathToFileURL` from node built-ins

## Implementation contract

### Changes to `src/macros/runner.ts`

Add at top (new imports):
```typescript
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import type { RegisterResult } from './types.js';
import { MACRO_NAME_PATTERN } from './types.js';
import { resolveUserDir } from './loader.js';
```

Add this method to the `MacroRunner` class body:

```typescript
async registerUserMacro(name: string, source: string, overwrite = false): Promise<RegisterResult> {
  if (!MACRO_NAME_PATTERN.test(name)) {
    return { success: false, error: `name must match ${MACRO_NAME_PATTERN.source}`, stage: 'validation' };
  }
  const dir = resolveUserDir();
  const file = path.join(dir, `${name}.js`);

  const existing = this.registry.get(name);
  if (existing && !overwrite) {
    return { success: false, error: `macro ${name} already exists (use overwrite: true)`, stage: 'persistence' };
  }

  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { success: false, error: `cannot create dir ${dir}: ${err}`, stage: 'persistence' };
  }

  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, source, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    return { success: false, error: `write failed: ${err}`, stage: 'persistence' };
  }

  let def: MacroDef;
  try {
    const url = pathToFileURL(file).href + `?v=${Date.now()}`;
    const mod = await import(url);
    def = mod.default;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), stage: 'import' };
  }

  if (!def
    || typeof def.name !== 'string'
    || typeof def.description !== 'string'
    || typeof def.run !== 'function') {
    return { success: false, error: 'macro must export default with name, description, run', stage: 'shape' };
  }

  if (def.name !== name) {
    return { success: false, error: `macro name '${def.name}' does not match filename '${name}'`, stage: 'shape' };
  }

  this.register(def, 'user', file);
  return { success: true, name, source: 'user', file };
}
```

### Create `tests/macros/register-delete.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MacroRunner } from '../../src/macros/runner.js';
import type { MacroContext } from '../../src/macros/types.js';

const mockCtx: MacroContext = {
  openTab: vi.fn(async () => '{}'), switchTab: vi.fn(async () => '{}'),
  closeTab: vi.fn(async () => '{}'), reattach: vi.fn(async () => '{}'),
  observe: vi.fn(async () => '{}'), inspect: vi.fn(async () => '{}'),
  diff: vi.fn(async () => '{}'), act: vi.fn(async () => '{}'),
  findElement: vi.fn(async () => '{}'), findClick: vi.fn(async () => '{}'),
  findType: vi.fn(async () => '{}'), smartType: vi.fn(async () => '{}'),
  techScan: vi.fn(async () => '{}'), stealthCheck: vi.fn(async () => '{}'),
  stealthEnable: vi.fn(async () => '{}'), stealthDisable: vi.fn(async () => '{}'),
  interceptEnable: vi.fn(async () => '{}'), interceptAddRule: vi.fn(async () => '{}'),
  interceptDisable: vi.fn(async () => '{}'), interceptLog: vi.fn(async () => '{}'),
  captureList: vi.fn(async () => '{}'), captureRequest: vi.fn(async () => '{}'),
  captureResponse: vi.fn(async () => '{}'), osintHarvest: vi.fn(async () => '{}'),
  netIntel: vi.fn(async () => '{}'), gqlQuery: vi.fn(async () => '{}'),
  siteMemory: vi.fn(async () => '{}'), siteMemoryClear: vi.fn(async () => '{}'),
  wsWatch: vi.fn(async () => '{}'), wsFrames: vi.fn(async () => '{}'),
  sleep: vi.fn(async () => {}), log: vi.fn(),
};

describe('MacroRunner.registerUserMacro', () => {
  let dir: string;
  let runner: MacroRunner;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yautja-reg-'));
    process.env.YAUTJA_USER_DIR = dir;
    runner = new MacroRunner(mockCtx as any);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.YAUTJA_USER_DIR;
  });

  const validSource = `export default { name: 'demo', description: 'demo', async run() { return 1; } };`;

  it('writes file, imports, registers with source=user', async () => {
    const r = await runner.registerUserMacro('demo', validSource);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.source).toBe('user');
      expect(fs.existsSync(r.file)).toBe(true);
    }
    expect(runner.get('demo')?.source).toBe('user');
  });

  it('rejects invalid name', async () => {
    const r = await runner.registerUserMacro('Bad Name!', validSource);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.stage).toBe('validation');
  });

  it('refuses existing macro without overwrite=true', async () => {
    await runner.registerUserMacro('demo', validSource);
    const r = await runner.registerUserMacro('demo', validSource);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.stage).toBe('persistence');
  });

  it('overwrites with overwrite=true', async () => {
    await runner.registerUserMacro('demo', validSource);
    const r = await runner.registerUserMacro('demo', validSource, true);
    expect(r.success).toBe(true);
  });

  it('rejects source with no default export (shape)', async () => {
    const r = await runner.registerUserMacro('badshape', `export const x = 1;`);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.stage).toBe('shape');
    expect(runner.get('badshape')).toBeUndefined();
  });

  it('rejects source that throws on import', async () => {
    const r = await runner.registerUserMacro('badsrc', `throw new Error('boom');`);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.stage).toBe('import');
  });
});
```

## Steps

### Step 1: Create the test file first (TDD)

Create `D:\Yautja\tests\macros\register-delete.test.ts` with the test content above using **Write**.

### Step 2: Run tests to verify they fail

Run: `cd D:\Yautja && npx vitest run tests/macros/register-delete.test.ts`

Expected: FAIL with `registerUserMacro is not a function` (or "cannot find module").

### Step 3: Modify `src/macros/runner.ts`

Use **Edit** to:
- Add the 5 new imports at the top
- Add the `registerUserMacro` method to the class body

### Step 4: Run tests to verify pass

Run: `cd D:\Yautja && npx vitest run tests/macros/register-delete.test.ts`

Expected: 6 tests pass.

### Step 5: Type-check

Run: `cd D:\Yautja && npx tsc --noEmit`

Expected: 0 errors.

### Step 6: Do NOT commit

## Report Contract

Write to `D:\Yautja\.superpowers\sdd\task-6-report.md`:

```
# Task 6 Report

## Status: <...>

## Test output
[vitest output]

## Compile
[tsc output]

## Files modified
- src/macros/runner.ts (added imports + method)
- tests/macros/register-delete.test.ts (created)

## Concerns
[none | details]
```

Reply:
```
STATUS: <...>
TESTS: 6/6 pass
COMPILE: 0 errors
FILES: src/macros/runner.ts (modified), tests/macros/register-delete.test.ts (created)
CONCERNS: <none | details>
```

## Constraints reminder

- TDD: test file first.
- Use **Write** to create new test file; **Edit** to modify runner.ts.
- Strict TS: no unused imports/params.
- Stage strings exactly: `'validation' | 'persistence' | 'import' | 'shape'`.
- Atomic write: write to `.tmp`, then `renameSync` to final.
- Cache-bust: `?v=${Date.now()}` (per-call, not mtimeMs — registration is a hot operation).
- DO NOT implement `deleteUserMacro` — Task 7.
- Do not commit.

## Model

`minimax-coding-plan/MiniMax-M3` (project default)