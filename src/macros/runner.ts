import type { ArgsSchema, HelmetLike, MacroContext, MacroDef, MacroRegistryEntry, MacroSource, MacroSummary, RunResult } from './types.js';
import { DEFAULT_MACRO_TIMEOUT_MS } from './types.js';

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timeout after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export class MacroRunner {
  private registry = new Map<string, MacroRegistryEntry>();

  constructor(private readonly host: HelmetLike) {
    // host is now used in buildCtx() below; the Task-2 `void this.host;` workaround is removed.
  }

  register(def: MacroDef, source: MacroSource, file?: string): void {
    this.registry.set(def.name, { def, source, file, loadedAt: Date.now() });
  }

  unregister(name: string): boolean {
    return this.registry.delete(name);
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
}