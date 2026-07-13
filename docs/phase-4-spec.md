# Yautja — Phase 4 Implementation Spec

## Context

Phases 1-3 are DONE. 159 tests passing. Sensors implemented: Thermal (network), EM (DOM), Audio (console).

Phase 4 adds the final two sensors:
1. `src/vision/motion.ts` — Performance sensor (metrics polling + long task detection)
2. `src/vision/threat.ts` — Security sensor (security state + mixed content + CSP violations)

Both extend `BaseSensor` which now has async `summarize()`.

## Module 1: MotionSensor (Performance)

**File:** `src/vision/motion.ts`

Named "motion" — performance is the movement/activity of the page.

### Approach

Performance metrics in CDP are **pull-based**. The sensor polls `Performance.getMetrics` at a configurable interval (default 2000ms). It also listens for `Log.entryAdded` entries with `level=warning` that often indicate performance issues (deprecation notices, long task warnings).

Additionally, uses `Runtime.evaluate` to check for `PerformanceObserver` long task entries.

### Types

```typescript
import type { Anomaly, SensorQuery, Transport } from './base-sensor.js';

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
```

### MotionSensor class

```typescript
export interface MotionConfig {
  pollIntervalMs: number;    // default 2000
  heapGrowthThreshold: number; // default 10 (MB delta to flag as "growing")
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
    // Start polling
    this.pollTimer = setInterval(() => this.poll(), this.config.pollIntervalMs);
    // Initial poll immediately
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

    // Determine heap trend
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

    // Heap pressure
    if (summary.jsHeapUsedMB > 100) {
      anomalies.push({
        domain: 'performance',
        severity: summary.jsHeapUsedMB > 200 ? 'critical' : 'warning',
        message: `JS heap usage high: ${summary.jsHeapUsedMB}MB`,
        timestamp: Date.now(),
        data: { jsHeapUsedMB: summary.jsHeapUsedMB },
      });
    }

    // Growing heap (potential leak)
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
```

### Implementation Notes

- `Performance.getMetrics` returns metrics like: `Timestamp`, `Documents`, `Frames`, `JSEventListeners`, `Nodes`, `LayoutCount`, `RecalcStyleCount`, `LayoutDuration`, `RecalcStyleDuration`, `ScriptDuration`, `TaskDuration`, `JSHeapUsedSize`, `JSHeapTotalSize`. Values for durations are in SECONDS (float). Convert to ms.
- Heap values are in BYTES. Convert to MB.
- The `poll()` method is fire-and-forget — it doesn't block `doSubscribe()`.
- `unsubscribe()` must clear the interval timer in addition to calling `super.unsubscribe()`.

## Module 2: ThreatSensor (Security)

**File:** `src/vision/threat.ts`

Named "threat" — security state of the page.

### Approach

The security sensor monitors:
1. `Security.securityStateChanged` — overall security state changes
2. `Security.certificateError` — certificate problems
3. Mixed content — detected via `Network.requestWillBeSent` with mixed content URLs (https page loading http resources)
4. CSP violations — detected via `Network.requestWillBeSent` with `blockedReason` containing "csp"

### Types

```typescript
export type SecurityState = 'secure' | 'insecure' | 'broken' | 'warning' | 'info';

export interface SecuritySummary {
  state: SecurityState;
  schemeIsCryptographic: boolean;
  explanations: SecurityExplanation[];
  mixedContentRequests: number;
  cspViolations: number;
  certificateErrors: number;
  blockedRequests: BlockedRequest[];
  totalThreats: number;
}

export interface SecurityExplanation {
  securityState: SecurityState;
  title: string;
  summary: string;
  description: string;
  certificate?: string[];
  recommendation?: string;
}

export interface BlockedRequest {
  url: string;
  reason: string;
  timestamp: number;
}
```

### ThreatSensor class

```typescript
export interface ThreatConfig {
  maxBlockedRequests: number;  // default 50
}

const DEFAULT_CONFIG: ThreatConfig = {
  maxBlockedRequests: 50,
};

export class ThreatSensor extends BaseSensor<SecuritySummary> {
  private config: ThreatConfig;
  private state: SecurityState = 'info';
  private schemeIsCryptographic: boolean = false;
  private explanations: SecurityExplanation[] = [];
  private certificateErrors: number = 0;
  private blockedRequests: BlockedRequest[] = [];
  private mixedContentCount: number = 0;
  private cspViolationCount: number = 0;
  private pageUrl: string = '';

  constructor(transport: Transport, config?: Partial<ThreatConfig>) {
    super(transport);
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  protected doSubscribe(): void {
    this.on('Security.securityStateChanged', (p) => this.onSecurityChanged(p));
    this.on('Security.certificateError', (p) => this.onCertError(p));
    this.on('Network.requestWillBeSent', (p) => this.checkMixedContent(p));
    this.on('Network.loadingFailed', (p) => this.checkBlocked(p));
  }

  private onSecurityChanged(p: any): void {
    this.state = (p.securityState || 'info') as SecurityState;
    this.schemeIsCryptographic = p.schemeIsCryptographic ?? false;
    this.explanations = (p.explanations || []).map((e: any) => ({
      securityState: e.securityState || 'info',
      title: e.title || '',
      summary: e.summary || '',
      description: e.description || '',
      certificate: e.certificate,
      recommendation: e.recommendation,
    }));
  }

  private onCertError(p: any): void {
    this.certificateErrors++;
  }

  private checkMixedContent(p: any): void {
    const url: string = p.request?.url || '';
    // If we don't know the page URL yet, try to infer from the first document request
    if (!this.pageUrl && p.type === 'Document') {
      this.pageUrl = url;
    }
    // Mixed content: page is HTTPS but resource is HTTP
    if (this.pageUrl.startsWith('https://') && url.startsWith('http://')) {
      this.mixedContentCount++;
    }
  }

  private checkBlocked(p: any): void {
    const blockedReason = p.blockedReason;
    if (!blockedReason) return;

    const entry: BlockedRequest = {
      url: p.url || '',
      reason: blockedReason,
      timestamp: Date.now(),
    };

    this.blockedRequests.push(entry);
    if (this.blockedRequests.length > this.config.maxBlockedRequests) {
      this.blockedRequests.shift();
    }

    if (blockedReason.toLowerCase().includes('csp')) {
      this.cspViolationCount++;
    }
  }

  async summarize(): Promise<SecuritySummary> {
    const totalThreats =
      this.mixedContentCount +
      this.cspViolationCount +
      this.certificateErrors +
      this.blockedRequests.length;

    return {
      state: this.state,
      schemeIsCryptographic: this.schemeIsCryptographic,
      explanations: this.explanations,
      mixedContentRequests: this.mixedContentCount,
      cspViolations: this.cspViolationCount,
      certificateErrors: this.certificateErrors,
      blockedRequests: [...this.blockedRequests],
      totalThreats,
    };
  }

  async getAnomalies(): Promise<Anomaly[]> {
    const anomalies: Anomaly[] = [];
    const summary = await this.summarize();
    const now = Date.now();

    if (summary.state === 'insecure' || summary.state === 'broken') {
      anomalies.push({
        domain: 'security',
        severity: 'critical',
        message: `Page security state is ${summary.state}`,
        timestamp: now,
      });
    }

    if (summary.certificateErrors > 0) {
      anomalies.push({
        domain: 'security',
        severity: 'critical',
        message: `${summary.certificateErrors} certificate error(s)`,
        timestamp: now,
      });
    }

    if (summary.mixedContentRequests > 0) {
      anomalies.push({
        domain: 'security',
        severity: 'warning',
        message: `${summary.mixedContentRequests} mixed content request(s) detected`,
        timestamp: now,
      });
    }

    if (summary.cspViolations > 0) {
      anomalies.push({
        domain: 'security',
        severity: 'warning',
        message: `${summary.cspViolations} CSP violation(s)`,
        timestamp: now,
      });
    }

    return anomalies;
  }

  clear(): void {
    this.state = 'info';
    this.explanations = [];
    this.certificateErrors = 0;
    this.blockedRequests = [];
    this.mixedContentCount = 0;
    this.cspViolationCount = 0;
    this.pageUrl = '';
  }
}
```

### Implementation Notes

- `Security.securityStateChanged` event provides `securityState`, `schemeIsCryptographic`, and `explanations` array.
- `Security.certificateError` event provides `eventId`, `errorType`, `requestId`.
- Mixed content detection: track the page URL from the first `Document` type request. If page is HTTPS and a resource URL starts with `http://`, it's mixed content.
- CSP violations: detected via `Network.loadingFailed` events where `blockedReason` contains "csp" (case-insensitive). Other blocked reasons: "mixed-content", "origin", "cors", etc.
- `blockedRequests` is capped at `maxBlockedRequests` with FIFO eviction.

## Test cases

### Motion tests

```
- poll calls Performance.getMetrics on subscribe
- summarize returns correct metrics from getMetrics result
- summarize converts heap bytes to MB
- summarize converts durations from seconds to ms
- summarize detects heap growth trend (growing)
- summarize detects heap shrink trend (shrinking)
- summarize returns 'stable' when heap unchanged
- summarize handles empty metrics gracefully (returns zeros)
- getAnomalies warns on heap > 100MB
- getAnomalies critical on heap > 200MB
- getAnomalies warns on growing heap trend
- clear resets all state
- unsubscribe clears poll timer
```

### Threat tests

```
- securityStateChanged updates state and explanations
- certificateError increments certificateErrors count
- mixed content: https page + http resource increments count
- mixed content: https page + https resource does NOT increment
- mixed content: http page + http resource does NOT increment
- loadingFailed with CSP blockedReason increments cspViolations
- loadingFailed with non-CSP blockedReason does NOT increment cspViolations
- loadingFailed without blockedReason is ignored
- blockedRequests capped at maxBlockedRequests (FIFO eviction)
- summarize returns correct counts and totalThreats
- getAnomalies critical on insecure state
- getAnomalies critical on broken state
- getAnomalies critical on certificate errors
- getAnomalies warning on mixed content
- getAnomalies warning on CSP violations
- getAnomalies empty when secure with no issues
- clear resets all state
- unsubscribe stops processing events
```

## Deliverables

1. `src/vision/motion.ts`
2. `src/vision/threat.ts`
3. `tests/vision/motion.test.ts`
4. `tests/vision/threat.test.ts`

After writing: `cd D:\Yautja && npx vitest run && npm run lint`
Report full output.
