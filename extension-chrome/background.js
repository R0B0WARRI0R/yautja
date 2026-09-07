// Yautja Bridge — Service Worker
// Relays CDP commands from Yautja (WebSocket) to chrome.debugger and back.
//
// Multi-puerto: varias instancias de Kimi/MCP pueden correr helmets en
// puertos distintos (resolvePort: arg CLI > YAUTJA_PORT > 9876). La extensión
// solo puede hablar con UN helmet a la vez. Orden de preferencia:
//   1. chrome.storage.local.yjPort con source=user (override estricto)
//   2. config.json con source=package (puerto base + ventana de respaldo)
//   3. DEFAULT_PORTS en orden (el primero que acepte conexión gana)
// Para apuntar la extensión a otro helmet:
//   chrome.storage.local.set({ yjPort: 9877 })  → reconecta sola.
// Ventana de puertos candidatos: debe cubrir la ventana de auto-incremento
// del helmet (base 9876 + hasta 9) — ver extension-server.ts.
const DEFAULT_PORTS = [9876, 9877, 9878, 9879, 9880, 9881, 9882, 9883, 9884, 9885];
const RECONNECT_DELAY = 2000;
const KEEPALIVE_ALARM = 'yautja-keepalive';
const DEBUGGER_VERSION = '1.3';

let candidatePorts = DEFAULT_PORTS;
let portIndex = 0;
let everConnected = false;
let connectInFlight = null;
let bridgeGeneration = null;
let browserInstanceId = crypto.randomUUID();
const commandControls = new Map();

// Check at every Chrome API boundary, including continuations after awaits.
function guardedApi(target, check) {
  return new Proxy(target, {
    get(object, key) {
      const value = object[key];
      if (typeof value === 'function') return (...args) => { check(); return value.apply(object, args); };
      return value && typeof value === 'object' ? guardedApi(value, check) : value;
    },
  });
}

function validPort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null;
}

function validBridgeToken(value) {
  return typeof value === 'string' && value.trim().length >= 32 ? value.trim() : null;
}

async function resolveCandidatePorts() {
  try {
    const { yjPort, yjPortSource } = await chrome.storage.local.get(['yjPort', 'yjPortSource']);
    const n = validPort(yjPort);
    if (n !== null) {
      // Un override manual es deliberadamente estricto para no saltar a otra
      // instancia. Un puerto procedente de config.json, en cambio, es el
      // puerto BASE de esa instancia: durante un reinicio solapado el nuevo
      // helmet puede ocupar temporalmente base+1, por lo que debe poder
      // recorrer su propia ventana y reconectar sin intervención manual.
      // Older installs can have yjPort without a source marker. Treat that
      // legacy state as the packaged base port; only an explicit user marker
      // is a strict single-port override.
      if (yjPortSource === 'user') return [n];
      return Array.from({ length: 10 }, (_, i) => n + i)
        .filter((port) => port <= 65535);
    }
  } catch {}
  return DEFAULT_PORTS;
}

// config.json supplies the initial port for an unpacked instance. A manual
// chrome.storage.local override wins afterwards, including across worker
// restarts. The explicit source marker keeps both cases distinguishable.
async function applyConfigFromPackage() {
  try {
    const stored = await chrome.storage.local.get([
      'yjPort', 'yjPortSource', 'yjBridgeToken', 'yjBridgeTokenSource',
    ]);
    const existing = validPort(stored.yjPort);
    const existingToken = validBridgeToken(stored.yjBridgeToken);
    const keepPort = existing !== null && stored.yjPortSource === 'user';
    const keepToken = existingToken !== null && stored.yjBridgeTokenSource !== 'package';

    const url = chrome.runtime.getURL('config.json');
    const resp = await fetch(url);
    if (!resp.ok) return;
    const cfg = await resp.json();
    const n = validPort(cfg.yjPort);
    const token = validBridgeToken(cfg.yjBridgeToken);
    const updates = {};
    if (n !== null && !keepPort && (existing !== n || stored.yjPortSource !== 'package')) {
      updates.yjPort = n;
      updates.yjPortSource = 'package';
    }
    if (token !== null && !keepToken && (existingToken !== token || stored.yjBridgeTokenSource !== 'package')) {
      updates.yjBridgeToken = token;
      updates.yjBridgeTokenSource = 'package';
    }
    if (Object.keys(updates).length > 0) await chrome.storage.local.set(updates);
  } catch {
    // config.json missing or invalid — fall back to default port rotation
  }
}

function rotatePort() {
  portIndex = (portIndex + 1) % candidatePorts.length;
}

// Si el usuario cambia yjPort en storage, reconectar al nuevo destino.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local' && (changes.yjPort || changes.yjBridgeToken)) {
    const updates = {};
    if (changes.yjPort && changes.yjPortSource?.newValue !== 'package') {
      updates.yjPortSource = 'user';
    }
    if (changes.yjBridgeToken && changes.yjBridgeTokenSource?.newValue !== 'package') {
      updates.yjBridgeTokenSource = 'user';
    }
    if (Object.keys(updates).length > 0) {
      try { await chrome.storage.local.set(updates); } catch {}
    }
    portIndex = 0;
    everConnected = false;
    if (ws) { try { ws.close(); } catch {} }
    // SIEMPRE llamar connectWS(), incluso si ws.close() falló (socket ya
    // cerrado lanza excepción que se silencia). Antes este else-if solo
    // llamaba connectWS() si ws era null, lo que dejaba el SW enganchado al
    // puerto viejo cuando ws estaba CLOSING/CLOSED.
    connectWS();
  }
});

// Ningún handler puede colgarse para siempre esperando a Chrome/CDP (renderer
// saturado): los awaits de APIs de Chrome van envueltos en withTimeout.
const HANDLER_TIMEOUT_MS = 20000;
// Page.navigate con espera de carga puede tardar más en SPAs pesadas; se le
// da más margen, pero por debajo del timeout heavy del helmet (60s) para que
// el error tipado llegue antes que el timeout propio del helmet.
const NAVIGATE_TIMEOUT_MS = 45000;

function withTimeout(promise, ms = HANDLER_TIMEOUT_MS, label = 'handler') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// Diagnóstico del service worker (comando health).
const swStartTime = Date.now();
let pendingHandlers = 0;

/** @type {WebSocket | null} */
let ws = null;
let connected = false;
let reconnectTimer = null;

// tabId -> Set of enabled CDP domains
const attachedTabs = new Map();

// targetId -> Set of enabled CDP domains (for extension service workers)
const attachedTargets = new Map();

// ─── webRequest capture (top-level, MV3-safe) ─────────────────────────────
const webRequestActive = new Set();   // extIds being monitored
const webRequestBuffers = new Map();  // extId -> { requests: [], totalSeen: 0 }
let _wrTotalEvents = 0;               // diagnostic: count ALL events seen by listener

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    _wrTotalEvents++;
    const init = (details.initiator || '').replace(/\/$/, '');
    const fromExt = init.startsWith('chrome-extension://') ? init.replace('chrome-extension://', '') : null;
    if (fromExt && webRequestActive.has(fromExt)) {
      const buf = webRequestBuffers.get(fromExt);
      if (buf) {
        buf.totalSeen++;
        buf.requests.push({
          id: details.requestId,
          url: details.url,
          method: details.method,
          type: details.type,
          timestamp: details.timeStamp,
          initiator: init,
        });
        if (buf.requests.length > 500) buf.requests.splice(0, buf.requests.length - 500);
      }
    }
  },
  { urls: ['<all_urls>'] },
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const init = (details.initiator || '').replace(/\/$/, '');
    const fromExt = init.startsWith('chrome-extension://') ? init.replace('chrome-extension://', '') : null;
    if (fromExt && webRequestBuffers.has(fromExt)) {
      const buf = webRequestBuffers.get(fromExt);
      const req = buf.requests.find((r) => r.id === details.requestId);
      if (req) { req.status = details.statusCode; req.fromCache = details.fromCache || false; }
    }
  },
  { urls: ['<all_urls>'] },
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    const init = (details.initiator || '').replace(/\/$/, '');
    const fromExt = init.startsWith('chrome-extension://') ? init.replace('chrome-extension://', '') : null;
    if (fromExt && webRequestBuffers.has(fromExt)) {
      const buf = webRequestBuffers.get(fromExt);
      const req = buf.requests.find((r) => r.id === details.requestId);
      if (req) { req.error = details.error; }
    }
  },
  { urls: ['<all_urls>'] },
);

// Pending command promises: id -> {resolve, reject, tabId}
const pending = new Map();
let nextId = 1;

// ─── WebSocket connection ─────────────────────────────────────────

function connectWS() {
  if (connectInFlight) return connectInFlight;
  connectInFlight = connectWSCore().finally(() => { connectInFlight = null; });
  return connectInFlight;
}

async function connectWSCore() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  await applyConfigFromPackage();
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  candidatePorts = await resolveCandidatePorts();
  if (portIndex >= candidatePorts.length) portIndex = 0;
  const port = candidatePorts[portIndex];
  const { yjBridgeToken } = await chrome.storage.local.get(['yjBridgeToken']);
  // Survives MV3 worker suspension, but never a browser restart (tab ids reuse).
  if (chrome.storage.session) {
    const stored = await chrome.storage.session.get('yjBrowserInstanceId');
    browserInstanceId = stored.yjBrowserInstanceId || browserInstanceId;
    if (!stored.yjBrowserInstanceId) await chrome.storage.session.set({ yjBrowserInstanceId: browserInstanceId });
  }
  const bridgeToken = validBridgeToken(yjBridgeToken);
  const url = `ws://127.0.0.1:${port}`;

  let socket;
  try {
    socket = new WebSocket(url);
    ws = socket;
  } catch {
    rotatePort();
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    if (ws !== socket) return;
    connected = true;
    everConnected = true;
    bridgeGeneration = null;
    sendToYautja({
      type: 'hello', extension: 'yautja-bridge', version: '0.2.0', protocolVersion: 2,
      browserInstanceId, id: chrome.runtime.id, port,
      ...(bridgeToken ? { bridgeToken } : {}),
    });
    // Re-attach to any tabs we were tracking before reconnect
    for (const tabId of attachedTabs.keys()) {
      sendToYautja({ type: 'info', message: `Tab ${tabId} was attached before reconnect` });
    }
  };

  socket.onmessage = (event) => {
    if (ws !== socket) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'helloAck') { bridgeGeneration = msg.generation; return; }
    if (msg.type === 'cancelCommand') {
      if (!msg.generation || msg.generation === bridgeGeneration) {
        const control = commandControls.get(msg.commandId);
        if (control) control.cancelled = true;
      }
      return;
    }
    // Contador de handlers en vuelo (lo expone health). Los handlers corren
    // concurrentes; si todos cuelgan contra el renderer, health sigue
    // respondiendo y delata el wedge.
    pendingHandlers++;
    Promise.resolve(handleCommand(msg))
      .catch(() => {})
      .finally(() => { pendingHandlers--; commandControls.delete(msg.id); });
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    const wasConnected = connected;
    connected = false;
    ws = null;
    // Si nunca llegamos a conectar en este intento, probar el siguiente
    // puerto candidato en la próxima reconexión (helmet en otro puerto).
    if (!wasConnected && candidatePorts.length > 1) rotatePort();
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose will fire after this
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, RECONNECT_DELAY);
}

function sendToYautja(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ...msg, ...(bridgeGeneration ? { generation: bridgeGeneration } : {}) }));
  }
}

// ─── Command handling ─────────────────────────────────────────────

async function handleCommand(msg) {
  const { id } = msg;
  const sourceSocket = ws;
  const generation = bridgeGeneration;
  const control = { cancelled: false };
  commandControls.set(id, control);
  const assertCurrent = () => {
    if (sourceSocket !== ws || generation !== bridgeGeneration || (msg.generation && generation && msg.generation !== generation)) throw new Error('STALE_GENERATION');
    if (control.cancelled || (msg.deadline && Date.now() >= msg.deadline)) throw new Error('OPERATION_CANCELLED_OR_EXPIRED');
  };
  const chrome = guardedApi(globalThis.chrome, assertCurrent);
  const sendToYautja = payload => {
    if (sourceSocket === ws && generation === bridgeGeneration && !control.cancelled && sourceSocket?.readyState === WebSocket.OPEN) {
      sourceSocket.send(JSON.stringify({ ...payload, ...(generation ? { generation } : {}), ...(msg.tabId !== undefined ? { sourceTabId: msg.tabId } : {}) }));
    }
  };
  try { assertCurrent(); } catch (error) {
    sendToYautja({ id, type: 'error', error: error.message }); return;
  }

  switch (msg.type) {
    case 'ping': {
      sendToYautja({ id, type: 'result', result: { pong: true, wrTotalEvents: _wrTotalEvents } });
      break;
    }

    // Sonda de liveness: responde SIN awaits para distinguir "SW muerto"
    // (ni health responde) de "renderer ocupado" (health responde, comandos no).
    case 'health': {
      sendToYautja({ id, type: 'result', result: {
        runtimeId: chrome.runtime.id,
        uptimeMs: Date.now() - swStartTime,
        pendingHandlers,
        attachedTabs: [...attachedTabs.keys()],
      }});
      break;
    }

    case 'attach': {
      const tabId = msg.tabId;
      if (!tabId && tabId !== 0) {
        sendToYautja({ id, type: 'error', error: 'attach requires tabId' });
        break;
      }
      if (attachedTabs.has(tabId)) {
        sendToYautja({ id, type: 'result', result: { alreadyAttached: true } });
        break;
      }
      try {
        await withTimeout(chrome.debugger.attach({ tabId }, DEBUGGER_VERSION), HANDLER_TIMEOUT_MS, 'debugger.attach');
        attachedTabs.set(tabId, new Set());
        sendToYautja({ type: 'attached', tabId });
        sendToYautja({ id, type: 'result', result: { attached: true } });
      } catch (e) {
        sendToYautja({ id, type: 'error', error: `attach failed: ${e.message}` });
      }
      break;
    }

    case 'detach': {
      const tabId = msg.tabId;
      try {
        await withTimeout(chrome.debugger.detach({ tabId }), HANDLER_TIMEOUT_MS, 'debugger.detach');
        attachedTabs.delete(tabId);
        sendToYautja({ type: 'detached', tabId });
        sendToYautja({ id, type: 'result', result: { detached: true } });
      } catch (e) {
        attachedTabs.delete(tabId);
        sendToYautja({ id, type: 'result', result: { detached: true, note: e.message } });
      }
      break;
    }

    case 'detachAll': {
      const detached = [];
      for (const tabId of [...attachedTabs.keys()]) {
        try {
          await withTimeout(chrome.debugger.detach({ tabId }), HANDLER_TIMEOUT_MS, 'debugger.detach');
          detached.push(tabId);
        } catch {
          // Already detached or error — remove from tracking anyway
        }
        attachedTabs.delete(tabId);
      }
      sendToYautja({ id, type: 'result', result: { detached: true, tabs: detached } });
      break;
    }

    case 'command': {
      const tabId = msg.tabId;
      const method = msg.method;
      const params = msg.params || {};
      if (!attachedTabs.has(tabId)) {
        sendToYautja({ id, type: 'error', error: `Tab ${tabId} not attached` });
        break;
      }
      try {
        const result = await withTimeout(
          chrome.debugger.sendCommand({ tabId }, method, params),
          method === 'Page.navigate' ? NAVIGATE_TIMEOUT_MS : HANDLER_TIMEOUT_MS,
          `CDP ${method}`,
        );
        if (method && method.endsWith('.enable')) {
          const domain = method.slice(0, -7);
          attachedTabs.get(tabId).add(domain);
        }
        if (method && method.endsWith('.disable')) {
          const domain = method.slice(0, -8);
          attachedTabs.get(tabId).delete(domain);
        }
        sendToYautja({ id, type: 'result', result: result || {} });
      } catch (e) {
        sendToYautja({ id, type: 'error', error: `CDP ${method} failed: ${e.message}` });
      }
      break;
    }

    case 'listTabs': {
      try {
        const tabs = await withTimeout(chrome.tabs.query({}), HANDLER_TIMEOUT_MS, 'tabs.query');
        const result = tabs.map((t) => ({
          tabId: t.id,
          url: t.url || '',
          title: t.title || '',
          active: t.active,
          index: t.index,
          windowId: t.windowId,
          groupId: t.groupId,
        }));
        sendToYautja({ id, type: 'result', result: { tabs: result } });
      } catch (e) {
        sendToYautja({ id, type: 'error', error: `listTabs failed: ${e.message}` });
      }
      break;
    }

    case 'openTab': {
      try {
        // Agent tabs stay in the background by default so automation does not
        // steal the user's current tab/window focus. Callers must opt in with
        // focus:true for the few flows that require visible browser focus.
        const focus = msg.focus === true;
        const tab = await withTimeout(chrome.tabs.create({ url: msg.url, active: focus }), HANDLER_TIMEOUT_MS, 'tabs.create');
        // Session group (P8): when a groupId is provided, the new tab joins
        // that group so Yautja-controlled tabs stay sandboxed together.
        if (typeof msg.groupId === 'number' && msg.groupId >= 0) {
          try { await withTimeout(chrome.tabs.group({ tabIds: [tab.id], groupId: msg.groupId }), HANDLER_TIMEOUT_MS, 'tabs.group'); }
          catch (error) {
            // The created tab is ours; report partial state if cleanup also fails.
            let cleaned = false;
            try { await chrome.tabs.remove(tab.id); cleaned = true; } catch {}
            sendToYautja({ id, type: 'error', error: `Grouping failed: ${error.message}; createdTabId=${tab.id}; cleaned=${cleaned}` });
            break;
          }
        }
        sendToYautja({ id, type: 'result', result: { tabId: tab.id, url: tab.url || msg.url, focused: focus } });
      } catch (e) {
        sendToYautja({ id, type: 'error', error: `openTab failed: ${e.message}` });
      }
      break;
    }

    // Session tab group (P8, estilo "MCP tab group" de Claude in Chrome):
    // crea una pestaña en blanco y la agrupa con título/color distintivos.
    case 'sessionGroupCreate': {
      try {
        const tab = await withTimeout(chrome.tabs.create({ url: 'about:blank', active: false }), HANDLER_TIMEOUT_MS, 'tabs.create');
        const groupId = await withTimeout(chrome.tabs.group({ tabIds: [tab.id] }), HANDLER_TIMEOUT_MS, 'tabs.group');
        await withTimeout(chrome.tabGroups.update(groupId, {
          title: msg.title || 'Yautja',
          color: msg.color || 'purple',
          collapsed: false,
        }), HANDLER_TIMEOUT_MS, 'tabGroups.update');
        sendToYautja({ id, type: 'result', result: { groupId, tabId: tab.id } });
      } catch (e) {
        sendToYautja({ id, type: 'error', error: `sessionGroupCreate failed: ${e.message}` });
      }
      break;
    }

    // Lectura de claves de chrome.storage.local de la extensión (kill switches,
    // p.ej. yjStripInterference). Devuelve { value } — undefined si no existe.
    case 'storageGet': {
      try {
        const data = await chrome.storage.local.get(msg.key);
        sendToYautja({ id, type: 'result', result: { value: data ? data[msg.key] : undefined } });
      } catch (e) {
        sendToYautja({ id, type: 'error', error: `storageGet failed: ${e.message}` });
      }
      break;
    }

    case 'closeTab': {
      try {
        if (typeof msg.expectedGroupId === 'number') {
          const tab = await chrome.tabs.get(msg.tabId);
          if (tab.groupId !== msg.expectedGroupId) throw new Error('Tab changed group; refusing close');
        }
        await withTimeout(chrome.tabs.remove(msg.tabId), HANDLER_TIMEOUT_MS, 'tabs.remove');
        sendToYautja({ id, type: 'result', result: { closed: true, tabId: msg.tabId } });
      } catch (e) {
        sendToYautja({ id, type: 'error', error: `closeTab failed: ${e.message}` });
      }
      break;
    }

    case 'groupTab': {
      try {
        await chrome.tabs.group({ tabIds: [msg.tabId], groupId: msg.groupId });
        sendToYautja({ id, type: 'result', result: { grouped: true, tabId: msg.tabId, groupId: msg.groupId } });
      } catch (error) { sendToYautja({ id, type: 'error', error: error.message }); }
      break;
    }
    case 'groupRename': {
      try {
        await chrome.tabGroups.update(msg.groupId, { title: msg.title });
        sendToYautja({ id, type: 'result', result: { groupId: msg.groupId, title: msg.title } });
      } catch (error) { sendToYautja({ id, type: 'error', error: error.message }); }
      break;
    }
    case 'restoreTab': {
      try {
        const tab = await chrome.tabs.get(msg.tabId);
        if (tab.groupId !== msg.expectedGroupId) throw new Error('Tab changed group; refusing restore');
        const original = msg.original;
        await chrome.tabs.ungroup([msg.tabId]);
        try { await chrome.tabs.move(msg.tabId, { windowId: original.windowId, index: original.index }); } catch (error) { assertCurrent(); }
        if (typeof original.groupId === 'number' && original.groupId >= 0) {
          let exists = false;
          try { await chrome.tabGroups.get(original.groupId); exists = true; } catch { assertCurrent(); }
          if (exists) await chrome.tabs.group({ tabIds: [msg.tabId], groupId: original.groupId });
        }
        sendToYautja({ id, type: 'result', result: { restored: true, tabId: msg.tabId } });
      } catch (error) { sendToYautja({ id, type: 'error', error: error.message }); }
      break;
    }

    case 'switchToTab': {
      try {
        const tab = await withTimeout(chrome.tabs.get(msg.tabId), HANDLER_TIMEOUT_MS, 'tabs.get');
        const focus = msg.focus === true;
        if (focus) {
          await withTimeout(chrome.tabs.update(msg.tabId, { active: true }), HANDLER_TIMEOUT_MS, 'tabs.update');
          if (typeof tab.windowId === 'number') {
            await withTimeout(chrome.windows.update(tab.windowId, { focused: true }), HANDLER_TIMEOUT_MS, 'windows.update');
          }
        }
        sendToYautja({ id, type: 'result', result: { tabId: msg.tabId, focused: focus } });
      } catch (e) {
        sendToYautja({ id, type: 'error', error: `switchToTab failed: ${e.message}` });
      }
      break;
    }

    // ─── Extension target commands ───────────────────────────────

    case 'listAllTargets': {
      try {
        const targets = await withTimeout(chrome.debugger.getTargets(), HANDLER_TIMEOUT_MS, 'debugger.getTargets');
        const result = targets
          .filter((t) => t.url && t.url.startsWith('chrome-extension://'))
          .map((t) => ({
            id: t.id,
            type: t.type,
            title: t.title || '',
            url: t.url || '',
            attached: t.attached || false,
            tabId: t.tabId || null,
          }));
        sendToYautja({ id, type: 'result', result: { targets: result } });
      } catch (e) {
        sendToYautja({ id, type: 'error', error: `listAllTargets failed: ${e.message}` });
      }
      break;
    }

    case 'attachTarget': {
      const { targetId } = msg;
      if (attachedTargets.has(targetId)) {
        sendToYautja({ id, type: 'result', result: { alreadyAttached: true } });
        break;
      }
      try {
        await withTimeout(chrome.debugger.attach({ targetId }, DEBUGGER_VERSION), HANDLER_TIMEOUT_MS, 'debugger.attach');
        attachedTargets.set(targetId, new Set());
        sendToYautja({ type: 'targetAttached', targetId });
        sendToYautja({ id, type: 'result', result: { attached: true } });
      } catch (e) {
        sendToYautja({ id, type: 'error', error: `attachTarget failed: ${e.message}` });
      }
      break;
    }

    case 'detachTarget': {
      const { targetId } = msg;
      try {
        await withTimeout(chrome.debugger.detach({ targetId }), HANDLER_TIMEOUT_MS, 'debugger.detach');
        attachedTargets.delete(targetId);
        sendToYautja({ type: 'targetDetached', targetId });
        sendToYautja({ id, type: 'result', result: { detached: true } });
      } catch (e) {
        attachedTargets.delete(targetId);
        sendToYautja({ id, type: 'result', result: { detached: true, note: e.message } });
      }
      break;
    }

    case 'commandTarget': {
      const { targetId, method, params } = msg;
      if (!attachedTargets.has(targetId)) {
        sendToYautja({ id, type: 'error', error: `Target ${targetId} not attached` });
        break;
      }
      try {
        const result = await withTimeout(
          chrome.debugger.sendCommand({ targetId }, method, params || {}),
          HANDLER_TIMEOUT_MS,
          `CDP target ${method}`,
        );

        if (method && method.endsWith('.enable')) {
          const domain = method.slice(0, -7);
          attachedTargets.get(targetId).add(domain);
        }
        if (method && method.endsWith('.disable')) {
          const domain = method.slice(0, -8);
          attachedTargets.get(targetId).delete(domain);
        }

        sendToYautja({ id, type: 'result', result: result || {} });
      } catch (e) {
        sendToYautja({ id, type: 'error', error: `CDP target ${method} failed: ${e.message}` });
      }
      break;
    }

    // ─── Management API (chrome.management) ──────────────────────

    case 'managementGetAll': {
      try {
        const all = await chrome.management.getAll();
        const extensions = all
          .filter((e) => e.type === 'extension')
          .map((e) => ({
            id: e.id,
            name: e.name,
            version: e.version,
            enabled: e.enabled,
            type: e.type,
            installType: e.installType,
            description: e.description || '',
            permissions: e.permissions || [],
            hostPermissions: e.hostPermissions || [],
            mayDisable: e.mayDisable !== false,
          }));
        sendToYautja({ id, type: 'result', result: { extensions } });
      } catch (e) {
        sendToYautja({ id, type: 'error', error: `managementGetAll failed: ${e.message}` });
      }
      break;
    }

    case 'managementSetEnabled': {
      const { extId, enabled } = msg;
      try {
        await chrome.management.setEnabled(extId, enabled);
        sendToYautja({ id, type: 'result', result: { success: true } });
      } catch (e) {
        sendToYautja({ id, type: 'error', error: `managementSetEnabled failed: ${e.message}` });
      }
      break;
    }

    // ─── webRequest API (extension network capture) ──────────────

    case 'webRequestStart': {
      const { extId } = msg;
      webRequestBuffers.set(extId, { requests: [], totalSeen: 0 });
      webRequestActive.add(extId);
      sendToYautja({ id, type: 'result', result: { success: true, action: 'started', extId, wrTotalEvents: _wrTotalEvents } });
      break;
    }

    case 'webRequestStop': {
      const { extId } = msg;
      webRequestActive.delete(extId);
      webRequestBuffers.delete(extId);
      sendToYautja({ id, type: 'result', result: { success: true, action: 'stopped', extId } });
      break;
    }

    case 'webRequestList': {
      const { extId } = msg;
      const buf = webRequestBuffers.get(extId);
      const requests = buf ? buf.requests : [];
      const totalSeen = buf ? buf.totalSeen : 0;
      sendToYautja({ id, type: 'result', result: { requests, count: requests.length, totalEventsSeen: totalSeen, wrAllEvents: _wrTotalEvents } });
      break;
    }

    // ─── Local proxy control (chrome.proxy API) ──────────────────

    case 'proxyStart': {
      const proxyPort = msg.port || 9877;
      chrome.proxy.settings.set({
        value: {
          mode: 'fixed_servers',
          rules: {
            singleProxy: {
              scheme: 'http',
              host: '127.0.0.1',
              port: proxyPort,
            },
            bypassList: ['localhost', '127.0.0.1'],
          },
        },
        scope: 'regular',
      }, () => {
        const err = chrome.runtime.lastError;
        sendToYautja({ id, type: 'result', result: err ? { success: false, error: err.message } : { success: true, port: proxyPort } });
      });
      break;
    }

    case 'proxyStop': {
      chrome.proxy.settings.clear({ scope: 'regular' }, () => {
        sendToYautja({ id, type: 'result', result: { success: true, cleared: true } });
      });
      break;
    }

    // ─── Tampermonkey bridge (content script → TM via chrome.runtime.sendMessage) ─
    // Modern Chrome does NOT expose chrome.runtime on web pages (only loadTimes, csi, app).
    // So we can't call TM from the page's main world. Instead: open a hidden tab on
    // greasyfork.org (TM's externally_connectable whitelist), and use the existing
    // content script (content-gql.js) which has chrome.runtime available. The content
    // script calls chrome.runtime.sendMessage(TM_ID, message, callback). TM's
    // onMessageExternal accepts because sender URL matches the page origin.
    case 'tmInstallViaBridge': {
      const { tmExtId, message, timeout: timeoutMs } = msg;
      const TM_DEFAULT = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
      const targetId = tmExtId || TM_DEFAULT;
      const wait = Math.min(timeoutMs || 20000, 30000);

      let bridgeTabId = null;

      const cleanup = async () => {
        if (bridgeTabId != null) {
          try { await chrome.tabs.remove(bridgeTabId); } catch {}
        }
      };

      try {
        // 1. Open a hidden tab on greasyfork.org (TM-whitelisted origin).
        // The content script is auto-injected via manifest content_scripts.
        const tab = await chrome.tabs.create({
          url: 'https://greasyfork.org/en/scripts',
          active: false,
        });
        bridgeTabId = tab.id;

        // 2. Wait for page to fully load (content script runs at document_idle)
        await new Promise((resolve) => {
          const listener = (tabId, changeInfo) => {
            if (tabId === bridgeTabId && changeInfo.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              // Small extra delay to ensure content script is fully wired up
              setTimeout(resolve, 300);
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }, 15000);
        });

        // 3. Send message to the content script via chrome.tabs.sendMessage.
        // The content script will use chrome.runtime.sendMessage(TM_ID, ...) to TM.
        const response = await Promise.race([
          chrome.tabs.sendMessage(bridgeTabId, {
            type: '__yautja_tm_bridge',
            tmId: targetId,
            message,
            timeoutMs: wait,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout waiting for content script')), wait + 3000)
          ),
        ]);

        await cleanup();
        sendToYautja({
          id,
          type: 'result',
          result: response || { error: 'no response from content script' },
        });
      } catch (e) {
        await cleanup();
        sendToYautja({ id, type: 'result', result: { error: `tmInstallViaBridge failed: ${e.message}` } });
      }
      break;
    }

    // ─── Tampermonkey bridge (chrome.runtime.connect) ────────────
    // Connects to TM's background SW via onConnectExternal and sends
    // a message. TM routes it through the same handler as its own pages.
    // NOTE: TM's onConnectExternal only accepts 3 editor extensions,
    // so this DOES NOT WORK for arbitrary external extensions. Kept
    // for backwards compatibility / testing — prefer tmInstallViaBridge.
    case 'tmMessage': {
      const { tmExtId, message, timeout: timeoutMs } = msg;
      const TM_DEFAULT = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
      const targetId = tmExtId || TM_DEFAULT;
      const wait = timeoutMs || 15000;

      let responded = false;
      let timer = null;
      let port = null;

      try {
        port = chrome.runtime.connect(targetId, { name: 'yautja-bridge' });

        timer = setTimeout(() => {
          if (!responded) {
            responded = true;
            try { port.disconnect(); } catch {}
            sendToYautja({ id, type: 'result', result: { error: 'timeout', detail: `No response after ${wait}ms` } });
          }
        }, wait);

        port.onMessage.addListener((response) => {
          if (responded) return;
          // Collect response — TM may send partial/progress messages
          if (response && (response.error || response.success || response.items !== undefined)) {
            responded = true;
            clearTimeout(timer);
            try { port.disconnect(); } catch {}
            sendToYautja({ id, type: 'result', result: response });
          }
        });

        port.onDisconnect.addListener(() => {
          if (!responded) {
            responded = true;
            clearTimeout(timer);
            const err = chrome.runtime.lastError;
            sendToYautja({ id, type: 'result', result: {
              error: err ? err.message : 'disconnected',
              hint: 'Tampermonkey may not allow external connections. Check TM Settings → Security → External Connect (set to "all").'
            }});
          }
        });

        // Send the actual message
        port.postMessage(message);
      } catch (e) {
        if (!responded) {
          responded = true;
          if (timer) clearTimeout(timer);
          if (port) try { port.disconnect(); } catch {}
          sendToYautja({ id, type: 'error', error: `tmMessage failed: ${e.message}` });
        }
      }
      break;
    }

    default:
      sendToYautja({ id, type: 'error', error: `Unknown command type: ${msg.type}` });
  }
}

// ─── CDP event forwarding ─────────────────────────────────────────

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  const targetId = source.targetId;

  if (tabId == null && targetId == null) return;

  if (targetId != null) {
    // Extension target event
    sendToYautja({
      type: 'event',
      targetId,
      method,
      params,
    });
  } else {
    // Regular tab event
    sendToYautja({
      type: 'event',
      tabId,
      method,
      params,
    });
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  const targetId = source.targetId;
  if (tabId != null) {
    attachedTabs.delete(tabId);
    sendToYautja({ type: 'detached', tabId, reason: reason || 'unknown' });
  }
  if (targetId != null) {
    attachedTargets.delete(targetId);
    sendToYautja({ type: 'targetDetached', targetId, reason: reason || 'unknown' });
  }
});

// ─── Service worker keep-alive ────────────────────────────────────

// An open WebSocket keeps the service worker alive.
// Alarms act as backup: if WS drops, the alarm fires reconnect.
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.25 }); // every 15s

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    connectWS();
  } else if (ws.readyState === WebSocket.OPEN) {
    // Ping the helmet to generate activity and keep the service worker alive.
    // MV3 kills idle workers after ~30s even with an open WebSocket.
    sendToYautja({ type: 'ping' });
  }
});

// ─── Startup ──────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(connectWS);
chrome.runtime.onInstalled.addListener(connectWS);

// Try immediate connect on load
connectWS();
