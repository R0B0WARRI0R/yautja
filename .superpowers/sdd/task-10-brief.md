# Task 10 Brief — Documentation: docs/MACROS.md

**Source plan:** `D:\Yautja\docs\superpowers\plans\2026-07-13-yautja-macros.md`
**Repo:** `D:\Yautja` (baseline before this task: `bfcab23`)
**Predecessors:** Tasks 1-9 — all committed and reviewed clean.

## Scene-setting

Task 10 writes the user-facing README addendum at `D:\Yautja\docs\MACROS.md`. Concise — usage-oriented, no marketing prose. Anchors the 4 MCP tools, the two loading paths (built-in vs user), the `MacroContext` API, and validation behavior. Does NOT modify the existing `D:\Yautja\docs\SPEC.md` (that's the architecture spec, not a user guide).

## Files

- Create: `D:\Yautja\docs\MACROS.md`
- Modify: none

## Implementation contract

Write this exact content to `docs/MACROS.md`:

```markdown
# Yautja Macros

Macros are reusable compositions of Yautja MCP tools. Define once, invoke with a single tool call.

## Discover

Call `macro_list` to see all registered macros — built-in (compiled into the binary) and user (in `%APPDATA%\.yautja-macros\`).

```
macro_list({})
→ { macros: [{ name: "page-summary", description: "...", source: "builtin", hasArgs: false, timeoutMs: 15000 }] }
```

## Invoke

```
macro_run({ name: "page-summary" })
macro_run({ name: "login-flow", args: { user: "bob", pass: "secret" } })
macro_run({ name: "scrape", args: {...}, timeoutMs: 30000 })
```

Result shape:
- Success: `{ success: true, result, log, elapsedMs, macro }`
- Error: `{ success: false, error, stage, ... }` where `stage` is `lookup`, `validation`, `execution`, or `timeout`

## Write your own

Two options:

### Built-in (recommended for stable macros)

Create `src/macros/<name>.ts` exporting a `MacroDef`:

```typescript
import type { MacroDef } from './types.js';

export default {
  name: 'my-macro',
  description: 'what it does',
  async run(args, ctx) {
    await ctx.act({ type: 'navigate', url: 'https://example.com' });
    return await ctx.observe('what changed?');
  },
} satisfies MacroDef;
```

Rebuild: `npm run build`. Restart the helmet.

### User (registered at runtime, no rebuild)

Call `macro_register` from the agent:

```
macro_register({
  name: "scrape-prices",
  source: "export default { name: 'scrape-prices', description: 'scrapes prices', async run(_a, ctx) { return await ctx.act({ type: 'evaluate', expression: '[...document.querySelectorAll(\".price\")].map(e => e.textContent)' }); } };"
})
```

The file persists at `%APPDATA%\.yautja-macros\scrape-prices.js` and loads automatically on next boot.

To overwrite an existing user macro: pass `overwrite: true`.

## Delete

```
macro_delete({ name: "scrape-prices" })
```

Cannot delete built-in macros.

## MacroContext API

Macros receive a `ctx` with these methods (all return `Promise<string>` containing JSON):

| Category | Methods |
|----------|---------|
| Navigation | `openTab(url)`, `switchTab(tabId)`, `closeTab(tabId)`, `reattach()` |
| Observation | `observe(question)`, `inspect(domain)`, `diff()` |
| Action | `act(action)` — any `BrowserAction` from `src/arsenal/action-types.ts` |
| Smart finding | `findElement(query, limit?)`, `findClick(query)`, `findType(query, text)`, `smartType(query, text, opts?)` |
| Tech & stealth | `techScan()`, `stealthCheck()`, `stealthEnable()`, `stealthDisable()` |
| Interception | `interceptEnable()`, `interceptAddRule(rule)`, `interceptDisable()`, `interceptLog(limit?)` |
| Capture | `captureList(filter?)`, `captureRequest(requestId)`, `captureResponse(requestId)` |
| Intel | `osintHarvest()`, `netIntel()`, `gqlQuery(opts)` |
| Site memory | `siteMemory()`, `siteMemoryClear(domain?)` |
| WebSocket | `wsWatch()`, `wsFrames(filter?)` |
| Utility | `sleep(ms)`, `log(message)` |

## Validation

If a macro declares `argsSchema`, `macro_run` validates `args` against it before invoking `run`. Supported types: `string`, `number`, `boolean`. Required fields enforced. Extra fields are allowed.

Example:

```typescript
{
  name: 'login',
  argsSchema: {
    type: 'object',
    properties: {
      user: { type: 'string', description: 'Username' },
      pass: { type: 'string', description: 'Password' },
    },
    required: ['user', 'pass'],
  },
  async run(args, ctx) { /* ... */ }
}
```

Missing required arg → `{ success: false, error: "missing required arg: pass", stage: "validation" }`
Wrong type → `{ success: false, error: "arg age: expected number, got string", stage: "validation" }`

## Timeouts

Each macro can declare `timeoutMs` (default 60000). Override per-call via `macro_run({ name, args, timeoutMs })`. On timeout, the macro's underlying promise continues silently; only the awaited result is abandoned.

## Built-in macro: page-summary

The seed built-in combines `observe("summary")` with `techScan()` for a quick page overview:

```
macro_run({ name: "page-summary" })
→ { success: true, result: { observation: "...", tech: "..." }, log: ["gathering observation", "scanning tech stack"], elapsedMs: 423, macro: {...} }
```

## File locations

| Source | Path | Format | Persistence |
|--------|------|--------|-------------|
| Built-in | `dist/macros/<name>.js` (after `npm run build`) | Compiled JS from `src/macros/<name>.ts` | In git, versionable |
| User | `%APPDATA%\.yautja-macros\<name>.js` | Plain JS | Persists across restarts, deletable via `macro_delete` |

Linux/macOS equivalent of `%APPDATA%`: `$HOME` (typically `~/.yautja-macros/`).

## Known limitations

- **HelmetLike interface gap**: macros can call `ctx.observe`, `ctx.techScan`, `ctx.act`, `ctx.inspect`, `ctx.diff` (these are real Helmet instance methods). Other `ctx.*` methods exist in the type but not yet as Helmet instance methods — calling them at runtime throws `TypeError: ctx.X is not a function`. To extend: implement the missing methods on `Helmet` or refactor to route through `handleToolCall`. Tracked for follow-up.
```

## Steps

1. Create `D:\Yautja\docs\MACROS.md` using **Write** with the exact content above.
2. Verify it exists and has the expected length (~130 lines).
3. Write report to `D:\Yautja\.superpowers\sdd\task-10-report.md`.

## Report Contract

```
# Task 10 Report

## Status: <DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED>

## Files created
- docs/MACROS.md

## Line count
[number of lines]

## Concerns
[none | details]
```

Reply:
```
STATUS: <...>
FILES: docs/MACROS.md
LINES: <N>
CONCERNS: <none | details>
```

## Constraints

- Copy the markdown content verbatim from this brief. No additions, no omissions, no rewording.
- Use **Write** to create the file.
- Do not modify any existing files.
- Do not commit.

## Model

`minimax-coding-plan/MiniMax-M3` (project default)