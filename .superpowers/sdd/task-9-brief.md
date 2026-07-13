# Task 9 Brief — Seed built-in macro: page-summary

**Source plan:** `D:\Yautja\docs\superpowers\plans\2026-07-13-yautja-macros.md`
**Repo:** `D:\Yautja` (baseline before this task: `8d45c8e`)
**Predecessors:** Tasks 1-8 — committed and reviewed clean.

## Scene-setting

Task 9 adds the first real built-in macro: `page-summary`. Demonstrates the system end-to-end without requiring users to write code. Uses `observe('summary')` and `techScan()` — both confirmed as actual Helmet instance methods (not just handleToolCall cases), so the deferred HelmetLike cast issue from Task 8 does NOT affect this macro.

Task 10 will add the user-facing docs.

## Files

- Create: `D:\Yautja\src\macros\page-summary.ts`
- Modify: none

## Implementation contract

```typescript
// src/macros/page-summary.ts
import type { MacroDef } from './types.js';

export default {
  name: 'page-summary',
  description: 'Combine observe("summary") with techScan() for a quick page overview.',
  timeoutMs: 15_000,
  async run(_args, ctx) {
    ctx.log('gathering observation');
    const observation = await ctx.observe('summary');
    ctx.log('scanning tech stack');
    const tech = await ctx.techScan();
    return { observation, tech };
  },
} satisfies MacroDef;
```

## Verification

After creating the file:

1. `cd D:\Yautja && npm run build` — verify `dist/macros/page-summary.js` exists
2. `cd D:\Yautja && npx tsc --noEmit` — 0 errors
3. `cd D:\Yautja && npx vitest run tests/macros/` — 22/22 pass (4 loadBuiltins + 4 loadUserMacros + 5 registry + 8 run + 6 register + 4 delete + 4 integration; verify actual count after running)
4. Optional smoke: set `YAUTJA_BUILTIN_DIR=D:\Yautja\dist\macros` and run a quick script that creates a `MacroRunner`, calls `loadBuiltins`, asserts `'page-summary'` appears in the list. Not required but good evidence.

## Report Contract

Write to `D:\Yautja\.superpowers\sdd\task-9-report.md`:

```
# Task 9 Report

## Status: <DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED>

## Build output
[tsc / npm run build result]

## Test output
[vitest result for tests/macros/]

## Files created
- src/macros/page-summary.ts

## Concerns
[none | details]
```

Reply:
```
STATUS: <...>
BUILD: <output>
TESTS: <X/X pass>
FILES: src/macros/page-summary.ts
CONCERNS: <none | details>
```

## Constraints reminder

- Single file, ~13 lines.
- Use `satisfies MacroDef` for type checking.
- timeoutMs: 15000 (15s — page summaries shouldn't take longer).
- Both `observe` and `techScan` are real Helmet instance methods (Task 8's HelmetLike cast does NOT block this macro).
- Do not commit.

## Model

`minimax-coding-plan/MiniMax-M3` (project default)