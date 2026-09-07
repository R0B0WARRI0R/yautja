import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { setTimeout as sleep } from 'node:timers/promises';
import { bindMacroScope, currentMacroSignal, MacroTimeoutError, withMacroDeadline } from './execution-scope.js';
import type { RegisterResult, DeleteResult } from './types.js';
import { MACRO_NAME_PATTERN } from './types.js';
import { resolveUserDir } from './loader.js';
import type { ArgsSchema, MacroContext, MacroDef, MacroRegistryEntry, MacroSource, MacroSummary, RunResult } from './types.js';
import { DEFAULT_MACRO_TIMEOUT_MS } from './types.js';
import type { BrowserAction } from '../arsenal/action-types.js';

/** Inline duck-typed surface required by MacroRunner — exactly the 6 Helmet
 *  instance methods the curated MacroContext exposes. Avoids a separate interface. */
type HostSurface = Pick<MacroContext, 'observe' | 'act' | 'inspect' | 'diff' | 'reattach' | 'callTool'>;

export class MacroRunner {
  private registry = new Map<string, MacroRegistryEntry>();

  constructor(private readonly host: HostSurface) {
    // host is now used in buildCtx() below; the Task-2 `void this.host;` workaround is removed.
  }

  register(def: MacroDef, source: MacroSource, file?: string): void {
    this.registry.set(def.name, { def, source, file, loadedAt: Date.now() });
  }

  unregister(name: string): boolean {
    return this.registry.delete(name);
  }

  async registerUserMacro(name: string, source: string, overwrite = false): Promise<RegisterResult> {
    if (!MACRO_NAME_PATTERN.test(name)) {
      return { success: false, error: `name must match ${MACRO_NAME_PATTERN.source}`, stage: 'validation' };
    }
    const dir = resolveUserDir();
    const file = path.join(dir, `${name}.js`);

    const existing = this.registry.get(name);
    if (existing && !overwrite) {
      return { success: false, error: `macro ${name} already exists (use overwrite: true)`, stage: 'persistence' };
    }

    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      return { success: false, error: `cannot create dir ${dir}: ${err}`, stage: 'persistence' };
    }

    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, source, 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch {}
      return { success: false, error: `write failed: ${err}`, stage: 'persistence' };
    }

    let def: MacroDef;
    try {
      const url = pathToFileURL(file).href + `?v=${Date.now()}`;
      const mod = await import(url);
      def = mod.default;
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err), stage: 'import' };
    }

    if (!def
      || typeof def.name !== 'string'
      || typeof def.description !== 'string'
      || typeof def.run !== 'function') {
      return { success: false, error: 'macro must export default with name, description, run', stage: 'shape' };
    }

    if (def.name !== name) {
      return { success: false, error: `macro name '${def.name}' does not match filename '${name}'`, stage: 'shape' };
    }

    this.register(def, 'user', file);
    return { success: true, name, source: 'user', file };
  }

  async deleteUserMacro(name: string): Promise<DeleteResult> {
    const entry = this.registry.get(name);
    if (!entry) {
      return { success: false, error: `unknown macro: ${name}`, stage: 'lookup' };
    }
    if (entry.source === 'builtin') {
      return { success: false, error: `cannot delete built-in macro: ${name}`, stage: 'permission' };
    }
    this.registry.delete(name);

    if (!entry.file) {
      return { success: false, error: `macro ${name} has no source file`, stage: 'io' };
    }
    try {
      if (!fs.existsSync(entry.file)) {
        return { success: false, error: `file not found: ${entry.file}`, stage: 'io' };
      }
      fs.unlinkSync(entry.file);
    } catch (err) {
      return { success: false, error: `delete failed: ${err}`, stage: 'io' };
    }
    return { success: true, name, removedFile: entry.file };
  }

  get(name: string): MacroRegistryEntry | undefined {
    return this.registry.get(name);
  }

  list(): MacroSummary[] {
    return [...this.registry.values()].map((e) => this.toSummary(e));
  }

  private toSummary(entry: MacroRegistryEntry): MacroSummary {
    const { def, source } = entry;
    const summary: MacroSummary = {
      name: def.name,
      description: def.description,
      source,
      hasArgs: def.argsSchema !== undefined,
    };
    if (def.timeoutMs !== undefined) summary.timeoutMs = def.timeoutMs;
    return summary;
  }

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
    if (!Number.isFinite(effectiveTimeout) || effectiveTimeout <= 0 || effectiveTimeout > 2_147_483_647) {
      return { success: false, stage: 'validation', error: 'timeout must be between 0 and 2147483647ms (exclusive of 0)' };
    }
    const logBuffer: string[] = [];

    const start = Date.now();
    try {
      const result = await withMacroDeadline(effectiveTimeout, () => def.run(args as any, this.buildCtx(logBuffer)));
      return {
        success: true,
        result,
        log: logBuffer,
        elapsedMs: Date.now() - start,
        macro: this.toSummary(entry),
      };
    } catch (err) {
      const elapsedMs = Date.now() - start;
      const isTimeout = err instanceof MacroTimeoutError;
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

  private buildCtx(logBuffer: string[]): MacroContext {
    const h = this.host;
    return {
      observe: bindMacroScope((q: string) => h.observe(q)),
      act: bindMacroScope((a: BrowserAction) => h.act(a)),
      inspect: bindMacroScope((d: 'network' | 'dom' | 'console' | 'performance' | 'security') => h.inspect(d)),
      diff: bindMacroScope(() => h.diff()),
      reattach: bindMacroScope(() => h.reattach()),
      callTool: bindMacroScope((name: string, args?: Record<string, unknown>) => h.callTool(name, args)),
      sleep: bindMacroScope((ms: number) => sleep(ms, undefined, { signal: currentMacroSignal() })),
      log: bindMacroScope((m: string) => { logBuffer.push(m); }),
    };
  }
}
