import { describe, it, expect, beforeEach } from 'vitest';
import {
  BrowserInterceptorManager,
  BROWSER_INTERCEPT_SCRIPT,
  type Transport,
} from '../../src/intel/browser-interceptor.js';

class MockTransport implements Transport {
  calls: { method: string; params?: Record<string, any> }[] = [];
  responder: (method: string, params?: Record<string, any>) => any = () => ({});

  async send(method: string, params?: Record<string, any>): Promise<any> {
    this.calls.push({ method, params });
    return this.responder(method, params);
  }

  callsFor(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
}

function gqlCapture(op: string, hash: string, extra: Record<string, any> = {}) {
  return { type: 'fetch', url: 'https://x/gql', method: 'POST', op, hash, timestamp: 1000, ...extra };
}

describe('BrowserInterceptorManager', () => {
  let transport: MockTransport;
  let manager: InstanceType<typeof BrowserInterceptorManager>;

  beforeEach(() => {
    transport = new MockTransport();
    manager = new BrowserInterceptorManager(transport);
  });

  describe('install', () => {
    it('sends Page.addScriptToEvaluateOnNewDocument with the intercept script', async () => {
      transport.responder = () => ({ result: { identifier: 'script-1' } });
      const ok = await manager.install();
      expect(ok).toBe(true);
      const calls = transport.callsFor('Page.addScriptToEvaluateOnNewDocument');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.params!.scriptSource).toBe(BROWSER_INTERCEPT_SCRIPT);
    });

    it('activates state with startedAt and lastCapturedOp=started', async () => {
      transport.responder = () => ({ result: { identifier: 'script-1' } });
      await manager.install();
      expect(manager.isActive()).toBe(true);
      const s = manager.getStatus();
      expect(s.active).toBe(true);
      expect(s.capturedCount).toBe(0);
      expect(typeof s.startedAt).toBe('number');
      expect(s.lastCapturedOp).toBe('started');
    });

    it('accepts result.scriptId when identifier is absent', async () => {
      transport.responder = () => ({ result: { scriptId: 'sid-9' } });
      await manager.install();
      await manager.uninstall();
      const calls = transport.callsFor('Page.removeScriptToEvaluateOnNewDocument');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.params).toEqual({ identifier: 'sid-9' });
    });

    it('is idempotent: second install returns true without another CDP call', async () => {
      transport.responder = () => ({ result: { identifier: 'script-1' } });
      expect(await manager.install()).toBe(true);
      expect(await manager.install()).toBe(true);
      expect(transport.callsFor('Page.addScriptToEvaluateOnNewDocument')).toHaveLength(1);
    });

    it('on transport error returns false and records ERROR in state', async () => {
      transport.responder = () => {
        throw new Error('target closed');
      };
      const ok = await manager.install();
      expect(ok).toBe(false);
      expect(manager.isActive()).toBe(false);
      expect(manager.getStatus().lastCapturedHash).toBe('ERROR: target closed');
    });
  });

  describe('uninstall', () => {
    it('removes the installed script and deactivates', async () => {
      transport.responder = () => ({ result: { identifier: 'script-1' } });
      await manager.install();
      await manager.uninstall();
      expect(manager.isActive()).toBe(false);
      expect(transport.callsFor('Page.removeScriptToEvaluateOnNewDocument')).toHaveLength(1);
    });

    it('without prior install sends nothing', async () => {
      await manager.uninstall();
      expect(transport.calls).toHaveLength(0);
      expect(manager.isActive()).toBe(false);
    });

    it('second uninstall does not re-send the removal', async () => {
      transport.responder = () => ({ result: { identifier: 'script-1' } });
      await manager.install();
      await manager.uninstall();
      await manager.uninstall();
      expect(transport.callsFor('Page.removeScriptToEvaluateOnNewDocument')).toHaveLength(1);
    });

    it('swallows transport errors during removal', async () => {
      let fail = false;
      transport.responder = () => {
        if (fail) throw new Error('gone');
        return { result: { identifier: 'script-1' } };
      };
      await manager.install();
      fail = true;
      await expect(manager.uninstall()).resolves.toBeUndefined();
      expect(manager.isActive()).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('returns a copy — mutating it does not affect internal state', async () => {
      transport.responder = () => ({ result: { identifier: 's' } });
      await manager.install();
      const s = manager.getStatus();
      s.active = false;
      s.capturedCount = 999;
      expect(manager.isActive()).toBe(true);
      expect(manager.getStatus().capturedCount).toBe(0);
    });
  });

  describe('pullCaptures', () => {
    beforeEach(async () => {
      transport.responder = (method) =>
        method === 'Page.addScriptToEvaluateOnNewDocument'
          ? { result: { identifier: 's' } }
          : {};
      await manager.install();
    });

    function respondWithCaptures(arr: any[]) {
      transport.responder = () => ({ result: { value: JSON.stringify(arr) } });
    }

    it('evaluates window.__yautjaBrowserCapture via Runtime.evaluate', async () => {
      respondWithCaptures([]);
      await manager.pullCaptures();
      const calls = transport.callsFor('Runtime.evaluate');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.params!.returnByValue).toBe(true);
      expect(calls[0]!.params!.expression).toContain('__yautjaBrowserCapture');
    });

    it('returns the parsed captures and accumulates capturedCount', async () => {
      respondWithCaptures([gqlCapture('OpA', 'h1'), gqlCapture('OpB', 'h2')]);
      const arr = await manager.pullCaptures();
      expect(arr).toHaveLength(2);
      expect(manager.getStatus().capturedCount).toBe(2);
      respondWithCaptures([gqlCapture('OpC', 'h3')]);
      await manager.pullCaptures();
      expect(manager.getStatus().capturedCount).toBe(3);
    });

    it('indexes hashes per operation; getLatestForOp returns the newest', async () => {
      respondWithCaptures([
        gqlCapture('OpA', 'h1', { timestamp: 1 }),
        gqlCapture('OpA', 'h2', { timestamp: 2 }),
        gqlCapture('OpB', 'hB', { timestamp: 3 }),
      ]);
      await manager.pullCaptures();
      expect(manager.getLatestForOp('OpA')).toEqual({ hash: 'h2', timestamp: 2 });
      expect(manager.getLatestForOp('OpB')).toEqual({ hash: 'hB', timestamp: 3 });
    });

    it('keeps only the last 20 hashes per op', async () => {
      const many = Array.from({ length: 25 }, (_, i) => gqlCapture('OpA', `h${i}`, { timestamp: i }));
      respondWithCaptures(many);
      await manager.pullCaptures();
      expect(manager.getLatestForOp('OpA')).toEqual({ hash: 'h24', timestamp: 24 });
    });

    it('entries without op or hash count toward total but are not indexed', async () => {
      respondWithCaptures([
        { type: 'fetch', url: 'https://x/gql', timestamp: 5 },
        gqlCapture('OpA', 'h1'),
      ]);
      const arr = await manager.pullCaptures();
      expect(arr).toHaveLength(2);
      expect(manager.getStatus().capturedCount).toBe(2);
      expect(manager.getLatestForOp('')).toBeNull();
    });

    it('returns [] when result value is missing', async () => {
      transport.responder = () => ({ result: {} });
      expect(await manager.pullCaptures()).toEqual([]);
      transport.responder = () => ({});
      expect(await manager.pullCaptures()).toEqual([]);
    });

    it('returns [] on malformed JSON and on transport errors', async () => {
      transport.responder = () => ({ result: { value: '{not json' } });
      expect(await manager.pullCaptures()).toEqual([]);
      transport.responder = () => {
        throw new Error('eval failed');
      };
      expect(await manager.pullCaptures()).toEqual([]);
      expect(manager.getStatus().capturedCount).toBe(0);
    });
  });

  describe('getLatestForOp / clear', () => {
    it('returns null for unknown operations', () => {
      expect(manager.getLatestForOp('Nope')).toBeNull();
    });

    it('clear resets capturedCount and the per-op index', async () => {
      transport.responder = (method) =>
        method === 'Runtime.evaluate'
          ? { result: { value: JSON.stringify([gqlCapture('OpA', 'h1')]) } }
          : { result: { identifier: 's' } };
      await manager.install();
      await manager.pullCaptures();
      expect(manager.getStatus().capturedCount).toBe(1);
      manager.clear();
      expect(manager.getStatus().capturedCount).toBe(0);
      expect(manager.getLatestForOp('OpA')).toBeNull();
    });
  });
});

describe('BROWSER_INTERCEPT_SCRIPT (executed against a fake window)', () => {
  function makeWindow() {
    const sent: any[] = [];
    const win: any = {
      __yautjaChrome: { sendMessage: (m: any) => sent.push(m) },
      fetch: async (..._args: any[]) => 'original-response',
    };
    class FakeXHR {
      open(_m: string, _u: string) {}
      send(_body?: string) {}
    }
    win.XMLHttpRequest = FakeXHR;
    return { win, sent };
  }

  function runScript(win: any) {
    new Function('window', BROWSER_INTERCEPT_SCRIPT)(win);
  }

  const persistedBody = (op: string, hash: string) =>
    JSON.stringify({ operationName: op, extensions: { persistedQuery: { sha256Hash: hash } } });

  it('initializes __yautja_persistent and the capture array', () => {
    const { win } = makeWindow();
    runScript(win);
    expect(win.__yautja_persistent).toBe(true);
    expect(win.__yautjaBrowserCapture).toEqual([]);
  });

  it('is idempotent: running it twice does not re-wrap fetch', () => {
    const { win } = makeWindow();
    runScript(win);
    const wrapped = win.fetch;
    runScript(win);
    expect(win.fetch).toBe(wrapped);
  });

  it('captures a gql fetch with operationName and persisted hash', async () => {
    const { win, sent } = makeWindow();
    runScript(win);
    const res = await win.fetch('https://api.example.com/gql', {
      method: 'POST',
      body: persistedBody('FollowedChannels', 'abc123'),
    });
    expect(res).toBe('original-response');
    expect(win.__yautjaBrowserCapture).toHaveLength(1);
    const entry = win.__yautjaBrowserCapture[0];
    expect(entry.op).toBe('FollowedChannels');
    expect(entry.hash).toBe('abc123');
    expect(entry.type).toBe('fetch');
    expect(entry.method).toBe('POST');
    expect(typeof entry.timestamp).toBe('number');
    expect(sent).toEqual([
      { type: 'yautja-gql-capture', op: 'FollowedChannels', hash: 'abc123', url: 'https://api.example.com/gql' },
    ]);
  });

  it('captures the first operation of a batched (array) gql body', async () => {
    const { win } = makeWindow();
    runScript(win);
    await win.fetch('https://api.example.com/gql', {
      method: 'POST',
      body: JSON.stringify([
        { operationName: 'First', extensions: { persistedQuery: { sha256Hash: 'h1' } } },
        { operationName: 'Second', extensions: { persistedQuery: { sha256Hash: 'h2' } } },
      ]),
    });
    expect(win.__yautjaBrowserCapture[0].op).toBe('First');
    expect(win.__yautjaBrowserCapture[0].hash).toBe('h1');
  });

  it('ignores non-gql URLs', async () => {
    const { win, sent } = makeWindow();
    runScript(win);
    await win.fetch('https://api.example.com/rest/users', {
      method: 'POST',
      body: persistedBody('Op', 'h'),
    });
    expect(win.__yautjaBrowserCapture).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('ignores gql calls whose body has no operationName or is malformed', async () => {
    const { win } = makeWindow();
    runScript(win);
    await win.fetch('https://api.example.com/gql', { method: 'POST', body: '{not json' });
    await win.fetch('https://api.example.com/gql', { method: 'POST', body: '{"query":"{ x }"}' });
    await win.fetch('https://api.example.com/gql', { method: 'GET' });
    expect(win.__yautjaBrowserCapture).toHaveLength(0);
  });

  it('truncates captured url to 100 chars and body to 500 chars', async () => {
    const { win } = makeWindow();
    runScript(win);
    const longUrl = 'https://api.example.com/gql?' + 'q'.repeat(200);
    const body = JSON.stringify({
      operationName: 'Op',
      extensions: { persistedQuery: { sha256Hash: 'h' } },
      padding: 'p'.repeat(1000),
    });
    await win.fetch(longUrl, { method: 'POST', body });
    const entry = win.__yautjaBrowserCapture[0];
    expect(entry.url).toHaveLength(100);
    expect(entry.body).toHaveLength(500);
  });

  it('captures gql XHR calls', () => {
    const { win, sent } = makeWindow();
    runScript(win);
    const xhr = new win.XMLHttpRequest();
    xhr.open('POST', 'https://api.example.com/gql');
    xhr.send(persistedBody('Viewer', 'hx'));
    expect(win.__yautjaBrowserCapture).toHaveLength(1);
    const entry = win.__yautjaBrowserCapture[0];
    expect(entry.type).toBe('xhr');
    expect(entry.method).toBe('POST');
    expect(entry.op).toBe('Viewer');
    expect(entry.hash).toBe('hx');
    expect(sent).toHaveLength(1);
  });

  it('ignores non-gql XHR calls', () => {
    const { win } = makeWindow();
    runScript(win);
    const xhr = new win.XMLHttpRequest();
    xhr.open('GET', 'https://api.example.com/rest');
    xhr.send('x');
    expect(win.__yautjaBrowserCapture).toHaveLength(0);
  });

  it('still works when __yautjaChrome bridge is missing', async () => {
    const { win } = makeWindow();
    delete win.__yautjaChrome;
    runScript(win);
    const res = await win.fetch('https://api.example.com/gql', {
      method: 'POST',
      body: persistedBody('Op', 'h'),
    });
    expect(res).toBe('original-response');
    expect(win.__yautjaBrowserCapture).toHaveLength(1);
  });
});
