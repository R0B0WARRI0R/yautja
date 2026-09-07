import { BaseSensor, type Anomaly, type Transport } from './base-sensor.js';

export type { Anomaly, Transport } from './base-sensor.js';

export type ConsoleLevel = 'log' | 'info' | 'warning' | 'error' | 'debug';

export interface ConsoleEntry {
  level: ConsoleLevel;
  text: string;
  count: number;
  url?: string;
  lineNumber?: number;
  stackTrace?: string;
  timestamp: number;
}

export interface ConsoleSummary {
  total: number;
  errors: ConsoleEntry[];
  warnings: ConsoleEntry[];
  logs: ConsoleEntry[];
  uncaughtExceptions: ConsoleEntry[];
  dedupCount: number;
}

export interface AudioConfig {
  maxEntries: number;
  dedupWindowMs: number;
}

export class AudioSensor extends BaseSensor<ConsoleSummary> {
  protected captureAllTabs = true;
  private config: AudioConfig;
  private buffers = new Map<string, { entries: ConsoleEntry[]; dedupMap: Map<string, ConsoleEntry>; dedupCount: number }>();
  private buffer(tabId?: number) {
    const key = this.scopeKey(tabId);
    if (!this.buffers.has(key)) {
      if (this.buffers.size >= 8) this.buffers.delete(this.buffers.keys().next().value!);
      this.buffers.set(key, { entries: [], dedupMap: new Map(), dedupCount: 0 });
    }
    return this.buffers.get(key)!;
  }
  private get entries() { return this.buffer().entries; }
  private get dedupMap() { return this.buffer().dedupMap; }
  private get dedupCount() { return this.buffer().dedupCount; }
  private set dedupCount(value: number) { this.buffer().dedupCount = value; }

  constructor(transport: Transport, config?: Partial<AudioConfig>) {
    super(transport);
    // Ring buffer de 500 entradas (tope documentado): histórico suficiente
    // para read_console_messages sin crecer sin límite; al excederlo se
    // evictan las más antiguas en addEntry.
    this.config = { maxEntries: 500, dedupWindowMs: 2000, ...config };
  }

  protected doSubscribe(): void {
    this.on('Runtime.consoleAPICalled', (p) => this.onConsole(p));
    this.on('Runtime.exceptionThrown', (p) => this.onException(p));
  }

  private onConsole(p: any): void {
    const level = mapLevel(p.type);
    const text = formatArgs(p.args);
    const entry: ConsoleEntry = {
      level,
      text,
      count: 1,
      url: p.stackTrace?.[0]?.url,
      lineNumber: p.stackTrace?.[0]?.lineNumber,
      timestamp: Date.now(),
    };
    this.addEntry(entry);
  }

  private onException(p: any): void {
    const details = p.exceptionDetails;
    const entry: ConsoleEntry = {
      level: 'error',
      text: details?.text || details?.exception?.description || 'Uncaught exception',
      count: 1,
      url: details?.url,
      lineNumber: details?.lineNumber,
      stackTrace: details?.stackTrace?.callFrames?.map((f: any) => f.functionName + '@' + f.url + ':' + f.lineNumber).join('\n'),
      timestamp: Date.now(),
    };
    this.addEntry(entry);
  }

  private addEntry(entry: ConsoleEntry): void {
    const key = entry.level + ':' + entry.text;
    const existing = this.dedupMap.get(key);
    if (existing && Date.now() - existing.timestamp < this.config.dedupWindowMs) {
      existing.count++;
      this.dedupCount++;
      return;
    }

    this.dedupMap.set(key, entry);
    this.entries.push(entry);

    if (this.entries.length > this.config.maxEntries) {
      const removed = this.entries.shift();
      if (removed) this.dedupMap.delete(removed.level + ':' + removed.text);
    }
  }

  async summarize(): Promise<ConsoleSummary> {
    return {
      total: this.entries.length,
      errors: this.entries.filter((e) => e.level === 'error'),
      warnings: this.entries.filter((e) => e.level === 'warning'),
      logs: this.entries.filter((e) => e.level === 'log' || e.level === 'info' || e.level === 'debug'),
      uncaughtExceptions: this.entries.filter((e) => e.stackTrace !== undefined),
      dedupCount: this.dedupCount,
    };
  }

  async getAnomalies(): Promise<Anomaly[]> {
    const anomalies: Anomaly[] = [];
    const errors = this.entries.filter((e) => e.level === 'error');
    if (errors.length > 5) {
      anomalies.push({
        domain: 'console',
        severity: 'warning',
        message: `${errors.length} console errors detected`,
        timestamp: Date.now(),
      });
    }
    return anomalies;
  }

  clear(tabId?: number): void {
    const buffer = this.buffer(tabId);
    buffer.entries = [];
    buffer.dedupMap.clear();
    buffer.dedupCount = 0;
  }

  getEntries(): ConsoleEntry[] {
    return [...this.entries];
  }

  /**
   * Lectura incremental para read_console_messages: filtra por nivel error
   * (opcional) y devuelve como mucho las `max` entradas más recientes
   * (default 100). El buffer es un ring de maxEntries (500 por defecto).
   */
  readEntries(opts?: { errorsOnly?: boolean; max?: number; tabId?: number }): ConsoleEntry[] {
    let list = this.buffer(opts?.tabId).entries;
    if (opts?.errorsOnly) list = list.filter((e) => e.level === 'error');
    const max = opts?.max ?? 100;
    return list.slice(-max);
  }
}

function mapLevel(type: string): ConsoleLevel {
  switch (type) {
    case 'error': return 'error';
    case 'warning': return 'warning';
    case 'info': return 'info';
    case 'debug': return 'debug';
    default: return 'log';
  }
}

function formatArgs(args: any[]): string {
  if (!args) return '';
  return args.map((a) => {
    if (a.type === 'string') return a.value;
    if (a.type === 'number') return String(a.value);
    if (a.type === 'object' && a.preview) return a.preview.properties?.map((p: any) => p.name + ': ' + p.value).join(', ') || '[object]';
    return a.description || a.value || '[' + a.type + ']';
  }).join(' ');
}
