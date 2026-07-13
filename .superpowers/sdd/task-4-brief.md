# Task 4 Brief — Built-in macro auto-discovery

**Source plan:** `D:\Yautja\docs\superpowers\plans\2026-07-13-yautja-macros.md`
**Repo:** `D:\Yautja` (baseline before this task: `1277e8c`)
**Predecessors:** Tasks 1-3 (types, registry, run) — committed and reviewed clean.

## Scene-setting

Task 4 creates the loader that scans a directory at boot and registers any valid built-in macro files it finds. Resolves the directory via `process.env.YAUTJA_BUILTIN_DIR` (test override) or `dist/macros/` (default, resolved from `import.meta.url`). Excludes the framework files (`runner.js`, `types.js`, `index.js`, `loader.js`). Fail-soft: bad files log a warning and continue.

Task 5 will add `loadUserMacros` + `resolveUserDir`. Task 8 will wire both into Helmet's `start()`.

## Files

- Create: `D:\Yautja\src\macros\loader.ts`
- Create: `D:\Yautja\tests\macros\loader.test.ts`
- Modify: none

## Interfaces (consumed from Tasks 1-3)

```typescript
import type { MacroRunner } from './runner.js';
import type { MacroDef } from './types.js';
```

## Implementation contract

### `src/macros/loader.ts` — Task 4 portion only

Task 4 implements **only** `loadBuiltins`. Task 5 will append `loadUserMacros` and `resolveUserDir`.

```typescript
import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import type { MacroRunner } from './runner.js';
import type { MacroDef } from './types.js';

const BUILTIN_EXCLUDES = new Set(['runner.js', 'types.js', 'index.js', 'loader.js']);

export interface LoadResult {
  loaded: string[];
  skipped: string[];
}

function resolveBuiltinDir(): string {
  if (process.env.YAUTJA_BUILTIN_DIR) return process.env.YAUTJA_BUILTIN_DIR;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'macros');
}

async function importMacro(file: string, cacheBust = false): Promise<MacroDef> {
  let url = pathToFileURL(file).href;
  if (cacheBust) {
    const stat = fs.statSync(file);
    url += `?v=${stat.mtimeMs}`;
  }
  const mod = await import(url);
  return mod.default as MacroDef;
}

function isValidMacro(def: unknown): def is MacroDef {
  return !!def
    && typeof def === 'object'
    && typeof (def as any).name === 'string'
    && typeof (def as any).description === 'string'
    && typeof (def as any).run === 'function';
}

export async function loadBuiltins(runner: MacroRunner): Promise<LoadResult> {
  const dir = resolveBuiltinDir();
  const result: LoadResult = { loaded: [], skipped: [] };
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !BUILTIN_EXCLUDES.has(f));
  } catch {
    return result;
  }
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const def = await importMacro(full, false);
      if (!isValidMacro(def)) {
        process.stderr.write(`[Yautja] builtin macro ${f}: invalid shape\n`);
        result.skipped.push(f);
        continue;
      }
      runner.register(def, 'builtin');
      result.loaded.push(def.name);
    } catch (err) {
      process.stderr.write(`[Yautja] builtin macro ${f}: ${err instanceof Error ? err.message : String(err)}\n`);
      result.skipped.push(f);
    }
  }
  return result;
}
```

### `tests/macros/loader.test.ts` — Task 4 portion only

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MacroRunner } from '../../src/macros/runner.js';
import { loadBuiltins } from '../../src/macros/loader.js';
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

describe('loadBuiltins', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yautja-builtin-'));
    process.env.YAUTJA_BUILTIN_DIR = dir;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.YAUTJA_BUILTIN_DIR;
  });

  it('loads a valid macro .js file', async () => {
    const file = path.join(dir, 'greet.js');
    fs.writeFileSync(file, `
      export default {
        name: 'greet',
        description: 'says hi',
        async run() { return 'hi'; },
      };
    `);
    const runner = new MacroRunner(mockCtx as any);
    const result = await loadBuiltins(runner);
    expect(result.loaded).toEqual(['greet']);
    expect(result.skipped).toEqual([]);
    expect(runner.list().map(m => m.name)).toContain('greet');
  });

  it('skips runner.js, types.js, index.js, loader.js', async () => {
    for (const n of ['runner', 'types', 'index', 'loader']) {
      fs.writeFileSync(path.join(dir, n + '.js'), `export default {};`);
    }
    const runner = new MacroRunner(mockCtx as any);
    const result = await loadBuiltins(runner);
    expect(result.loaded).toEqual([]);
    expect(result.skipped.length).toBe(0);
  });

  it('records malformed file in skipped, continues loading others', async () => {
    fs.writeFileSync(path.join(dir, 'broken.js'), `export default {};`);
    fs.writeFileSync(path.join(dir, 'good.js'), `
      export default { name: 'good', description: 'ok', async run() { return 1; } };
    `);
    const runner = new MacroRunner(mockCtx as any);
    const result = await loadBuiltins(runner);
    expect(result.loaded).toEqual(['good']);
    expect(result.skipped).toEqual(['broken.js']);
  });

  it('skips directory that does not exist silently', async () => {
    process.env.YAUTJA_BUILTIN_DIR = path.join(dir, 'nonexistent');
    const runner = new MacroRunner(mockCtx as any);
    const result = await loadBuiltins(runner);
    expect(result.loaded).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});
```

## Steps

### Step 1: Write the test file first (TDD)

Create `D:\Yautja\tests\macros\loader.test.ts` with the test content above.

### Step 2: Run test to verify it fails

Run: `cd D:\Yautja && npx vitest run tests/macros/loader.test.ts`

Expected: FAIL with `Cannot find module '../../src/macros/loader.js'`.

### Step 3: Write the implementation

Create `D:\Yautja\src\macros\loader.ts` with the implementation content above (Task 4 portion only — NO `resolveUserDir` or `loadUserMacros` yet).

### Step 4: Run tests to verify pass

Run: `cd D:\Yautja && npx vitest run tests/macros/loader.test.ts`

Expected: 4 tests pass.

### Step 5: Type-check

Run: `cd D:\Yautja && npx tsc --noEmit`

Expected: 0 errors.

### Step 6: Do NOT commit

Controller handles git after review.

## Report Contract

Write to `D:\Yautja\.superpowers\sdd\task-4-report.md`:

```
# Task 4 Report

## Status: <DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED>

## Test output
[full vitest output]

## Compile output
[tsc --noEmit result]

## Files created
- src/macros/loader.ts
- tests/macros/loader.test.ts

## Concerns
[none | details]
```

Reply in shape:
```
STATUS: <...>
TESTS: 4/4 pass
COMPILE: 0 errors
FILES: src/macros/loader.ts, tests/macros/loader.test.ts
CONCERNS: <none | details>
```

## Constraints reminder

- TDD: test first, watch fail, implement, watch pass
- vitest, `vi.fn()` for mocks, `os.tmpdir()` for ephemeral dirs
- `process.env.YAUTJA_BUILTIN_DIR` is the test override; default uses `import.meta.url`
- Module-scope functions: `resolveBuiltinDir`, `importMacro`, `isValidMacro`
- Exports: `loadBuiltins`, `LoadResult`
- DO NOT add `resolveUserDir` / `loadUserMacros` — Task 5

## Model

`minimax-coding-plan/MiniMax-M3` (project default)