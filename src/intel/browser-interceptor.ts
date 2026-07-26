export interface BrowserInterceptor {
  active: boolean;
  capturedCount: number;
  lastCapturedHash?: string;
  lastCapturedOp?: string;
  startedAt?: number;
}

export const BROWSER_INTERCEPT_SCRIPT = `
(function() {
  if (window.__yautja_persistent) return;
  window.__yautja_persistent = true;
  window.__yautjaBrowserCapture = [];

  function send(msg) {
    try {
      if (window.__yautjaChrome && window.__yautjaChrome.sendMessage) {
        window.__yautjaChrome.sendMessage(msg);
      }
    } catch {}
  }

  function getOpAndHash(body) {
    if (!body) return null;
    try {
      const json = typeof body === 'string' ? JSON.parse(body) : body;
      if (Array.isArray(json)) {
        for (const q of json) {
          if (q && q.operationName) return [q.operationName, q.extensions?.persistedQuery?.sha256Hash];
        }
      } else if (json.operationName) {
        return [json.operationName, json.extensions?.persistedQuery?.sha256Hash];
      }
    } catch {}
    return null;
  }

  const MAX_CAPTURES = 200;

  function pushCapture(entry) {
    window.__yautjaBrowserCapture.push(entry);
    // Prune on every push — a page-level trim after the IIFE would only run once.
    if (window.__yautjaBrowserCapture.length > MAX_CAPTURES) {
      window.__yautjaBrowserCapture = window.__yautjaBrowserCapture.slice(-MAX_CAPTURES);
    }
  }

  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    if (url && typeof url === 'string' && url.includes('gql')) {
      try {
        const body = init?.body ? (typeof init.body === 'string' ? init.body : JSON.stringify(init.body)) : '';
        const oh = getOpAndHash(body);
        if (oh) {
          pushCapture({
            type: 'fetch', url: url.substring(0, 100), method: init?.method || 'GET',
            op: oh[0], hash: oh[1], body: body.substring(0, 500), timestamp: Date.now(),
          });
          send({ type: 'yautja-gql-capture', op: oh[0], hash: oh[1], url });
        }
      } catch {}
    }
    return origFetch.apply(this, arguments);
  };

  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    const xhr = new OrigXHR();
    let url = '';
    let method = '';
    const origOpen = xhr.open;
    const origSend = xhr.send;
    xhr.open = function(m, u) { method = m; url = u; return origOpen.apply(this, arguments); };
    xhr.send = function(body) {
      if (url.includes('gql')) {
        try {
          const oh = getOpAndHash(body);
          if (oh) {
            pushCapture({
              type: 'xhr', url, method, op: oh[0], hash: oh[1], body: (body || '').substring(0, 500), timestamp: Date.now(),
            });
            send({ type: 'yautja-gql-capture', op: oh[0], hash: oh[1], url });
          }
        } catch {}
      }
      return origSend.apply(this, arguments);
    };
    return xhr;
  };
})();
`;

export class BrowserInterceptorManager {
  private transport: Transport;
  private state: BrowserInterceptor = { active: false, capturedCount: 0 };
  private scriptId?: string;
  private capturedByOp: Map<string, { hash: string; timestamp: number }[]> = new Map();

  constructor(transport: Transport) {
    this.transport = transport;
  }

  async install(): Promise<boolean> {
    if (this.state.active) return true;
    try {
      const r = await this.transport.send('Page.addScriptToEvaluateOnNewDocument', {
        scriptSource: BROWSER_INTERCEPT_SCRIPT,
      });
      this.scriptId = r?.result?.identifier || r?.result?.scriptId;
      this.state = { active: true, capturedCount: 0, startedAt: Date.now(), lastCapturedOp: 'started' };
      return true;
    } catch (e: any) {
      this.state.active = false;
      this.state.lastCapturedHash = 'ERROR: ' + (e.message || 'unknown');
      return false;
    }
  }

  async uninstall(): Promise<void> {
    if (this.scriptId) {
      try { await this.transport.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.scriptId }); } catch {}
      this.scriptId = undefined;
    }
    this.state.active = false;
  }

  isActive(): boolean { return this.state.active; }

  getStatus(): BrowserInterceptor { return { ...this.state }; }

  async pullCaptures(): Promise<any[]> {
    try {
      const r = await this.transport.send('Runtime.evaluate', {
        expression: `JSON.stringify((window.__yautjaBrowserCapture || []).slice(-100))`,
        returnByValue: true,
      });
      const arr = r?.result?.value ? JSON.parse(r.result.value) : [];
      this.state.capturedCount += arr.length;
      for (const item of arr) {
        if (item.op && item.hash) {
          const list = this.capturedByOp.get(item.op) || [];
          list.push({ hash: item.hash, timestamp: item.timestamp });
          if (list.length > 20) list.shift();
          this.capturedByOp.set(item.op, list);
        }
      }
      return arr;
    } catch {
      return [];
    }
  }

  getLatestForOp(opName: string): { hash: string; timestamp: number } | null {
    const list = this.capturedByOp.get(opName);
    if (!list || list.length === 0) return null;
    return list[list.length - 1];
  }

  clear(): void {
    this.capturedByOp.clear();
    this.state.capturedCount = 0;
  }
}

export interface Transport {
  send(method: string, params?: Record<string, any>): Promise<any>;
}