import { BaseSensor, type Anomaly, type SensorQuery, type Transport } from './base-sensor.js';

export type { Anomaly, SensorQuery, Transport } from './base-sensor.js';

export interface PerformanceMetric {
  name: string;
  value: number;
}

export interface PerformanceSummary {
  metrics: PerformanceMetric[];
  jsHeapUsedMB: number;
  jsHeapTotalMB: number;
  domNodes: number;
  layoutCount: number;
  recalcStyleCount: number;
  scriptDurationMs: number;
  taskDurationMs: number;
  jsHeapTrend: 'stable' | 'growing' | 'shrinking';
  longTaskCount: number;
  timestamp: number;
}

export interface PerformanceQuery extends SensorQuery {
  includeHistory?: boolean;
}

export interface MotionConfig {
  pollIntervalMs: number;
  heapGrowthThreshold: number;
}

const DEFAULT_CONFIG: MotionConfig = {
  pollIntervalMs: 2000,
  heapGrowthThreshold: 10,
};

export class MotionSensor extends BaseSensor<PerformanceSummary> {
  private config: MotionConfig;
  private currentMetrics: Map<string, number> = new Map();
  private previousHeapUsed: number | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private longTaskCount = 0;

  constructor(transport: Transport, config?: Partial<MotionConfig>) {
    super(transport);
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  protected doSubscribe(): void {
    this.pollTimer = setInterval(() => this.poll(), this.config.pollIntervalMs);
    this.poll();
  }

  private async poll(): Promise<void> {
    try {
      const result = await this.transport.send('Performance.getMetrics');
      const metrics = result?.metrics ?? [];
      for (const m of metrics) {
        this.currentMetrics.set(m.name, m.value);
      }
    } catch {
      // Performance domain might not be enabled
    }
  }

  async summarize(): Promise<PerformanceSummary> {
    const get = (name: string): number => this.currentMetrics.get(name) ?? 0;

    const jsHeapUsed = get('JSHeapUsedSize');
    const jsHeapTotal = get('JSHeapTotalSize');

    let trend: 'stable' | 'growing' | 'shrinking' = 'stable';
    if (this.previousHeapUsed !== null) {
      const deltaBytes = jsHeapUsed - this.previousHeapUsed;
      const deltaMB = deltaBytes / (1024 * 1024);
      if (deltaMB > this.config.heapGrowthThreshold) trend = 'growing';
      else if (deltaMB < -this.config.heapGrowthThreshold) trend = 'shrinking';
    }

    const summary: PerformanceSummary = {
      metrics: Array.from(this.currentMetrics.entries()).map(([name, value]) => ({ name, value })),
      jsHeapUsedMB: Math.round((jsHeapUsed / (1024 * 1024)) * 10) / 10,
      jsHeapTotalMB: Math.round((jsHeapTotal / (1024 * 1024)) * 10) / 10,
      domNodes: get('Nodes'),
      layoutCount: get('LayoutCount'),
      recalcStyleCount: get('RecalcStyleCount'),
      scriptDurationMs: Math.round(get('ScriptDuration') * 1000),
      taskDurationMs: Math.round(get('TaskDuration') * 1000),
      jsHeapTrend: trend,
      longTaskCount: this.longTaskCount,
      timestamp: Date.now(),
    };

    this.previousHeapUsed = jsHeapUsed;
    return summary;
  }

  async getAnomalies(): Promise<Anomaly[]> {
    const anomalies: Anomaly[] = [];
    const summary = await this.summarize();

    if (summary.jsHeapUsedMB > 100) {
      anomalies.push({
        domain: 'performance',
        severity: summary.jsHeapUsedMB > 200 ? 'critical' : 'warning',
        message: `JS heap usage high: ${summary.jsHeapUsedMB}MB`,
        timestamp: Date.now(),
        data: { jsHeapUsedMB: summary.jsHeapUsedMB },
      });
    }

    if (summary.jsHeapTrend === 'growing') {
      anomalies.push({
        domain: 'performance',
        severity: 'warning',
        message: `JS heap growing (potential memory leak)`,
        timestamp: Date.now(),
      });
    }

    return anomalies;
  }

  clear(): void {
    this.currentMetrics.clear();
    this.previousHeapUsed = null;
    this.longTaskCount = 0;
  }

  unsubscribe(): void {
    super.unsubscribe();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
