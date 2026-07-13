# Yautja — Phase 2 Implementation Spec

## Context

Read `D:\Yautja\docs\SPEC.md` for architecture. Read `D:\Yautja\docs\phase-1-spec.md` for Phase 1 context.

Phase 1 (connection + rolling buffer) is DONE and tested against a real browser via the extension bridge.

Phase 2 implements:
1. `src/vision/base-sensor.ts` — abstract base class for all sensors
2. `src/vision/thermal.ts` — network sensor (correlates raw Network CDP events into transactions)
3. Tests for both

## Transport Interface

Both `CDPSessionManager` and `ExtensionServer` implement this interface. Sensors depend ONLY on this, not on specific transport implementations.

```typescript
// src/vision/base-sensor.ts
export interface Transport {
  on(event: string, handler: (params: any) => void): () => void;
  send(method: string, params?: Record<string, any>): Promise<any>;
}
```

Both existing classes already have compatible `on()` and `send()` methods.

## Module 1: BaseSensor

**File:** `src/vision/base-sensor.ts`

```typescript
export interface Transport {
  on(event: string, handler: (params: any) => void): () => void;
  send(method: string, params?: Record<string, any>): Promise<any>;
}

export interface Anomaly {
  domain: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  timestamp: number;
  data?: Record<string, any>;
}

export interface SensorQuery {
  limit?: number;
  [key: string]: any;
}

export abstract class BaseSensor<TSummary> {
  protected transport: Transport;
  protected unsubscribers: (() => void)[] = [];
  protected _active = false;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /** Subscribe to CDP events. Idempotent. */
  subscribe(): void {
    if (this._active) return;
    this._active = true;
    this.doSubscribe();
  }

  /** Unsubscribe from all CDP events. */
  unsubscribe(): void {
    for (const unsub of this.unsubscribers) {
      try { unsub(); } catch {}
    }
    this.unsubscribers = [];
    this._active = false;
  }

  get active(): boolean {
    return this._active;
  }

  /** Produce a summary of current state. */
  abstract summarize(query?: SensorQuery): TSummary;

  /** Check for anomalies. */
  abstract getAnomalies(): Anomaly[];

  /** Clear all buffered data. */
  abstract clear(): void;

  /** Subscribe to domain-specific CDP events. Called by subscribe(). */
  protected abstract doSubscribe(): void;

  /** Helper to register a CDP event handler and track for cleanup. */
  protected on(event: string, handler: (params: any) => void): void {
    const unsub = this.transport.on(event, handler);
    this.unsubscribers.push(unsub);
  }
}
```

## Module 2: ThermalSensor (Network)

**File:** `src/vision/thermal.ts`

Correlates raw Network CDP events into complete transactions. Named "thermal" — network traffic is the heat signature of a page.

### Types

```typescript
import type { Anomaly, SensorQuery } from './base-sensor.js';

export type RequestState =
  | 'pending'        // requestWillBeSent, no response yet
  | 'receiving'      // responseReceived, waiting for data
  | 'completed'      // loadingFinished
  | 'failed'         // loadingFailed
  | 'cached'         // requestServedFromCache
  | 'data_url';      // data: or blob: URL (no network)

export type ResourceType =
  | 'Document' | 'Script' | 'Stylesheet' | 'Image' | 'Font'
  | 'Media' | 'XHR' | 'Fetch' | 'TextTrack' | 'EventSource'
  | 'WebSocket' | 'Manifest' | 'Other';

export interface NetworkTransaction {
  id: string;                    // CDP requestId
  state: RequestState;
  redirectChain: string[];       // URLs that were redirected (empty if no redirects)
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
    resourceType: ResourceType;
    initiatorType: string;       // parser, script, redirect, preload, other
    initiatorUrl?: string;
    hasUserGesture: boolean;
  };
  response?: {
    status: number;
    statusText: string;
    mimeType: string;
    headers: Record<string, string>;
    encodedSize: number;         // response.headers.encodedDataSize or resourceSize
    decodedSize: number;         // resourceSize or encodedSize
    fromCache: boolean;
    fromServiceWorker: boolean;
    remoteIP?: string;
    remotePort?: number;
    timing?: {
      requestTime: number;
      dnsMs: number;
      connectMs: number;
      sslMs: number;
      ttfbMs: number;            // time to first byte
      downloadMs: number;
      totalMs: number;
    };
  };
  error?: {
    blockedReason?: string;
    canceled: boolean;
    errorText: string;
    failedUrl?: string;
  };
  dataChunks: number;            // count of dataReceived events
  isWebSocket: boolean;
  isSSE: boolean;                // EventSource
  startedAt: number;             // timestamp from requestWillBeSent
  finishedAt?: number;
  durationMs?: number;           // finishedAt - startedAt
}

export interface NetworkSummary {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  byType: Record<string, number>;       // ResourceType → count
  byStatus: Record<string, number>;     // "2xx", "3xx", "4xx", "5xx", "pending", "failed"
  slow: NetworkTransaction[];           // sorted by duration desc
  failedRequests: NetworkTransaction[];
  webSockets: NetworkTransaction[];
  apiCalls: NetworkTransaction[];       // XHR + Fetch with JSON/response body
  totalEncodedBytes: number;
  totalDecodedBytes: number;
}

export interface NetworkQuery extends SensorQuery {
  slowThresholdMs?: number;     // default 2000
  urlContains?: string;
  resourceType?: ResourceType;
  minStatus?: number;           // e.g., 400 for errors only
  maxStatus?: number;
}
```

### ThermalSensor class

```typescript
import { BaseSensor, type Transport } from './base-sensor.js';
import { RollingBuffer } from '../memory/rolling-buffer.js';
import type { NetworkTransaction, NetworkSummary, NetworkQuery, RequestState, ResourceType } from './thermal-types.js';

export interface ThermalConfig {
  maxTransactions: number;      // default 200
  slowThresholdMs: number;      // default 2000
  pageOrigin?: string;          // for third-party classification
}

const DEFAULT_CONFIG: ThermalConfig = {
  maxTransactions: 200,
  slowThresholdMs: 2000,
};

export class ThermalSensor extends BaseSensor<NetworkSummary> {
  private config: ThermalConfig;
  private buffer: RollingBuffer<NetworkTransaction>;
  private transactions: Map<string, NetworkTransaction> = new Map();

  constructor(transport: Transport, config?: Partial<ThermalConfig>) {
    super(transport);
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.buffer = new RollingBuffer(this.config.maxTransactions);
  }

  protected doSubscribe(): void {
    this.on('Network.requestWillBeSent', (p) => this.onRequest(p));
    this.on('Network.responseReceived', (p) => this.onResponse(p));
    this.on('Network.dataReceived', (p) => this.onData(p));
    this.on('Network.loadingFinished', (p) => this.onFinished(p));
    this.on('Network.loadingFailed', (p) => this.onFailed(p));
    this.on('Network.requestServedFromCache', (p) => this.onCached(p));
    this.on('Network.webSocketCreated', (p) => this.onWebSocketCreated(p));
    this.on('Network.eventSourceMessageReceived', (p) => this.onSSE(p));
  }

  // ─── Event handlers ──────────────────────────────────────────

  private onRequest(p: any): void {
    const requestId: string = p.requestId;
    const url: string = p.request?.url || '';
    const existing = this.transactions.get(requestId);

    // Handle redirect: CDP reuses requestId for redirected requests
    if (p.redirectResponse && existing) {
      // Save old URL to redirect chain
      existing.redirectChain.push(existing.request.url);
      // Fill in the redirect response
      existing.response = extractResponse(p.redirectResponse);
      existing.state = 'receiving';
    }

    // Check for data/blob URL
    const isDataUrl = url.startsWith('data:') || url.startsWith('blob:');

    const txn: NetworkTransaction = {
      id: requestId,
      state: isDataUrl ? 'data_url' : 'pending',
      redirectChain: existing?.redirectChain ?? [],
      request: {
        url,
        method: p.request?.method || 'GET',
        headers: p.request?.headers || {},
        postData: p.request?.postData,
        resourceType: (p.type || 'Other') as ResourceType,
        initiatorType: p.initiator?.type || 'other',
        initiatorUrl: p.initiator?.url,
        hasUserGesture: p.hasUserGesture ?? false,
      },
      dataChunks: 0,
      isWebSocket: false,
      isSSE: false,
      startedAt: p.timestamp ?? Date.now() / 1000,
    };

    if (isDataUrl) {
      txn.state = 'completed';
      txn.finishedAt = p.timestamp ?? Date.now() / 1000;
      txn.durationMs = 0;
    }

    this.transactions.set(requestId, txn);
    this.syncBuffer();
  }

  private onResponse(p: any): void {
    const txn = this.transactions.get(p.requestId);
    if (!txn) return;
    txn.response = extractResponse(p.response);
    txn.state = 'receiving';
  }

  private onData(p: any): void {
    const txn = this.transactions.get(p.requestId);
    if (!txn) return;
    txn.dataChunks++;
  }

  private onFinished(p: any): void {
    const txn = this.transactions.get(p.requestId);
    if (!txn) return;
    txn.state = 'completed';
    txn.finishedAt = p.timestamp ?? Date.now() / 1000;
    txn.durationMs = Math.round((txn.finishedAt - txn.startedAt) * 1000);
  }

  private onFailed(p: any): void {
    const txn = this.transactions.get(p.requestId);
    if (!txn) return;
    txn.state = 'failed';
    txn.error = {
      blockedReason: p.blockedReason,
      canceled: p.canceled ?? false,
      errorText: p.errorText || 'unknown',
      failedUrl: p.url,
    };
    txn.finishedAt = p.timestamp ?? Date.now() / 1000;
    txn.durationMs = Math.round((txn.finishedAt - txn.startedAt) * 1000);
  }

  private onCached(p: any): void {
    const txn = this.transactions.get(p.requestId);
    if (!txn) return;
    txn.state = 'cached';
    if (txn.response) txn.response.fromCache = true;
  }

  private onWebSocketCreated(p: any): void {
    const txn = this.transactions.get(p.requestId);
    if (!txn) {
      // Create a synthetic transaction for the WebSocket
      this.onRequest({
        requestId: p.requestId,
        request: { url: p.url, method: 'GET', headers: p.request?.headers || {} },
        type: 'WebSocket',
        timestamp: Date.now() / 1000,
      });
    }
    const ws = this.transactions.get(p.requestId);
    if (ws) ws.isWebSocket = true;
  }

  private onSSE(p: any): void {
    const txn = this.transactions.get(p.requestId);
    if (txn) txn.isSSE = true;
  }

  // ─── Public API ──────────────────────────────────────────────

  summarize(query?: NetworkQuery): NetworkSummary {
    const slowThreshold = query?.slowThresholdMs ?? this.config.slowThresholdMs;
    let txns = Array.from(this.transactions.values());

    // Apply filters
    if (query?.urlContains) {
      txns = txns.filter(t => t.request.url.includes(query.urlContains!));
    }
    if (query?.resourceType) {
      txns = txns.filter(t => t.request.resourceType === query.resourceType);
    }

    const completed = txns.filter(t => t.state === 'completed' || t.state === 'cached');
    const failed = txns.filter(t => t.state === 'failed');
    const pending = txns.filter(t => t.state === 'pending' || t.state === 'receiving');

    const slow = completed
      .filter(t => (t.durationMs ?? 0) > slowThreshold)
      .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));

    const webSockets = txns.filter(t => t.isWebSocket);
    const apiCalls = txns.filter(t =>
      (t.request.resourceType === 'XHR' || t.request.resourceType === 'Fetch') &&
      t.response?.mimeType?.includes('json')
    );

    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const t of txns) {
      byType[t.request.resourceType] = (byType[t.request.resourceType] ?? 0) + 1;
      const statusKey = t.response
        ? `${Math.floor(t.response.status / 100)}xx`
        : t.state === 'failed' ? 'failed' : 'pending';
      byStatus[statusKey] = (byStatus[statusKey] ?? 0) + 1;
    }

    return {
      total: txns.length,
      completed: completed.length,
      failed: failed.length,
      pending: pending.length,
      byType,
      byStatus,
      slow,
      failedRequests: failed,
      webSockets,
      apiCalls,
      totalEncodedBytes: sum(completed, t => t.response?.encodedSize ?? 0),
      totalDecodedBytes: sum(completed, t => t.response?.decodedSize ?? 0),
    };
  }

  getAnomalies(): Anomaly[] {
    const anomalies: Anomaly[] = [];
    const now = Date.now();

    // High failure rate
    const summary = this.summarize();
    if (summary.total > 5 && summary.failed / summary.total > 0.3) {
      anomalies.push({
        domain: 'network',
        severity: 'warning',
        message: `${summary.failed} of ${summary.total} requests failed (${Math.round(summary.failed / summary.total * 100)}%)`,
        timestamp: now,
      });
    }

    // Very slow requests
    for (const t of summary.slow) {
      if ((t.durationMs ?? 0) > 10000) {
        anomalies.push({
          domain: 'network',
          severity: 'warning',
          message: `Request to ${t.request.url.substring(0, 60)} took ${t.durationMs}ms`,
          timestamp: now,
          data: { url: t.request.url, durationMs: t.durationMs },
        });
      }
    }

    return anomalies;
  }

  clear(): void {
    this.transactions.clear();
    this.buffer.clear();
  }

  getTransactions(): NetworkTransaction[] {
    return Array.from(this.transactions.values());
  }

  // ─── Internal ────────────────────────────────────────────────

  private syncBuffer(): void {
    // Keep buffer and map in sync — enforce size limit via eviction
    if (this.transactions.size > this.config.maxTransactions) {
      // Evict oldest completed transactions first
      const sorted = Array.from(this.transactions.entries())
        .sort(([, a], [, b]) => a.startedAt - b.startedAt);
      const toEvict = sorted.length - this.config.maxTransactions;
      for (let i = 0; i < toEvict; i++) {
        const [id] = sorted[i];
        this.transactions.delete(id);
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function extractResponse(r: any): NetworkTransaction['response'] {
  const timing = r?.timing;
  let timingParsed: NetworkTransaction['response'] extends object ? NonNullable<NetworkTransaction['response']>['timing'] : undefined;
  if (timing && typeof timing.requestTime === 'number') {
    const total = (timing.receiveHeadersEnd ?? 0) - timing.requestTime;
    timingParsed = {
      requestTime: timing.requestTime,
      dnsMs: Math.max(0, (timing.connectEnd ?? 0) - (timing.connectStart ?? 0) > 0
        ? (timing.dnsEnd ?? 0) - (timing.dnsStart ?? 0) : 0),
      connectMs: Math.max(0, (timing.connectEnd ?? 0) - (timing.connectStart ?? 0)),
      sslMs: Math.max(0, (timing.sslEnd ?? 0) - (timing.sslStart ?? 0)),
      ttfbMs: Math.max(0, (timing.receiveHeadersEnd ?? 0) - (timing.sendEnd ?? 0)),
      downloadMs: 0, // filled on loadingFinished
      totalMs: Math.max(0, total * 1000),
    };
  }

  return {
    status: r?.status ?? 0,
    statusText: r?.statusText || '',
    mimeType: r?.mimeType || '',
    headers: r?.headers || {},
    encodedSize: r?.encodedDataSize ?? r?.headers?.['content-length'] ? parseInt(r.headers['content-length'], 10) || 0 : 0,
    decodedSize: r?.decodedBodySize ?? r?.encodedDataSize ?? 0,
    fromCache: r?.fromDiskCache ?? r?.fromPrefetchCache ?? false,
    fromServiceWorker: r?.fromServiceWorker ?? false,
    remoteIP: r?.remoteIPAddress,
    remotePort: r?.remotePort,
    timing: timingParsed,
  };
}

function sum<T>(arr: T[], fn: (item: T) => number): number {
  let total = 0;
  for (const item of arr) total += fn(item);
  return total;
}
```

### Implementation Notes

1. **All NetworkTransaction types go in a separate `thermal-types.ts` file** so the test file can import types without importing the class. Actually, keep types and class in the SAME file (`thermal.ts`) for simplicity. Export all types from there.

2. **Timestamp handling**: CDP timestamps are in seconds (float). Convert to ms when computing duration: `durationMs = (finishedAt - startedAt) * 1000`, rounded.

3. **Eviction policy**: When transactions exceed `maxTransactions`, evict the OLDEST by `startedAt`. Prefer evicting completed/failed transactions over pending ones.

4. **`syncBuffer()`**: Called after each new transaction. Maintains the size invariant. The `RollingBuffer` from Phase 1 is used for the initial buffer, but the `Map` is the primary store. The buffer can be kept in sync for compatibility, or you can just use the Map and enforce size manually. Choose whichever is cleaner — the Map-based approach in the code above is fine.

5. **extractResponse helper**: Must handle missing/null fields gracefully. CDP responses can have varying shapes.

6. **No `any` in YOUR interfaces** — but CDP event params can be `any` since they come from the browser.

## Tests

**File:** `tests/vision/thermal.test.ts`

Create a `MockTransport` that implements `Transport`:

```typescript
class MockTransport implements Transport {
  handlers: Map<string, ((params: any) => void)[]> = new Map();

  on(event: string, handler: (params: any) => void): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(handler);
    return () => {
      const arr = this.handlers.get(event);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
  }

  emit(event: string, params: any): void {
    const arr = this.handlers.get(event);
    if (arr) for (const h of arr) h(params);
  }

  async send(): Promise<any> { return {}; }
}
```

### Test cases

```
BaseSensor:
- subscribe sets active=true
- unsubscribe sets active=false and removes handlers
- subscribe is idempotent (calling twice doesn't double-register)
- on() helper tracks unsubscriptions

ThermalSensor:
- requestWillBeSent creates pending transaction
- responseReceived updates to receiving state
- loadingFinished marks completed and sets duration
- loadingFailed marks failed with error info
- requestServedFromCache marks cached
- data URL (data:text/html,...) creates completed transaction immediately
- redirect: requestWillBeSent with redirectResponse updates redirectChain
- webSocketCreated sets isWebSocket=true
- multiple dataReceived increments dataChunks
- summarize returns correct counts (total, completed, failed, pending)
- summarize groups by resourceType
- summarize groups by status category (2xx, 3xx, 4xx, 5xx)
- summarize identifies slow requests (> threshold)
- summarize identifies API calls (XHR/Fetch + JSON mime)
- summarize calculates total bytes
- summarize with urlContains filter
- summarize with resourceType filter
- clear() empties all transactions
- eviction removes oldest when maxTransactions exceeded
- getAnomalies detects high failure rate
- getAnomalies detects very slow requests
- unsubscribe stops processing events
- full lifecycle: request → response → data → finished produces correct transaction
```

## Style

- Same as Phase 1: strict TypeScript, no unused vars, ESM, no comments
- Export all types from thermal.ts
- The `extractResponse` helper can be a module-level function (not exported)

## Deliverables

1. `src/vision/base-sensor.ts`
2. `src/vision/thermal.ts`
3. `tests/vision/thermal.test.ts`

After writing: `cd D:\Yautja && npx vitest run && npm run lint`
Report full output.
