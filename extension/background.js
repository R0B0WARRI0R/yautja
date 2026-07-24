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

// extId -> { onBefore, onComplete, onError, requests } for webRequest capture
const webRequestListeners = new Map();

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
      const initiatorPattern = `chrome-extension://${extId}`;
      const requests = [];
      let totalEventsSeen = 0; // debug: count ALL events, not just matched

      const matchInit = (details) => {
        const init = (details.initiator || details.originUrl || '').replace(/\/$/, '');
        return init === initiatorPattern;
      };

      const onBefore = (details) => {
        totalEventsSeen++;
        if (!matchInit(details)) return;
        requests.push({
          id: details.requestId,
          url: details.url,
          method: details.method,
          type: details.type,
          timestamp: details.timeStamp,
          initiator: details.initiator || details.originUrl || '',
        });
        if (requests.length > 500) requests.splice(0, requests.length - 500);
      };

      const onComplete = (details) => {
        if (!matchInit(details)) return;
        const req = requests.find((r) => r.id === details.requestId);
        if (req) {
          req.status = details.statusCode;
          req.fromCache = details.fromCache || false;
        }
      };

      const onError = (details) => {
        if (!matchInit(details)) return;
        const req = requests.find((r) => r.id === details.requestId);
        if (req) {
          req.error = details.error;
        }
      };

      chrome.webRequest.onBeforeRequest.addListener(onBefore, { urls: ['<all_urls>'] });
      chrome.webRequest.onCompleted.addListener(onComplete, { urls: ['<all_urls>'] });
      chrome.webRequest.onErrorOccurred.addListener(onError, { urls: ['<all_urls>'] });

      webRequestListeners.set(extId, { onBefore, onComplete, onError, requests, getTotalSeen: () => totalEventsSeen });
      sendToYautja({ id, type: 'result', result: { success: true, action: 'started', extId } });
      break;
    }

    case 'webRequestStop': {
      const { extId } = msg;
      const entry = webRequestListeners.get(extId);
      if (entry) {
        chrome.webRequest.onBeforeRequest.removeListener(entry.onBefore);
        chrome.webRequest.onCompleted.removeListener(entry.onComplete);
        chrome.webRequest.onErrorOccurred.removeListener(entry.onError);
        webRequestListeners.delete(extId);
      }
      sendToYautja({ id, type: 'result', result: { success: true, action: 'stopped', extId } });
      break;
    }

    case 'webRequestList': {
      const { extId } = msg;
      const entry = webRequestListeners.get(extId);
      const requests = entry ? entry.requests : [];
      const totalSeen = entry && entry.getTotalSeen ? entry.getTotalSeen() : 0;
      sendToYautja({ id, type: 'result', result: { requests, count: requests.length, totalEventsSeen: totalSeen } });
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
