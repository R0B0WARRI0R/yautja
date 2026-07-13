export interface BiofilmCell {
  id: string;
  tabId: number;
  url: string;
  role: 'primary' | 'backup' | 'interceptor' | 'validator' | 'observer';
  status: 'active' | 'failed' | 'recovering' | 'dormant';
  createdAt: number;
  lastSeenAt: number;
  hashCaptures: number;
  errorCount: number;
}

export interface BiofilmState {
  cells: BiofilmCell[];
  quorumThreshold: number;
  lastSyncAt: number;
  rotationsDetected: number;
}

export interface Transport {
  send(method: string, params?: Record<string, any>): Promise<any>;
}

const DEFAULT_ROLES: BiofilmCell['role'][] = ['primary', 'backup', 'interceptor'];

export class BiofilmManager {
  private transport: Transport;
  private cells: Map<string, BiofilmCell> = new Map();
  private quorumThreshold = 2;
  private observations: Map<string, Set<string>> = new Map();

  constructor(transport: Transport) {
    this.transport = transport;
  }

  async initialize(roles: BiofilmCell['role'][] = DEFAULT_ROLES): Promise<BiofilmCell[]> {
    const created: BiofilmCell[] = [];
    for (const role of roles) {
      try {
        const targetUrl = role === 'interceptor' ? 'about:blank' : 'https://www.twitch.tv';
        const r = await this.transport.send('Target.createTarget', { url: targetUrl });
        const targetId = r?.result?.targetId;
        if (!targetId) continue;
        const attachR = await this.transport.send('Target.attachToTarget', { targetId, flatten: true });
        const sessionId = attachR?.result?.sessionId;
        if (!sessionId) continue;
        const cell: BiofilmCell = {
          id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          tabId: parseInt(targetId, 10),
          url: targetUrl,
          role,
          status: 'active',
          createdAt: Date.now(),
          lastSeenAt: Date.now(),
          hashCaptures: 0,
          errorCount: 0,
        };
        this.cells.set(cell.id, cell);
        created.push(cell);
      } catch {}
    }
    return created;
  }

  listCells(): BiofilmCell[] {
    return Array.from(this.cells.values());
  }

  getState(): BiofilmState {
    return {
      cells: this.listCells(),
      quorumThreshold: this.quorumThreshold,
      lastSyncAt: Date.now(),
      rotationsDetected: 0,
    };
  }

  setQuorumThreshold(n: number): void {
    this.quorumThreshold = n;
  }

  recordObservation(dataPoint: string, cellId: string): void {
    if (!this.observations.has(dataPoint)) this.observations.set(dataPoint, new Set());
    this.observations.get(dataPoint)!.add(cellId);
  }

  isQuorumConfirmed(dataPoint: string): boolean {
    return (this.observations.get(dataPoint)?.size || 0) >= this.quorumThreshold;
  }

  clearObservations(): void {
    this.observations.clear();
  }

  async terminate(): Promise<void> {
    for (const cell of this.cells.values()) {
      try {
        await this.transport.send('Target.closeTarget', { targetId: String(cell.tabId) });
      } catch {}
    }
    this.cells.clear();
  }
}