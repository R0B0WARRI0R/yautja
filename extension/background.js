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
    case 'ping':
      sendToYautja({ id, type: 'pong' });
      break;

    case 'listTabs': {
      try {
        const tabs = await chrome.tabs.query({});
        const result = tabs
          .filter((t) => t.id != null)
          .map((t) => ({
            tabId: t.id,
            url: t.url || '',
            title: t.title || '',
            active: t.active,
            index: t.index,
            windowId: t.windowId,
          }));
        sendToYautja({ id, type: 'tabs', tabs: result });
      } catch (e) {
        sendToYautja({ id, type: 'error', error: `listTabs failed: ${e.message}` });
      }
      break;
    }

    case 'attach': {
      const { tabId } = msg;
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
      const { tabId } = msg;
      try {
        await chrome.debugger.detach({ tabId });
        attachedTabs.delete(tabId);
        sendToYautja({ type: 'detached', tabId });
        sendToYautja({ id, type: 'result', result: { detached: true } });
      } catch (e) {
        // Already detached is fine
        attachedTabs.delete(tabId);
        sendToYautja({ id, type: 'result', result: { detached: true, note: e.message } });
      }
      break;
    }

    case 'detachAll': {
      for (const tabId of attachedTabs.keys()) {
        try {
          await chrome.debugger.detach({ tabId });
        } catch {}
      }
      attachedTabs.clear();
      sendToYautja({ id, type: 'result', result: { detachedAll: true } });
      break;
    }

    case 'command': {
      const { tabId, method, params } = msg;
      if (!attachedTabs.has(tabId)) {
        sendToYautja({ id, type: 'error', error: `Tab ${tabId} not attached` });
        break;
      }
      try {
        const result = await chrome.debugger.sendCommand(
          { tabId },
          method,
          params || {},
        );

        // Track enabled domains for re-attach after reconnect
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

    case 'switchToTab': {
      const { tabId } = msg;
      try {
        await chrome.tabs.update(tabId, { active: true });
        sendToYautja({ id, type: 'result', result: { switched: true } });
      } catch (e) {
        sendToYautja({ id, type: 'error', error: `switchToTab failed: ${e.message}` });
      }
      break;
    }

    case 'closeTab': {
      const { tabId } = msg;
      try {
        if (attachedTabs.has(tabId)) {
          try { await chrome.debugger.detach({ tabId }); } catch {}
          attachedTabs.delete(tabId);
        }
        await chrome.tabs.remove(tabId);
        sendToYautja({ id, type: 'result', result: { closed: true } });
      } catch (e) {
        sendToYautja({ id, type: 'error', error: `closeTab failed: ${e.message}` });
      }
      break;
    }

    case 'getCapturedGql': {
      const tabId = msg.tabId;
      const limit = msg.limit || 100;
      let data = lastCapturedGql;
      if (tabId !== undefined) data = data.filter(c => c.tabId === tabId);
      sendToYautja({ id, type: 'result', result: { items: data.slice(-limit), total: data.length } });
      break;
    }

    case 'clearCapturedGql': {
      if (msg.tabId !== undefined) {
        lastCapturedGql = lastCapturedGql.filter(c => c.tabId !== msg.tabId);
      } else {
        lastCapturedGql = [];
      }
      sendToYautja({ id, type: 'result', result: { cleared: true } });
      break;
    }

    default:
      sendToYautja({ id, type: 'error', error: `Unknown command type: ${msg.type}` });
  }
}

// ─── CDP event forwarding ─────────────────────────────────────────

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  sendToYautja({
    type: 'event',
    tabId,
    method,
    params,
  });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  attachedTabs.delete(tabId);
  sendToYautja({
    type: 'detached',
    tabId,
    reason: reason || 'unknown',
  });
});

// ─── Tab lifecycle ────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (attachedTabs.has(tabId)) {
    attachedTabs.delete(tabId);
    sendToYautja({ type: 'tabClosed', tabId });
  }
});

// ─── Content script messages (GQL captures) ────────────────────────────────────────────────

let lastCapturedGql = [];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'yautja-gql-request') {
    lastCapturedGql.push({
      url: msg.url,
      ops: msg.ops || [],
      hash: msg.hash,
      timestamp: Date.now(),
      tabId: sender.tab?.id,
    });
    if (lastCapturedGql.length > 500) lastCapturedGql = lastCapturedGql.slice(-500);
    return false;
  }
});

// ─── Popup communication ──────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getState') {
    sendResponse({
      connected,
      attachedTabs: attachedTabs.size,
    });
    return false;
  }
  if (msg.type === 'forceReconnect') {
    if (ws) {
      try { ws.close(); } catch {}
    }
    setTimeout(() => connectWS(), 200);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// ─── Service worker keep-alive ────────────────────────────────────

// An open WebSocket keeps the service worker alive.
// Alarms act as backup: if WS drops, the alarm fires reconnect.
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.25 }); // every 15s

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    connectWS();
  }
});

// ─── Startup ──────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(connectWS);
chrome.runtime.onInstalled.addListener(connectWS);

// Try immediate connect on load
connectWS();
