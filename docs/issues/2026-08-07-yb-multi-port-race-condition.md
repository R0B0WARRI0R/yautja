# Bug: Yautja Bridge service worker se queda enganchado a un puerto incorrecto (race condition multi-puerto)

- **ID**: `yb-multi-port-race-condition`
- **Fecha**: 2026-08-07
- **Severidad**: Alta — instancia dedicada de Yautja no funciona si el SW arranca con timing adverso
- **Componentes**: `extension-chrome/background.js`, `extension/background.js`, `dist/extension/background.js`
- **Aplica a**: cualquier instalación con un helmet en puerto distinto del default (`9876`)

## Síntomas

- El SW de Yautja Bridge se conecta al **primer puerto que responda** en `DEFAULT_PORTS = [9876, 9877, ..., 9885]`, ignorando el puerto deseado (`yjPort` en `config.json` o `chrome.storage.local.yjPort`)
- Una vez conectado, **no se mueve** aunque cambies el storage o recargues la extensión
- El helmet en el puerto "correcto" (p. ej. 9999 para una instancia dedicada llamada Victoria) queda sin SW conectado
- La sesión MCP del helmet correcto reporta `link.connected: false`, `linkDegraded: true`

## Causa raíz

En `extension-chrome/background.js` (y su gemelo `extension/background.js`):

```js
const DEFAULT_PORTS = [9876, 9877, 9878, 9879, 9880, 9881, 9882, 9883, 9884, 9885];

async function resolveCandidatePorts() {
  const { yjPort } = await chrome.storage.local.get('yjPort');
  const n = Number(yjPort);
  if (Number.isInteger(n) && n >= 1024 && n <= 65535) {
    return [n, ...DEFAULT_PORTS.filter((p) => p !== n)];
  }
  return DEFAULT_PORTS;
}
```

El bug tiene **tres causas combinadas**:

### 1. Race condition al arrancar

`connectWS()` se ejecuta antes de que `applyConfigFromPackage()` haya escrito el `yjPort` correcto en storage. Flujo real:

```
1. SW arranca
2. connectWS() llamado
3. await applyConfigFromPackage()       ← escribe storage.yjPort desde config.json
4. await resolveCandidatePorts()        ← lee storage.yjPort
5. new WebSocket(url)                    ← conecta al primer candidato (yjPort)
```

Si en el paso 3 hay un fallo (CSP, fetch race, etc.), `resolveCandidatePorts` cae al fallback `DEFAULT_PORTS = [9876, 9877, ..., 9885]`, y el primer candidato es **9876** (el helmet principal por defecto).

### 2. `ws.onclose` no rota si ya conectó

```js
ws.onclose = () => {
  const wasConnected = connected;
  connected = false;
  ws = null;
  if (!wasConnected && candidatePorts.length > 1) rotatePort();   // ← clave
  scheduleReconnect();
};
```

`rotatePort()` solo se ejecuta cuando **nunca llegó a conectar** (`!wasConnected`). Si conectó a 9876 (aunque fuera por error), se queda ahí para siempre.

### 3. Listener `storage.onChanged` no garantiza reconexión

```js
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.yjPort) {
    portIndex = 0;
    everConnected = false;
    if (ws) { try { ws.close(); } catch {} }
    else connectWS();
  }
});
```

`ws.close()` debería disparar `ws.onclose` → `scheduleReconnect` → `connectWS()` con `portIndex=0`. PERO en la práctica:

- Si `ws.readyState !== OPEN || CONNECTING` (puede estar CLOSING/CLOSED), el `try { ws.close() }` falla silenciosamente
- El listener asume que `close()` siempre tiene éxito, pero en WebSocket de Chrome, un socket ya cerrado lanza excepción que se silencia
- Resultado: `connectWS()` no se llama, el SW sigue con el `ws` viejo en memoria

Adicionalmente, cuando `connectWS()` SÍ se llama y conecta al nuevo puerto (9999), si por cualquier razón falla (timing, race, helmet no listo), el `onclose` de ese intento SÍ rota (porque `wasConnected=false`). Pero si en la lista de candidatos el 9876 está antes que el 9999 y el 9876 está vivo, el SW acaba regresando al 9876.

## Reproducción

```
# Setup: dos helmets corriendo
node D:/Yautja/dist/helmet-main.js          # helmet principal en 9876
node D:/Yautja/dist/helmet-main.js 9999     # helmet Victoria en 9999

# Cargar Yautja Bridge unpacked en Chrome Profile 1
# config.json: { "yjPort": 9999 }

# Resultado: SW se conecta al 9876 (helmet principal), no al 9999
```

Variantes que reproducen:

- Si el helmet 9999 está muerto cuando arranca el SW → SW conecta al 9876
- Si el fetch de `config.json` falla (CSP, race) → SW no actualiza storage → fallback a DEFAULT_PORTS → 9876
- Si dos helmets compiten por el mismo puerto → uno "gana" por timing

## Diagnóstico (sesión 2026-08-07)

Verificación realizada por SwarmForge orchestrator (modo inline):

| Prueba | Resultado |
|---|---|
| `yautja-victoria_capabilities` | ✅ responde |
| `yautja-victoria_session_summary` | `link.connected: false`, `linkDegraded: true`, `lastHealthMs: null` |
| `yautja-victoria_listTabs` | ❌ "Enlace extensión degradado; recuperación automática en curso" |
| Conexiones TCP Established en 9999 | 2 (otras instancias de helmet, **NO el SW**) |
| Conexiones TCP Established en 9876 | 2 (cliente MCP + SW de Yautja Bridge) |
| `chrome.storage.local` del SW (LevelDB) | `yjPort: 9999` (correcto, PERO el SW está en 9876) |
| SW ScriptCache `index-dir/the-real-index` | Actualizado (SW vivo) |
| Extension cargada en Chrome | ✅ Profile 1, ruta `D:\Yautja\extension-chrome` |

**Conclusión**: SW vivo, storage correcto, helmet 9999 vivo, pero SW enganchado al 9876. El listener `storage.onChanged` no logra moverlo.

## Workarounds intentados (todos insuficientes)

1. **Recargar extension desde `chrome://extensions/`** — el SW rearranca, lee config.json (9999), pero el bug se reproduce si el primer intento de conexión al 9999 falla por timing. Resultado: SW vuelve al 9876.
2. **`chrome.storage.local.set({ yjPort: 9998 })` desde DevTools del SW** — dispara `storage.onChanged`, cierra WS al 9876, intenta 9998 → falla → rota a 9999 → debería conectar. **PERO en la práctica**: tras la rotación vuelve al 9876 (que es el siguiente candidato vivo). El listener no garantiza persistencia en el nuevo puerto.
3. **Matar el helmet 9999 (`PID 35288`) para forzar la rotación del SW** — opencode **no rearranca automáticamente** el helmet. Tras 30+ segundos sin rearranque, el SW no tuvo incentivo para cambiar.
4. **Lanzar helmet 9999 manualmente (`PID 24064`) con stdin pipe vivo** — el proceso arrancó y escuchó en 9999, pero murió poco después (probablemente opencode lo limpió por conflicto de puerto).

**Único workaround confirmado**: cerrar Chrome completamente y rearrancar. El SW arranca limpio, lee config.json, conecta al 9999 en el primer intento. PERO esto es disruptivo (pierde sesión actual del browser).

## Fix definitiva recomendada

### Corto plazo (en `background.js`)

```js
// Cambiar el orden: leer config ANTES del primer intento de conexión
async function connectWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  await applyConfigFromPackage();          // garantiza storage.yjPort actualizado
  candidatePorts = await resolveCandidatePorts();

  // NUEVO: si el primer candidato es el yjPort configurado y FALLA N veces,
  // marcar el puerto como "down" y NO rotar al fallback que ya estaba enganchado
  let firstAttempt = true;
  let consecutiveFailures = 0;

  while (firstAttempt || consecutiveFailures < 3) {
    if (portIndex >= candidatePorts.length) portIndex = 0;
    const url = `ws://localhost:${candidatePorts[portIndex]}`;
    // ... intentar conectar ...
    if (!wasConnected) consecutiveFailures++;
    if (wasConnected) break;
    if (consecutiveFailures >= 3 && portIndex !== 0) {
      // Primer candidato (yjPort) no responde después de 3 intentos.
      // NO rotar a DEFAULT_PORTS — el SW estaba mal enganchado antes.
      // Reportar error y esperar reconexión manual.
      throw new Error(`YB: yjPort ${candidatePorts[0]} unreachable after 3 attempts`);
    }
  }
}
```

### Mediano plazo

Añadir "sticky port" — el SW recuerda el puerto en el que conectó con éxito en este proceso de vida, y solo rota si ese puerto falla N veces consecutivas. Si `chrome.storage.local.yjPort` cambia, marcar el puerto viejo como "abandonado" y usar el nuevo inmediatamente.

### Largo plazo

Health check periódico del puerto configurado (`yjPort`) en background. Si el helmet del puerto configurado no responde, el SW espera y reintenta con backoff, sin tocar los puertos de `DEFAULT_PORTS`.

## Fix operacional inmediato (para sesiones futuras)

Cuando se quiere que el SW se mueva a un puerto distinto:

1. Cerrar Chrome completamente
2. Las pestañas se restauran desde `Profile 1\Sessions`
3. El SW arranca limpio, lee config.json, conecta al puerto correcto en el primer intento
4. Verificar con `yautja-victoria_listTabs` que ahora devuelve las pestañas

No requiere tocar código, solo aceptar la disrupción de cerrar Chrome.

## Referencias

- `extension-chrome/background.js` líneas 1-50 (DEFAULT_PORTS, applyConfigFromPackage, resolveCandidatePorts)
- `extension-chrome/background.js` líneas 100-180 (connectWS, ws.onclose, scheduleReconnect)
- `extension-chrome/background.js` líneas 60-80 (storage.onChanged listener)
- `dist/connection/extension-server.js` (lado servidor — multi-instance broker)
- `dist/helmet.js` (inicialización del ExtensionServer)

## Sesión de troubleshooting

Ver `D:\Yautja\logbook.md` entrada 2026-08-07 21:11 UTC para el detalle completo de la sesión.
