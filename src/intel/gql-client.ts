import { GQLCache } from './gql-cache.js';
import https from 'https';

export interface GQLQueryOptions {
  endpoint?: string;
  query?: string;
  variables?: Record<string, any>;
  hash?: string;
  operationName?: string;
  headers?: Record<string, string>;
  cookies?: string;
}

export interface GQLQueryResult {
  success: boolean;
  data?: any;
  errors?: any[];
  method: 'raw' | 'persisted' | 'cache-hit';
  endpoint?: string;
  cached?: boolean;
  fallback?: string;
}

export interface Transport {
  send(method: string, params?: Record<string, any>): Promise<any>;
}

const COMMON_ENDPOINTS = ['/gql', '/graphql', '/api/graphql', '/api/gql', '/v1/graphql', '/v2/graphql', '/query'];

const COMMON_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
};

export class GQLClient {
  private transport: Transport;
  private cache: GQLCache;

  constructor(transport: Transport, cache: GQLCache) {
    this.transport = transport;
    this.cache = cache;
  }

  async query(domain: string, opts: GQLQueryOptions): Promise<GQLQueryResult> {
    const endpoint = opts.endpoint || this.cache.get(domain)?.endpoint || '';
    const headers = { ...COMMON_HEADERS, ...(this.cache.get(domain)?.headers || {}), ...(opts.headers || {}) };

    if (opts.hash || opts.operationName) {
      const hash = opts.hash || this.cache.getHash(domain, opts.operationName || '');
      if (hash) {
        const persisted = await this.sendPersisted(endpoint, hash, opts.variables, opts.operationName, headers, opts.cookies);
        if (persisted.success) {
          this.cache.addHash(domain, opts.operationName || 'unknown', hash, opts.query);
          return persisted;
        }
        if (!opts.query) return persisted;
      }
    }

    if (opts.query) {
      const raw = await this.sendRaw(endpoint, opts.query, opts.variables, opts.operationName, headers, opts.cookies);
      if (raw.success) {
        if (opts.operationName) {
          this.cache.set(domain, { rawQueries: { [opts.operationName]: opts.query } });
        }
        return raw;
      }
      return { ...raw, fallback: 'Try with hash from cache or use visual scraping' };
    }

    return {
      success: false,
      errors: [{ message: 'No query or hash provided. Use query for raw GraphQL, hash for persisted query, or operationName if hash is cached.' }],
      method: 'raw',
      fallback: 'Use osintHarvest or scrap the page DOM',
    };
  }

  async discoverEndpoint(domain: string, baseUrl: string): Promise<string | null> {
    for (const ep of COMMON_ENDPOINTS) {
      try {
        const url = baseUrl.replace(/\/$/, '') + ep;
        const r = await this.transport.send('Runtime.evaluate', {
          expression: `(async () => {
            try {
              const res = await fetch('${url}', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: '{ __typename }' }),
                mode: 'cors',
                credentials: 'omit',
              });
              return JSON.stringify({ status: res.status, body: (await res.text()).substring(0, 200) });
            } catch(e) { return JSON.stringify({ error: e.message }); }
          })()`,
          awaitPromise: true,
          returnByValue: true,
        });
        const data = JSON.parse(r?.result?.value || '{}');
        if (data.status === 200 && data.body && !data.body.includes('Not Found')) {
          this.cache.set(domain, { endpoint: url });
          return url;
        }
      } catch {}
    }
    return null;
  }

  private async sendRaw(endpoint: string, query: string, variables?: any, operationName?: string, headers: Record<string, string> = {}, cookies?: string): Promise<GQLQueryResult> {
    if (!endpoint) return { success: false, errors: [{ message: 'No endpoint' }], method: 'raw' };
    const allHeaders = { ...(cookies ? { Cookie: cookies } : {}), ...headers };
    const body = JSON.stringify({ query, variables, operationName });
    const result = await this.nodeFetch(endpoint, allHeaders, body);
    if (result.error) return { success: false, errors: [{ message: result.error }], method: 'raw', endpoint };
    if (result.status !== 200) return { success: false, errors: [{ message: `HTTP ${result.status}`, body: result.body }], method: 'raw', endpoint };
    try {
      const json = JSON.parse(result.body);
      if (json.errors) return { success: false, errors: json.errors, method: 'raw', endpoint };
      return { success: true, data: json.data, method: 'raw', endpoint };
    } catch (e: any) {
      return { success: false, errors: [{ message: `Parse error: ${e.message}`, body: result.body.substring(0, 200) }], method: 'raw', endpoint };
    }
  }

  private async sendPersisted(endpoint: string, hash: string, variables?: any, operationName?: string, headers: Record<string, string> = {}, cookies?: string): Promise<GQLQueryResult> {
    if (!endpoint) return { success: false, errors: [{ message: 'No endpoint' }], method: 'persisted' };
    const allHeaders = { ...(cookies ? { Cookie: cookies } : {}), ...headers };
    const body = JSON.stringify([{ operationName, variables, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }]);
    const result = await this.nodeFetch(endpoint, allHeaders, body);
    if (result.error) return { success: false, errors: [{ message: result.error }], method: 'persisted', endpoint };
    if (result.status !== 200) return { success: false, errors: [{ message: `HTTP ${result.status}`, body: result.body }], method: 'persisted', endpoint };
    try {
      const json = JSON.parse(result.body);
      const item = Array.isArray(json) ? json[0] : json;
      if (item?.errors) {
        const isPersistedNotFound = item.errors.some((e: any) => e.message === 'PersistedQueryNotFound');
        return {
          success: false,
          errors: item.errors,
          method: 'persisted',
          endpoint,
          fallback: isPersistedNotFound ? 'Hash not registered yet. Client must call it first.' : undefined,
        };
      }
      return { success: true, data: item?.data, method: 'persisted', endpoint, cached: true };
    } catch (e: any) {
      return { success: false, errors: [{ message: `Parse error: ${e.message}` }], method: 'persisted', endpoint };
    }
  }

  private nodeFetch(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string; error?: string }> {
    return new Promise((resolve) => {
      try {
        const urlObj = new URL(url);
        const options: https.RequestOptions = {
          hostname: urlObj.hostname,
          path: urlObj.pathname + urlObj.search,
          method: 'POST',
          headers: {
            ...headers,
            'Content-Length': Buffer.byteLength(body),
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
            'Accept': 'application/json',
          },
        };
        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
        });
        req.on('error', (e: any) => resolve({ status: 0, body: '', error: 'HTTPS_ERROR: ' + e.message + ' code=' + (e.code || '?') }));
        req.write(body);
        req.end();
      } catch (e: any) {
        resolve({ status: 0, body: '', error: e.message });
      }
    });
  }
}