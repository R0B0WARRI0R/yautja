import WebSocket from 'ws';
import { BrokerDisconnectedError, TabOwnedByOtherSessionError } from './extension-server.js';
import { OperationError } from './operation-scope.js';

/**
 * BrokerClient — lado CLIENT del protocolo broker↔cliente (Tanda A
 * multi-instancia, "winner takes <puerto base>").
 *
 * Topología: la extensión solo mantiene UN websocket — con el helmet BROKER
 * (el que bindeó el puerto base, 9876 por defecto). Los demás helmets
 * (CLIENT, puertos base+1…) se registran en el broker y enrutan sus comandos
 * a través de él. Mensajes (mismo puerto que la extensión):
 *
 *   CLIENT → broker : `{type:'register', role:'client', sessionId, groupId?}`
 *                     (groupId — Tanda C: opcional, grupo de sesión actual del
 *                     cliente; el broker lo usa para repoblar sessionGroups
 *                     tras una reelección)
 *   broker → CLIENT : `{type:'registered', brokerSessionId}`
 *   CLIENT → broker : `{type:'clientCommand', sessionId, id, payload}`
 *   broker → CLIENT : `{type:'clientResult', id, ok, result|error, errorType?}`
 *   broker → CLIENTs: `{type:'clientEvent', payload}` (eventos CDP enrutados
 *                     por namespace — Tanda B: solo al dueño del grupo)
 *   CLIENT → broker : `{type:'ping'}` cada 15s → `{type:'pong'}`
 *
 * Sin broker vivo en el puerto base, start() resuelve false y el helmet
 * queda en modo standalone (comportamiento clásico). Si el broker se pierde
 * a mitad de sesión, el helmet pasa a modo degradado: los comandos de
 * navegador fallan rápido con BrokerDisconnectedError hasta que el bucle de
 * reelección (Tanda C, BrokerReelection) lo re-registre con otro broker o
 * promueva al helmet a broker.
 */

/** Heartbeat cliente→broker. */
const HEARTBEAT_INTERVAL_MS = 15_000;
/**
 * Timeout de comando reenviado: 35s por defecto para dar margen al timeout
 * de 30s del broker (ExtensionServer ya aplica su propio timeout por clase).
 */
const DEFAULT_COMMAND_TIMEOUT_MS = 35_000;

interface PendingBrokerCommand {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type BrokerStatusHandler = (registered: boolean) => void;
type BrokerEventHandler = (payload: any) => void;

export class BrokerClient {
  private ws: WebSocket | null = null;
  private registered = false;
  private bridgeState: { connected: boolean; generation: string; extensionVersion?: string | null; browserInstanceId?: string | null; linkDegraded?: boolean; consecutiveTimeouts?: number; lastHealthMs?: number | null } | null = null;
  private brokerSessionId: string | null = null;
  private nextId = 1;
  private pending: Map<number, PendingBrokerCommand> = new Map();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private statusHandlers: Set<BrokerStatusHandler> = new Set();
  private eventHandlers: Set<BrokerEventHandler> = new Set();
  /** Grupo de sesión propio (Tanda C): se incluye en el `register`. */
  private groupId: number | null = null;

  constructor(
    private readonly port: number,
    private readonly sessionId: string,
    private readonly connectTimeoutMs = 2_000,
    private readonly bridgeToken?: string,
  ) {}

  isRegistered(): boolean {
    return this.registered && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
  getBridgeState() { return this.bridgeState; }

  /** sessionId del broker (del `registered`); null hasta registrarse. */
  getBrokerSessionId(): string | null {
    return this.brokerSessionId;
  }

  /**
   * Grupo de sesión propio (Tanda C): si se fija ANTES de start(), viaja en
   * el `register` y el broker repuebla sus sessionGroups con él (re-registro
   * tras reelección).
   */
  setGroupId(groupId: number | null): void {
    this.groupId = groupId;
  }

  onStatusChange(handler: BrokerStatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  /** Eventos CDP reenviados por el broker (payload = mensaje de la extensión). */
  onEvent(handler: BrokerEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /**
   * Conecta con el broker y se registra. Resuelve true si el registro
   * completó; false si no hay broker vivo (el caller queda en standalone).
   */
  async start(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!ok) this.closeSocket();
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), this.connectTimeoutMs);

      let ws: WebSocket;
      try {
        ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      } catch {
        finish(false);
        return;
      }
      this.ws = ws;

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'register',
          role: 'client',
          sessionId: this.sessionId,
          ...(this.groupId !== null ? { groupId: this.groupId } : {}),
          ...(this.bridgeToken ? { bridgeToken: this.bridgeToken } : {}),
        }));
      });
      ws.on('message', (data) => {
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        this.handleMessage(msg);
        if (msg?.type === 'registered') finish(true);
      });
      ws.on('error', () => finish(false));
      ws.on('close', () => {
        this.handleClose();
        finish(false);
      });
    });
  }

  /** Envía un comando al broker y espera su `clientResult`. */
  sendToBroker(payload: any, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, signal?: AbortSignal): Promise<any> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      if (!this.isRegistered()) {
        reject(new BrokerDisconnectedError());
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        try { this.ws?.send(JSON.stringify({ type: 'clientCancel', id })); } catch {}
        const label = payload?.method ? `${payload.type}:${payload.method}` : String(payload?.type);
        process.stderr.write(`[Yautja] broker command timeout (${label}) after ${timeoutMs}ms\n`);
        reject(new OperationError('OPERATION_TIMEOUT', `BrokerClient: command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const onAbort = () => {
        clearTimeout(timer); this.pending.delete(id); cleanup();
        try { this.ws?.send(JSON.stringify({ type: 'clientCancel', id })); } catch {}
        reject(signal?.reason);
      };
      this.pending.set(id, { resolve: value => { cleanup(); resolve(value); }, reject: err => { cleanup(); reject(err); }, timer });
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        this.ws!.send(JSON.stringify({ type: 'clientCommand', sessionId: this.sessionId, id, payload, timeoutMs }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        cleanup();
        reject(new Error(`BrokerClient: failed to send: ${err}`));
      }
    });
  }

  async stop(): Promise<void> {
    this.stopHeartbeat();
    this.registered = false;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BrokerDisconnectedError());
    }
    this.pending.clear();
    this.closeSocket();
  }

  // ─── Internal ────────────────────────────────────────────────────

  private handleMessage(msg: any): void {
    switch (msg?.type) {
      case 'registered':
        this.registered = true;
        this.bridgeState = msg.bridgeState ?? null;
        this.brokerSessionId = typeof msg.brokerSessionId === 'string' ? msg.brokerSessionId : null;
        this.startHeartbeat();
        this.notifyStatus(true);
        break;

      case 'bridgeState':
        this.bridgeState = msg.state;
        this.notifyStatus(this.isRegistered());
        break;

      case 'clientResult': {
        const pending = this.pending.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(msg.id);
          if (msg.ok) {
            pending.resolve(msg.result);
          } else if (msg.errorType === 'TAB_OWNED_BY_OTHER_SESSION') {
            // Error tipado de namespace (Tanda B): se reconstruye la clase
            // conservando el mensaje exacto del broker.
            const typed = new TabOwnedByOtherSessionError('tab/grupo', 'otra sesión');
            if (msg.error) typed.message = String(msg.error);
            pending.reject(typed);
          } else {
            pending.reject(msg.errorType ? new OperationError(msg.errorType, msg.error || 'broker error') : new Error(msg.error || 'broker: unknown error'));
          }
        }
        break;
      }

      case 'clientEvent':
        for (const handler of this.eventHandlers) {
          try {
            handler(msg.payload);
          } catch {}
        }
        break;

      case 'pong':
        break;
    }
  }

  private handleClose(): void {
    const wasRegistered = this.registered;
    this.registered = false;
    if (this.bridgeState) this.bridgeState = { ...this.bridgeState, connected: false };
    this.stopHeartbeat();
    this.ws = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BrokerDisconnectedError());
    }
    this.pending.clear();
    if (wasRegistered) {
      process.stderr.write('[Yautja] broker connection lost — browser tools degraded (standalone)\n');
      this.notifyStatus(false);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          // Incluir sessionId en el ping para que el broker pueda refrescar
          // el heartbeat de los grupos de esta sesión.
          this.ws.send(JSON.stringify({ type: 'ping', sessionId: this.sessionId }));
        } catch {}
      }
    }, HEARTBEAT_INTERVAL_MS);
    // El heartbeat no debe mantener vivo el proceso por sí solo.
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private closeSocket(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
    }
  }

  private notifyStatus(registered: boolean): void {
    for (const handler of this.statusHandlers) {
      try {
        handler(registered);
      } catch {}
    }
  }
}
