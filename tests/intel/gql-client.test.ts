import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { GQLClient, type Transport } from '../../src/intel/gql-client.js';
import type { GQLCache, GQLEndpointInfo } from '../../src/intel/gql-cache.js';

// ---------------------------------------------------------------------------
// In-memory fake for GQLCache (avoids touching the real APPDATA cache dir)
// ---------------------------------------------------------------------------
class FakeGQLCache {
  store: Map<string, GQLEndpointInfo> = new Map();

  get(domain: string): GQLEndpointInfo | null {
    return this.store.get(domain) ?? null;
  }

  set(domain: string, info: Partial<GQLEndpointInfo>): GQLEndpointInfo {
    const existing = this.get(domain);
    const merged: GQLEndpointInfo = {
      endpoint: info.endpoint || existing?.endpoint || '',
      headers: { ...(existing?.headers || {}), ...(info.headers || {}) },
      queries: { ...(existing?.queries || {}), ...(info.queries || {}) },
      rawQueries: { ...(existing?.rawQueries || {}), ...(info.rawQueries || {}) },
      updatedAt: Date.now(),
    };
    this.store.set(domain, merged);
    return merged;
  }

  addHash(domain: string, operationName: string, hash: string, query?: string): void {
    const existing = this.get(domain) || {
      endpoint: '',
      headers: {},
      queries: {},
      rawQueries: {},
      updatedAt: Date.now(),
    };
    existing.queries[operationName] = hash;
    if (query) existing.rawQueries[operationName] = query;
    this.set(domain, existing);
  }

  getHash(domain: string, operationName: string): string | undefined {
    return this.get(domain)?.queries[operationName];
  }

  getRawQuery(domain: string, operationName: string): string | undefined {
    return this.get(domain)?.rawQueries[operationName];
  }

  clear(domain?: string): void {
    if (domain) this.store.delete(domain);
    else this.store.clear();
  }
}

// ---------------------------------------------------------------------------
// Fake https.request — queues responses, captures requests. No real network.
// ---------------------------------------------------------------------------
interface FakeNetResponse {
  status: number;
  body: string;
  error?: Error;
}

interface CapturedRequest {
  options: https.RequestOptions;
  body: string;
}

const netResponses: FakeNetResponse[] = [];
const netRequests: CapturedRequest[] = [];

function queueResponse(status: number, body: string): void {
  netResponses.push({ status, body });
}

function queueNetworkError(message: string, code = 'ECONNREFUSED'): void {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  netResponses.push({ status: 0, body: '', error: err });
}

function lastRequest(): CapturedRequest {
  const r = netRequests[netRequests.length - 1];
  if (!r) throw new Error('no https request captured');
  return r;
}

// ---------------------------------------------------------------------------
// MockTransport for CDP (discoverEndpoint uses Runtime.evaluate)
// ---------------------------------------------------------------------------
class MockTransport implements Transport {
  sendImpl: (method: string, params?: Record<string, any>) => Promise<any> = async () => ({});
  calls: { method: string; params?: Record<string, any> }[] = [];

  async send(method: string, params?: Record<string, any>): Promise<any> {
    this.calls.push({ method, params });
    return this.sendImpl(method, params);
  }
}

function evaluateReturning(value: unknown): { result: { value: string } } {
  return { result: { value: JSON.stringify(value) } };
}

// ---------------------------------------------------------------------------

describe('GQLClient', () => {
  let cache: FakeGQLCache;
  let transport: MockTransport;
  let client: GQLClient;
  let requestSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    netResponses.length = 0;
    netRequests.length = 0;

    requestSpy = vi.spyOn(https, 'request').mockImplementation(((options: any, callback: any) => {
      const req = new EventEmitter() as any;
      const captured: CapturedRequest = { options, body: '' };
      netRequests.push(captured);
      req.write = (chunk: string) => { captured.body += chunk; };
      req.end = () => {
        const r = netResponses.shift();
        if (!r) throw new Error('no fake https response queued');
        if (r.error) {
          queueMicrotask(() => req.emit('error', r.error));
          return;
        }
        const res = new EventEmitter() as any;
        res.statusCode = r.status;
        callback(res);
        queueMicrotask(() => {
          res.emit('data', r.body);
          res.emit('end');
        });
      };
      req.setTimeout = () => {};
      return req;
    }) as any);

    cache = new FakeGQLCache();
    transport = new MockTransport();
    client = new GQLClient(transport, cache as unknown as GQLCache);
  });

  afterEach(() => {
    requestSpy.mockRestore();
  });

  describe('query — input validation', () => {
    it('returns an error with scraping fallback when neither query nor hash is provided', async () => {
      const result = await client.query('example.com', {});
      expect(result.success).toBe(false);
      expect(result.method).toBe('raw');
      expect(result.errors![0]!.message).toContain('No query or hash provided');
      expect(result.fallback).toBe('Use osintHarvest or scrap the page DOM');
      expect(netRequests).toHaveLength(0);
    });

    it('returns the same error when operationName has no cached hash and no query', async () => {
      const result = await client.query('example.com', { operationName: 'Missing' });
      expect(result.success).toBe(false);
      expect(result.errors![0]!.message).toContain('No query or hash provided');
      expect(netRequests).toHaveLength(0);
    });

    it('fails fast with "No endpoint" when no endpoint is given or cached', async () => {
      const result = await client.query('example.com', { query: '{ __typename }' });
      expect(result.success).toBe(false);
      expect(result.errors![0]!.message).toBe('No endpoint');
      expect(result.fallback).toBe('Try with hash from cache or use visual scraping');
      expect(netRequests).toHaveLength(0);
    });
  });

  describe('query — raw mode', () => {
    const endpoint = 'https://api.example.com/graphql';

    it('succeeds with a 200 JSON response containing data', async () => {
      queueResponse(200, JSON.stringify({ data: { viewer: { id: '1' } } }));
      const result = await client.query('example.com', { endpoint, query: '{ viewer { id } }' });
      expect(result.success).toBe(true);
      expect(result.method).toBe('raw');
      expect(result.endpoint).toBe(endpoint);
      expect(result.data).toEqual({ viewer: { id: '1' } });

      const req = lastRequest();
      expect(req.options.hostname).toBe('api.example.com');
      expect(req.options.path).toBe('/graphql');
      expect(req.options.method).toBe('POST');
      const sentBody = JSON.parse(req.body);
      expect(sentBody.query).toBe('{ viewer { id } }');
    });

    it('sends variables, operationName and merged headers', async () => {
      queueResponse(200, JSON.stringify({ data: {} }));
      await client.query('example.com', {
        endpoint,
        query: 'query GetUser($id: ID!) { user(id: $id) { id } }',
        variables: { id: '42' },
        operationName: 'GetUser',
        headers: { 'x-custom': 'yes' },
        cookies: 'session=abc',
      });

      const req = lastRequest();
      const headers = req.options.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['x-custom']).toBe('yes');
      expect(headers['Cookie']).toBe('session=abc');
      expect(headers['Content-Length']).toBe(Buffer.byteLength(req.body));

      const sentBody = JSON.parse(req.body);
      expect(sentBody.variables).toEqual({ id: '42' });
      expect(sentBody.operationName).toBe('GetUser');
    });

    it('caches the raw query under operationName on success', async () => {
      queueResponse(200, JSON.stringify({ data: { ok: true } }));
      const result = await client.query('example.com', {
        endpoint,
        query: 'query Foo { foo }',
        operationName: 'Foo',
      });
      expect(result.success).toBe(true);
      expect(cache.getRawQuery('example.com', 'Foo')).toBe('query Foo { foo }');
    });

    it('fails on non-200 status and adds a fallback hint', async () => {
      queueResponse(500, 'Internal Server Error');
      const result = await client.query('example.com', { endpoint, query: '{ x }' });
      expect(result.success).toBe(false);
      expect(result.method).toBe('raw');
      expect(result.errors![0]!.message).toBe('HTTP 500');
      expect(result.fallback).toBe('Try with hash from cache or use visual scraping');
    });

    it('fails when the GraphQL response contains errors', async () => {
      queueResponse(200, JSON.stringify({ errors: [{ message: 'Cannot query field "nope"' }] }));
      const result = await client.query('example.com', { endpoint, query: '{ nope }' });
      expect(result.success).toBe(false);
      expect(result.errors![0]!.message).toContain('Cannot query field');
    });

    it('fails with a parse error on malformed JSON body', async () => {
      queueResponse(200, '<html>not json</html>');
      const result = await client.query('example.com', { endpoint, query: '{ x }' });
      expect(result.success).toBe(false);
      expect(result.errors![0]!.message).toContain('Parse error');
    });

    it('fails with HTTPS_ERROR on network-level errors', async () => {
      queueNetworkError('connect ECONNREFUSED 10.0.0.1:443');
      const result = await client.query('example.com', { endpoint, query: '{ x }' });
      expect(result.success).toBe(false);
      expect(result.errors![0]!.message).toContain('HTTPS_ERROR');
      expect(result.errors![0]!.message).toContain('ECONNREFUSED');
    });

    it('uses the cached endpoint and cached headers when opts.endpoint is omitted', async () => {
      cache.set('example.com', {
        endpoint: 'https://cached.example.com/gql',
        headers: { 'x-csrf': 'token123' },
      });
      queueResponse(200, JSON.stringify({ data: { ok: 1 } }));
      const result = await client.query('example.com', { query: '{ ok }' });

      expect(result.success).toBe(true);
      const req = lastRequest();
      expect(req.options.hostname).toBe('cached.example.com');
      const headers = req.options.headers as Record<string, string>;
      expect(headers['x-csrf']).toBe('token123');
    });

    it('opts.headers override cached headers on conflict', async () => {
      cache.set('example.com', { endpoint, headers: { 'x-auth': 'cached' } });
      queueResponse(200, JSON.stringify({ data: {} }));
      await client.query('example.com', { query: '{ x }', headers: { 'x-auth': 'override' } });
      const headers = lastRequest().options.headers as Record<string, string>;
      expect(headers['x-auth']).toBe('override');
    });
  });

  describe('query — persisted mode', () => {
    const endpoint = 'https://api.example.com/graphql';

    it('sends an APQ-style array body with the sha256Hash extension', async () => {
      queueResponse(200, JSON.stringify([{ data: { user: { id: '7' } } }]));
      const result = await client.query('example.com', {
        endpoint,
        hash: 'abc123',
        operationName: 'GetUser',
        variables: { id: '7' },
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe('persisted');
      expect(result.cached).toBe(true);
      expect(result.data).toEqual({ user: { id: '7' } });

      const sentBody = JSON.parse(lastRequest().body);
      expect(Array.isArray(sentBody)).toBe(true);
      expect(sentBody[0].operationName).toBe('GetUser');
      expect(sentBody[0].variables).toEqual({ id: '7' });
      expect(sentBody[0].extensions.persistedQuery).toEqual({ version: 1, sha256Hash: 'abc123' });
    });

    it('resolves the hash from cache when only operationName is given', async () => {
      cache.set('example.com', { endpoint });
      cache.addHash('example.com', 'Feed', 'deadbeef');
      queueResponse(200, JSON.stringify([{ data: { feed: [] } }]));

      const result = await client.query('example.com', { operationName: 'Feed' });
      expect(result.success).toBe(true);
      const sentBody = JSON.parse(lastRequest().body);
      expect(sentBody[0].extensions.persistedQuery.sha256Hash).toBe('deadbeef');
    });

    it('stores the hash in cache on success', async () => {
      cache.set('example.com', { endpoint });
      queueResponse(200, JSON.stringify([{ data: {} }]));
      const result = await client.query('example.com', {
        hash: 'newhash',
        operationName: 'NewOp',
        query: 'query NewOp { x }',
      });
      expect(result.success).toBe(true);
      expect(cache.getHash('example.com', 'NewOp')).toBe('newhash');
      expect(cache.getRawQuery('example.com', 'NewOp')).toBe('query NewOp { x }');
    });

    it('accepts a plain (non-array) JSON response', async () => {
      queueResponse(200, JSON.stringify({ data: { ok: true } }));
      const result = await client.query('example.com', { endpoint, hash: 'h1' });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ ok: true });
    });

    it('returns the persisted failure when no raw query is available as fallback', async () => {
      queueResponse(200, JSON.stringify([{ errors: [{ message: 'PersistedQueryNotFound' }] }]));
      const result = await client.query('example.com', { endpoint, hash: 'unknown-hash' });
      expect(result.success).toBe(false);
      expect(result.method).toBe('persisted');
      expect(result.errors![0]!.message).toBe('PersistedQueryNotFound');
      expect(result.fallback).toBe('Hash not registered yet. Client must call it first.');
      expect(netRequests).toHaveLength(1);
    });

    it('falls back to the raw query when the persisted call fails and a query is provided', async () => {
      queueResponse(200, JSON.stringify([{ errors: [{ message: 'PersistedQueryNotFound' }] }]));
      queueResponse(200, JSON.stringify({ data: { recovered: true } }));

      const result = await client.query('example.com', {
        endpoint,
        hash: 'stale-hash',
        operationName: 'Op',
        query: 'query Op { recovered }',
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe('raw');
      expect(result.data).toEqual({ recovered: true });
      expect(netRequests).toHaveLength(2);
    });

    it('fails on non-200 status in persisted mode', async () => {
      queueResponse(403, 'Forbidden');
      const result = await client.query('example.com', { endpoint, hash: 'h' });
      expect(result.success).toBe(false);
      expect(result.method).toBe('persisted');
      expect(result.errors![0]!.message).toBe('HTTP 403');
    });

    it('fails with a parse error on malformed JSON in persisted mode', async () => {
      queueResponse(200, '### not json ###');
      const result = await client.query('example.com', { endpoint, hash: 'h' });
      expect(result.success).toBe(false);
      expect(result.method).toBe('persisted');
      expect(result.errors![0]!.message).toContain('Parse error');
    });

    it('fails fast with "No endpoint" in persisted mode when none is available', async () => {
      const result = await client.query('example.com', { hash: 'h', operationName: 'Op' });
      expect(result.success).toBe(false);
      expect(result.method).toBe('persisted');
      expect(result.errors![0]!.message).toBe('No endpoint');
      expect(netRequests).toHaveLength(0);
    });
  });

  describe('discoverEndpoint', () => {
    it('returns the first endpoint that answers 200 and caches it', async () => {
      transport.sendImpl = async () =>
        evaluateReturning({ status: 200, body: '{"data":{"__typename":"Query"}}' });

      const found = await client.discoverEndpoint('example.com', 'https://example.com');
      expect(found).toBe('https://example.com/gql');
      expect(cache.get('example.com')?.endpoint).toBe('https://example.com/gql');
      expect(transport.calls[0]!.method).toBe('Runtime.evaluate');
      expect(transport.calls[0]!.params!.awaitPromise).toBe(true);
      expect(transport.calls).toHaveLength(1);
    });

    it('strips a trailing slash from baseUrl', async () => {
      transport.sendImpl = async () => evaluateReturning({ status: 200, body: '{}' });
      const found = await client.discoverEndpoint('example.com', 'https://example.com/');
      expect(found).toBe('https://example.com/gql');
    });

    it('skips endpoints that do not return 200 and keeps probing', async () => {
      const statuses = [404, 405, 200];
      transport.sendImpl = async () => {
        const status = statuses.shift()!;
        return evaluateReturning({ status, body: status === 200 ? '{"data":{}}' : 'nope' });
      };
      const found = await client.discoverEndpoint('example.com', 'https://example.com');
      expect(found).toBe('https://example.com/api/graphql');
      expect(transport.calls).toHaveLength(3);
    });

    it('rejects 200 responses whose body contains "Not Found"', async () => {
      transport.sendImpl = async () => evaluateReturning({ status: 200, body: '404 Not Found page' });
      const found = await client.discoverEndpoint('example.com', 'https://example.com');
      expect(found).toBeNull();
      expect(cache.get('example.com')).toBeNull();
    });

    it('returns null when every candidate fails', async () => {
      transport.sendImpl = async () => evaluateReturning({ status: 404, body: 'Not Found' });
      const found = await client.discoverEndpoint('example.com', 'https://example.com');
      expect(found).toBeNull();
      expect(transport.calls).toHaveLength(7); // COMMON_ENDPOINTS.length
    });

    it('tolerates transport errors and malformed evaluate results', async () => {
      let i = 0;
      transport.sendImpl = async () => {
        i++;
        if (i === 1) throw new Error('CDP detached');
        if (i === 2) return {}; // no result.value — parses as {}
        return evaluateReturning({ status: 200, body: '{"data":{}}' });
      };
      const found = await client.discoverEndpoint('example.com', 'https://example.com');
      expect(found).toBe('https://example.com/api/graphql');
      expect(transport.calls).toHaveLength(3);
    });
  });
});
