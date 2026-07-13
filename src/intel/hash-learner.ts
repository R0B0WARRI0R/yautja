import { HashSeedDB, HashSeed } from './hash-seed.js';
import { GQLClient } from './gql-client.js';

export interface LearningResult {
  success: boolean;
  hash?: string;
  source: 'cache' | 'external' | 'browser' | 'inference' | 'scraping' | 'none';
  attempts: string[];
  latencyMs: number;
}

export interface Transport {
  send(method: string, params?: Record<string, any>): Promise<any>;
}

const KNOWN_EXTERNAL_SOURCES: { name: string; url: string; parser: (text: string, opName: string) => string | null }[] = [
  {
    name: 'twitch-dev-public',
    url: 'https://raw.githubusercontent.com/twitchdev/pubsub-js/main/src/queries.ts',
    parser: (text, op) => {
      const re = new RegExp(`"${op}":\\s*"([a-f0-9]{64})"`, 'i');
      const m = text.match(re);
      return m ? m[1] : null;
    },
  },
  {
    name: 'twurple-queries',
    url: 'https://raw.githubusercontent.com/twurple/twurple/main/packages/api/src/api/queries.gql.json',
    parser: (text, op) => {
      try {
        const json = JSON.parse(text);
        for (const k of Object.keys(json)) {
          if (k.includes(op) || op.includes(k.replace(/[^A-Za-z]/g, ''))) {
            return json[k];
          }
        }
      } catch {}
      return null;
    },
  },
  {
    name: 'twitch-inspector-gql',
    url: 'https://raw.githubusercontent.com/ThatOneCalculator/twitch-gql/main/queries.json',
    parser: (text, op) => {
      try {
        const json = JSON.parse(text);
        const q = json[op] || json.queries?.[op];
        return typeof q === 'string' && /^[a-f0-9]{64}$/.test(q) ? q : null;
      } catch {}
      return null;
    },
  },
];

export class HashLearner {
  private transport: Transport;
  private seedDB: HashSeedDB;
  private gqlClient: GQLClient;

  constructor(transport: Transport, seedDB: HashSeedDB, gqlClient: GQLClient) {
    this.transport = transport;
    this.seedDB = seedDB;
    this.gqlClient = gqlClient;
  }

  async acquire(operationName: string, domain: string, queryTemplate?: string, endpoint?: string, headers?: Record<string, string>): Promise<LearningResult> {
    const start = Date.now();
    const attempts: string[] = [];

    // Strategy 1: Cache hit
    const cached = this.seedDB.get(operationName, domain);
    if (cached) {
      attempts.push('cache-hit');
      const valid = await this.validateHash(cached.hash, endpoint, headers);
      if (valid) {
        return { success: true, hash: cached.hash, source: 'cache', attempts, latencyMs: Date.now() - start };
      }
      attempts.push('cache-stale-invalidated');
      this.seedDB.invalidate(operationName, domain);
    }

    // Strategy 2: External sources
    for (const source of KNOWN_EXTERNAL_SOURCES) {
      try {
        const r = await this.fetchExternal(source.url);
        if (r) {
          const hash = source.parser(r, operationName);
          if (hash) {
            const valid = await this.validateHash(hash, endpoint, headers);
            if (valid) {
              this.storeSeed(operationName, domain, hash, queryTemplate, 'external');
              return { success: true, hash, source: 'external', attempts: [...attempts, `external:${source.name}`], latencyMs: Date.now() - start };
            }
          }
        }
      } catch {}
    }
    attempts.push('external-exhausted');

    // Strategy 3: Browser interception via content script capture buffer
    try {
      const captured = await this.transport.send('getCapturedGql', { limit: 100 });
      if (captured?.result?.items) {
        for (const item of captured.result.items) {
          if (item.ops?.includes(operationName) && item.hash) {
            const valid = await this.validateHash(item.hash, endpoint, headers);
            if (valid) {
              this.storeSeed(operationName, domain, item.hash, queryTemplate, 'browser');
              return { success: true, hash: item.hash, source: 'browser', attempts: [...attempts, 'browser-intercept'], latencyMs: Date.now() - start };
            }
          }
        }
      }
    } catch {}
    attempts.push('browser-empty');

    // Strategy 4: Inference from query template
    if (queryTemplate) {
      const hash = HashSeedDB.computeHash(queryTemplate);
      const valid = await this.validateHash(hash, endpoint, headers);
      if (valid) {
        this.storeSeed(operationName, domain, hash, queryTemplate, 'inference');
        return { success: true, hash, source: 'inference', attempts: [...attempts, 'inference'], latencyMs: Date.now() - start };
      }
    }
    attempts.push('inference-failed');

    // Strategy 5: Fallback to scraping (always returns null but documented)
    attempts.push('scraping-fallback');
    return { success: false, source: 'none', attempts, latencyMs: Date.now() - start };
  }

  private async validateHash(hash: string, endpoint?: string, headers?: Record<string, string>): Promise<boolean> {
    try {
      const r = await this.gqlClient.query(endpoint ? new URL(endpoint).hostname : 'unknown', {
        endpoint,
        hash,
        operationName: 'validation',
        headers,
      });
      return r.success && !r.errors?.some((e: any) =>
        e.message === 'PersistedQueryNotFound' || e.message?.includes('PersistedQuery')
      );
    } catch {
      return false;
    }
  }

  private async fetchExternal(url: string): Promise<string | null> {
    try {
      const r = await this.transport.send('Runtime.evaluate', {
        expression: `fetch(${JSON.stringify(url)}, { cache: 'no-cache' }).then(r => r.text()).catch(e => null)`,
        awaitPromise: true,
        returnByValue: true,
      });
      return r?.result?.value || null;
    } catch {
      return null;
    }
  }

  private storeSeed(operationName: string, domain: string, hash: string, queryTemplate: string | undefined, source: HashSeed['source']): void {
    const seed: HashSeed = {
      operationName,
      hash,
      hashPrefix: HashSeedDB.hashPrefix(hash),
      queryTemplate: queryTemplate || '',
      variables: this.extractVariables(queryTemplate || ''),
      signatureFields: [],
      capturedAt: Date.now(),
      lastValidatedAt: Date.now(),
      ttlDays: 30,
      rotationCount: 0,
      source,
    };
    this.seedDB.set(seed, domain);
  }

  private extractVariables(template: string): string[] {
    const re = /\$([A-Za-z][A-Za-z0-9_]*)/g;
    const vars = new Set<string>();
    let m;
    while ((m = re.exec(template))) vars.add(m[1]);
    return Array.from(vars);
  }
}