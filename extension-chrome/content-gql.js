// Yautja — Content Script
// Patches fetch + XMLHttpRequest persistently across navigations.
// Captures request bodies (especially GQL persists) and sends to background.

(function() {
  if (window.__yautja_patched) return;
  window.__yautja_patched = true;

  const captured = [];
  const MAX_CAPTURED = 200;

  function safeSend(msg) {
    try { chrome.runtime.sendMessage(msg); } catch (e) { console.log('[Yautja] sendMessage err:', e); }
  }

  function getOperationName(body) {
    if (!body) return null;
    try {
      const json = typeof body === 'string' ? JSON.parse(body) : body;
      if (Array.isArray(json)) {
        return json.map(q => q?.operationName || q?.extensions?.persistedQuery?.sha256Hash).filter(Boolean);
      }
      return [json.operationName || json?.extensions?.persistedQuery?.sha256Hash].filter(Boolean);
    } catch {
      return null;
    }
  }

  function getHash(body) {
    if (!body) return null;
    try {
      const json = typeof body === 'string' ? JSON.parse(body) : body;
      if (Array.isArray(json)) {
        for (const q of json) {
          if (q?.extensions?.persistedQuery?.sha256Hash) return q.extensions.persistedQuery.sha256Hash;
        }
        return null;
      }
      return json?.extensions?.persistedQuery?.sha256Hash || null;
    } catch { return null; }
  }

  // --- Patch fetch ---
  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    if (url && url.includes('gql.twitch.tv')) {
      try {
        const body = init?.body ? (typeof init.body === 'string' ? init.body : JSON.stringify(init.body)) : '';
        const ops = getOperationName(body);
        const hash = getHash(body);
        captured.push({
          type: 'fetch',
          url: url.substring(0, 100),
          method: init?.method || 'GET',
          ops,
          hash,
          body: body.substring(0, 500),
          timestamp: Date.now(),
        });
        if (captured.length > MAX_CAPTURED) captured.shift();
        safeSend({ type: 'yautja-gql-request', url, ops, hash });
      } catch {}
    }
    return origFetch.apply(this, arguments);
  };

  // --- Patch XHR ---
  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    const xhr = new OrigXHR();
    const origOpen = xhr.open;
    const origSend = xhr.send;
    let url = '';
    let method = '';
    xhr.open = function(m, u) {
      method = m;
      url = u;
      return origOpen.apply(this, arguments);
    };
    xhr.send = function(body) {
      if (url.includes('gql.twitch.tv')) {
        try {
          const ops = getOperationName(body);
          const hash = getHash(body);
          captured.push({ type: 'xhr', url, method, ops, hash, body: (body || '').substring(0, 500), timestamp: Date.now() });
          if (captured.length > MAX_CAPTURED) captured.shift();
          safeSend({ type: 'yautja-gql-request', url, ops, hash });
        } catch {}
      }
      return origSend.apply(this, arguments);
    };
    return xhr;
  };

  window.__yautjaGqlCapture = captured;

  console.log('[Yautja] GQL content script patched on', window.location.href);

  // ─── Tampermonkey bridge (content script → TM via chrome.runtime.sendMessage) ───
  // The page's main world has no chrome.runtime (modern Chrome doesn't expose it).
  // But content scripts HAVE chrome.runtime. TM's onMessageExternal accepts the message
  // when sender.url matches its externally_connectable whitelist (the page URL).
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === '__yautja_tm_bridge') {
      const { tmId, message, timeoutMs } = msg;
      const wait = Math.min(timeoutMs || 20000, 30000);
      let responded = false;
      const timer = setTimeout(() => {
        if (!responded) {
          responded = true;
          sendResponse({ error: 'timeout', detail: 'TM did not respond within ' + wait + 'ms' });
        }
      }, wait);
      try {
        chrome.runtime.sendMessage(tmId, message, (response) => {
          if (responded) return;
          responded = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            sendResponse({ error: 'TM-rejected: ' + (chrome.runtime.lastError.message || 'lastError') });
          } else {
            sendResponse(response);
          }
        });
      } catch (e) {
        if (responded) return;
        responded = true;
        clearTimeout(timer);
        sendResponse({ error: 'throw: ' + (e.message || String(e)) });
      }
      return true; // will respond asynchronously
    }
    return false; // let other listeners handle other messages
  });
})();
