export type WSConnectionState = 'connecting' | 'open' | 'closed' | 'error';

export interface WSFrame {
  direction: 'sent' | 'received';
  data: string;
  opcode: number;
  timestamp: number;
  length: number;
}

export interface WSConnection {
  id: string;
  url: string;
  state: WSConnectionState;
  frames: WSFrame[];
  sentCount: number;
  receivedCount: number;
  createdAt: number;
  closedAt?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  error?: string;
}

export interface WSStats {
  totalConnections: number;
  activeConnections: number;
  closedConnections: number;
  totalFramesSent: number;
  totalFramesReceived: number;
  totalDataSent: number;
  totalDataReceived: number;
}

const MAX_CONNECTIONS = 50;
const MAX_FRAMES_PER_CONN = 500;
const MAX_FRAME_DATA_LEN = 2000;

export interface Transport {
  on(event: string, handler: (params: any) => void): () => void;
  send(method: string, params?: Record<string, any>): Promise<any>;
}

export class WebSocketInspector {
  private transport: Transport;
  private connections: Map<string, WSConnection> = new Map();
  private active = false;
  private unsubs: (() => void)[] = [];

  constructor(transport: Transport) {
    this.transport = transport;
  }

  watch(): void {
    if (this.active) return;
    this.active = true;

    this.unsubs.push(
      this.transport.on('Network.webSocketCreated', (p: any) => this.onCreated(p)),
    );
    this.unsubs.push(
      this.transport.on('Network.webSocketWillSendHandshakeRequest', (p: any) => this.onHandshakeReq(p)),
    );
    this.unsubs.push(
      this.transport.on('Network.webSocketHandshakeResponseReceived', (p: any) => this.onHandshakeResp(p)),
    );
    this.unsubs.push(
      this.transport.on('Network.webSocketFrameSent', (p: any) => this.onFrame(p, 'sent')),
    );
    this.unsubs.push(
      this.transport.on('Network.webSocketFrameReceived', (p: any) => this.onFrame(p, 'received')),
    );
    this.unsubs.push(
      this.transport.on('Network.webSocketFrameError', (p: any) => this.onError(p)),
    );
    this.unsubs.push(
      this.transport.on('Network.webSocketClosed', (p: any) => this.onClosed(p)),
    );
  }

  unwatch(): void {
    this.active = false;
    for (const unsub of this.unsubs) { try { unsub(); } catch {} }
    this.unsubs = [];
  }

  isActive(): boolean {
    return this.active;
  }

  listConnections(): WSConnection[] {
    return Array.from(this.connections.values()).map(c => ({
      ...c,
      frames: c.frames.slice(-5),
    }));
  }

  getFrames(opts: {
    connectionId?: string;
    direction?: 'sent' | 'received';
    search?: string;
    limit?: number;
  }): WSFrame[] {
    let conns: WSConnection[];
    if (opts.connectionId) {
      const c = this.connections.get(opts.connectionId);
      if (!c) return [];
      conns = [c];
    } else {
      conns = Array.from(this.connections.values());
    }

    let frames: WSFrame[] = [];
    for (const c of conns) {
      frames = frames.concat(c.frames);
    }

    if (opts.direction) {
      frames = frames.filter(f => f.direction === opts.direction);
    }

    if (opts.search) {
      const q = opts.search.toLowerCase();
      frames = frames.filter(f => f.data.toLowerCase().includes(q));
    }

    frames.sort((a, b) => a.timestamp - b.timestamp);

    const limit = opts.limit ?? 50;
    return frames.slice(-limit);
  }

  getStats(): WSStats {
    const conns = Array.from(this.connections.values());
    let sent = 0, received = 0, dataSent = 0, dataReceived = 0;
    for (const c of conns) {
      sent += c.sentCount;
      received += c.receivedCount;
      for (const f of c.frames) {
        if (f.direction === 'sent') dataSent += f.length;
        else dataReceived += f.length;
      }
    }

    return {
      totalConnections: conns.length,
      activeConnections: conns.filter(c => c.state === 'open' || c.state === 'connecting').length,
      closedConnections: conns.filter(c => c.state === 'closed').length,
      totalFramesSent: sent,
      totalFramesReceived: received,
      totalDataSent: dataSent,
      totalDataReceived: dataReceived,
    };
  }

  clear(): void {
    this.connections.clear();
  }

  private onCreated(p: any): void {
    const id: string = p.requestId;
    if (this.connections.has(id)) return;

    const conn: WSConnection = {
      id,
      url: p.url || '',
      state: 'connecting',
      frames: [],
      sentCount: 0,
      receivedCount: 0,
      createdAt: Date.now(),
    };

    this.connections.set(id, conn);
    this.evictIfNeeded();
  }

  private onHandshakeReq(p: any): void {
    const conn = this.connections.get(p.requestId);
    if (!conn) return;
    conn.requestHeaders = p.request?.headers || {};
    conn.state = 'open';
  }

  private onHandshakeResp(p: any): void {
    const conn = this.connections.get(p.requestId);
    if (!conn) return;
    conn.responseHeaders = p.response?.headers || {};
    conn.state = 'open';
  }

  private onFrame(p: any, direction: 'sent' | 'received'): void {
    const conn = this.connections.get(p.requestId);
    if (!conn) return;

    const rawData = p.response?.payloadData || p.payloadData || '';
    const opcode = p.response?.opcode ?? 1;
    const data = opcode === 2 ? '[binary]' : this.truncate(rawData);

    const frame: WSFrame = {
      direction,
      data,
      opcode,
      timestamp: Date.now(),
      length: rawData.length,
    };

    conn.frames.push(frame);
    if (direction === 'sent') conn.sentCount++;
    else conn.receivedCount++;

    if (conn.frames.length > MAX_FRAMES_PER_CONN) {
      conn.frames = conn.frames.slice(-MAX_FRAMES_PER_CONN);
    }
  }

  private onError(p: any): void {
    const conn = this.connections.get(p.requestId);
    if (!conn) return;
    conn.state = 'error';
    conn.error = p.errorMessage || 'unknown error';
  }

  private onClosed(p: any): void {
    const conn = this.connections.get(p.requestId);
    if (!conn) return;
    conn.state = 'closed';
    conn.closedAt = Date.now();
  }

  private truncate(data: string): string {
    if (data.length <= MAX_FRAME_DATA_LEN) return data;
    return data.substring(0, MAX_FRAME_DATA_LEN) + `... [${data.length} bytes total]`;
  }

  private evictIfNeeded(): void {
    if (this.connections.size > MAX_CONNECTIONS) {
      const sorted = Array.from(this.connections.entries())
        .sort(([, a], [, b]) => a.createdAt - b.createdAt);
      const toEvict = sorted.length - MAX_CONNECTIONS;
      for (let i = 0; i < toEvict; i++) {
        this.connections.delete(sorted[i][0]);
      }
    }
  }
}
