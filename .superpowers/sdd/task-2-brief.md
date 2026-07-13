# Task 2 Brief — MacroRunner registry (register/unregister/list/get)

**Source plan:** `D:\Yautja\docs\superpowers\plans\2026-07-13-yautja-macros.md`
**Repo:** `D:\Yautja` (baseline before this task: `20c60fb`)
**Predecessor:** Task 1 (`src/macros/types.ts`) — committed and reviewed clean.

## Scene-setting

Task 2 creates the `MacroRunner` class skeleton with the in-memory registry and the four basic operations: `register`, `unregister`, `get`, `list`. Task 3 will add `run` with validation/timeout/log. Tasks 4-7 add loaders and filesystem operations. Task 8 wires it into Helmet.

This task does NOT include `run`, `registerUserMacro`, or `deleteUserMacro` — those are separate tasks with their own tests.

## Files

- Create: `D:\Yautja\src\macros\runner.ts`
- Create: `D:\Yautja\tests\macros\runner.test.ts`
- Modify: none

## Interfaces (consumed from Task 1)

```typescript
import type { HelmetLike, MacroDef, MacroRegistryEntry, MacroSource, MacroSummary } from './types.js';
```

## Implementation contract

### `src/macros/runner.ts` — minimal skeleton

```typescript
import type { HelmetLike, MacroDef, MacroRegistryEntry, MacroSource, MacroSummary } from './types.js';

export class MacroRunner {
  private registry = new Map<string, MacroRegistryEntry>();

  constructor(private readonly host: HelmetLike) {}

  register(def: MacroDef, source: MacroSource, file?: string): void {
    this.registry.set(def.name, { def, source, file, loadedAt: Date.now() });
  }

  unregister(name: string): boolean {
    return this.registry.delete(name);
  }

  get(name: string): MacroRegistryEntry | undefined {
    return this.registry.get(name);
  }

  list(): MacroSummary[] {
    return [...this.registry.values()].map((e) => this.toSummary(e));
  }

  private toSummary(entry: MacroRegistryEntry): MacroSummary {
    const { def, source } = entry;
    const summary: MacroSummary = {
      name: def.name,
      description: def.description,
      source,
      hasArgs: def.argsSchema !== undefined,
    };
    if (def.timeoutMs !== undefined) summary.timeoutMs = def.timeoutMs;
    return summary;
  }
}
```

### `tests/macros/runner.test.ts` — exact content

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MacroRunner } from '../../src/macros/runner.js';
import type { MacroContext, MacroDef } from '../../src/macros/types.js';

function makeMockCtx(): MacroContext {
  return {
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
}

const sampleDef: MacroDef = { name: 'sample', description: 'A sample macro', async run() { return 'done'; } };

describe('MacroRunner registry', () => {
  let runner: MacroRunner;
  beforeEach(() => {
    runner = new MacroRunner({} as any); // host unused in Task 2
  });

  it('registers a macro and lists it as builtin by default', () => {
    runner.register(sampleDef, 'builtin');
    const list = runner.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'sample', source: 'builtin', hasArgs: false });
  });

  it('registers with argsSchema and reports hasArgs=true', () => {
    runner.register({
      name: 'login',
      description: 'login flow',
      argsSchema: { type: 'object', properties: { user: { type: 'string' } }, required: ['user'] },
      async run() { return 'ok'; },
    }, 'builtin');
    expect(runner.list()[0].hasArgs).toBe(true);
  });

  it('get returns the entry; unknown returns undefined', () => {
    runner.register(sampleDef, 'builtin');
    expect(runner.get('sample')?.def.name).toBe('sample');
    expect(runner.get('nope')).toBeUndefined();
  });

  it('unregister removes and returns true; false if absent', () => {
    runner.register(sampleDef, 'builtin');
    expect(runner.unregister('sample')).toBe(true);
    expect(runner.list()).toHaveLength(0);
    expect(runner.unregister('sample')).toBe(false);
  });

  it('re-registering same name overwrites', () => {
    runner.register(sampleDef, 'builtin');
    runner.register({ ...sampleDef, description: 'updated' }, 'user');
    expect(runner.list()).toHaveLength(1);
    expect(runner.list()[0].description).toBe('updated');
    expect(runner.list()[0].source).toBe('user');
  });
});
```

## Steps

### Step 1: Write the test file first (TDD)

Create `D:\Yautja\tests\macros\runner.test.ts` with the test content above.

### Step 2: Run the test to verify it fails

Run: `cd D:\Yautja && npx vitest run tests/macros/runner.test.ts`

Expected: FAIL with `Cannot find module '../../src/macros/runner.js'`.

### Step 3: Write the implementation

Create `D:\Yautja\src\macros\runner.ts` with the implementation content above.

### Step 4: Run the test to verify it passes

Run: `cd D:\Yautja && npx vitest run tests/macros/runner.test.ts`

Expected: PASS, 5 tests.

### Step 5: Full type-check

Run: `cd D:\Yautja && npx tsc --noEmit`

Expected: 0 errors.

### Step 6: Do NOT commit

The controller handles git after review passes.

## Report Contract

Write report to `D:\Yautja\.superpowers\sdd\task-2-report.md` containing:
- Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
- Test output: `npx vitest run tests/macros/runner.test.ts` (number of tests, pass/fail)
- Compile output: `tsc --noEmit` (0 errors expected)
- Files created (list)
- Any concerns

Reply in this shape:
```
STATUS: <...>
TESTS: <X/X pass>
COMPILE: <output>
FILES: src/macros/runner.ts, tests/macros/runner.test.ts
CONCERNS: <none | details>
```

## Constraints reminder

- TDD: test first, watch it fail, implement, watch it pass
- vitest with `describe/it/expect/beforeEach/vi`
- TypeScript strict — every variable used
- Naming: `MacroRunner` PascalCase, `runner.ts` kebab-case
- Do not modify Task 1's `types.ts`
- Do not implement `run` / `registerUserMacro` / `deleteUserMacro` — those are separate tasks

## Model

`minimax-coding-plan/MiniMax-M3` (project default)