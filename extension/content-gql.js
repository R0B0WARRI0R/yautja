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
})();
