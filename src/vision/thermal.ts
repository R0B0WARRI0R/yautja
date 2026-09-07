import { BaseSensor, type Anomaly, type SensorQuery, type Transport } from './base-sensor.js';

export type { Anomaly, SensorQuery, Transport } from './base-sensor.js';

export type RequestState =
  | 'pending'
  | 'receiving'
  | 'completed'
  | 'failed'
  | 'cached'
  | 'data_url';

export type ResourceType =
  | 'Document'
  | 'Script'
  | 'Stylesheet'
  | 'Image'
  | 'Font'
  | 'Media'
  | 'XHR'
  | 'Fetch'
  | 'TextTrack'
  | 'EventSource'
  | 'WebSocket'
  | 'Manifest'
  | 'Other';

export interface NetworkResponseTiming {
  requestTime: number;
  dnsMs: number;
  connectMs: number;
  sslMs: number;
  ttfbMs: number;
  downloadMs: number;
  totalMs: number;
}

export interface NetworkResponse {
  status: number;
  statusText: string;
  mimeType: string;
  headers: Record<string, string>;
  encodedSize: number;
  decodedSize: number;
  fromCache: boolean;
  fromServiceWorker: boolean;
  remoteIP?: string;
  remotePort?: number;
  timing?: NetworkResponseTiming;
}

export interface NetworkRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  resourceType: ResourceType;
  initiatorType: string;
  initiatorUrl?: string;
  hasUserGesture: boolean;
}

export interface NetworkError {
  blockedReason?: string;
  canceled: boolean;
  errorText: string;
  failedUrl?: string;
}

export interface NetworkTransaction {
  id: string;
  state: RequestState;
  redirectChain: string[];
  request: NetworkRequest;
  response?: NetworkResponse;
  error?: NetworkError;
  dataChunks: number;
  isWebSocket: boolean;
  isSSE: boolean;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface NetworkSummary {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  slow: NetworkTransaction[];
  failedRequests: NetworkTransaction[];
  webSockets: NetworkTransaction[];
  apiCalls: NetworkTransaction[];
  totalEncodedBytes: number;
  totalDecodedBytes: number;
}

export interface NetworkQuery extends SensorQuery {
  slowThresholdMs?: number;
  urlContains?: string;
  resourceType?: ResourceType;
  minStatus?: number;
  maxStatus?: number;
}

export interface ThermalConfig {
  maxTransactions: number;
  slowThresholdMs: number;
  pageOrigin?: string;
}

const DEFAULT_CONFIG: ThermalConfig = {
  // Ring buffer de 500 transacciones (tope documentado): histórico para
  // read_network_requests sin crecer sin límite; syncBuffer evicta las más
  // antiguas por startedAt al excederlo.
  maxTransactions: 500,
  slowThresholdMs: 2000,
};

export class ThermalSensor extends BaseSensor<NetworkSummary> {
  protected captureAllTabs = true;
  private config: ThermalConfig;
  private buffers = new Map<string, Map<string, NetworkTransaction>>();
  private buffer(tabId?: number): Map<string, NetworkTransaction> {
    const key = this.scopeKey(tabId);
    if (!this.buffers.has(key)) {
      if (this.buffers.size >= 8) this.buffers.delete(this.buffers.keys().next().value!);
      this.buffers.set(key, new Map());
    }
    return this.buffers.get(key)!;
  }
  private get transactions() { return this.buffer(); }

  constructor(transport: Transport, config?: Partial<ThermalConfig>) {
    super(transport);
    this.config = { ...DEFAULT_CONFIG, ...config };
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

  private onRequest(p: any): void {
    const requestId: string = p.requestId;
    const url: string = p.request?.url || '';
    const existing = this.transactions.get(requestId);

    let redirectChain = existing?.redirectChain ?? [];
    let redirectedResponse: NetworkResponse | undefined;

    if (p.redirectResponse && existing) {
      redirectChain = [...existing.redirectChain, existing.request.url];
      redirectedResponse = extractResponse(p.redirectResponse);
    }

    const isDataUrl = url.startsWith('data:') || url.startsWith('blob:');

    const txn: NetworkTransaction = {
      id: requestId,
      state: isDataUrl ? 'data_url' : 'pending',
      redirectChain,
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

    if (redirectedResponse) {
      txn.response = redirectedResponse;
      txn.state = 'receiving';
    }

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
    const finishedAt = p.timestamp ?? Date.now() / 1000;
    txn.finishedAt = finishedAt;
    txn.durationMs = Math.round((finishedAt - txn.startedAt) * 1000);
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
    const finishedAt = p.timestamp ?? Date.now() / 1000;
    txn.finishedAt = finishedAt;
    txn.durationMs = Math.round((finishedAt - txn.startedAt) * 1000);
  }

  private onCached(p: any): void {
    const txn = this.transactions.get(p.requestId);
    if (!txn) return;
    txn.state = 'cached';
    if (txn.response) txn.response.fromCache = true;
  }

  private onWebSocketCreated(p: any): void {
    if (!this.transactions.has(p.requestId)) {
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

  /** Pending (in-flight) request count — used by waitForUi networkIdle (P12). */
  getPendingCount(): number {
    let n = 0;
    for (const t of this.transactions.values()) {
      if (t.state === 'pending' || t.state === 'receiving') n++;
    }
    return n;
  }

  async summarize(query?: NetworkQuery): Promise<NetworkSummary> {
    const slowThreshold = query?.slowThresholdMs ?? this.config.slowThresholdMs;
    let txns = Array.from(this.transactions.values());

    if (query?.urlContains) {
      txns = txns.filter((t) => t.request.url.includes(query.urlContains!));
    }
    if (query?.resourceType) {
      txns = txns.filter((t) => t.request.resourceType === query.resourceType);
    }

    const completed = txns.filter(
      (t) => t.state === 'completed' || t.state === 'cached',
    );
    const failed = txns.filter((t) => t.state === 'failed');
    const pending = txns.filter(
      (t) => t.state === 'pending' || t.state === 'receiving',
    );

    const slow = completed
      .filter((t) => (t.durationMs ?? 0) > slowThreshold)
      .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
      .slice(0, 5);

    const webSockets = txns.filter((t) => t.isWebSocket).slice(0, 5);
    const apiCalls = txns.filter(
      (t) =>
        (t.request.resourceType === 'XHR' || t.request.resourceType === 'Fetch') &&
        !!t.response?.mimeType?.includes('json'),
    ).slice(0, 10);

    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const t of txns) {
      byType[t.request.resourceType] = (byType[t.request.resourceType] ?? 0) + 1;
      const statusKey = t.response
        ? `${Math.floor(t.response.status / 100)}xx`
        : t.state === 'failed'
          ? 'failed'
          : 'pending';
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
      failedRequests: failed.slice(0, 5),
      webSockets,
      apiCalls,
      totalEncodedBytes: sum(completed, (t) => t.response?.encodedSize ?? 0),
      totalDecodedBytes: sum(completed, (t) => t.response?.decodedSize ?? 0),
    };
  }

  getAnomalies(): Anomaly[] {
    const anomalies: Anomaly[] = [];
    const now = Date.now();

    const txns = Array.from(this.transactions.values());
    const total = txns.length;
    const failed = txns.filter((t) => t.state === 'failed');
    const completed = txns.filter(
      (t) => t.state === 'completed' || t.state === 'cached',
    );

    if (total > 5 && failed.length / total > 0.3) {
      anomalies.push({
        domain: 'network',
        severity: 'warning',
        message: `${failed.length} of ${total} requests failed (${Math.round((failed.length / total) * 100)}%)`,
        timestamp: now,
      });
    }

    for (const t of completed) {
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

  clear(tabId?: number): void {
    this.buffer(tabId).clear();
  }

  getTransactions(): NetworkTransaction[] {
    return Array.from(this.transactions.values());
  }

  /**
   * Lectura incremental para read_network_requests: filtra por substring de
   * URL (opcional) y devuelve como mucho las `max` transacciones más
   * recientes (default 100; el Map conserva orden de inserción). El buffer
   * es un ring de maxTransactions (500 por defecto).
   */
  readTransactions(opts?: { urlContains?: string; max?: number; tabId?: number }): NetworkTransaction[] {
    let txns = Array.from(this.buffer(opts?.tabId).values());
    if (opts?.urlContains) {
      txns = txns.filter((t) => t.request.url.includes(opts.urlContains!));
    }
    const max = opts?.max ?? 100;
    return txns.slice(-max);
  }

  private syncBuffer(): void {
    if (this.transactions.size > this.config.maxTransactions) {
      const sorted = Array.from(this.transactions.entries()).sort(
        ([, a], [, b]) => a.startedAt - b.startedAt,
      );
      const toEvict = sorted.length - this.config.maxTransactions;
      for (let i = 0; i < toEvict; i++) {
        const [id] = sorted[i]!;
        this.transactions.delete(id);
      }
    }
  }
}

function extractResponse(r: any): NetworkResponse {
  const timing = r?.timing;
  let timingParsed: NetworkResponseTiming | undefined;
  if (timing && typeof timing.requestTime === 'number') {
    const total = (timing.receiveHeadersEnd ?? 0) - timing.requestTime;
    const dnsMs =
      timing.dnsStart != null && timing.dnsEnd != null
        ? Math.max(0, timing.dnsEnd - timing.dnsStart)
        : 0;
    const connectMs =
      timing.connectStart != null && timing.connectEnd != null
        ? Math.max(0, timing.connectEnd - timing.connectStart)
        : 0;
    const sslMs =
      timing.sslStart != null && timing.sslEnd != null
        ? Math.max(0, timing.sslEnd - timing.sslStart)
        : 0;
    const ttfbMs =
      timing.sendEnd != null && timing.receiveHeadersEnd != null
        ? Math.max(0, timing.receiveHeadersEnd - timing.sendEnd)
        : 0;
    timingParsed = {
      requestTime: timing.requestTime,
      dnsMs,
      connectMs,
      sslMs,
      ttfbMs,
      downloadMs: 0,
      totalMs: Math.max(0, total * 1000),
    };
  }

  const headerLength = r?.headers?.['content-length'];
  const encodedSize =
    r?.encodedDataSize ??
    (headerLength ? parseInt(headerLength, 10) || 0 : 0);

  return {
    status: r?.status ?? 0,
    statusText: r?.statusText || '',
    mimeType: r?.mimeType || '',
    headers: r?.headers || {},
    encodedSize,
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
