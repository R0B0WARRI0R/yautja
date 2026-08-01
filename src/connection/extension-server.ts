import { WebSocketServer, WebSocket } from 'ws';
import { RollingBuffer } from '../memory/rolling-buffer.js';
import type { BrokerClient } from './broker-client.js';

/**
 * Timeouts por clase de comando:
 * - heavy: comandos que esperan al renderer (Page.navigate, Runtime.evaluate
 *   con awaitPromise = evaluateAsync) — 60s.
 * - default: el resto — 30s.
 * - health: sonda de liveness — 5s (debe responder al instante).
 */
const COMMAND_TIMEOUT_MS = {
  heavy: 60_000,
  default: 30_000,
  health: 5_000,
} as const;

/** Timeouts consecutivos que declaran el enlace degradado. */
const DEGRADED_THRESHOLD = 3;

/**
 * Enlace extensión↔helmet degradado: N timeouts consecutivos indican handlers
 * colgados en el service worker (renderer saturado). Mientras dura, los
 * comandos de navegador fallan rápido con este error en vez de esperar 30s.
 */
export class ExtensionLinkDegradedError extends Error {
  readonly code = 'EXTENSION_LINK_DEGRADED' as const;
  constructor() {
    super('Enlace extensión degradado; recuperación automática en curso — reintenta en unos segundos');
    this.name = 'ExtensionLinkDegradedError';
  }
}

/**
 * Multi-instancia (Tanda A): este helmet es CLIENT y perdió al broker (o
 * nunca llegó a registrarse). Los comandos de navegador fallan rápido con
 * este error tipado, sin tumbar el helmet, mientras el bucle de reelección
 * (Tanda C) busca otro broker o promueve este helmet.
 */
export class BrokerDisconnectedError extends Error {
  readonly code = 'BROKER_DISCONNECTED' as const;
  constructor() {
    super('broker disconnected — browser tools no disponibles en esta instancia; la extensión la controla el helmet broker (puerto base). La reelección automática (Tanda C) reintentará el registro o promoverá este helmet a broker.');
    this.name = 'BrokerDisconnectedError';
  }
}

/**
 * Namespaces por sesión (Tanda B): un CLIENT intentó operar sobre una tab (o
 * grupo) que pertenece al grupo de sesión de OTRA sesión (otro cliente o la
 * broker-session). El broker deniega el comando con este error tipado, que
 * viaja al cliente como `errorType` en el `clientResult`.
 */
export class TabOwnedByOtherSessionError extends Error {
  readonly code = 'TAB_OWNED_BY_OTHER_SESSION' as const;
  constructor(target: string, owner: string) {
    super(`${target} pertenece a otra sesión (${owner}); usa tu propio grupo o pide handoff`);
    this.name = 'TabOwnedByOtherSessionError';
  }
}

// ─── Session lifecycle types (heartbeat + TTL) ───────────────────────

/** Una entrada de grupo de sesión con heartbeat para detección de zombis. */
export interface SessionGroupEntry {
  sessionId: string;
  groupId: number;
  lastHeartbeat: number;
}

/** Resumen de una sesión del broker para la tool `sessionList`. */
export interface SessionOverview {
  sessionId: string;
  isBroker: boolean;
  isAlive: boolean;
  groupIds: number[];
  tabCount: number;
  lastSeen: number | null;
}

/** TTL por defecto: 2 min sin heartbeat = sesión zombie. */
const DEFAULT_GROUP_TTL_MS = 120_000;
/** Intervalo del barrido de grupos muertos. */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
/** TTL por defecto para el watchdog de silencio MCP (5 min). */
const DEFAULT_MCP_SILENCE_TTL_MS = 300_000;
/** Intervalo del watchdog de silencio MCP. */
const DEFAULT_MCP_WATCHDOG_INTERVAL_MS = 30_000;

export interface ExtensionTab {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
  index: number;
  windowId: number;
  /** chrome.tabs groupId (-1 = sin grupo). Presente desde que el SW lo expone. */
  groupId?: number;
}

export interface ExtensionEvent {
  tabId: number;
  method: string;
  params: any;
  /** Present only for events originating from an extension service-worker target. */
  targetId?: string;
}

type EventHandler = (event: ExtensionEvent) => void;
type StatusHandler = (status: ExtensionStatus) => void;

interface ExtensionStatus {
  connected: boolean;
  extensionVersion?: string;
}

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  tabId: number | null;
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
  private extensionId: string | null = null;
  private enabledDomains: Set<string> = new Set();
  private eventBuffer: RollingBuffer<ExtensionEvent>;
  private networkCaptureCallback?: (msg: any) => void;
  private gqlCaptureCallback?: (msg: any) => void;
  // ─── Watchdog de enlace (timeouts consecutivos = handlers colgados) ──
  private consecutiveTimeouts = 0;
  private linkDegraded = false;
  private lastHealthMs: number | null = null;
  /** Último comando idempotente que expiró (solo para el log de recuperación). */
  private lastFailedRetryable: string | null = null;
  // ─── Multi-instancia (Tanda A): broker "winner takes <puerto base>" ──
  /** Sockets de helmets CLIENT registrados (solo los usa el BROKER). */
  private clientSockets: Map<string, WebSocket> = new Map();
  /** Enlace al broker (solo en modo CLIENT; null en broker/standalone). */
  private brokerClient: BrokerClient | null = null;
  /** sessionId propio que el BROKER expone a sus clientes en `registered`. */
  private brokerSessionId = 'broker';
  // ─── Namespaces por sesión (Tanda B; solo los usa el BROKER) ──────
  /** Grupo de tabs → entrada con sessionId + heartbeat (broker-session o client). */
  private sessionGroups: Map<number, SessionGroupEntry> = new Map();
  /** Tab → groupId (sincronizado con listTabs; -1/sin grupo = ausencia). */
  private tabToGroup: Map<number, number> = new Map();
  /** Pares sesión:tab-de-usuario ya auditados (evita spam en stderr). */
  private userTabAudited: Set<string> = new Set();
  // ─── Heartbeat + TTL (zombie detection) ────────────────────────
  /** Timer del barrido periódico de grupos sin heartbeat. */
  private groupSweepTimer: ReturnType<typeof setInterval> | null = null;
  /** TTL configurable (para tests). */
  private readonly groupTtlMs: number;
  /** Intervalo configurable (para tests). */
  private readonly sweepIntervalMs: number;
  // ─── MCP silence watchdog ──────────────────────────────────────
  /** Última vez que se recibió un comando MCP (cualquier tool call). */
  private mcpLastActivity = Date.now();
  /** Timer del watchdog de silencio MCP. */
  private mcpWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  /** TTL del silencio MCP configurable (para tests). */
  private readonly mcpSilenceTtlMs: number;
  /** Si el watchdog ya liberó los grupos (evita repeticiones). */
  private mcpWatchdogFired = false;

  constructor(port = 9876, maxBufferedEvents = 500, opts?: {
    groupTtlMs?: number;
    sweepIntervalMs?: number;
    mcpSilenceTtlMs?: number;
  }) {
    this.port = port;
    this.eventBuffer = new RollingBuffer(maxBufferedEvents);
    this.groupTtlMs = opts?.groupTtlMs ?? DEFAULT_GROUP_TTL_MS;
    this.sweepIntervalMs = opts?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.mcpSilenceTtlMs = opts?.mcpSilenceTtlMs ?? DEFAULT_MCP_SILENCE_TTL_MS;
  }

  async start(): Promise<void> {
    // Asignación dinámica de puerto: si el resuelto (CLI > env > 9876) está
    // ocupado (otra instancia de Kimi/helmet viva), se prueba el siguiente
    // hasta 10 candidatos. La extensión rota por la misma ventana
    // (DEFAULT_PORTS en background.js), así que ambos lados se encuentran
    // sin configuración manual.
    const MAX_ATTEMPTS = 10;
    const basePort = this.port;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const candidate = basePort + attempt;
      try {
        await this.tryListen(candidate);
        if (attempt > 0) {
          this.port = candidate;
          process.stderr.write(`[Yautja] Port ${basePort} busy — using ${candidate} instead (auto)\n`);
        }
        return;
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'EADDRINUSE') throw err;
      }
    }
    throw new Error(`ExtensionServer: no free port in range ${basePort}..${basePort + MAX_ATTEMPTS - 1}: ${lastErr}`);
  }

  private tryListen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let wss: WebSocketServer;
      try {
        wss = new WebSocketServer({ port });
      } catch (err) {
        reject(new Error(`ExtensionServer: failed to bind port ${port}: ${err}`));
        return;
      }

      const onError = (err: NodeJS.ErrnoException) => {
        wss.close(() => reject(err));
      };
      wss.on('error', onError);

      wss.on('listening', () => {
        wss.off('error', onError);
        this.wss = wss;
        this.wss.on('connection', (socket) => this.handleNewConnection(socket));
        this.wss.on('error', (err) => {
          process.stderr.write(`[Yautja] ExtensionServer error post-listen: ${err.message}\n`);
        });
        resolve();
      });
    });
  }

  /**
   * Protocolo broker↔cliente (Tanda A multi-instancia), en el MISMO puerto
   * que la extensión. El primer mensaje decide el slot:
   * - `{type:'hello', ...}` (o cualquier otro) → slot de extensión (clásico).
   * - `{type:'register', role:'client', sessionId, groupId?}` → slot de
   *   cliente broker; se responde `{type:'registered', brokerSessionId}`.
   *   El `groupId` opcional (Tanda C) repuebla sessionGroups del broker en un
   *   re-registro tras reelección.
   * - `{type:'brokerInfo'}` → sonda de discovery (Tanda C): todo helmet es
   *   broker-capable y responde siempre `{type:'brokerInfo', accepts:true,
   *   sessionId, hasExtension}` y cierra; no ocupa ningún slot.
   * Cliente→broker: `{type:'clientCommand', sessionId, id, payload}` — el
   * broker ejecuta `payload` contra la extensión (mismo pipeline sendCommand)
   * y responde `{type:'clientResult', id, ok, result|error}`; sin extensión,
   * `ok:false` con 'broker: extension not connected'. Las violaciones de
   * namespace (Tanda B) responden `ok:false` con `errorType` tipado.
   * Broker→clientes: `{type:'clientEvent', payload}` — eventos CDP de la
   * extensión enrutados por namespace (Tanda B): cada evento solo va al
   * cliente dueño del grupo de la tab origen; eventos sin tab o de tabs sin
   * grupo quedan en la broker-session.
   * Heartbeat: `{type:'ping'}` del cliente → `{type:'pong'}` del broker.
   */
  private handleNewConnection(socket: WebSocket): void {
    const slotFree = !(this.socket && this.socket.readyState === WebSocket.OPEN);
    if (slotFree) {
      // Asignación optimista del slot de extensión (compat: el socket queda
      // usable para comandos desde la conexión TCP, sin esperar al hello).
      this.socket = socket;
    }
    const onFirstMessage = (data: WebSocket.RawData) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        socket.close(4001, 'Invalid first message');
        return;
      }
      socket.off('message', onFirstMessage);
      if (msg?.type === 'brokerInfo') {
        // Sonda de discovery (Tanda C): responde siempre y libera el slot de
        // extensión si la sonda lo ocupó optimistamente al conectar.
        const hasExtension = this.connected
          && this.socket !== null
          && this.socket !== socket
          && this.socket.readyState === WebSocket.OPEN;
        if (this.socket === socket) this.socket = null;
        try {
          socket.send(JSON.stringify({
            type: 'brokerInfo',
            accepts: true,
            sessionId: this.brokerSessionId,
            hasExtension,
          }));
        } catch {}
        socket.close();
        return;
      }
      if (msg?.type === 'register' && msg.role === 'client' && typeof msg.sessionId === 'string' && msg.sessionId) {
        // Cliente broker: no ocupa el slot de la extensión.
        if (this.socket === socket) this.socket = null;
        this.acceptClient(socket, msg.sessionId, typeof msg.groupId === 'number' ? msg.groupId : undefined);
        return;
      }
      if (!slotFree) {
        socket.close(4000, 'Another extension already connected');
        return;
      }
      this.setupSocket(socket);
      this.handleExtensionMessage(msg);
    };
    socket.on('message', onFirstMessage);
    socket.on('close', () => {
      // Si murió sin identificarse y ocupaba el slot optimista, liberarlo.
      if (this.socket === socket) {
        this.socket = null;
        this.connected = false;
      }
    });
    socket.on('error', () => {
      // close handler will fire
    });
  }

  private acceptClient(socket: WebSocket, sessionId: string, groupId?: number): void {
    const prev = this.clientSockets.get(sessionId);
    if (prev && prev !== socket && prev.readyState === WebSocket.OPEN) {
      prev.close(4002, 'session re-registered');
    }
    this.clientSockets.set(sessionId, socket);
    // Re-registro tras reelección (Tanda C): el cliente trae su grupo de
    // sesión actual → repoblar sessionGroups de este (nuevo) broker.
    if (typeof groupId === 'number' && groupId >= 0) {
      this.sessionGroups.set(groupId, {
        sessionId,
        groupId,
        lastHeartbeat: Date.now(),
      });
    }
    socket.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.handleClientMessage(socket, msg);
    });
    socket.on('close', () => {
      if (this.clientSockets.get(sessionId) === socket) {
        this.clientSockets.delete(sessionId);
        this.forgetSessionGroups(sessionId);
      }
    });
    socket.on('error', () => {
      // close handler will fire
    });
    socket.send(JSON.stringify({ type: 'registered', brokerSessionId: this.brokerSessionId }));
  }

  private handleClientMessage(socket: WebSocket, msg: any): void {
    switch (msg?.type) {
      case 'ping':
        // Refrescar heartbeat si el cliente incluye su sessionId.
        if (typeof msg.sessionId === 'string' && msg.sessionId) {
          this.recordHeartbeat(msg.sessionId);
        }
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'pong' }));
        }
        break;
      case 'clientCommand':
        this.executeClientCommand(socket, msg);
        break;
    }
  }

  private executeClientCommand(socket: WebSocket, msg: any): void {
    const reply = (ok: boolean, result?: any, error?: string, errorType?: string) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(ok
        ? { type: 'clientResult', id: msg.id, ok, result }
        : { type: 'clientResult', id: msg.id, ok, error, ...(errorType ? { errorType } : {}) }));
    };
    if (!this.isExtensionConnected()) {
      reply(false, undefined, 'broker: extension not connected');
      return;
    }
    const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
    // Política de tabs (Tanda B): namespaces por sesión.
    const violation = this.checkClientTabPolicy(sessionId, msg.payload);
    if (violation) {
      reply(false, undefined, violation.message, violation.code);
      return;
    }
    this.sendCommand(msg.payload)
      .then((result) => {
        this.trackClientCommand(sessionId, msg.payload, result);
        reply(true, result);
      })
      .catch((err) => reply(false, undefined, err instanceof Error ? err.message : String(err)));
  }

  /**
   * Política de namespaces (Tanda B): una sesión solo opera sobre tabs de su
   * propio grupo. Tabs del grupo de OTRA sesión (otro cliente o la
   * broker-session) → TabOwnedByOtherSessionError. Tabs sin grupo (del
   * usuario) → PERMITIDO en v1, pero auditado en stderr (una vez por
   * sesión+tab); la política dura para user-tabs queda para una iteración
   * futura.
   */
  private checkClientTabPolicy(sessionId: string | null, payload: any): TabOwnedByOtherSessionError | null {
    if (!payload || typeof payload !== 'object') return null;
    // openTab con groupId ajeno → denegar (sin groupId es tab suelta: permitir).
    if (payload.type === 'openTab' && typeof payload.groupId === 'number' && payload.groupId >= 0) {
      const entry = this.sessionGroups.get(payload.groupId);
      if (entry !== undefined && entry.sessionId !== sessionId) {
        return new TabOwnedByOtherSessionError(`group ${payload.groupId}`, entry.sessionId);
      }
    }
    const tabId = typeof payload.tabId === 'number' ? payload.tabId : null;
    if (tabId === null) return null;
    const groupId = this.tabToGroup.get(tabId);
    if (groupId === undefined) {
      const key = `${sessionId ?? '?'}:${tabId}`;
      if (!this.userTabAudited.has(key)) {
        this.userTabAudited.add(key);
        process.stderr.write(`[broker] session ${sessionId ?? '?'} tocó tab de usuario ${tabId} (${String(payload.type)})\n`);
      }
      return null;
    }
    const entry = this.sessionGroups.get(groupId);
    if (entry !== undefined && entry.sessionId !== sessionId) {
      return new TabOwnedByOtherSessionError(`tab ${tabId}`, entry.sessionId);
    }
    return null;
  }

  /**
   * Registro de grupos por sesión (Tanda B): tras un clientCommand OK,
   * `sessionGroupCreate` registra el groupId para ese sessionId; `openTab`
   * dentro de un grupo registra la tab; `listTabs` resincroniza tabToGroup.
   */
  private trackClientCommand(sessionId: string | null, payload: any, result: any): void {
    if (Array.isArray(result?.tabs)) {
      this.syncTabGroups(result.tabs);
    }
    if (!sessionId || !payload || !result) return;
    // Refresh heartbeat: cualquier comando exitoso de una sesión actualiza
    // su último heartbeat en todos sus grupos.
    this.refreshSessionHeartbeat(sessionId);
    if (payload.type === 'sessionGroupCreate' && typeof result.groupId === 'number') {
      this.sessionGroups.set(result.groupId, {
        sessionId,
        groupId: result.groupId,
        lastHeartbeat: Date.now(),
      });
      if (typeof result.tabId === 'number') {
        this.tabToGroup.set(result.tabId, result.groupId);
      }
    }
    if (payload.type === 'openTab' && typeof payload.groupId === 'number' && payload.groupId >= 0 && typeof result.tabId === 'number') {
      this.tabToGroup.set(result.tabId, payload.groupId);
    }
  }

  /** Sincroniza tabToGroup con una respuesta listTabs (fuente de verdad). */
  private syncTabGroups(tabs: ExtensionTab[]): void {
    const seen = new Set<number>();
    for (const tab of tabs) {
      if (typeof tab?.tabId !== 'number') continue;
      seen.add(tab.tabId);
      if (typeof tab.groupId === 'number' && tab.groupId >= 0) {
        this.tabToGroup.set(tab.tabId, tab.groupId);
      } else {
        this.tabToGroup.delete(tab.tabId);
      }
    }
    // listTabs devuelve TODAS las tabs: las ausentes están cerradas.
    for (const tabId of Array.from(this.tabToGroup.keys())) {
      if (!seen.has(tabId)) this.tabToGroup.delete(tabId);
    }
  }

  /**
   * Heartbeat de grupo (Tanda B): al morir un cliente (socket cerrado) el
   * broker olvida sus registros de grupo — NO sus tabs reales. Sus tabs
   * vuelven a ser "de usuario" para la política: otra sesión puede operarlas.
   * Si la sesión se re-registró con otro socket, esto no se ejecuta (guard
   * en el close handler).
   */
  private forgetSessionGroups(sessionId: string): void {
    const ownedGroups = new Set<number>();
    for (const [groupId, entry] of this.sessionGroups) {
      if (entry.sessionId === sessionId) ownedGroups.add(groupId);
    }
    if (ownedGroups.size === 0) return;
    for (const groupId of ownedGroups) this.sessionGroups.delete(groupId);
    for (const [tabId, groupId] of Array.from(this.tabToGroup)) {
      if (ownedGroups.has(groupId)) this.tabToGroup.delete(tabId);
    }
  }

  // ─── Heartbeat + TTL: zombie detection API ────────────────────────

  /** Refresca el heartbeat de todos los grupos de una sesión. */
  refreshSessionHeartbeat(sessionId: string): void {
    const now = Date.now();
    for (const [, entry] of this.sessionGroups) {
      if (entry.sessionId === sessionId) {
        entry.lastHeartbeat = now;
      }
    }
  }

  /** Recibe un heartbeat de un cliente (ping/pong con sessionId). */
  recordHeartbeat(sessionId: string): void {
    this.refreshSessionHeartbeat(sessionId);
  }

  /** Inicia el barrido periódico de grupos sin heartbeat. */
  startGroupSweep(): void {
    if (this.groupSweepTimer) return;
    this.groupSweepTimer = setInterval(
      () => this.sweepDeadGroups(),
      this.sweepIntervalMs,
    );
    this.groupSweepTimer.unref?.();
  }

  /** Barrido: elimina grupos cuyo heartbeat expiró. Devuelve cuántos limpió. */
  sweepDeadGroups(): number {
    const now = Date.now();
    const dead: number[] = [];
    for (const [groupId, entry] of this.sessionGroups) {
      if (now - entry.lastHeartbeat > this.groupTtlMs) {
        dead.push(groupId);
      }
    }
    for (const groupId of dead) {
      const entry = this.sessionGroups.get(groupId)!;
      this.sessionGroups.delete(groupId);
      for (const [tabId, gid] of this.tabToGroup) {
        if (gid === groupId) this.tabToGroup.delete(tabId);
      }
      process.stderr.write(
        `[broker] group ${groupId} expired (session ${entry.sessionId} silent >${this.groupTtlMs / 1000}s)\n`,
      );
    }
    return dead.length;
  }

  // ─── MCP silence watchdog ──────────────────────────────────────────

  /** Marca actividad MCP (llamar en cada tool call). */
  markMcpActivity(): void {
    this.mcpLastActivity = Date.now();
    this.mcpWatchdogFired = false;
  }

  /** Inicia el watchdog de silencio MCP. */
  startMcpWatchdog(): void {
    if (this.mcpWatchdogTimer) return;
    this.mcpLastActivity = Date.now();
    this.mcpWatchdogTimer = setInterval(
      () => this.checkMcpSilence(),
      DEFAULT_MCP_WATCHDOG_INTERVAL_MS,
    );
    this.mcpWatchdogTimer.unref?.();
  }

  /** Si el MCP lleva demasiado silencioso, libera los grupos del broker-session. */
  private checkMcpSilence(): void {
    if (this.mcpWatchdogFired) return;
    if (Date.now() - this.mcpLastActivity > this.mcpSilenceTtlMs) {
      process.stderr.write(
        `[broker] MCP silence >${this.mcpSilenceTtlMs / 1000}s — releasing broker-session groups\n`,
      );
      this.forgetSessionGroups(this.brokerSessionId);
      this.mcpWatchdogFired = true;
    }
  }

  // ─── Session management API (sessionList + sessionDestroy) ─────────

  /** Lista todas las sesiones conocidas (vivas, zombis, broker). */
  getSessionOverview(): SessionOverview[] {
    const result: SessionOverview[] = [];
    const seen = new Set<string>();

    // Broker session
    const brokerGroups = [...this.sessionGroups]
      .filter(([, e]) => e.sessionId === this.brokerSessionId)
      .map(([gid]) => gid);
    const brokerAlive = this.socket !== null && this.socket.readyState === WebSocket.OPEN;
    result.push({
      sessionId: this.brokerSessionId,
      isBroker: true,
      isAlive: brokerAlive,
      groupIds: brokerGroups,
      tabCount: brokerGroups.reduce((n, gid) =>
        n + [...this.tabToGroup.values()].filter(v => v === gid).length, 0),
      lastSeen: brokerAlive ? Date.now() : null,
    });
    seen.add(this.brokerSessionId);

    // Client sessions
    for (const [sessionId, socket] of this.clientSockets) {
      const alive = socket.readyState === WebSocket.OPEN;
      const groups = [...this.sessionGroups]
        .filter(([, e]) => e.sessionId === sessionId)
        .map(([gid]) => gid);
      result.push({
        sessionId,
        isBroker: false,
        isAlive: alive,
        groupIds: groups,
        tabCount: groups.reduce((n, gid) =>
          n + [...this.tabToGroup.values()].filter(v => v === gid).length, 0),
        lastSeen: alive ? Date.now() : null,
      });
      seen.add(sessionId);
    }

    // Dead sessions (en sessionGroups pero sin socket)
    for (const [, entry] of this.sessionGroups) {
      if (!seen.has(entry.sessionId)) {
        const groups = [...this.sessionGroups]
          .filter(([, e]) => e.sessionId === entry.sessionId)
          .map(([gid]) => gid);
        result.push({
          sessionId: entry.sessionId,
          isBroker: false,
          isAlive: false,
          groupIds: groups,
          tabCount: 0,
          lastSeen: entry.lastHeartbeat || null,
        });
        seen.add(entry.sessionId);
      }
    }

    return result;
  }

  /** Fuerza el cleanup de una sesión: libera grupos + cierra socket. */
  forceForgetSession(sessionId: string): boolean {
    const before = this.sessionGroups.size;
    this.forgetSessionGroups(sessionId);
    const socket = this.clientSockets.get(sessionId);
    if (socket) {
      try { socket.close(4003, 'session destroyed by admin'); } catch {}
      this.clientSockets.delete(sessionId);
    }
    const after = this.sessionGroups.size;
    return after < before;
  }

  /**
   * Enrutado de eventos por namespace (Tanda B, fin del broadcast
   * indiscriminado): cada evento CDP va SOLO al cliente dueño del grupo de
   * la tab origen. Eventos sin tabId, de tabs sin grupo o de tabs del grupo
   * de la broker-session NO se reenvían: los procesa localmente la
   * broker-session (comportamiento por defecto de siempre).
   */
  private routeEventToClients(msg: any): void {
    if (this.clientSockets.size === 0) return;
    const tabId = typeof msg.tabId === 'number' ? msg.tabId : null;
    if (tabId === null) return;
    const groupId = this.tabToGroup.get(tabId);
    if (groupId === undefined) return;
    const owner = this.sessionGroups.get(groupId);
    if (owner === undefined || owner.sessionId === this.brokerSessionId) return;
    const client = this.clientSockets.get(owner.sessionId);
    if (client && client.readyState === WebSocket.OPEN) {
      try {
        client.send(JSON.stringify({ type: 'clientEvent', payload: msg }));
      } catch {}
    }
  }

  // ─── Multi-instancia: lado CLIENT ─────────────────────────────────

  /** Registra el enlace al broker (modo CLIENT). Pasar null en standalone. */
  setBrokerClient(client: BrokerClient | null): void {
    this.brokerClient = client;
    if (client) {
      client.onStatusChange((registered) => {
        this.notifyStatus(registered ? { connected: true } : { connected: false });
      });
    }
  }

  /** sessionId que este helmet (BROKER) expone a sus clientes. */
  setBrokerSessionId(sessionId: string): void {
    this.brokerSessionId = sessionId;
  }

  /** Devuelve el brokerSessionId (para cleanup desde helmet.ts). */
  getBrokerSessionId(): string {
    return this.brokerSessionId;
  }

  /** Evento reenviado por el broker: se inyecta en el pipeline local de eventos. */
  dispatchBrokerEvent(payload: any): void {
    this.handleExtensionMessage(payload);
  }

  async stop(): Promise<void> {
    // Reject all pending commands
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('ExtensionServer: shutting down'));
    }
    this.pending.clear();

    // Los clientes broker registrados reciben el cierre y pasan a degradado.
    for (const [, client] of this.clientSockets) {
      try {
        client.close();
      } catch {}
    }
    this.clientSockets.clear();

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
    this.sessionGroups.clear();
    this.tabToGroup.clear();
    this.userTabAudited.clear();
    // Limpiar timers de heartbeat/TTL y watchdog MCP.
    if (this.groupSweepTimer) {
      clearInterval(this.groupSweepTimer);
      this.groupSweepTimer = null;
    }
    if (this.mcpWatchdogTimer) {
      clearInterval(this.mcpWatchdogTimer);
      this.mcpWatchdogTimer = null;
    }
  }

  isExtensionConnected(): boolean {
    if (this.connected && this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
      return true;
    }
    // Modo CLIENT registrado: la extensión es alcanzable a través del broker.
    return this.brokerClient?.isRegistered() ?? false;
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
    const tabs: ExtensionTab[] = result.tabs || [];
    // Solo el BROKER mantiene el registro (ejecución local contra la extensión);
    // en modo CLIENT la respuesta viene del broker, que ya sincronizó el suyo.
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.syncTabGroups(tabs);
    }
    return tabs;
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

  async openTab(url: string, groupId?: number): Promise<{ tabId: number; url: string }> {
    const result = await this.sendCommand({ type: 'openTab', url, groupId });
    if (this.socket && this.socket.readyState === WebSocket.OPEN && typeof groupId === 'number' && groupId >= 0) {
      this.tabToGroup.set(result.tabId, groupId);
    }
    return { tabId: result.tabId, url: result.url || url };
  }

  /** Crea el grupo de pestañas de sesión (sandbox estilo "MCP tab group"). */
  async sessionGroupCreate(title = 'Yautja', color = 'purple'): Promise<{ groupId: number; tabId: number }> {
    const result = await this.sendCommand({ type: 'sessionGroupCreate', title, color });
    // Ejecución local (broker/standalone): registrar el grupo para la
    // broker-session. En modo CLIENT lo registra el broker vía trackClientCommand.
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.sessionGroups.set(result.groupId, {
        sessionId: this.brokerSessionId,
        groupId: result.groupId,
        lastHeartbeat: Date.now(),
      });
      if (typeof result.tabId === 'number') {
        this.tabToGroup.set(result.tabId, result.groupId);
      }
    }
    return { groupId: result.groupId, tabId: result.tabId };
  }

  /**
   * Lee una clave de chrome.storage.local de la extensión (kill switches).
   * Devuelve undefined si la clave no existe.
   */
  async storageGet(key: string): Promise<any> {
    const result = await this.sendCommand({ type: 'storageGet', key });
    return result?.value;
  }

  /** Id de la extensión Yautja Bridge (del hello); null hasta conectar. */
  getExtensionId(): string | null {
    return this.extensionId;
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

  // ─── Extension target commands ──────────────────────────────────

  async listAllTargets(): Promise<CdpTarget[]> {
    const result = await this.sendCommand({ type: 'listAllTargets' });
    return result.targets || [];
  }

  async attachTarget(targetId: string): Promise<void> {
    await this.sendCommand({ type: 'attachTarget', targetId });
  }

  async detachTarget(targetId: string): Promise<void> {
    await this.sendCommand({ type: 'detachTarget', targetId });
  }

  async sendToTarget(targetId: string, method: string, params?: Record<string, any>): Promise<any> {
    if (!this.isExtensionConnected()) {
      throw new Error(`ExtensionServer: cannot send to target — extension not connected`);
    }
    const result = await this.sendCommand({
      type: 'commandTarget',
      targetId,
      method,
      params: params ?? {},
    });
    return result;
  }

  // ─── Management API (chrome.management) ───────────────────────

  async managementGetAll(): Promise<any[]> {
    const result = await this.sendCommand({ type: 'managementGetAll' });
    return result.extensions || [];
  }

  async managementSetEnabled(extId: string, enabled: boolean): Promise<void> {
    await this.sendCommand({ type: 'managementSetEnabled', extId, enabled });
  }

  // ─── webRequest API (extension network capture) ───────────────

  async webRequestStart(extId: string): Promise<void> {
    await this.sendCommand({ type: 'webRequestStart', extId });
  }

  async webRequestStop(extId: string): Promise<void> {
    await this.sendCommand({ type: 'webRequestStop', extId });
  }

  async webRequestList(extId: string): Promise<{ requests: any[]; count: number; totalEventsSeen: number; wrAllEvents: number }> {
    const result = await this.sendCommand({ type: 'webRequestList', extId });
    return { requests: result.requests || [], count: result.count || 0, totalEventsSeen: result.totalEventsSeen || 0, wrAllEvents: result.wrAllEvents || 0 };
  }

  // ─── CDP-level commands (same as CDPSessionManager) ──────────────

  async proxyStart(port: number): Promise<any> {
    return await this.sendCommand({ type: 'proxyStart', port });
  }

  async proxyStop(): Promise<any> {
    return await this.sendCommand({ type: 'proxyStop' });
  }

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
      // Rechazar pendientes: con el socket cerrado ya no llegarán respuestas.
      // Si el cierre lo provocó el watchdog, el error tipado permite fallar rápido.
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(this.linkDegraded
          ? new ExtensionLinkDegradedError()
          : new Error('ExtensionServer: connection closed'));
      }
      this.pending.clear();
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
        this.consecutiveTimeouts = 0;
        if (typeof msg.id === 'string' && msg.id) this.extensionId = msg.id;
        this.notifyStatus({ connected: true, extensionVersion: msg.version });
        if (this.linkDegraded) {
          // El WS puede reconectar sobre un service worker aún colgado:
          // solo un health OK levanta la degradación.
          this.probeLinkRecovery();
        }
        break;

      case 'ping':
        // Keepalive ping from extension — reply with pong to generate bidirectional activity
        if (this.socket) {
          this.socket.send(JSON.stringify({ type: 'pong' }));
        }
        break;

      case 'pong':
        break;

      case 'result':
      case 'error': {
        const pending = id ? this.pending.get(id) : undefined;
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          // Cualquier respuesta (OK o error) demuestra que el SW responde.
          this.consecutiveTimeouts = 0;
          if (type === 'result') {
            pending.resolve(msg.result);
          } else {
            pending.reject(new Error(msg.error || 'Unknown extension error'));
          }
        }
        break;
      }

      case 'tabs': {
        if (Array.isArray(msg.tabs)) {
          this.syncTabGroups(msg.tabs);
        }
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

        // Also forward target-based events (extension service workers)
        if (msg.targetId) {
          const targetEvent = { ...event, targetId: msg.targetId };
          for (const handler of this.eventHandlers) {
            try {
              handler(targetEvent as ExtensionEvent);
            } catch {}
          }
        }

        // Multi-instancia (Tanda B): enrutar el evento solo al dueño del grupo.
        this.routeEventToClients(msg);
        break;
      }

      case 'targetAttached':
      case 'targetDetached':
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

  /** Public alias for sendCommand — used by tm* tools for direct extension-to-extension messaging */
  async sendRaw(msg: any, timeoutMs?: number): Promise<any> {
    return this.sendCommand(msg, timeoutMs);
  }

  /** Estado del enlace extensión↔helmet (para session_summary y diagnóstico). */
  getLinkState(): { connected: boolean; consecutiveTimeouts: number; linkDegraded: boolean; lastHealthMs: number | null } {
    return {
      connected: this.isExtensionConnected(),
      consecutiveTimeouts: this.consecutiveTimeouts,
      linkDegraded: this.linkDegraded,
      lastHealthMs: this.lastHealthMs,
    };
  }

  private sendCommand(msg: any, timeoutMs?: number): Promise<any> {
    // Cualquier comando (local o reenviado) cuenta como actividad MCP.
    this.markMcpActivity();
    // Routing transparente (Tanda A): sin extensión local, un CLIENT registrado
    // reenvía el comando al broker (+5s de margen sobre su propio timeout).
    if ((!this.socket || this.socket.readyState !== WebSocket.OPEN) && this.brokerClient) {
      if (!this.brokerClient.isRegistered()) {
        return Promise.reject(new BrokerDisconnectedError());
      }
      return this.brokerClient.sendToBroker(msg, timeoutMs ?? this.timeoutFor(msg) + 5_000);
    }
    return new Promise((resolve, reject) => {
      // Enlace degradado: fallar rápido (la sonda health sí pasa).
      if (this.linkDegraded && msg.type !== 'health') {
        reject(new ExtensionLinkDegradedError());
        return;
      }
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('ExtensionServer: extension not connected'));
        return;
      }

      const id = this.nextId++;
      const fullMsg = { id, ...msg };
      const timeout = timeoutMs ?? this.timeoutFor(msg);
      const startedAt = Date.now();

      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.consecutiveTimeouts++;
        const label = msg.method ? `${msg.type}:${msg.method}` : String(msg.type);
        process.stderr.write(
          `[Yautja] extension command timeout (${label}) after ${Date.now() - startedAt}ms — consecutiveTimeouts=${this.consecutiveTimeouts}\n`,
        );
        this.rememberRetryable(msg);
        if (this.consecutiveTimeouts >= DEGRADED_THRESHOLD) {
          this.declareLinkDegraded();
        }
        reject(new Error(`ExtensionServer: command timed out after ${timeout}ms`));
      }, timeout);

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

  /** Timeout por clase de comando (ver COMMAND_TIMEOUT_MS). */
  private timeoutFor(msg: any): number {
    if (msg.type === 'health') return COMMAND_TIMEOUT_MS.health;
    if (msg.type === 'command' || msg.type === 'commandTarget') {
      const method: string = msg.method ?? '';
      if (method === 'Page.navigate') return COMMAND_TIMEOUT_MS.heavy;
      if (method === 'Runtime.evaluate' && msg.params?.awaitPromise === true) return COMMAND_TIMEOUT_MS.heavy;
    }
    return COMMAND_TIMEOUT_MS.default;
  }

  /**
   * Tipos de comando idempotentes (solo lectura). navigate NO lo es (efectos
   * externos); los `command`/`commandTarget` CDP tampoco en general. Tras una
   * recuperación no se re-despacha nada automáticamente (el caller ya recibió
   * su rechazo) — solo se registra para el log de diagnóstico.
   */
  private static readonly RETRYABLE_TYPES = new Set([
    'listTabs', 'listAllTargets', 'managementGetAll', 'storageGet',
    'getCapturedGql', 'webRequestList', 'health', 'ping',
  ]);

  private rememberRetryable(msg: any): void {
    this.lastFailedRetryable = ExtensionServer.RETRYABLE_TYPES.has(msg.type) ? String(msg.type) : null;
  }

  /** Declara el enlace degradado y cierra el socket: la extensión reconecta sola. */
  private declareLinkDegraded(): void {
    if (this.linkDegraded) return;
    this.linkDegraded = true;
    process.stderr.write(
      `[Yautja] extension link DEGRADED (${this.consecutiveTimeouts} consecutive timeouts) — closing socket; extension will auto-reconnect\n`,
    );
    try { this.socket?.close(); } catch {}
  }

  /** Tras reconexión, un health decide si se levanta la degradación. */
  private probeLinkRecovery(): void {
    this.sendCommand({ type: 'health' })
      .then((health) => {
        this.linkDegraded = false;
        this.consecutiveTimeouts = 0;
        this.lastHealthMs = Date.now();
        const retry = this.lastFailedRetryable ? ` — last retryable command lost: ${this.lastFailedRetryable}` : '';
        process.stderr.write(
          `[Yautja] extension link recovered (health ok, pendingHandlers=${health?.pendingHandlers ?? '?'})${retry}\n`,
        );
        this.lastFailedRetryable = null;
      })
      .catch(() => {
        // SW todavía colgado: seguimos degradados; los próximos timeouts
        // (health a 5s) volverán a cerrar el socket hasta que Chrome lo mate.
        process.stderr.write('[Yautja] extension link still degraded after reconnect (health failed)\n');
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
