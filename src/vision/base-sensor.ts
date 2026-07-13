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

  subscribe(): void {
    if (this._active) return;
    this._active = true;
    this.doSubscribe();
  }

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

  abstract summarize(query?: SensorQuery): Promise<TSummary>;

  abstract getAnomalies(): Anomaly[] | Promise<Anomaly[]>;

  abstract clear(): void;

  protected abstract doSubscribe(): void;

  protected on(event: string, handler: (params: any) => void): void {
    const unsub = this.transport.on(event, handler);
    this.unsubscribers.push(unsub);
  }
}