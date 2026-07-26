import { describe, it, expect, beforeEach } from 'vitest';
import {
  NetworkIntel,
  type Transport,
  type NetworkIntelResult,
} from '../../src/intel/network-intel.js';

class MockTransport implements Transport {
  calls: { method: string; params?: Record<string, any> }[] = [];
  response: any = { result: { value: '{}' } };

  async send(method: string, params?: Record<string, any>): Promise<any> {
    this.calls.push({ method, params });
    return this.response;
  }
}

const EMPTY_RESULT: NetworkIntelResult = {
  apis: [],
  tokens: [],
  infra: {
    domains: [],
    cdnDomains: [],
    apiDomains: [],
    analyticsDomains: [],
    trackingDomains: [],
    externalServices: [],
    websocketUrls: [],
  },
  cookies: [],
  localStorageKeys: [],
  sessionStorageKeys: [],
};

// --- Fake browser environment to execute the real INTEL_SCRIPT in Node ---
interface FakePerfEntry {
  name: string;
  initiatorType?: string;
  encodedBodySize?: number;
}

interface FakeBrowserEnv {
  entries?: FakePerfEntry[];
  localStorage?: Record<string, string> | { throwing: true };
  sessionStorage?: Record<string, string>;
  cookie?: string;
  metas?: Record<string, string | null>[];
  hostname?: string;
  protocol?: string;
}

function makeStorage(data: Record<string, string>): any {
  const keys = Object.keys(data);
  return {
    get length() {
      return keys.length;
    },
    key: (i: number) => (i >= 0 && i < keys.length ? keys[i]! : null),
    getItem: (k: string) => (k in data ? data[k]! : null),
  };
}

function runIntelScript(expression: string, env: FakeBrowserEnv): any {
  const ls =
    env.localStorage && 'throwing' in env.localStorage
      ? {
          get length(): number {
            throw new Error('SecurityError: access denied');
          },
        }
      : makeStorage((env.localStorage as Record<string, string>) ?? {});
  const ss = makeStorage(env.sessionStorage ?? {});
  const metas = (env.metas ?? []).map((attrs) => ({
    getAttribute: (n: string) => attrs[n] ?? null,
  }));
  const document = {
    cookie: env.cookie ?? '',
    querySelectorAll: (sel: string) => (sel === 'meta' ? metas : []),
  };
  const performance = {
    getEntriesByType: (_type: string) => env.entries ?? [],
  };
  const location = {
    hostname: env.hostname ?? 'example.com',
    protocol: env.protocol ?? 'https:',
  };
  const fn = new Function(
    'performance',
    'localStorage',
    'sessionStorage',
    'document',
    'location',
    `return (${expression});`,
  );
  return JSON.parse(fn(performance, ls, ss, document, location));
}

describe('NetworkIntel', () => {
  let transport: MockTransport;
  let intel: NetworkIntel;

  beforeEach(() => {
    transport = new MockTransport();
    intel = new NetworkIntel(transport);
  });

  describe('transport interaction', () => {
    it('sends Runtime.evaluate once with returnByValue and the intel script', async () => {
      await intel.analyze();
      expect(transport.calls).toHaveLength(1);
      const call = transport.calls[0]!;
      expect(call.method).toBe('Runtime.evaluate');
      expect(call.params!.returnByValue).toBe(true);
      expect(typeof call.params!.expression).toBe('string');
      expect(call.params!.expression).toContain('performance.getEntriesByType');
    });
  });

  describe('empty / malformed responses', () => {
    it('returns the empty result when response is undefined', async () => {
      transport.response = undefined;
      expect(await intel.analyze()).toEqual(EMPTY_RESULT);
    });

    it('returns the empty result when result is missing', async () => {
      transport.response = {};
      expect(await intel.analyze()).toEqual(EMPTY_RESULT);
    });

    it('returns the empty result when value is an empty string', async () => {
      transport.response = { result: { value: '' } };
      expect(await intel.analyze()).toEqual(EMPTY_RESULT);
    });

    it('returns the empty result when value is null', async () => {
      transport.response = { result: { value: null } };
      expect(await intel.analyze()).toEqual(EMPTY_RESULT);
    });

    it('rejects when the value is not valid JSON', async () => {
      transport.response = { result: { value: 'not json{' } };
      await expect(intel.analyze()).rejects.toThrow(SyntaxError);
    });

    it('defaults missing fields in the parsed payload to empty arrays', async () => {
      transport.response = { result: { value: JSON.stringify({}) } };
      expect(await intel.analyze()).toEqual(EMPTY_RESULT);
    });
  });

  describe('result mapping', () => {
    it('passes through apis, tokens, cookies and storage keys', async () => {
      const raw = {
        apis: [{ url: 'https://ex.com/api/x', method: 'GET', status: 0, mimeType: '', hasAuth: false, responseSize: 10 }],
        tokens: [{ type: 'cookie', name: 'csrf', value: 'v', location: 'cookie' }],
        domains: {},
        wsUrls: ['wss://ex.com/ws'],
        cookies: [{ name: 'sid', domain: 'ex.com', secure: true, httpOnly: false, session: true }],
        lsKeys: ['a'],
        ssKeys: ['b'],
      };
      transport.response = { result: { value: JSON.stringify(raw) } };
      const r = await intel.analyze();
      expect(r.apis).toEqual(raw.apis);
      expect(r.tokens).toEqual(raw.tokens);
      expect(r.cookies).toEqual(raw.cookies);
      expect(r.localStorageKeys).toEqual(['a']);
      expect(r.sessionStorageKeys).toEqual(['b']);
      expect(r.infra.websocketUrls).toEqual(['wss://ex.com/ws']);
    });
  });

  describe('infra classification', () => {
    it('classifies domains into cdn / analytics / tracking / api / static / other', async () => {
      const raw = {
        domains: {
          'static.cloudflare.com': { count: 3, categories: [] },
          'google-analytics.com': { count: 1, categories: [] },
          'doubleclick.net': { count: 1, categories: [] },
          'api.example.com': { count: 2, categories: [] },
          'graphql.foo.com': { count: 1, categories: [] },
          'assets.bar.com': { count: 1, categories: [] },
          'plain.org': { count: 1, categories: [] },
        },
      };
      transport.response = { result: { value: JSON.stringify(raw) } };
      const r = await intel.analyze();

      expect(r.infra.domains).toEqual([
        'static.cloudflare.com',
        'google-analytics.com',
        'doubleclick.net',
        'api.example.com',
        'graphql.foo.com',
        'assets.bar.com',
        'plain.org',
      ]);
      expect(r.infra.cdnDomains).toEqual(['static.cloudflare.com']);
      expect(r.infra.analyticsDomains).toEqual(['google-analytics.com', 'doubleclick.net']);
      expect(r.infra.trackingDomains).toEqual(['doubleclick.net']);
      expect(r.infra.apiDomains).toEqual(['api.example.com', 'graphql.foo.com']);

      const categories = Object.fromEntries(
        r.infra.externalServices.map((s) => [s.domain, s.category]),
      );
      expect(categories).toEqual({
        'static.cloudflare.com': 'cdn',
        'google-analytics.com': 'analytics',
        'doubleclick.net': 'analytics',
        'api.example.com': 'api',
        'graphql.foo.com': 'api',
        'assets.bar.com': 'static',
        'plain.org': 'other',
      });
    });

    it('handles an empty domains map', async () => {
      transport.response = { result: { value: JSON.stringify({ domains: {} }) } };
      const r = await intel.analyze();
      expect(r.infra.domains).toEqual([]);
      expect(r.infra.externalServices).toEqual([]);
    });
  });

  describe('INTEL_SCRIPT execution against a fake DOM', () => {
    let expression: string;

    beforeEach(async () => {
      await intel.analyze();
      expression = transport.calls[0]!.params!.expression;
    });

    it('detects APIs by path pattern and initiatorType, deduplicated, with sizes', () => {
      const raw = runIntelScript(expression, {
        entries: [
          { name: 'https://ex.com/api/users', initiatorType: 'fetch', encodedBodySize: 512 },
          { name: 'https://ex.com/v2/items', initiatorType: 'other' },
          { name: 'https://ex.com/graphql', initiatorType: 'xmlhttprequest' },
          { name: 'https://ex.com/api/users', initiatorType: 'fetch' },
          { name: 'https://ex.com/static/logo.png', initiatorType: 'img' },
        ],
      });
      expect(raw.apis).toHaveLength(3);
      const urls = raw.apis.map((a: any) => a.url).sort();
      expect(urls).toEqual(['https://ex.com/api/users', 'https://ex.com/graphql', 'https://ex.com/v2/items']);
      const usersApi = raw.apis.find((a: any) => a.url === 'https://ex.com/api/users');
      expect(usersApi.responseSize).toBe(512);
      expect(usersApi.method).toBe('GET');
    });

    it('collects websocket URLs from performance entries', () => {
      const raw = runIntelScript(expression, {
        entries: [
          { name: 'wss://ex.com/socket', initiatorType: 'other' },
          { name: 'https://ex.com/page', initiatorType: 'other' },
        ],
      });
      expect(raw.wsUrls).toEqual(['wss://ex.com/socket']);
      expect(raw.domains['ex.com']).toBeDefined();
    });

    it('skips unparseable performance entry names without throwing', () => {
      const raw = runIntelScript(expression, {
        entries: [
          { name: 'not a url at all', initiatorType: 'fetch' },
          { name: 'https://ex.com/api/ok', initiatorType: 'fetch' },
        ],
      });
      expect(raw.apis).toHaveLength(1);
      expect(raw.apis[0].url).toBe('https://ex.com/api/ok');
    });

    it('finds token-like keys and JWTs in localStorage', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const raw = runIntelScript(expression, {
        localStorage: { auth_token: 'secretvalue', plain: 'x', id: jwt },
      });
      expect(raw.lsKeys.sort()).toEqual(['auth_token', 'id', 'plain']);
      const lsToken = raw.tokens.find((t: any) => t.name === 'auth_token');
      expect(lsToken).toMatchObject({ type: 'localStorage', value: 'secretvalue', location: 'localStorage' });
      const jwtToken = raw.tokens.find((t: any) => t.type === 'JWT');
      expect(jwtToken).toMatchObject({ name: 'id', location: 'localStorage' });
    });

    it('truncates localStorage token values to 100 chars', () => {
      const raw = runIntelScript(expression, {
        localStorage: { api_token: 'x'.repeat(200) },
      });
      const token = raw.tokens.find((t: any) => t.name === 'api_token');
      expect(token.value).toHaveLength(100);
    });

    it('finds token-like keys in sessionStorage', () => {
      const raw = runIntelScript(expression, {
        sessionStorage: { session_id: 'sess-value', other: 'no' },
      });
      expect(raw.ssKeys.sort()).toEqual(['other', 'session_id']);
      const token = raw.tokens.find((t: any) => t.location === 'sessionStorage');
      expect(token).toMatchObject({ type: 'sessionStorage', name: 'session_id', value: 'sess-value' });
    });

    it('finds tokens in cookies and reports cookie details', () => {
      const raw = runIntelScript(expression, {
        cookie: 'csrf_token=abc123; sid=xyz; theme=dark',
        hostname: 'ex.com',
        protocol: 'https:',
      });
      const cookieToken = raw.tokens.find((t: any) => t.location === 'cookie');
      expect(cookieToken).toMatchObject({ type: 'cookie', name: 'csrf_token', value: 'abc123' });

      expect(raw.cookies).toHaveLength(3);
      const sid = raw.cookies.find((c: any) => c.name === 'sid');
      expect(sid).toMatchObject({ domain: 'ex.com', secure: true, httpOnly: false });
      expect(Boolean(sid.session)).toBe(true);
      const theme = raw.cookies.find((c: any) => c.name === 'theme');
      expect(Boolean(theme.session)).toBe(false);
    });

    it('marks cookies insecure on http pages', () => {
      const raw = runIntelScript(expression, {
        cookie: 'a=b',
        protocol: 'http:',
      });
      expect(raw.cookies[0].secure).toBe(false);
    });

    it('finds tokens in meta tags with content', () => {
      const raw = runIntelScript(expression, {
        metas: [
          { name: 'csrf-token', content: 'tok123' },
          { name: 'description', content: 'a page' },
          { name: 'api-key', content: null },
        ],
      });
      expect(raw.tokens).toHaveLength(1);
      expect(raw.tokens[0]).toMatchObject({ type: 'meta', name: 'csrf-token', value: 'tok123', location: 'meta' });
    });

    it('survives localStorage throwing a SecurityError', () => {
      const raw = runIntelScript(expression, {
        localStorage: { throwing: true },
        cookie: 'auth_token=fromcookie',
      });
      expect(raw.lsKeys).toEqual([]);
      expect(raw.tokens.some((t: any) => t.location === 'cookie')).toBe(true);
    });

    it('returns empty collections for a blank page (with a phantom cookie entry from the empty cookie string)', () => {
      const raw = runIntelScript(expression, {});
      // NOTE: ''.split(';') yields [''], so the script always emits one cookie
      // with an empty name even when document.cookie is empty (source quirk).
      expect(raw).toEqual({
        apis: [],
        tokens: [],
        domains: {},
        wsUrls: [],
        cookies: [{ name: '', domain: 'example.com', secure: true, httpOnly: false, session: true }],
        lsKeys: [],
        ssKeys: [],
      });
    });
  });

  describe('end-to-end: script output through analyze()', () => {
    it('classifies domains produced by the real script', async () => {
      // First call captures the expression; second call feeds back script output.
      await intel.analyze();
      const expression = transport.calls[0]!.params!.expression;
      const raw = runIntelScript(expression, {
        entries: [
          { name: 'https://api.ex.com/v1/users', initiatorType: 'fetch' },
          { name: 'https://cdnjs.cloudflare.com/lib.js', initiatorType: 'script' },
        ],
        localStorage: { jwt_token: 'abc' },
      });
      transport.response = { result: { value: JSON.stringify(raw) } };
      const r = await intel.analyze();
      expect(r.apis.map((a) => a.url)).toEqual(['https://api.ex.com/v1/users']);
      expect(r.infra.apiDomains).toEqual(['api.ex.com']);
      expect(r.infra.cdnDomains).toEqual(['cdnjs.cloudflare.com']);
      expect(r.tokens[0]).toMatchObject({ name: 'jwt_token', location: 'localStorage' });
    });
  });
});
