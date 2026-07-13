# Task 11 Brief — Critical fix: restrict MacroContext to working Helmet methods

**Source:** Final whole-branch code review (`D:\Yautja\.superpowers\sdd\final-review-package.txt` issue **C1**)
**Severity:** Critical (blocks merge — seed built-in crashes at runtime)
**User decision:** Option A — restrict `MacroContext`, fix `page-summary`, update docs

## Scene-setting

The `HelmetLike` interface declares ~30 methods. Helmet implements **only 5** as instance methods:

| Method on Helmet | Verified at |
|---|---|
| `observe(question)` | `src/helmet.ts:232` |
| `act(action)` | `src/helmet.ts:237` |
| `inspect(domain)` | `src/helmet.ts:273` |
| `diff()` | `src/helmet.ts:286` |
| `reattach()` | `src/helmet.ts:216` |

All others (`techScan`, `openTab`, `switchTab`, `findElement`, `smartType`, etc.) exist only as `case` arms inside `handleToolCall`. The `as unknown as HelmetLike` cast at `src/helmet.ts:125` lets compile pass, but at runtime, ~25 of 30 ctx methods throw `TypeError`.

The seed built-in `src/macros/page-summary.ts:12` calls `ctx.techScan()` → `h.techScan()` → `TypeError`.

This task restricts `MacroContext` to the 5 working methods + sleep/log. Updates `page-summary` to only use working methods. Updates docs. Adds an integration test that exercises `buildCtx` end-to-end.

## Files

- Modify: `D:\Yautja\src\macros\types.ts` (replace `MacroContext` interface + comment)
- Modify: `D:\Yautja\src\macros\runner.ts` (replace `buildCtx` to drop missing methods)
- Modify: `D:\Yautja\src\macros\page-summary.ts` (drop `techScan` call)
- Modify: `D:\Yautja\docs\MACROS.md` (fix Known Limitations, update Built-in section, drop MacroContext API table to match)
- Modify: `D:\Yautja\tests\macros\helmet-integration.test.ts` (add 1 test exercising buildCtx)
- Modify: `D:\Yautja\.superpowers\sdd\task-9-review.md` (correction note — page-summary works ONLY with observe, not techScan)
- Modify: `D:\Yautja\.superpowers\sdd\progress.md` (note the Critical fix)

## Verification — BEFORE editing

Run this grep to confirm the 5-method list is correct (and find any others I missed):

```bash
grep -nE '^\s*(async\s+)?[a-z][a-zA-Z0-9_]*\s*\(' src/helmet.ts | head -40
```

In particular, verify `listTabs`, `switchTab`, `closeTab`, `openTab`, `findElement`, `findClick`, `findType`, `smartType`, `interceptEnable`, `captureList`, `osintHarvest`, etc. are **NOT** defined as methods on Helmet (only as handleToolCall cases).

If any of the 5 listed methods aren't actually defined, find what IS and use that instead.

## Implementation contract

### Change 1: `src/macros/types.ts` — replace `MacroContext` interface

Replace the entire `MacroContext` interface (currently lines ~24-78 of `types.ts`) with this minimal version:

```typescript
/**
 * Curated, typed subset of Helmet methods exposed to macros.
 *
 * IMPORTANT: Only includes methods that Helmet ACTUALLY defines as instance
 * methods. Everything else in Helmet is dispatched via handleToolCall(name, args)
 * and is NOT callable directly as ctx.X — those will throw TypeError at runtime.
 *
 * As Helmet grows more instance methods, extend this list. As a quick rule:
 * `grep -nE '^\s*async\s+[a-z][a-zA-Z0-9_]*\s*\(' src/helmet.ts` shows what's defined.
 *
 * Macro-only utilities: `sleep` (not on Helmet), `log` (captured per-run buffer, not on Helmet).
 */
export interface MacroContext {
  /** Pose a question about the current browser state; returns a focused answer. */
  observe(question: string): Promise<string>;

  /** Execute a single low-level browser action (navigate, click, type, evaluate, etc). */
  act(action: BrowserAction): Promise<string>;

  /** Deep-dive into one sensor domain: network, dom, console, performance, security. */
  inspect(domain: 'network' | 'dom' | 'console' | 'performance' | 'security'): Promise<string>;

  /** Show what changed since the last action. */
  diff(): Promise<string>;

  /** Re-attach to the active browser tab (use after tab switch/close). */
  reattach(): Promise<string>;

  // Macro-only utilities (NOT on Helmet)
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}
```

Remove `HelmetLike` interface entirely (it's no longer used). Update the file's imports — `BrowserAction` stays.

### Change 2: `src/macros/runner.ts` — replace `buildCtx`

Replace `buildCtx` (currently around lines 208-244) with a minimal version that only exposes the 5 working methods + sleep/log:

```typescript
private buildCtx(logBuffer: string[]): MacroContext {
  const h = this.host;
  return {
    observe: (q: string) => h.observe(q),
    act: (a: BrowserAction) => h.act(a),
    inspect: (d: 'network' | 'dom' | 'console' | 'performance' | 'security') => h.inspect(d),
    diff: () => h.diff(),
    reattach: () => h.reattach(),
    sleep: (ms: number) => new Promise<void>(r => setTimeout(r, ms)),
    log: (m: string) => { logBuffer.push(m); },
  };
}
```

Remove the `HelmetLike` import — use a duck-typed type that requires only the 5 methods. Define inline:

```typescript
type HostSurface = Pick<MacroContext, 'observe' | 'act' | 'inspect' | 'diff' | 'reattach'>;
```

Replace the `HelmetLike` parameter type with `HostSurface` everywhere it's referenced in this file (constructor, buildCtx).

Update the import line to drop `HelmetLike`.

### Change 3: `src/helmet.ts` — remove the cast

Find:
```typescript
this.macroRunner = new MacroRunner(this as unknown as HelmetLike);
```

Replace with:
```typescript
this.macroRunner = new MacroRunner(this);
```

Remove the `HelmetLike` import (no longer used).

### Change 4: `src/macros/page-summary.ts` — drop techScan

Replace the file content with:

```typescript
// src/macros/page-summary.ts
import type { MacroDef } from './types.js';

export default {
  name: 'page-summary',
  description: 'Capture a focused page summary via observe("summary").',
  timeoutMs: 15_000,
  async run(_args, ctx) {
    ctx.log('gathering observation');
    const observation = await ctx.observe('summary');
    return { observation };
  },
} satisfies MacroDef;
```

### Change 5: `docs/MACROS.md` — fix Known Limitations, Built-in section, MacroContext API table

Three edits:

**5a. Update MacroContext API table** (around line 78):
Replace the whole table with a minimal version:

```markdown
| Category | Methods |
|----------|---------|
| Observation | `observe(question)`, `inspect(domain)`, `diff()` |
| Action | `act(action)` — any `BrowserAction` from `src/arsenal/action-types.ts` |
| Tab control | `reattach()` |
| Utility | `sleep(ms)`, `log(message)` |
```

**5b. Update Built-in macro: page-summary** (around line 118):
Replace the example output:

```
macro_run({ name: "page-summary" })
→ { success: true, result: { observation: "..." }, log: ["gathering observation"], elapsedMs: 423, macro: {...} }
```

**5c. Update Known limitations** (line 138):
Replace the entire "## Known limitations" section with:

```markdown
## Available `ctx.*` methods

Macros can only call the methods listed in the [MacroContext API](#macrocontext-api) section. Other Helmet capabilities (e.g. `openTab`, `switchTab`, `findElement`, `smartType`, `interceptEnable`, etc.) are not yet exposed as instance methods on `Helmet` and are therefore NOT callable as `ctx.X` — doing so will throw `TypeError: ctx.X is not a function` at runtime.

Workaround for now: dispatch via `ctx.act` with a `BrowserAction` (e.g. `{ type: 'evaluate', expression: 'window.location.href = "..."' }`).

Roadmap: as more Helmet instance methods are added (or as Helmet routes through `handleToolCall` more broadly), `MacroContext` will be extended. To check what's currently safe: `grep -nE '^\s*async\s+[a-z][a-zA-Z0-9_]*\s*\(' src/helmet.ts`.
```

### Change 6: `tests/macros/helmet-integration.test.ts` — add buildCtx integration test

Append a new `describe('buildCtx integration')` block. This test:
1. Registers a built-in macro that calls `ctx.observe('overview')` and `ctx.act({type:'evaluate',...})`
2. Invokes `macro_run` and asserts `success: true`

This catches the C1 regression (broken ctx methods) end-to-end. The test should mock just enough — the existing `vi.mock` of extension-server already mocks `send()`, which is what `observe` / `act` route through internally.

```typescript
describe('buildCtx integration — real ctx methods called by macro', () => {
  // Note: This test uses the same spawn() helper and Helmet instance as above.
  // The mock extension-server's send() returns {}, which is fine — the macro just needs
  // to be invoked without TypeError. We register the macro inline via a macro_register call.

  it('invokes a macro that calls ctx.observe without TypeError', () => {
    const src = `export default { name: 'smoke', description: 'smoke', async run(_a, ctx) { const o = await ctx.observe('overview'); return { ok: true, o }; } };`;
    send(stdin, { jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'macro_register', arguments: { name: 'smoke', source: src } } });
    const regResult = JSON.parse(last(out).result.content[0].text);
    expect(regResult.success).toBe(true);

    send(stdin, { jsonrpc: '2.0', id: 101, method: 'tools/call', params: { name: 'macro_run', arguments: { name: 'smoke' } } });
    const runResult = JSON.parse(last(out).result.content[0].text);
    expect(runResult.success).toBe(true);
    expect(runResult.result.ok).toBe(true);
  });
});
```

### Change 7: `task-9-review.md` — correction note

Append a "## Correction (Task 11)" section explaining the reviewer error and the fix.

### Change 8: `progress.md` — note the fix

Add an entry for Task 11 at the bottom of the task list.

## Steps

### Step 1: Verify the 5-method list

Run the grep above. If any of `observe/act/inspect/diff/reattach` is NOT defined as an instance method on Helmet, STOP and report.

### Step 2: Apply all 8 changes

Use **Edit** for each. Do NOT use Write (preserve git history).

### Step 3: Run all tests

```bash
cd D:\Yautja && npx tsc --noEmit
cd D:\Yautja && npx vitest run tests/macros/
```

Expected: tsc 0 errors, all 36+ macro tests pass (35 existing + 1 new buildCtx test).

### Step 4: Run full suite (regression check)

```bash
cd D:\Yautja && npx vitest run
```

Expected: 16 pre-existing helmet.test.ts failures, no NEW failures.

### Step 5: Do NOT commit

## Report Contract

Write to `D:\Yautja\.superpowers\sdd\task-11-report.md`:

```
# Task 11 Report — Critical fix

## Status: <...>

## Method verification
[grep results confirming the 5 working Helmet methods]

## Files modified
- src/macros/types.ts
- src/macros/runner.ts
- src/macros/page-summary.ts
- src/helmet.ts
- docs/MACROS.md
- tests/macros/helmet-integration.test.ts
- .superpowers/sdd/task-9-review.md
- .superpowers/sdd/progress.md

## Test results
- tsc: 0 errors
- tests/macros/: 36/X pass
- full suite: <X> failures (16 baseline + 0 new)

## Concerns
[none | details]
```

Reply:
```
STATUS: <...>
TSC: 0 errors
TESTS_MACROS: <X/X pass>
TESTS_FULL_FAILURES: <X — must be 16>
CONCERNS: <none | details>
```

## Constraints

- **CRITICAL**: this fix unblocks merge. Be precise.
- Use **Edit**, not Write.
- Strict TS.
- 8 file modifications — apply all.
- Do not commit.

## Model

`minimax-coding-plan/MiniMax-M3` (project default)