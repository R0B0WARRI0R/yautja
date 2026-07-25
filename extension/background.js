// Yautja Bridge — Service Worker
// Relays CDP commands from Yautja (WebSocket) to chrome.debugger and back.

const YAUTJA_URL = 'ws://localhost:9876';
const RECONNECT_DELAY = 2000;
const KEEPALIVE_ALARM = 'yautja-keepalive';
const DEBUGGER_VERSION = '1.3';

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
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = new WebSocket(YAUTJA_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    connected = true;
    sendToYautja({ type: 'hello', extension: 'yautja-bridge', version: '0.1.0' });
    // Re-attach to any tabs we were tracking before reconnect
    for (const tabId of attachedTabs.keys()) {
      sendToYautja({ type: 'info', message: `Tab ${tabId} was attached before reconnect` });
    }
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleCommand(msg);
  };

  ws.onclose = () => {
    connected = false;
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
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
    ws.send(JSON.stringify(msg));
  }
}

// ─── Command handling ─────────────────────────────────────────────

async function handleCommand(msg) {
  const { id } = msg;

  switch (msg.type) {
    case 'ping': {
      sendToYautja({ id, type: 'result', result: { pong: true, wrTotalEvents: _wrTotalEvents } });
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
        await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
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
        await chrome.debugger.detach({ tabId });
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
          await chrome.debugger.detach({ tabId });
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
        const result = await chrome.debugger.sendCommand({ tabId }, method, params);
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
        const tabs = await chrome.tabs.query({});
        const result = tabs.map((t) => ({
          tabId: t.id,
          url: t.url || '',
          title: t.title || '',
          active: t.active,
          index: t.index,
          windowId: t.windowId,
        }));
        sendToYautja({ id, type: 'result', result: { tabs: result } });
      } catch (e) {
        sendToYautja({ id, type: 'error', error: `listTabs failed: ${e.message}` });
      }
      break;
    }

    case 'openTab': {
      try {
        const tab = await chrome.tabs.create({ url: msg.url, active: true });
        sendToYautja({ id, type: 'result', result: { tabId: tab.id, url: tab.url || msg.url } });
      } catch (e) {
        sendToYautja({ id, type: 'error', error: `openTab failed: ${e.message}` });
      }
      break;
    }

    case 'closeTab': {
      try {
        await chrome.tabs.remove(msg.tabId);
        sendToYautja({ id, type: 'result', result: { closed: true, tabId: msg.tabId } });
      } catch (e) {
        sendToYautja({ id, type: 'error', error: `closeTab failed: ${e.message}` });
      }
      break;
    }

    case 'switchToTab': {
      try {
        await chrome.tabs.update(msg.tabId, { active: true });
        const tab = await chrome.tabs.get(msg.tabId);
        if (tab.windowId) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        sendToYautja({ id, type: 'result', result: { tabId: msg.tabId } });
      } catch (e) {
        sendToYautja({ id, type: 'error', error: `switchToTab failed: ${e.message}` });
      }
      break;
    }

    // ─── Extension target commands ───────────────────────────────

    case 'listAllTargets': {
      try {
        const targets = await chrome.debugger.getTargets();
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
        await chrome.debugger.attach({ targetId }, DEBUGGER_VERSION);
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
        await chrome.debugger.detach({ targetId });
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
        const result = await chrome.debugger.sendCommand(
          { targetId },
          method,
          params || {},
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

    // ─── Tampermonkey bridge (CDP-injected from whitelisted origin) ─
    // TM's onConnectExternal only accepts 3 hardcoded editor extensions
    // (function `xp` in TM's SW). So we can't connect directly from
    // another extension. Instead: open a hidden tab on greasyfork.org
    // (TM's externally_connectable whitelist includes this origin),
    // attach CDP, inject chrome.runtime.connect(TM_ID) from the page
    // context, and await the response. Generic bridge — passes any TM
    // method call (importEx, saveScript, getScript, etc.) in `message`.
    case 'tmInstallViaBridge': {
      const { tmExtId, message, timeout: timeoutMs } = msg;
      const TM_DEFAULT = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
      const targetId = tmExtId || TM_DEFAULT;
      const wait = Math.min(timeoutMs || 20000, 30000);

      let bridgeTabId = null;
      let attached = false;

      const cleanup = async () => {
        if (attached && bridgeTabId != null) {
          try { await chrome.debugger.detach({ tabId: bridgeTabId }); } catch {}
        }
        if (bridgeTabId != null) {
          try { await chrome.tabs.remove(bridgeTabId); } catch {}
        }
      };

      const fail = async (error, detail) => {
        await cleanup();
        sendToYautja({ id, type: 'result', result: { error, detail } });
      };

      try {
        // 1. Open hidden tab on greasyfork.org (TM whitelisted origin)
        const tab = await chrome.tabs.create({
          url: 'https://greasyfork.org/en/scripts',
          active: false,
        });
        bridgeTabId = tab.id;

        // 2. Wait for page to fully load
        await new Promise((resolve) => {
          const listener = (tabId, changeInfo) => {
            if (tabId === bridgeTabId && changeInfo.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }, 15000);
        });

        // 3. Attach CDP debugger
        await chrome.debugger.attach({ tabId: bridgeTabId }, DEBUGGER_VERSION);
        attached = true;

        // 4. Inject the bridge function from the page context.
        // The page is on a TM-whitelisted origin, so chrome.runtime.sendMessage(TM_ID)
        // should be accepted by TM's onMessageExternal handler.
        // Wait for chrome.runtime to appear (lazy on hidden tabs) then send.
        // SENTINEL: v5-sendMessage-wait
        const expression = `
          (async function() {
            window.__tmInstallResult = null;
            window.__tmInstallError = null;
            window.__tmBridgeVersion = 'v5-sendMessage-wait';
            const waitFor = ${wait};
            const targetId = ${JSON.stringify(targetId)};
            const message = ${JSON.stringify(message)};
            // Wait up to 5s for chrome.runtime to be available
            const startWait = Date.now();
            const dump = () => ({
              hasChrome: typeof chrome !== 'undefined',
              hasRuntime: typeof chrome !== 'undefined' && typeof chrome.runtime !== 'undefined',
              hasSendMessage: typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage,
              hasConnect: typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.connect,
              chromeKeys: typeof chrome !== 'undefined' ? Object.keys(chrome).slice(0, 30) : [],
              runtimeKeys: typeof chrome !== 'undefined' && chrome.runtime ? Object.keys(chrome.runtime).slice(0, 30) : [],
              readyState: document.readyState,
              url: location.href,
            });
            while (Date.now() - startWait < 5000) {
              if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
                break;
              }
              await new Promise((r) => setTimeout(r, 100));
            }
            if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
              window.__tmInstallError = 'v5-sendMessage unavailable. diag=' + JSON.stringify(dump());
              return;
            }
            try {
              chrome.runtime.sendMessage(targetId, message, function(response) {
                if (chrome.runtime.lastError) {
                  window.__tmInstallError = 'v5-rejected: ' + (chrome.runtime.lastError.message || 'lastError');
                } else {
                  window.__tmInstallResult = response;
                }
              });
              setTimeout(() => {
                if (!window.__tmInstallResult && !window.__tmInstallError) {
                  window.__tmInstallError = 'v5-timeout';
                }
              }, waitFor);
            } catch (e) {
              window.__tmInstallError = 'v5-throw: ' + (e.message || String(e));
            }
          })();
        `;

        await chrome.debugger.sendCommand({ tabId: bridgeTabId }, 'Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });

        // 5. Poll for the result stored on window
        const start = Date.now();
        let result = null;
        while (Date.now() - start < wait + 2000) {
          const poll = await chrome.debugger.sendCommand({ tabId: bridgeTabId }, 'Runtime.evaluate', {
            expression: 'JSON.stringify({ r: window.__tmInstallResult, e: window.__tmInstallError })',
            returnByValue: true,
          });
          const val = poll?.result?.value;
          if (val) {
            try {
              const parsed = JSON.parse(val);
              if (parsed.r !== null || parsed.e !== null) {
                result = parsed.r !== null ? parsed.r : { error: parsed.e };
                break;
              }
            } catch {}
          }
          await new Promise((r) => setTimeout(r, 200));
        }

        await cleanup();
        sendToYautja({
          id,
          type: 'result',
          result: result || { error: 'timeout', detail: 'window.__tmInstallResult never set' },
        });
      } catch (e) {
        await fail(`tmInstallViaBridge failed: ${e.message}`);
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
