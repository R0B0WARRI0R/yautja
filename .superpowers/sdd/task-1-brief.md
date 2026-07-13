# Task 1 Brief — Type definitions

**Source plan:** `D:\Yautja\docs\superpowers\plans\2026-07-13-yautja-macros.md`
**Repo:** `D:\Yautja` (git initialized, baseline commit `9153b93`)
**Ledger:** `D:\Yautja\.superpowers\sdd\progress.md`

## Scene-setting

This is Task 1 of 10 in the Yautja Macros feature. The plan introduces a new `MacroRunner` sub-system alongside existing helmet sub-systems (finder, interceptor, siteMemory, ...). This task lays the type foundation that every later task builds on. No tests needed — pure type definitions. No external dependencies.

## Global Constraints (apply to every task)

- OS: Windows, paths via `path.join(process.env.APPDATA || process.env.HOME || '/tmp', ...)`
- Module system: ESM (`"type": "module"`, `"moduleResolution": "bundler"` per `tsconfig.json`)
- Compile: `tsc` only. No bundler, no esbuild.
- TS strict: `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true`, `noFallthroughCasesInSwitch: true`
- Naming: files `kebab-case.ts`, classes PascalCase, mirror existing patterns
- Fail-soft for I/O, hard errors for misuse
- Tool methods return `Promise<string>` containing `JSON.stringify(...)`
- **No commits unless explicitly instructed.**

## Files

- Create: `D:\Yautja\src\macros\types.ts`
- Test: none (pure types)
- Modify: none

## Interfaces (this is what later tasks consume)

`types.ts` exports the following types that Tasks 2-10 will import:

```typescript
import type { BrowserAction } from '../arsenal/action-types.js';

/** Minimal JSON-schema-like shape for macro argument validation. */
export interface ArgsSchema {
  type: 'object';
  properties: Record<string, { type: 'string' | 'number' | 'boolean'; description?: string }>;
  required?: string[];
}

/** A macro definition exported as `default` from a built-in or user macro module. */
export interface MacroDef<Args = Record<string, never>, Result = unknown> {
  name: string;
  description: string;
  argsSchema?: ArgsSchema;
  timeoutMs?: number;
  run(args: Args, ctx: MacroContext): Promise<Result>;
}

/** Curated, typed subset of Helmet methods exposed to macros. */
export interface MacroContext {
  // Tabs
  openTab(url: string): Promise<string>;
  switchTab(tabId: number): Promise<string>;
  closeTab(tabId: number): Promise<string>;
  reattach(): Promise<string>;

  // Observation
  observe(question: string): Promise<string>;
  inspect(domain: 'network' | 'dom' | 'console' | 'performance' | 'security'): Promise<string>;
  diff(): Promise<string>;

  // Action
  act(action: BrowserAction): Promise<string>;

  // Smart finding + typing
  findElement(query: string, limit?: number): Promise<string>;
  findClick(query: string): Promise<string>;
  findType(query: string, text: string): Promise<string>;
  smartType(query: string, text: string, opts?: { submit?: boolean; stealth?: boolean }): Promise<string>;

  // Tech & stealth
  techScan(): Promise<string>;
  stealthCheck(): Promise<string>;
  stealthEnable(): Promise<string>;
  stealthDisable(): Promise<string>;

  // Interception
  interceptEnable(): Promise<string>;
  interceptAddRule(rule: unknown): Promise<string>;
  interceptDisable(): Promise<string>;
  interceptLog(limit?: number): Promise<string>;

  // Capture
  captureList(filter?: { urlPattern?: string; method?: string; hasMatches?: boolean; limit?: number }): Promise<string>;
  captureRequest(requestId: string): Promise<string>;
  captureResponse(requestId: string): Promise<string>;

  // Intel
  osintHarvest(): Promise<string>;
  netIntel(): Promise<string>;
  gqlQuery(opts: { endpoint?: string; query?: string; hash?: string; operationName?: string; variables?: Record<string, unknown>; headers?: Record<string, string> }): Promise<string>;

  // Site memory
  siteMemory(): Promise<string>;
  siteMemoryClear(domain?: string): Promise<string>;

  // WebSocket
  wsWatch(): Promise<string>;
  wsFrames(filter?: { connectionId?: string; direction?: 'sent' | 'received'; search?: string; limit?: number }): Promise<string>;

  // Utility (macro-only, not on Helmet)
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

/** Subset of Helmet that MacroRunner needs.
 *  Helmet implicitly satisfies this — listed here for type-checking.
 *  Note: `sleep` and `log` are macro-runtime utilities, NOT on Helmet. */
export interface HelmetLike {
  openTab(url: string): Promise<string>;
  switchTab(tabId: number): Promise<string>;
  closeTab(tabId: number): Promise<string>;
  reattach(): Promise<string>;
  observe(question: string): Promise<string>;
  inspect(domain: string): Promise<string>;
  diff(): Promise<string>;
  act(action: BrowserAction): Promise<string>;
  findElement(query: string, limit?: number): Promise<string>;
  findClick(query: string): Promise<string>;
  findType(query: string, text: string): Promise<string>;
  smartType(query: string, text: string, opts?: { submit?: boolean; stealth?: boolean }): Promise<string>;
  techScan(): Promise<string>;
  stealthCheck(): Promise<string>;
  stealthEnable(): Promise<string>;
  stealthDisable(): Promise<string>;
  interceptEnable(): Promise<string>;
  interceptAddRule(rule: any): Promise<string>;
  interceptDisable(): Promise<string>;
  interceptLog(limit?: number): Promise<string>;
  captureList(filter?: any): Promise<string>;
  captureRequest(requestId: string): Promise<string>;
  captureResponse(requestId: string): Promise<string>;
  osintHarvest(): Promise<string>;
  netIntel(): Promise<string>;
  gqlQuery(opts: any): Promise<string>;
  siteMemory(): Promise<string>;
  siteMemoryClear(domain?: string): Promise<string>;
  wsWatch(): Promise<string>;
  wsFrames(filter?: any): Promise<string>;
}

/** One row returned by `macro_list`. */
export interface MacroSummary {
  name: string;
  description: string;
  source: MacroSource;
  hasArgs: boolean;
  timeoutMs?: number;
}

export type MacroSource = 'builtin' | 'user';

/** Internal registry entry. */
export interface MacroRegistryEntry {
  def: MacroDef;
  source: MacroSource;
  file?: string;
  loadedAt: number;
}

/** Result of `MacroRunner.run`. */
export type RunResult =
  | { success: true; result: unknown; log: string[]; elapsedMs: number; macro: MacroSummary }
  | { success: false; error: string; stage: 'lookup' | 'validation' | 'execution' | 'timeout'; stack?: string; log?: string[]; elapsedMs?: number; macro?: MacroSummary };

/** Result of `MacroRunner.registerUserMacro` (writes user file). */
export type RegisterResult =
  | { success: true; name: string; source: 'user'; file: string }
  | { success: false; error: string; stage: 'validation' | 'persistence' | 'import' | 'shape' };

/** Result of `MacroRunner.deleteUserMacro`. */
export type DeleteResult =
  | { success: true; name: string; removedFile: string }
  | { success: false; error: string; stage: 'permission' | 'lookup' | 'io' };

/** Default per-call and per-macro timeout (ms). */
export const DEFAULT_MACRO_TIMEOUT_MS = 60_000;

/** Pattern that macro names must match (filename-safe). */
export const MACRO_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
```

## Steps

### Step 1: Create the types file

Write `D:\Yautja\src\macros\types.ts` with exactly the content shown above under "Interfaces".

### Step 2: Verify it compiles

Run: `cd D:\Yautja && npx tsc --noEmit`

Expected: no errors. No "unused" complaints. Every export used somewhere in subsequent tasks (the report should confirm by listing the exports).

### Step 3: Do NOT commit

Per the project rule "No commits unless explicitly authorized." The implementer only writes the file and verifies it compiles. Commits happen later, at review checkpoints, only if the human partner instructs.

## Report Contract

Write a brief report to `D:\Yautja\.superpowers\sdd\task-1-report.md` containing:
- Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
- One-line test/compile summary (e.g., `tsc --noEmit: 0 errors`)
- List of exports (so reviewer can confirm coverage)
- Any concerns (none expected for a pure-types task)

Then return to me:
- The status
- The compile output
- The exports list
- A one-line "ready for review"