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
