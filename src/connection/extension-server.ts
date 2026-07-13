import { WebSocketServer, WebSocket } from 'ws';
import { RollingBuffer } from '../memory/rolling-buffer.js';

export interface ExtensionTab {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
  index: number;
  windowId: number;
}

export interface ExtensionEvent {
  tabId: number;
  method: string;
  params: any;
}

type EventHandler = (event: ExtensionEvent) => void;
type StatusHandler = (status: ExtensionStatus) => void;

interface ExtensionStatus {
  connected: boolean;
  extensionVersion?: string;
}

interface PendingCommand {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ExtensionServer {
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private port: number;
  private nextId = 1;
  private pending: Map<number, PendingCommand> = new Map();
  private eventHandlers: Set<EventHandler> = new Set();
  private statusHandlers: Set<StatusHandler> = new Set();
  private connected = false;
  private currentTabId: number | null = null;
  private enabledDomains: Set<string> = new Set();
  private eventBuffer: RollingBuffer<ExtensionEvent>;
  private networkCaptureCallback?: (msg: any) => void;
  private gqlCaptureCallback?: (msg: any) => void;

  constructor(port = 9876, maxBufferedEvents = 500) {
    this.port = port;
    this.eventBuffer = new RollingBuffer(maxBufferedEvents);
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({ port: this.port });
      } catch (err) {
        reject(new Error(`ExtensionServer: failed to bind port ${this.port}: ${err}`));
        return;
      }

      this.wss.on('connection', (socket) => {
        // Only allow one extension connection at a time
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
          socket.close(4000, 'Another extension already connected');
          return;
        }
        this.socket = socket;
        this.setupSocket(socket);
      });

      this.wss.on('error', (err) => {
        if (!this.connected) {
          reject(new Error(`ExtensionServer: server error: ${err.message}`));
        }
      });

      this.wss.on('listening', () => {
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // Reject all pending commands
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('ExtensionServer: shutting down'));
    }
    this.pending.clear();

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
      this.wss = null;
    }
    this.connected = false;
    this.currentTabId = null;
    this.enabledDomains.clear();
  }

  isExtensionConnected(): boolean {
    return this.connected && this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  getPort(): number {
    return this.port;
  }

  // ─── Event subscription ──────────────────────────────────────────

  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  // Transport-compatible: subscribe to a specific CDP event by method name.
  // Matches CDPSessionManager.on(event, handler) interface.
  on(event: string, handler: (params: any) => void): () => void {
    const filtered: EventHandler = (e) => {
      if (e.method === event) {
        handler(e.params);
      }
    };
    this.eventHandlers.add(filtered);
    return () => this.eventHandlers.delete(filtered);
  }

  onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  getBufferedEvents(): ExtensionEvent[] {
    return this.eventBuffer.toArray();
  }

  // ─── Commands to extension ───────────────────────────────────────

  async listTabs(): Promise<ExtensionTab[]> {
    const result = await this.sendCommand({ type: 'listTabs' });
    return result.tabs || [];
  }

  async attachTab(tabId: number): Promise<void> {
    await this.sendCommand({ type: 'attach', tabId });
    this.currentTabId = tabId;
  }

  async detachTab(tabId: number): Promise<void> {
    await this.sendCommand({ type: 'detach', tabId });
    if (this.currentTabId === tabId) {
      this.currentTabId = null;
    }
  }

  async closeTab(tabId: number): Promise<void> {
    await this.sendCommand({ type: 'closeTab', tabId });
    if (this.currentTabId === tabId) {
      this.currentTabId = null;
    }
  }

  async getCapturedGql(tabId?: number, limit = 100): Promise<any> {
    return await this.sendCommand({ type: 'getCapturedGql', tabId, limit });
  }

  async clearCapturedGql(tabId?: number): Promise<void> {
    await this.sendCommand({ type: 'clearCapturedGql', tabId });
  }

  async detachAll(): Promise<void> {
    await this.sendCommand({ type: 'detachAll' });
    this.currentTabId = null;
    this.enabledDomains.clear();
  }

  async switchToTab(tabId: number): Promise<void> {
    await this.sendCommand({ type: 'switchToTab', tabId });
  }

  // ─── CDP-level commands (same as CDPSessionManager) ──────────────

  async send(method: string, params?: Record<string, any>): Promise<any> {
    if (!this.isExtensionConnected()) {
      throw new Error(`ExtensionServer: cannot send '${method}' — extension not connected`);
    }
    if (this.currentTabId === null) {
      throw new Error(`ExtensionServer: cannot send '${method}' — no tab attached`);
    }
    const result = await this.sendCommand({
      type: 'command',
      tabId: this.currentTabId,
      method,
      params: params ?? {},
    });
    return result;
  }

  async enableDomains(domains: string[]): Promise<void> {
    for (const domain of domains) {
      if (this.enabledDomains.has(domain)) continue;
      await this.send(`${domain}.enable`);
      this.enabledDomains.add(domain);
    }
  }

  async disableDomains(domains: string[]): Promise<void> {
    for (const domain of domains) {
      if (!this.enabledDomains.has(domain)) continue;
      await this.send(`${domain}.disable`);
      this.enabledDomains.delete(domain);
    }
  }

  getCurrentTabId(): number | null {
    return this.currentTabId;
  }

  getEnabledDomains(): string[] {
    return Array.from(this.enabledDomains);
  }

  // ─── Internal ────────────────────────────────────────────────────

  private setupSocket(socket: WebSocket): void {
    socket.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (process.env.YAUTJA_DEBUG) {
        console.log(`  [WS<-] ${msg.type} ${msg.method || ''} ${msg.tabId != null ? 'tab=' + msg.tabId : ''}`);
      }
      this.handleExtensionMessage(msg);
    });

    socket.on('close', () => {
      this.connected = false;
      this.socket = null;
      this.currentTabId = null;
      this.notifyStatus({ connected: false });
    });

    socket.on('error', () => {
      // close handler will fire
    });
  }

  private handleExtensionMessage(msg: any): void {
    const { id, type } = msg;

    switch (type) {
      case 'yautja-network-capture':
        this.handleNetworkCapture(msg);
        return;
      case 'yautja-gql-capture':
        this.handleGqlCapture(msg);
        return;
      case 'hello':
        this.connected = true;
        this.notifyStatus({ connected: true, extensionVersion: msg.version });
        break;

      case 'pong':
        break;

      case 'result':
      case 'error': {
        const pending = id ? this.pending.get(id) : undefined;
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          if (type === 'result') {
            pending.resolve(msg.result);
          } else {
            pending.reject(new Error(msg.error || 'Unknown extension error'));
          }
        }
        break;
      }

      case 'tabs': {
        const pending = id ? this.pending.get(id) : undefined;
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.resolve(msg);
        }
        break;
      }

      case 'event': {
        const event: ExtensionEvent = {
          tabId: msg.tabId,
          method: msg.method,
          params: msg.params,
        };
        this.eventBuffer.push(event);
        for (const handler of this.eventHandlers) {
          try {
            handler(event);
          } catch {}
        }
        break;
      }

      case 'attached':
      case 'detached':
      case 'tabClosed':
        // Lifecycle notifications — could notify status handlers
        break;

      case 'info':
        // Informational message from extension
        break;
    }
  }

  private sendCommand(msg: any, timeoutMs = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('ExtensionServer: extension not connected'));
        return;
      }

      const id = this.nextId++;
      const fullMsg = { id, ...msg };

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ExtensionServer: command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.socket.send(JSON.stringify(fullMsg));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`ExtensionServer: failed to send: ${err}`));
      }
    });
  }

  private notifyStatus(status: ExtensionStatus): void {
    for (const handler of this.statusHandlers) {
      try {
        handler(status);
      } catch {}
    }
  }

  setNetworkCaptureCallback(cb: (msg: any) => void): void {
    this.networkCaptureCallback = cb;
  }

  setGqlCaptureCallback(cb: (msg: any) => void): void {
    this.gqlCaptureCallback = cb;
  }

  private handleNetworkCapture(msg: any): void {
    if (this.networkCaptureCallback) {
      try { this.networkCaptureCallback(msg); } catch {}
    }
  }

  private handleGqlCapture(msg: any): void {
    if (this.gqlCaptureCallback) {
      try { this.gqlCaptureCallback(msg); } catch {}
    }
  }
}
