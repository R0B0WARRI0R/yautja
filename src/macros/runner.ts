import type { HelmetLike, MacroDef, MacroRegistryEntry, MacroSource, MacroSummary } from './types.js';

export class MacroRunner {
  private registry = new Map<string, MacroRegistryEntry>();

  constructor(private readonly host: HelmetLike) {
    void this.host;
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
}