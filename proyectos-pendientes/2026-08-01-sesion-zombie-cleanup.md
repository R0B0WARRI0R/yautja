# Sesiones zombi: root cause y 3 soluciones de fondo

> Fecha: 2026-08-01 · Tras debug en vivo de un `TabOwnedByOtherSessionError` fantasma

## Root cause (confirmado con código)

El broker process **sobrevive entre sesiones MCP** (lo arranca el daemon o no hizo shutdown limpio). Su `Map<groupId, sessionId>` en memoria (`sessionGroups` en `extension-server.ts:140`) retiene el ownership de tab groups creados por sesiones muertas.

El flujo del bug:

```
Sesión 1 (sess_01KYYE2P...) arranca → bindea 9876 → es BROKER
  → sessionGroupCreate() → Chrome crea tab group 1153749117
  → sessionGroups.set(1153749117, 'sess_01KYYE2P...')   ← queda en RAM

Sesión 1 termina (MCP host se cierra)
  → stdin.close → helmet.stop() → process.exit
  → PERO el broker sobrevive (daemon, o shutdown colgado en proxy/MV3)

Sesión 2 (sess_01KYZ22H...) arranca
  → 9876 ocupado → bindea 9877 → es CLIENT del broker viejo
  → listTabs() → syncTabGroups() → tabToGroup[tab] = 1153749117
  → switchTab(1903245744)
  → checkClientTabPolicy(): groupId=1153749117, owner='sess_01KYYE2P...'
  → owner !== 'sess_01KYZ22H...' → 💥 TabOwnedByOtherSessionError
```

El problema está en `extension-server.ts`, método `forgetSessionGroups()` (línea 430):

```typescript
// Solo se llama desde el 'close' handler de un CLIENT socket (acceptClient).
// La BROKER-SESSION no tiene client socket → NUNCA se limpia.
private forgetSessionGroups(sessionId: string): void { ... }
```

Y en `checkClientTabPolicy()` (línea 340): no hay TTL ni validación de liveness — si el `sessionId` está en el Map, se asume vivo.

---

## Solución 1: Heartbeat + TTL en sessionGroups

**Archivo:** `src/connection/extension-server.ts`

**Concepto:** Cada entrada en `sessionGroups` lleva un timestamp de último heartbeat. Un timer barre el Map cada 60s y elimina entradas sin heartbeat en >120s. El heartbeat viene del `ping`/`pong` que ya existe en el protocolo broker↔cliente (15s).

### Cambios concretos

```typescript
// extension-server.ts — nuevos campos en ExtensionServer

interface SessionGroupEntry {
  sessionId: string;
  groupId: number;
  lastHeartbeat: number;  // Date.now()
}

// Reemplazar el Map plano por:
private sessionGroups: Map<number, SessionGroupEntry> = new Map();

// TTL configuration
private static readonly GROUP_TTL_MS = 120_000;        // 2 min sin heartbeat = muerto
private static readonly GROUP_SWEEP_INTERVAL_MS = 60_000; // barrido cada 1 min
private groupSweepTimer: ReturnType<typeof setInterval> | null = null;

// Iniciar el timer en start():
startSweep() {
  this.groupSweepTimer = setInterval(
    () => this.sweepDeadGroups(),
    ExtensionServer.GROUP_SWEEP_INTERVAL_MS,
  );
  this.groupSweepTimer.unref?.();
}

// Barrido:
private sweepDeadGroups() {
  const now = Date.now();
  const dead: number[] = [];
  for (const [groupId, entry] of this.sessionGroups) {
    if (now - entry.lastHeartbeat > ExtensionServer.GROUP_TTL_MS) {
      dead.push(groupId);
    }
  }
  for (const groupId of dead) {
    const entry = this.sessionGroups.get(groupId)!;
    this.sessionGroups.delete(groupId);
    // Limpiar tabToGroup del grupo muerto
    for (const [tabId, gid] of this.tabToGroup) {
      if (gid === groupId) this.tabToGroup.delete(tabId);
    }
    process.stderr.write(
      `[broker] group ${groupId} expired (session ${entry.sessionId} silent >${ExtensionServer.GROUP_TTL_MS / 1000}s)\n`,
    );
  }
}

// Actualizar heartbeat en cada pong del cliente:
// En handleMessage, case 'pong':
case 'pong': {
  // Refresh heartbeat for the client's session
  // (Requires knowing which session sent the pong — add sessionId to ping/pong)
  break;
}

// Para la BROKER-SESSION: heartbeat automático en cada operación local
// En trackClientCommand, cuando sessionId === this.brokerSessionId:
// refresh lastHeartbeat para todos sus grupos
```

**Dónde tocar:**
- `extension-server.ts`: cambiar `sessionGroups` de `Map<number, string>` a `Map<number, SessionGroupEntry>`, añadir timer, añadir `sweepDeadGroups()`.
- `broker-client.ts`: añadir `sessionId` al payload del `ping` para que el broker sepa quién late.
- `tests/connection/extension-server.test.ts`: test de expiración (crear grupo, simular timeout, verificar cleanup).

**Prós:** Detecta zombis automáticamente sin intervención. Funciona para broker-session y clients.
**Contras:** Requiere cambiar el protocolo ping/pong (breaking change para clientes viejos — añadir campo opcional, no romper).

---

## Solución 2: sessionList + sessionDestroy (MCP tools)

**Archivos:** `src/helmet.ts` (registro de tools), `src/connection/extension-server.ts` (implementación)

**Concepto:** Dos nuevas MCP tools que dan visibilidad y control sobre sesiones del broker.

### Tool 1: `sessionList`

```typescript
// ExtensionServer: nuevo método público
getSessionOverview(): Array<{
  sessionId: string;
  isBroker: boolean;
  isAlive: boolean;       // socket abierto
  groupIds: number[];
  tabCount: number;
  lastSeen: number | null;
}> {
  const result: any[] = [];
  // Broker session
  const brokerGroups = [...this.sessionGroups]
    .filter(([, sid]) => sid === this.brokerSessionId)
    .map(([gid]) => gid);
  result.push({
    sessionId: this.brokerSessionId,
    isBroker: true,
    isAlive: true,
    groupIds: brokerGroups,
    tabCount: brokerGroups.reduce((n, gid) =>
      n + [...this.tabToGroup.values()].filter(v => v === gid).length, 0),
    lastSeen: Date.now(),
  });
  // Client sessions
  for (const [sessionId, socket] of this.clientSockets) {
    const alive = socket.readyState === WebSocket.OPEN;
    const groups = [...this.sessionGroups]
      .filter(([, sid]) => sid === sessionId)
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
  }
  // Dead sessions (en sessionGroups pero sin socket)
  const liveSessions = new Set([this.brokerSessionId, ...this.clientSockets.keys()]);
  for (const [, sid] of this.sessionGroups) {
    if (!liveSessions.has(sid) && !result.some(r => r.sessionId === sid)) {
      result.push({
        sessionId: sid,
        isBroker: false,
        isAlive: false,
        groupIds: [...this.sessionGroups].filter(([, s]) => s === sid).map(([g]) => g),
        tabCount: 0,
        lastSeen: null,
      });
    }
  }
  return result;
}
```

### Tool 2: `sessionDestroy`

```typescript
// ExtensionServer: forzar cleanup de una sesión
forceForgetSession(sessionId: string): boolean {
  const before = this.sessionGroups.size;
  this.forgetSessionGroups(sessionId);
  // También cerrar su socket si sigue vivo
  const socket = this.clientSockets.get(sessionId);
  if (socket) {
    try { socket.close(4003, 'session destroyed by admin'); } catch {}
    this.clientSockets.delete(sessionId);
  }
  return this.sessionGroups.size < before;
}
```

### Registro en helmet.ts

```typescript
// En el array MCP_TOOLS, añadir:
{
  name: 'sessionList',
  description: 'List all broker sessions (alive, zombie, broker) with their tab groups.',
  inputSchema: { type: 'object', properties: {} },
},
{
  name: 'sessionDestroy',
  description: 'Force-destroy a session: release its tab groups and close its socket.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session ID to destroy' },
    },
    required: ['sessionId'],
  },
},
```

**Prós:** Debugging inmediato desde cualquier agente. Permite recuperación manual sin reiniciar nada.
**Contras:** `sessionDestroy` es un botón rojo — necesita gate P2 mínimo. Pero es la única salida cuando ya hay un zombi.

---

## Solución 3: Cleanup proactivo al detectar MCP disconnect en el broker

**Archivos:** `src/helmet.ts` (serveMCP), `src/connection/extension-server.ts`

**Concepto:** Cuando el MCP host se desconecta (stdin cierra), el broker-session hace cleanup explícito de SUS PROPIOS grupos antes de morir. Hoy el `rl.on('close')` llama `this.stop()` que mata procesos pero no limpia `sessionGroups` con un `forgetSessionGroups(brokerSessionId)`.

### Cambio concreto

```typescript
// helmet.ts, en serveMCP():
rl.on('close', () => {
  const force = setTimeout(() => process.exit(0), 3000);
  force.unref();

  // NUEVO: cleanup explícito de la broker-session antes de morir.
  // Si este helmet es BROKER, liberar sus propios tab groups para que
  // la próxima sesión no los encuentre secuestrados.
  const brokerSessionId = this.server.getBrokerSessionId?.();
  if (brokerSessionId) {
    this.server.forceForgetSession?.(brokerSessionId);
  }

  this.stop()
    .catch(() => {})
    .finally(() => process.exit(0));
});
```

Y para el caso en que el broker **no muere** (daemon lo mantiene vivo), añadir un watchdog de MCP:

```typescript
// extension-server.ts — detectar que el MCP host se fue pero el proceso vive
private static readonly MCP_SILENCE_TTL_MS = 60_000; // 1 min sin comando MCP
private mcpLastActivity = Date.now();
private mcpWatchdog: ReturnType<typeof setInterval> | null = null;

// En sendCommand(), refresh timestamp:
// this.mcpLastActivity = Date.now();   ← ya que todo comando pasa por aquí

// Watchdog:
startMcpWatchdog() {
  this.mcpWatchdog = setInterval(() => {
    if (Date.now() - this.mcpLastActivity > ExtensionServer.MCP_SILENCE_TTL_MS) {
      // El MCP host se fue pero el broker vive (daemon).
      // Liberar la broker-session: sus tabs vuelven a ser "de usuario".
      process.stderr.write(
        `[broker] MCP silence >${ExtensionServer.MCP_SILENCE_TTL_MS / 1000}s — releasing broker-session groups\n`,
      );
      this.forgetSessionGroups(this.brokerSessionId);
      this.mcpLastActivity = Date.now(); // reset para no repetir
    }
  }, 30_000);
  this.mcpWatchdog.unref?.();
}
```

**Prós:** Previene el problema en la fuente. No requiere tools nuevas ni cambios de protocolo.
**Contras:** El watchdog de silencio puede dispararse en operaciones largas (scrapeo de 2+ min). Mitigación: subir el TTL a 5 min, o resetear el timestamp en cualquier comando del broker-session.

---

## Recomendación

| Solución | Esfuerzo | Impacto | Cuándo |
|----------|----------|---------|--------|
| **3 — Cleanup en disconnect** | 30 min | Previene el 80% de los casos | Ya — quick win |
| **2 — sessionList + sessionDestroy** | 1h | Recovery manual inmediato | Esta semana |
| **1 — Heartbeat + TTL** | 3h | Elimina el problema para siempre | Próxima fase |

**Orden recomendado:** 3 → 2 → 1. La 3 corta el problema en la fuente hoy. La 2 da una palanca de recuperación. La 1 es la solución arquitectónica definitiva.
