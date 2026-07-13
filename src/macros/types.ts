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
  reattach(): Promise<void>;

  // Macro-only utilities (NOT on Helmet)
  sleep(ms: number): Promise<void>;
  log(message: string): void;
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