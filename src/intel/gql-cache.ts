import fs from 'fs';
import path from 'path';

export interface GQLEndpointInfo {
  endpoint: string;
  headers: Record<string, string>;
  queries: Record<string, string>;
  rawQueries: Record<string, string>;
  updatedAt: number;
}

const CACHE_DIR = path.join(process.env.APPDATA || process.env.HOME || '/tmp', '.yautja-gql-cache');

export class GQLCache {
  private cache: Map<string, GQLEndpointInfo> = new Map();

  constructor() {
    try { if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
  }

  private key(domain: string): string {
    return domain.replace(/[^a-z0-9.-]/gi, '_') + '.json';
  }

  get(domain: string): GQLEndpointInfo | null {
    if (this.cache.has(domain)) return this.cache.get(domain)!;
    try {
      const file = path.join(CACHE_DIR, this.key(domain));
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8')) as GQLEndpointInfo;
        this.cache.set(domain, data);
        return data;
      }
    } catch {}
    return null;
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
    this.cache.set(domain, merged);
    try {
      const file = path.join(CACHE_DIR, this.key(domain));
      fs.writeFileSync(file, JSON.stringify(merged, null, 2));
    } catch {}
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
    existing.updatedAt = Date.now();
    this.set(domain, existing);
  }

  getHash(domain: string, operationName: string): string | undefined {
    return this.get(domain)?.queries[operationName];
  }

  getRawQuery(domain: string, operationName: string): string | undefined {
    return this.get(domain)?.rawQueries[operationName];
  }

  listDomains(): string[] {
    try {
      if (!fs.existsSync(CACHE_DIR)) return [];
      return fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '').replace(/_/g, '.'));
    } catch { return []; }
  }

  clear(domain?: string): void {
    if (domain) {
      this.cache.delete(domain);
      try { fs.unlinkSync(path.join(CACHE_DIR, this.key(domain))); } catch {}
    } else {
      this.cache.clear();
      try { for (const f of fs.readdirSync(CACHE_DIR)) fs.unlinkSync(path.join(CACHE_DIR, f)); } catch {}
    }
  }
}