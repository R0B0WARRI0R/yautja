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
| Observation | `observe(question)`, `inspect(domain)`, `diff()` |
| Action | `act(action)` — any `BrowserAction` from `src/arsenal/action-types.ts` |
| Tab control | `reattach()` |
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

The seed built-in calls `observe("summary")` for a focused page overview:

```
macro_run({ name: "page-summary" })
→ { success: true, result: { observation: "..." }, log: ["gathering observation"], elapsedMs: 423, macro: {...} }
```

## File locations

| Source | Path | Format | Persistence |
|--------|------|--------|-------------|
| Built-in | `dist/macros/<name>.js` (after `npm run build`) | Compiled JS from `src/macros/<name>.ts` | In git, versionable |
| User | `%APPDATA%\.yautja-macros\<name>.js` | Plain JS | Persists across restarts, deletable via `macro_delete` |

Linux/macOS equivalent of `%APPDATA%`: `$HOME` (typically `~/.yautja-macros/`).

## Available `ctx.*` methods

Macros can only call the methods listed in the [MacroContext API](#macrocontext-api) section. Other Helmet capabilities (e.g. `openTab`, `switchTab`, `findElement`, `smartType`, `interceptEnable`, etc.) are not yet exposed as instance methods on `Helmet` and are therefore NOT callable as `ctx.X` — doing so will throw `TypeError: ctx.X is not a function` at runtime.

Workaround for now: dispatch via `ctx.act` with a `BrowserAction` (e.g. `{ type: 'evaluate', expression: 'window.location.href = "..."' }`).

Roadmap: as more Helmet instance methods are added (or as Helmet routes through `handleToolCall` more broadly), `MacroContext` will be extended. To check what's currently safe: `grep -nE '^\s*async\s+[a-z][a-zA-Z0-9_]*\s*\(' src/helmet.ts`.
