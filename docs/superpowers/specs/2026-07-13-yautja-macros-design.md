# Yautja Macros — Design Spec

**Status:** Draft
**Date:** 2026-07-13
**Owner:** jroca
**Codebase:** `D:\Yautja`

## Problem

Yautja exposes 30+ MCP tools (observe, act, smartType, findClick, intercept…). Many real-world browser workflows require **chaining** several of these tools in a fixed order with the same arguments every time ("go to /login, type username, type password, submit, wait for dashboard"). Today, the LLM agent must repeat that chain manually every time it encounters the workflow, burning tokens and risking inconsistency.

Existing tooling in the repo (e.g. `SiteMemory` for cached selectors) persists data but not behaviour. There is no way to compose existing Yautja tools into a reusable, named, typed sequence.

## Goal

Add a **macro system** to Yautja that lets the user (and the LLM agent) define **reusable compositions of Yautja MCP tools**, callable as a single MCP tool with typed arguments.

Non-goals:
- No recording/replay of browser events (Selenium IDE-style).
- No standalone scripting language — macros are TS/JS files calling existing Yautja tools.
- No sandboxing of macro code (user trusts their own macros, same trust level as the helmet itself).
- No persistence of macro *executions* — only macro *definitions*.

## Approach (chosen: B3 — hybrid real)

Macros live in **two locations**, share a single registry, share a single API:

| Source | Path | Format | How loaded |
|---|---|---|---|
| Built-in | `D:\Yautja\src\macros\<name>.ts` | TypeScript, exported `default` `MacroDef` | Compiled by `tsc`, auto-discovered at boot, `import()` |
| User | `%APPDATA%\.yautja-macros\<name>.js` | Plain JS, exported `default` `MacroDef` | Scanned at boot, `import()` with cache-busting `?v=mtimeMs`. Re-importable in hot via `macro_register` |

Both sources are merged into one `MacroRegistry` keyed by `name`. A name collision between built-in and user logs a warning at boot and the user macro wins (overridable behaviour).

## Architecture

```
LLM (MCP stdio)
    │
    ▼
Helmet.handleToolCall()         ← +4 cases: macro_list/run/register/delete
    │
    ▼
MacroRunner
   ├── registry: Map<name, { def, source }>
   ├── run(name, args): Promise<Result>
   ├── list(): MacroSummary[]
   ├── register(name, source): { success, error? }
   └── delete(name): { success, error? }
    │
    ▼
MacroContext (typed subset of Helmet, passed to macro.run)
    │
    ▼
Helmet.act() / .observe() / .smartType() / .findClick() / .interceptAddRule() / ...
```

A macro never touches CDP directly. It only calls `MacroContext` methods, which are bound methods of `Helmet` itself. This guarantees:
- All actions go through `Helmet.act()` → `ActionTranslator` → `ensureAttached` + `WorkingMemory.update` + diff (existing behaviour inherited).
- All interception goes through `Helmet.interceptor.addRule()`.
- All state (memory, site memory, network capture) is the same `Helmet` singleton — no parallel state.

### New files

```
src/
├── macros/
│   ├── types.ts          MacroDef, MacroContext, ArgsSchema, MacroSummary
│   ├── runner.ts         MacroRunner class
│   └── index.ts          auto-discovery + load built-in and user macros at boot
└── helmet.ts             +1 field `macroRunner`, +4 cases in handleToolCall, +4 entries in MCP_TOOLS
tests/
└── macros/
    ├── runner.test.ts
    ├── builtin-loading.test.ts
    ├── user-loading.test.ts
    ├── register.test.ts
    └── arg-validation.test.ts
```

No new dependencies. Reuses `fs`, `path`, `url.pathToFileURL`, dynamic `import()` (Node 20+ standard).

## Data shapes

### `MacroDef<Args, Result>`

```typescript
export interface ArgsSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
}

export interface MacroDef<Args = Record<string, never>, Result = unknown> {
  name: string;
  description: string;
  argsSchema?: ArgsSchema;          // omitted = no args
  timeoutMs?: number;               // default 60000
  run(args: Args, ctx: MacroContext): Promise<Result>;
}
```

Two modes:
- **No args**: omit `argsSchema`. `macro_run({ name })` requires no `args` field.
- **With args**: declare `argsSchema`. `macro_run({ name, args })` validates `args` against schema before invoking `run`. Missing required fields → `{ success: false, error: "missing required arg: <field>" }`. Type mismatches → `{ success: false, error: "arg <field>: expected <type>, got <actual>" }`.

Validation is hand-rolled against the simple JSON-schema-like `ArgsSchema` shape (we only support `type: 'string' | 'number' | 'boolean'`). No external validation library.

### `MacroContext`

Curated, typed subset of `Helmet` methods. Listed in full in `src/macros/types.ts`. Categories:

| Category | Methods |
|---|---|
| Tabs | `openTab`, `switchTab`, `closeTab`, `reattach` |
| Observation | `observe`, `inspect`, `diff` |
| Action | `act` |
| Smart finding | `findElement`, `findClick`, `findType`, `smartType` |
| Tech/stealth | `techScan`, `stealthCheck`, `stealthEnable`, `stealthDisable` |
| Interception | `interceptEnable`, `interceptAddRule`, `interceptDisable`, `interceptLog` |
| Capture | `captureList`, `captureRequest`, `captureResponse` |
| Intel | `osintHarvest`, `netIntel`, `gqlQuery` |
| Site memory | `siteMemory`, `siteMemoryClear` |
| WebSocket | `wsWatch`, `wsFrames` |
| Utility | `sleep`, `log` |

Every method on `MacroContext` returns `Promise<string>` (matches the existing JSON-string return convention of `Helmet`'s tool methods). Macros that want structured data `JSON.parse()` the result.

`Helmet` already implements all of these as instance methods. The simplest implementation: pass `helmet` itself as the context (`runner.run(name, args, this.helmet)`). TypeScript will narrow via the `MacroContext` interface.

### `MacroSummary` (returned by `macro_list`)

```typescript
export interface MacroSummary {
  name: string;
  description: string;
  source: 'builtin' | 'user';
  hasArgs: boolean;        // argsSchema !== undefined
  timeoutMs?: number;
}
```

## MCP tools (4 new)

Added to `MCP_TOOLS` (`helmet.ts:778`) and to the switch in `handleToolCall` (`helmet.ts:332`):

### `macro_list`
```json
{
  "name": "macro_list",
  "description": "List all registered macros (built-in and user-defined).",
  "inputSchema": { "type": "object", "properties": {} }
}
```
Returns `JSON.stringify({ macros: MacroSummary[] })`.

### `macro_run`
```json
{
  "name": "macro_run",
  "description": "Invoke a macro by name with optional typed arguments.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Macro name (from macro_list)" },
      "args": { "type": "object", "description": "Macro arguments (validated against argsSchema)" },
      "timeoutMs": { "type": "number", "description": "Override default timeout (ms)" }
    },
    "required": ["name"]
  }
}
```
Returns:
- Success: `{ success: true, result, log, elapsedMs, macro }` where `result` is the macro's return value, `log` is array of `ctx.log()` calls, `elapsedMs` is wall-clock time.
- Validation error: `{ success: false, error, stage: 'validation' }`
- Execution error: `{ success: false, error, stack, stage: 'execution', log, elapsedMs }`
- Timeout: `{ success: false, error: 'macro timed out after Xms', stage: 'timeout', elapsedMs }`
- Unknown macro: `{ success: false, error: 'unknown macro: <name>', stage: 'lookup' }`

### `macro_register`
```json
{
  "name": "macro_register",
  "description": "Write a user macro to %APPDATA%\\.yautja-macros\\<name>.js, import it, and register it. Validates shape before persisting.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Macro name (filename-safe: [a-z0-9_-]+)" },
      "source": { "type": "string", "description": "Full source code of the macro module (must export default a MacroDef)" },
      "overwrite": { "type": "boolean", "description": "Overwrite existing user macro with same name (default false)" }
    },
    "required": ["name", "source"]
  }
}
```
Returns:
- Success: `{ success: true, name, source: 'user', file: <absolutePath> }`
- Name invalid: `{ success: false, error: 'name must match [a-z0-9_-]+', stage: 'validation' }`
- Already exists: `{ success: false, error: 'macro <name> already exists (use overwrite: true)', stage: 'persistence' }`
- Import failed: `{ success: false, error: <reason>, stage: 'import' }`
- Shape invalid: `{ success: false, error: <which field missing>, stage: 'shape' }`

### `macro_delete`
```json
{
  "name": "macro_delete",
  "description": "Delete a user-defined macro file and unregister it. Cannot delete built-in macros.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Macro name to delete" }
    },
    "required": ["name"]
  }
}
```
Returns:
- Success: `{ success: true, name, removedFile: <path> }`
- Built-in: `{ success: false, error: 'cannot delete built-in macro: <name>', stage: 'permission' }`
- Unknown: `{ success: false, error: 'unknown macro: <name>', stage: 'lookup' }`

## Loading and execution semantics

### Built-in loading (boot)

1. `MacroRunner.loadBuiltins()` reads `dist/macros/` (after `tsc` has run).
2. Iterates `fs.readdirSync()`, filters `*.js`, excludes `runner.js`, `types.js`, `index.js`.
3. For each file: `await import(pathToFileURL(file).href)`, read `.default`, validate it has `name`, `description`, `run`.
4. On any failure, log warning to stderr and continue (fail-soft, one bad macro does not break boot).
5. Each successful macro enters the registry with `source: 'builtin'`.

### User loading (boot)

1. Resolve user dir: `path.join(process.env.APPDATA || process.env.HOME || '/tmp', '.yautja-macros')`.
2. Create dir if missing (mirror `SiteMemory` `mkdirSync({recursive:true})` pattern at `src/memory/site-memory.ts:19`).
3. Read all `*.js` (excluding hidden).
4. For each file: `await import(pathToFileURL(file).href + '?v=' + stat.mtimeMs)`.
5. Cache-busting `?v=mtimeMs` ensures `import()` does not return a cached copy across restarts (and across multiple file rewrites within a session).
6. Same fail-soft on shape/import errors.

### Name collisions

If a built-in and a user macro share a name:
- Boot logs warning: `[Yautja] user macro '<name>' shadows built-in`.
- Registry keeps the **user** version (user wins).
- `macro_list` shows source as `'user'`.
- `macro_delete` refuses to delete it as built-in (it can delete the user version).

### Execution flow (`macro_run`)

```
macro_run({ name, args, timeoutMs? })
  │
  ├─ lookup in registry
  │    └─ miss → { success: false, error: 'unknown macro: <name>', stage: 'lookup' }
  │
  ├─ validate args against def.argsSchema (if present)
  │    └─ invalid → { success: false, error: <reason>, stage: 'validation' }
  │
  ├─ wrap def.run(args, ctx) in Promise.race with timeout
  │    └─ timeout → { success: false, error: 'timed out after Xms', stage: 'timeout' }
  │
  ├─ try { const result = await def.run(args, ctx); }
  │    catch (err) → { success: false, error, stack, stage: 'execution', log, elapsedMs }
  │
  └─ return { success: true, result, log, elapsedMs, macro: <summary> }
```

`ctx` is constructed once at boot: an object with the listed methods bound to `helmet`. `ctx.log(msg)` pushes to a per-invocation array that is captured by `MacroRunner.run()` via closure.

### Concurrency

Serial by inheritance. `Helmet.serveMCP()` reads stdin line-by-line (`helmet.ts:279`), processes each line to completion before reading the next. A `macro_run` call therefore runs to completion (or timeout) before the next MCP message is handled. No additional locking required.

### Timeouts

- Default: `60000` ms (overridable per-macro via `MacroDef.timeoutMs`, overridable per-call via `macro_run.timeoutMs`).
- Per-call wins over per-macro wins over default.
- Implemented as `Promise.race([def.run(...), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), effectiveTimeout))])`.
- Timeout does not cancel the underlying `def.run` — it only stops awaiting. A long-running macro will continue executing silently if not awaited. This is acceptable: the user trusts their own macros, and the helmet is the only consumer.

## Persistence

User macros live at `path.join(process.env.APPDATA || process.env.HOME || '/tmp', '.yautja-macros')`. On Windows: `C:\Users\<user>\AppData\Roaming\.yautja-macros\`. On Linux/Mac: `~/.yautja-macros/`.

Each macro is one file: `<name>.js`. No metadata sidecar. The module's `default` export is the source of truth for `name`, `description`, `argsSchema`.

No TTL. Macros are user artefacts, deleted explicitly via `macro_delete`.

Write operations are atomic (`fs.writeFile(file, source)` then `import()`), fail-soft (errors return to MCP, do not crash helmet).

## Error handling

| Stage | Failure mode | Result to caller |
|---|---|---|
| `lookup` | unknown name | `{ success: false, error, stage: 'lookup' }` |
| `validation` | missing/invalid arg | `{ success: false, error, stage: 'validation' }` |
| `import` (register only) | syntax error / wrong export shape | `{ success: false, error, stage: 'import'/'shape' }`, file NOT deleted |
| `execution` | throw inside `def.run` | `{ success: false, error, stack, stage: 'execution', log, elapsedMs }` |
| `timeout` | exceeds timeoutMs | `{ success: false, error, stage: 'timeout', elapsedMs }` |

`stack` is included only when `process.env.YAUTJA_DEBUG === 'true'` (or similar — confirmed in implementation phase).

## Testing strategy

Vitest. Mock `MacroContext` in unit tests so `MacroRunner.run` is testable without a real browser.

### Unit (`tests/macros/`)

| File | Covers |
|---|---|
| `runner.test.ts` | run/lookup/timeout, error propagation, log capture |
| `builtin-loading.test.ts` | discovery filters out runner/types/index, fail-soft on bad file |
| `user-loading.test.ts` | scans user dir, cache-busting import, fail-soft |
| `register.test.ts` | write to disk, import, validate shape, overwrite=false blocks |
| `delete.test.ts` | removes user file, refuses built-in |
| `arg-validation.test.ts` | required missing, type mismatch, extra args allowed |

### Integration (manual, scripted)

A smoke-test script `tests/integration/macro-smoke.ts` that:
1. Starts the helmet against a real Chrome (or recorded CDP fixture).
2. Calls `macro_register` with a simple macro that calls `observe("overview")`.
3. Calls `macro_list`, asserts the new macro appears with `source: 'user'`.
4. Calls `macro_run({ name: <new>, args: {} })`, asserts `success: true`.

## Migration / rollout

1. Implement in a feature branch (no `git` here — manual rollout).
2. Bump no other module's public surface; this is purely additive.
3. Add one seed built-in macro `src/macros/page-summary.ts` (calls `observe('summary')` + `techScan()`) so the user can verify end-to-end without writing anything.
4. README addendum in `D:\Yautja\docs\MACROS.md` (5-line usage example).
5. After testing, commit and rebuild (`npm run build`) so `dist/macros/*.js` exists.

## Open questions

None at design time. Implementation may surface:
- Whether to support `macro_reload` (rescan user dir without re-registering) — defer unless requested.
- Whether to expose `ctx.act()` directly or wrap with retry/error policies — defer, use raw `act` initially.
- Whether built-in macros should be reloadable without restart — out of scope; `npm run build && restart` is the path.

## Self-review checklist

- [x] No placeholders / TBDs.
- [x] Architecture matches the feature descriptions end-to-end.
- [x] Scope is single-implementation-plan-sized (4 new tools, 1 new sub-system, no refactors of existing code).
- [x] No requirement has two valid interpretations: each MCP tool has one explicit return shape; `argsSchema` validation is fully specified; persistence path is fully specified.
- [x] All file paths and class names match existing project conventions (`src/<feature>/<name>.ts`, classes in PascalCase, mirror `SiteMemory` pattern for persistence, mirror `handleToolCall`/`MCP_TOOLS` for tool registration).