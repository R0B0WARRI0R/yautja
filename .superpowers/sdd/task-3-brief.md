# Task 3 Brief — MacroRunner.run with validation, timeout, log capture

**Source plan:** `D:\Yautja\docs\superpowers\plans\2026-07-13-yautja-macros.md`
**Repo:** `D:\Yautja` (baseline before this task: `ea67a1d`)
**Predecessors:** Tasks 1-2 (types, registry) — committed and reviewed clean.

## Scene-setting

Task 3 adds the execution engine to `MacroRunner`. The `run` method:
1. Looks up the macro in the registry
2. Validates `args` against the macro's `argsSchema` (if any)
3. Wraps `def.run(args, ctx)` with a timeout race
4. Captures `ctx.log()` calls into a per-invocation buffer
5. Returns structured `RunResult`

The `host` field (currently `void this.host;` from Task 2) becomes actively used. Remove the `void` workaround.

## Files

- Modify: `D:\Yautja\src\macros\runner.ts` (extend class)
- Modify: `D:\Yautja\tests\macros\runner.test.ts` (append tests)
- Create: none

## Interfaces (consumed from Tasks 1-2)

Already imported in `runner.ts`: `HelmetLike, MacroDef, MacroRegistryEntry, MacroSource, MacroSummary`.
New imports needed: `ArgsSchema, MacroContext, RunResult` (types) and `DEFAULT_MACRO_TIMEOUT_MS` (const) — both from `./types.js`.

## Implementation contract

### Changes to `src/macros/runner.ts`

Add to existing imports at top:
```typescript
import type { ArgsSchema, MacroContext, RunResult } from './types.js';
import { DEFAULT_MACRO_TIMEOUT_MS } from './types.js';
```

Add a `TimeoutError` class at module scope (above the class):
```typescript
class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timeout after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}
```

Replace `void this.host;` workaround in the constructor:
```typescript
constructor(private readonly host: HelmetLike) {
  // host is now used in buildCtx() below; the Task-2 `void this.host;` workaround is removed.
}
```

Add these methods to the `MacroRunner` class body:

```typescript
async run(name: string, args?: unknown, timeoutMsOverride?: number): Promise<RunResult> {
  const entry = this.registry.get(name);
  if (!entry) {
    return { success: false, error: `unknown macro: ${name}`, stage: 'lookup' };
  }
  const { def } = entry;

  const validationError = this.validateArgs(def.argsSchema, args);
  if (validationError) {
    return { success: false, error: validationError, stage: 'validation' };
  }

  const effectiveTimeout = timeoutMsOverride ?? def.timeoutMs ?? DEFAULT_MACRO_TIMEOUT_MS;
  const logBuffer: string[] = [];
  const ctx = this.buildCtx(logBuffer);

  const start = Date.now();
  try {
    const result = await this.raceWithTimeout(def.run(args as any, ctx), effectiveTimeout);
    return {
      success: true,
      result,
      log: logBuffer,
      elapsedMs: Date.now() - start,
      macro: this.toSummary(entry),
    };
  } catch (err) {
    const elapsedMs = Date.now() - start;
    const isTimeout = err instanceof TimeoutError;
    return {
      success: false,
      error: isTimeout
        ? `macro timed out after ${effectiveTimeout}ms`
        : err instanceof Error ? err.message : String(err),
      stage: isTimeout ? 'timeout' : 'execution',
      ...(err instanceof Error && !isTimeout ? { stack: err.stack } : {}),
      log: logBuffer,
      elapsedMs,
      macro: this.toSummary(entry),
    };
  }
}

private validateArgs(schema: ArgsSchema | undefined, args: unknown): string | null {
  if (!schema) return null;
  if (args === undefined || args === null) {
    if (schema.required && schema.required.length > 0) {
      return `missing required arg: ${schema.required[0]}`;
    }
    return null;
  }
  if (typeof args !== 'object' || Array.isArray(args)) {
    return 'args must be an object';
  }
  const obj = args as Record<string, unknown>;
  for (const required of schema.required ?? []) {
    if (!(required in obj)) return `missing required arg: ${required}`;
  }
  for (const [key, spec] of Object.entries(schema.properties)) {
    if (!(key in obj)) continue;
    const v = obj[key];
    const actual = Array.isArray(v) ? 'array' : typeof v;
    if (actual !== spec.type) {
      return `arg ${key}: expected ${spec.type}, got ${actual}`;
    }
  }
  return null;
}

private async raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

private buildCtx(logBuffer: string[]): MacroContext {
  const h = this.host;
  return {
    openTab: (u: string) => h.openTab(u),
    switchTab: (t: number) => h.switchTab(t),
    closeTab: (t: number) => h.closeTab(t),
    reattach: () => h.reattach(),
    observe: (q: string) => h.observe(q),
    inspect: (d: any) => h.inspect(d),
    diff: () => h.diff(),
    act: (a: any) => h.act(a),
    findElement: (q: string, l?: number) => h.findElement(q, l),
    findClick: (q: string) => h.findClick(q),
    findType: (q: string, t: string) => h.findType(q, t),
    smartType: (q: string, t: string, o?: any) => h.smartType(q, t, o),
    techScan: () => h.techScan(),
    stealthCheck: () => h.stealthCheck(),
    stealthEnable: () => h.stealthEnable(),
    stealthDisable: () => h.stealthDisable(),
    interceptEnable: () => h.interceptEnable(),
    interceptAddRule: (r: unknown) => h.interceptAddRule(r as any),
    interceptDisable: () => h.interceptDisable(),
    interceptLog: (l?: number) => h.interceptLog(l),
    captureList: (f?: any) => h.captureList(f),
    captureRequest: (i: string) => h.captureRequest(i),
    captureResponse: (i: string) => h.captureResponse(i),
    osintHarvest: () => h.osintHarvest(),
    netIntel: () => h.netIntel(),
    gqlQuery: (o: any) => h.gqlQuery(o),
    siteMemory: () => h.siteMemory(),
    siteMemoryClear: (d?: string) => h.siteMemoryClear(d),
    wsWatch: () => h.wsWatch(),
    wsFrames: (f?: any) => h.wsFrames(f),
    sleep: (ms: number) => new Promise<void>(r => setTimeout(r, ms)),
    log: (m: string) => { logBuffer.push(m); },
  };
}
```

### Tests to append to `tests/macros/runner.test.ts`

Append a new `describe` block at the end of the file:

```typescript
describe('MacroRunner.run', () => {
  let runner: MacroRunner;
  beforeEach(() => {
    runner = new MacroRunner({} as any);
  });

  it('returns lookup error for unknown macro', async () => {
    const r = await runner.run('nope');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.stage).toBe('lookup');
  });

  it('runs a no-arg macro and returns result + log + elapsedMs', async () => {
    runner.register({
      name: 'hi',
      description: 'greets',
      async run(_args, c) {
        c.log('starting');
        await c.sleep(5);
        c.log('done');
        return 42;
      },
    }, 'builtin');
    const r = await runner.run('hi');
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.result).toBe(42);
      expect(r.log).toEqual(['starting', 'done']);
      expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(r.macro.name).toBe('hi');
    }
  });

  it('validates missing required args before run', async () => {
    runner.register({
      name: 'login',
      description: 'login',
      argsSchema: {
        type: 'object',
        properties: { user: { type: 'string' }, pass: { type: 'string' } },
        required: ['user', 'pass'],
      },
      async run() { return 'ok'; },
    }, 'builtin');
    const r = await runner.run('login', { user: 'bob' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.stage).toBe('validation');
      expect(r.error).toMatch(/pass/);
    }
  });

  it('validates wrong-type arg', async () => {
    runner.register({
      name: 'agecheck',
      description: 'age',
      argsSchema: { type: 'object', properties: { age: { type: 'number' } }, required: ['age'] },
      async run() { return 'ok'; },
    }, 'builtin');
    const r = await runner.run('agecheck', { age: 'twenty' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.stage).toBe('validation');
  });

  it('allows extra args (no additionalProperties:false)', async () => {
    runner.register({
      name: 'echo',
      description: 'echo',
      argsSchema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      async run(args) { return (args as any).x; },
    }, 'builtin');
    const r = await runner.run('echo', { x: 'hello', extra: 1 });
    expect(r.success).toBe(true);
  });

  it('captures thrown error with stack', async () => {
    runner.register({
      name: 'boom',
      description: 'throws',
      async run() { throw new Error('kaboom'); },
    }, 'builtin');
    const r = await runner.run('boom');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.stage).toBe('execution');
      expect(r.error).toBe('kaboom');
      expect(typeof r.stack).toBe('string');
    }
  });

  it('aborts on macro timeoutMs', async () => {
    runner.register({
      name: 'slow',
      description: 'slow',
      timeoutMs: 50,
      async run(_, c) { await c.sleep(500); return 'late'; },
    }, 'builtin');
    const r = await runner.run('slow');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.stage).toBe('timeout');
      expect((r.elapsedMs ?? 0)).toBeGreaterThanOrEqual(45);
    }
  });

  it('per-call timeoutMs overrides macro default', async () => {
    runner.register({
      name: 'medium',
      description: 'medium',
      timeoutMs: 10_000,
      async run(_, c) { await c.sleep(200); return 'done'; },
    }, 'builtin');
    const r = await runner.run('medium', undefined, 50);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.stage).toBe('timeout');
  });
});
```

## Steps

### Step 1: Append the new tests first (TDD)

Use **Edit** tool to append the `describe('MacroRunner.run', ...)` block at the end of `tests/macros/runner.test.ts`.

### Step 2: Run tests to verify new ones fail, old ones still pass

Run: `cd D:\Yautja && npx vitest run tests/macros/runner.test.ts`

Expected: 5 existing pass, 8 new FAIL with "is not a function" (run not implemented).

### Step 3: Implement run + validateArgs + raceWithTimeout + buildCtx

Use **Edit** to modify `src/macros/runner.ts`:
- Replace the existing `import` block with the expanded imports
- Add `TimeoutError` class at module scope
- Remove the `void this.host;` workaround in constructor
- Add the four new methods to the class body

### Step 4: Run tests to verify all pass

Run: `cd D:\Yautja && npx vitest run tests/macros/runner.test.ts`

Expected: 13 tests pass (5 registry + 8 run).

### Step 5: Type-check

Run: `cd D:\Yautja && npx tsc --noEmit`

Expected: 0 errors.

### Step 6: Do NOT commit

The controller handles git after review passes.

## Report Contract

Write report to `D:\Yautja\.superpowers\sdd\task-3-report.md` containing:
- Status
- Test output (13/13 pass expected)
- Compile output (0 errors)
- Files modified
- Concerns (especially: any deviations from the brief's contract block)

Reply in this shape:
```
STATUS: <...>
TESTS: 13/13 pass
COMPILE: 0 errors
FILES: src/macros/runner.ts (extended), tests/macros/runner.test.ts (appended)
CONCERNS: <none | details>
```

## Constraints reminder

- TDD: tests first
- Edit existing files (do not rewrite)
- `noUnusedLocals` is back to normal — remove `void this.host;` workaround
- Do not implement `registerUserMacro` / `deleteUserMacro` (separate tasks)
- Do not commit

## Model

`minimax-coding-plan/MiniMax-M3` (project default)