# Task 8 Brief — Wire MacroRunner into Helmet (integration)

**Source plan:** `D:\Yautja\docs\superpowers\plans\2026-07-13-yautja-macros.md`
**Repo:** `D:\Yautja` (baseline before this task: `fa8539c`)
**Predecessors:** Tasks 1-7 — committed and reviewed clean.

## Scene-setting

Task 8 integrates `MacroRunner` into the running Helmet. Six touch points in `src/helmet.ts`:
1. Add imports for `MacroRunner`, `loadBuiltins`, `loadUserMacros`
2. Declare `private macroRunner: MacroRunner;` field
3. Initialize in constructor: `this.macroRunner = new MacroRunner(this);`
4. In `start()`, call loaders (fail-soft)
5. Add 4 cases in `handleToolCall` switch: `macro_list`, `macro_run`, `macro_register`, `macro_delete`
6. Add 4 entries to `MCP_TOOLS` array

Plus an integration test file. This is the highest-risk task because it modifies a large existing file (`src/helmet.ts`, ~1242 lines).

## Files

- Modify: `D:\Yautja\src\helmet.ts` (6 touch points — exact line ranges in Steps below)
- Create: `D:\Yautja\tests\macros\helmet-integration.test.ts`
- Modify: none other

## Touch points in `src/helmet.ts` — exact context

Before editing, READ the file at the following locations to find exact text:

1. **Imports** — around line 27: the block of `import` lines for arsenal, vision, memory, targeting, intel modules. Add a new line for the macros modules.
2. **Field** — around line 87-88: the `private` declarations for sub-systems (`private learningLoop`, `private networkCapture`, etc). Add `private macroRunner: MacroRunner;`.
3. **Constructor init** — around line 120: the line `this.networkCapture = new NetworkCapture(this.server);`. Add `this.macroRunner = new MacroRunner(this);` after it.
4. **start()** — around line 174: the `for (const domain of ['Network', ...])` block at the end of `start()`. Add macro loading BEFORE this loop (between sensor subscribes and domain enables).
5. **handleToolCall switch** — around line 736: the `default: return 'Unknown tool: ' + name;` case. Insert 4 new cases BEFORE `default:`.
6. **MCP_TOOLS array** — around line 1230: the closing `];` of the const MCP_TOOLS array. Insert 4 entries before it.

## Implementation contract

### Change 1: Imports (around line 27)

Find the block of imports. After the existing last `import type` or `import` line, add:

```typescript
import { MacroRunner } from './macros/runner.js';
import { loadBuiltins, loadUserMacros } from './macros/loader.js';
```

### Change 2: Field declaration (around line 87)

Find:
```typescript
private networkCapture: NetworkCapture;
private attached = false;
```

Add between them:
```typescript
private macroRunner: MacroRunner;
```

### Change 3: Constructor init (around line 120)

Find:
```typescript
    this.networkCapture = new NetworkCapture(this.server);
```

Add immediately after (on its own line):
```typescript
    this.macroRunner = new MacroRunner(this);
```

### Change 4: Load macros in start() (around line 174)

Find the end of `start()` — the `for (const domain of ['Network', ...])` loop. Add this BEFORE the for loop:

```typescript
    // Load macros (fail-soft — boot continues even if loading fails)
    try {
      const builtinsResult = await loadBuiltins(this.macroRunner);
      const userResult = await loadUserMacros(this.macroRunner);
      process.stderr.write(
        `[Yautja] Macros loaded: ${builtinsResult.loaded.length} builtin, ${userResult.loaded.length} user\n`,
      );
    } catch (err) {
      process.stderr.write(`[Yautja] macro loading failed (continuing): ${err}\n`);
    }
```

### Change 5: handleToolCall cases (around line 736)

Find:
```typescript
      default:
        return `Unknown tool: ${name}`;
```

Insert BEFORE it:

```typescript
      case 'macro_list':
        return JSON.stringify({ macros: this.macroRunner.list() });
      case 'macro_run': {
        const result = await this.macroRunner.run(args.name, args.args, args.timeoutMs);
        return JSON.stringify(result);
      }
      case 'macro_register': {
        const result = await this.macroRunner.registerUserMacro(args.name, args.source, args.overwrite === true);
        return JSON.stringify(result);
      }
      case 'macro_delete': {
        const result = await this.macroRunner.deleteUserMacro(args.name);
        return JSON.stringify(result);
      }
```

### Change 6: MCP_TOOLS entries (around line 1230)

Find:
```typescript
  {
    name: 'captureClear',
    description: 'Clear all captured requests from memory (does not delete files).',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];
```

Insert BEFORE the closing `];`:

```typescript
  {
    name: 'macro_list',
    description: 'List all registered macros (built-in and user-defined). Use this first to discover available macros before calling macro_run.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'macro_run',
    description: 'Invoke a macro by name. Use macro_list first to see names and whether they take args.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Macro name (from macro_list)' },
        args: { type: 'object', description: "Macro arguments (validated against the macro's argsSchema if present)" },
        timeoutMs: { type: 'number', description: 'Override the macro default timeout (ms)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'macro_register',
    description: "Register a new user macro by writing its source to %APPDATA%\\.yautja-macros\\<name>.js and importing it. Source must export default a MacroDef object with { name, description, run }.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Macro name, filename-safe [a-z0-9_-]+' },
        source: { type: 'string', description: 'Full JavaScript source of the macro module' },
        overwrite: { type: 'boolean', description: 'Overwrite existing macro with same name (default false)' },
      },
      required: ['name', 'source'],
    },
  },
  {
    name: 'macro_delete',
    description: 'Delete a user-defined macro. Cannot delete built-in macros.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Macro name to delete' },
      },
      required: ['name'],
    },
  },
```

### Create `tests/macros/helmet-integration.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';

vi.mock('../../src/connection/extension-server.js', () => {
  class MES {
    isExtensionConnected = vi.fn(() => true);
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
    listTabs = vi.fn(async () => [{ tabId: 1, url: 'https://example.com', title: 'Example', active: true, index: 0, windowId: 1 }]);
    attachTab = vi.fn(async () => {});
    detachAll = vi.fn(async () => {});
    detachTab = vi.fn(async () => {});
    switchToTab = vi.fn(async () => {});
    enableDomains = vi.fn(async () => {});
    disableDomains = vi.fn(async () => {});
    onStatusChange = vi.fn(() => () => {});
    getCurrentTabId = vi.fn(() => 1);
    setNetworkCaptureCallback = vi.fn();
    on = vi.fn(() => () => {});
    send = vi.fn(async () => ({}));
  }
  return { ExtensionServer: MES };
});

import { Helmet } from '../../src/helmet.js';

function spawn() {
  const stdin = new Readable({ read() {} });
  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: any) => { out.push(c.toString()); return true; }) as any;
  const h = new Helmet({ port: 9999 });
  h.serveMCP();
  process.stdout.write = orig;
  return { h, stdin, out };
}

function send(stdin: Readable, o: unknown): void {
  stdin.emit('data', JSON.stringify(o) + '\n');
}

function last(out: string[]): any {
  return JSON.parse(out[out.length - 1].trim());
}

describe('Helmet macro tools (tools/list + tool routing)', () => {
  let h: Helmet;
  let stdin: Readable;
  let out: string[];

  beforeEach(() => {
    ({ h, stdin, out } = spawn());
  });

  it('tools/list includes macro_list, macro_run, macro_register, macro_delete', () => {
    send(stdin, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = last(out).result.tools.map((t: any) => t.name);
    expect(names).toContain('macro_list');
    expect(names).toContain('macro_run');
    expect(names).toContain('macro_register');
    expect(names).toContain('macro_delete');
  });

  it('macro_list returns array (possibly empty since start() not called)', () => {
    send(stdin, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'macro_list', arguments: {} } });
    const r = JSON.parse(last(out).result.content[0].text);
    expect(Array.isArray(r.macros)).toBe(true);
  });

  it('macro_run on unknown returns lookup error', () => {
    send(stdin, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'macro_run', arguments: { name: 'ghost' } } });
    const r = JSON.parse(last(out).result.content[0].text);
    expect(r.success).toBe(false);
    expect(r.stage).toBe('lookup');
  });

  it('macro_register with invalid name returns validation error', () => {
    send(stdin, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'macro_register', arguments: { name: 'Bad!', source: 'x' } } });
    const r = JSON.parse(last(out).result.content[0].text);
    expect(r.success).toBe(false);
    expect(r.stage).toBe('validation');
  });
});
```

## Steps

### Step 1: Read `src/helmet.ts` to find exact context

Use **read** tool to find the exact line numbers for each of the 6 touch points. Adjust the brief's "around line X" hints as needed.

### Step 2: Create the integration test first

Create `D:\Yautja\tests\macros\helmet-integration.test.ts` with the content above using **Write**.

### Step 3: Run test to verify it fails

Run: `cd D:\Yautja && npx vitest run tests/macros/helmet-integration.test.ts`

Expected: FAIL with `tools/list does not include macro_list` (or similar).

### Step 4: Apply 6 edits to `src/helmet.ts`

Use **Edit** 6 times (one per touch point). Make each edit minimal and precise — don't accidentally rewrite other parts of the file.

Order matters — apply edits in this order to avoid line-number drift:
1. Imports (top of file)
2. Field declaration
3. Constructor init
4. start() loader call
5. handleToolCall switch cases
6. MCP_TOOLS entries

### Step 5: Run integration test to verify pass

Run: `cd D:\Yautja && npx vitest run tests/macros/helmet-integration.test.ts`

Expected: 4 tests pass.

### Step 6: Run full test suite (regression check)

Run: `cd D:\Yautja && npx vitest run`

Expected: ALL pre-existing tests still pass (helmet.test.ts, translator.test.ts, etc.) plus the 22 macro tests (5+8+4+6+4+4).

### Step 7: Type-check

Run: `cd D:\Yautja && npx tsc --noEmit`

Expected: 0 errors.

### Step 8: Do NOT commit

## Report Contract

Write to `D:\Yautja\.superpowers\sdd\task-8-report.md`:

```
# Task 8 Report

## Status: <...>

## Test output
[full vitest output]

## Compile
[tsc output]

## Files modified
- src/helmet.ts (6 touch points)
- tests/macros/helmet-integration.test.ts (new)

## Concerns
[none | details — especially any deviations from exact line numbers in brief]
```

Reply:
```
STATUS: <...>
TESTS: <X/X pass for integration + X/X pass for full suite>
COMPILE: 0 errors
FILES: src/helmet.ts (6 edits), tests/macros/helmet-integration.test.ts (new)
CONCERNS: <none | details>
```

## Constraints reminder

- **HIGH RISK**: this modifies the largest file in the project. Be surgical.
- Use **Edit** 6 times, NOT Write — do not rewrite helmet.ts.
- Read the file first to find exact context for each touch point.
- The `vi.mock` pattern in the test mirrors `tests/helmet.test.ts`.
- Do not modify other parts of helmet.ts — only the 6 touch points.
- Do not commit.

## Model

`minimax-coding-plan/MiniMax-M3` (project default)