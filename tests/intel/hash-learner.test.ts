import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GQLClient } from '../../src/intel/gql-client.js';

type HashSeedDBClass = typeof import('../../src/intel/hash-seed.js').HashSeedDB;
type HashSeedDBInstance = import('../../src/intel/hash-seed.js').HashSeedDB;
type HashSeed = import('../../src/intel/hash-seed.js').HashSeed;
type HashLearnerClass = typeof import('../../src/intel/hash-learner.js').HashLearner;

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const DOMAIN = 'twitch.tv';

/**
 * HashSeedDB persiste en APPDATA/.yautja-hash-seeds (constante de módulo),
 * así que redirigimos APPDATA a un directorio temporal ANTES de importar
 * los módulos dinámicamente (vi.resetModules fuerza la reevaluación).
 */
const ORIGINAL_APPDATA = process.env.APPDATA;

class MockTransport {
  calls: { method: string; params?: Record<string, any> }[] = [];
  private responders: ((method: string, params?: Record<string, any>) => any)[] = [];

  respondWith(fn: (method: string, params?: Record<string, any>) => any): void {
    this.responders.push(fn);
  }

  async send(method: string, params?: Record<string, any>): Promise<any> {
    this.calls.push({ method, params });
    for (const r of this.responders) {
      const v = r(method, params);
      if (v !== undefined) return v;
    }
    return {};
  }
}

/** Responde a los Runtime.evaluate de fetchExternal según la URL fetcheada. */
function externalFetchResponder(map: Record<string, string | null>) {
  return (method: string, params?: Record<string, any>) => {
    if (method !== 'Runtime.evaluate') return undefined;
    const expr: string = params?.expression ?? '';
    if (!expr.startsWith('fetch(')) return undefined;
    for (const [fragment, body] of Object.entries(map)) {
      if (expr.includes(fragment)) return { result: { value: body } };
    }
    return { result: { value: null } };
  };
}

function makeGqlClient(result: any): { client: GQLClient; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => result);
  return { client: { query } as unknown as GQLClient, query };
}

function makeSeed(overrides: Partial<HashSeed> = {}): HashSeed {
  const now = Date.now();
  return {
    operationName: 'ViewerCount',
    hash: HASH_A,
    hashPrefix: HASH_A.substring(0, 16),
    queryTemplate: 'query ViewerCount { x }',
    variables: [],
    signatureFields: [],
    capturedAt: now,
    lastValidatedAt: now,
    ttlDays: 30,
    rotationCount: 0,
    source: 'cache',
    ...overrides,
  };
}

describe('HashLearner', () => {
  let tmpDir: string;
  let HashSeedDB: HashSeedDBClass;
  let HashLearner: HashLearnerClass;
  let seedDB: HashSeedDBInstance;
  let transport: MockTransport;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'yautja-hash-learner-'));
    process.env.APPDATA = tmpDir;
    vi.resetModules();
    ({ HashSeedDB } = await import('../../src/intel/hash-seed.js'));
    ({ HashLearner } = await import('../../src/intel/hash-learner.js'));
    seedDB = new HashSeedDB();
    transport = new MockTransport();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterAll(() => {
    if (ORIGINAL_APPDATA === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = ORIGINAL_APPDATA;
  });

  describe('acquire — estrategia cache', () => {
    it('devuelve el hash cacheado cuando la validación tiene éxito', async () => {
      seedDB.set(makeSeed(), DOMAIN);
      const { client, query } = makeGqlClient({ success: true, method: 'persisted' });
      const learner = new HashLearner(transport, seedDB, client);

      const r = await learner.acquire('ViewerCount', DOMAIN);

      expect(r.success).toBe(true);
      expect(r.hash).toBe(HASH_A);
      expect(r.source).toBe('cache');
      expect(r.attempts).toEqual(['cache-hit']);
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
      expect(query).toHaveBeenCalledWith('unknown', expect.objectContaining({
        hash: HASH_A,
        operationName: 'validation',
      }));
    });

    it('usa el hostname del endpoint para validar cuando se proporciona', async () => {
      seedDB.set(makeSeed(), DOMAIN);
      const { client, query } = makeGqlClient({ success: true });
      const learner = new HashLearner(transport, seedDB, client);

      await learner.acquire('ViewerCount', DOMAIN, undefined, 'https://gql.twitch.tv/gql', { 'Client-Id': 'x' });

      expect(query).toHaveBeenCalledWith('gql.twitch.tv', expect.objectContaining({
        endpoint: 'https://gql.twitch.tv/gql',
        headers: { 'Client-Id': 'x' },
      }));
    });

    it('invalida la seed cuando la validación reporta PersistedQueryNotFound', async () => {
      seedDB.set(makeSeed(), DOMAIN);
      const { client } = makeGqlClient({ success: true, errors: [{ message: 'PersistedQueryNotFound' }] });
      const learner = new HashLearner(transport, seedDB, client);

      const r = await learner.acquire('ViewerCount', DOMAIN);

      expect(r.success).toBe(false);
      expect(r.source).toBe('none');
      expect(r.attempts).toContain('cache-stale-invalidated');
      expect(seedDB.get('ViewerCount', DOMAIN)).toBeNull();
    });

    it('trata como inválido cualquier error que mencione PersistedQuery', async () => {
      seedDB.set(makeSeed(), DOMAIN);
      const { client } = makeGqlClient({ success: true, errors: [{ message: 'PersistedQueryTimeout: slow' }] });
      const learner = new HashLearner(transport, seedDB, client);

      const r = await learner.acquire('ViewerCount', DOMAIN);

      expect(r.attempts).toContain('cache-stale-invalidated');
      expect(seedDB.get('ViewerCount', DOMAIN)).toBeNull();
    });

    it('trata una excepción de validación como hash inválido', async () => {
      seedDB.set(makeSeed(), DOMAIN);
      const query = vi.fn(async () => { throw new Error('network down'); });
      const client = { query } as unknown as GQLClient;
      const learner = new HashLearner(transport, seedDB, client);

      const r = await learner.acquire('ViewerCount', DOMAIN);

      expect(r.success).toBe(false);
      expect(r.attempts).toContain('cache-stale-invalidated');
    });
  });

  describe('acquire — estrategia fuentes externas', () => {
    it('extrae el hash del parser twitch-dev-public (regex)', async () => {
      transport.respondWith(externalFetchResponder({
        'pubsub-js': `"ViewerCount": "${HASH_B}"`,
      }));
      const { client } = makeGqlClient({ success: true });
      const learner = new HashLearner(transport, seedDB, client);

      const r = await learner.acquire('ViewerCount', DOMAIN);

      expect(r.success).toBe(true);
      expect(r.hash).toBe(HASH_B);
      expect(r.source).toBe('external');
      expect(r.attempts).toEqual(['external:twitch-dev-public']);
      const stored = seedDB.get('ViewerCount', DOMAIN);
      expect(stored?.hash).toBe(HASH_B);
      expect(stored?.source).toBe('external');
      expect(stored?.hashPrefix).toBe(HASH_B.substring(0, 16));
    });

    it('extrae el hash del parser twurple-queries (JSON por clave)', async () => {
      transport.respondWith(externalFetchResponder({
        'pubsub-js': null,
        'twurple': JSON.stringify({ ViewerCount: HASH_C }),
      }));
      const { client } = makeGqlClient({ success: true });
      const learner = new HashLearner(transport, seedDB, client);

      const r = await learner.acquire('ViewerCount', DOMAIN);

      expect(r.success).toBe(true);
      expect(r.source).toBe('external');
      expect(r.attempts).toEqual(['external:twurple-queries']);
    });

    it('extrae el hash del parser twitch-inspector-gql (queries anidadas)', async () => {
      transport.respondWith(externalFetchResponder({
        'pubsub-js': null,
        'twurple': 'not json at all {{{',
        'twitch-gql': JSON.stringify({ queries: { ViewerCount: HASH_B } }),
      }));
      const { client } = makeGqlClient({ success: true });
      const learner = new HashLearner(transport, seedDB, client);

      const r = await learner.acquire('ViewerCount', DOMAIN);

      expect(r.success).toBe(true);
      expect(r.source).toBe('external');
      expect(r.attempts).toEqual(['external:twitch-inspector-gql']);
    });

    it('no guarda la seed si el hash externo no valida', async () => {
      transport.respondWith(externalFetchResponder({
        'pubsub-js': `"ViewerCount": "${HASH_B}"`,
      }));
      const { client } = makeGqlClient({ success: false, errors: [{ message: 'PersistedQueryNotFound' }] });
      const learner = new HashLearner(transport, seedDB, client);

      const r = await learner.acquire('ViewerCount', DOMAIN);

      expect(r.success).toBe(false);
      expect(r.attempts).toContain('external-exhausted');
      expect(seedDB.get('ViewerCount', DOMAIN)).toBeNull();
    });

    it('sobrevive a un transport que lanza en Runtime.evaluate', async () => {
      transport.respondWith(() => { throw new Error('CDP disconnected'); });
      const { client } = makeGqlClient({ success: true });
      const learner = new HashLearner(transport, seedDB, client);

      const r = await learner.acquire('ViewerCount', DOMAIN);

      expect(r.success).toBe(false);
      expect(r.attempts).toContain('external-exhausted');
    });
  });

  describe('acquire — estrategia intercepción del navegador', () => {
    it('encuentra el hash en el buffer de capturas cuando coincide la operación', async () => {
      transport.respondWith((method) => {
        if (method === 'getCapturedGql') {
          return { result: { items: [
            { ops: ['OtherOp'], hash: HASH_C },
            { ops: ['ViewerCount', 'AnotherOp'], hash: HASH_B },
          ] } };
        }
        return undefined;
      });
      const { client } = makeGqlClient({ success: true });
      const learner = new HashLearner(transport, seedDB, client);

      const r = await learner.acquire('ViewerCount', DOMAIN);

      expect(r.success).toBe(true);
      expect(r.hash).toBe(HASH_B);
      expect(r.source).toBe('browser');
      expect(r.attempts).toEqual(['external-exhausted', 'browser-intercept']);
      expect(seedDB.get('ViewerCount', DOMAIN)?.source).toBe('browser');
    });

    it('ignora capturas sin hash o sin la operación buscada', async () => {
      transport.respondWith((method) => {
        if (method === 'getCapturedGql') {
          return { result: { items: [
            { ops: ['ViewerCount'] },               // sin hash
            { hash: HASH_B },                        // sin ops
            { ops: ['Unrelated'], hash: HASH_C },    // otra operación
          ] } };
        }
        return undefined;
      });
      const { client } = makeGqlClient({ success: true });
      const learner = new HashLearner(transport, seedDB, client);

      const r = await learner.acquire('ViewerCount', DOMAIN);

      expect(r.success).toBe(false);
      expect(r.attempts).toContain('browser-empty');
    });

    it('sobrevive a un getCapturedGql que lanza', async () => {
      transport.respondWith((method) => {
        if (method === 'getCapturedGql') throw new Error('no browser');
        return undefined;
      });
      const { client } = makeGqlClient({ success: true });
      const learner = new HashLearner(transport, seedDB, client);

      const r = await learner.acquire('ViewerCount', DOMAIN);

      expect(r.success).toBe(false);
      expect(r.attempts).toContain('browser-empty');
    });
  });

  describe('acquire — estrategia inferencia y fallo total', () => {
    it('infiere el hash desde el queryTemplate y guarda variables extraídas', async () => {
      const template = 'query Login($login: String!, $password: String!, $login2: Int) { auth(login: $login, password: $password) }';
      const { client } = makeGqlClient({ success: true });
      const learner = new HashLearner(transport, seedDB, client);

      const r = await learner.acquire('Login', DOMAIN, template);

      expect(r.success).toBe(true);
      expect(r.source).toBe('inference');
      expect(r.hash).toBe(HashSeedDB.computeHash(template));
      expect(r.attempts).toEqual(['external-exhausted', 'browser-empty', 'inference']);
      const stored = seedDB.get('Login', DOMAIN);
      expect(stored?.source).toBe('inference');
      expect(stored?.queryTemplate).toBe(template);
      expect(stored?.variables).toEqual(['login', 'password', 'login2']);
    });

    it('falla con source none y scraping-fallback cuando nada funciona', async () => {
      const { client } = makeGqlClient({ success: false, errors: [{ message: 'nope' }] });
      const learner = new HashLearner(transport, seedDB, client);

      const r = await learner.acquire('ViewerCount', DOMAIN, 'query ViewerCount { x }');

      expect(r.success).toBe(false);
      expect(r.hash).toBeUndefined();
      expect(r.source).toBe('none');
      expect(r.attempts).toEqual([
        'external-exhausted',
        'browser-empty',
        'inference-failed',
        'scraping-fallback',
      ]);
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('sin queryTemplate salta la inferencia directamente', async () => {
      const { client } = makeGqlClient({ success: true });
      const learner = new HashLearner(transport, seedDB, client);

      const r = await learner.acquire('ViewerCount', DOMAIN);

      expect(r.success).toBe(false);
      expect(r.attempts).toEqual([
        'external-exhausted',
        'browser-empty',
        'inference-failed',
        'scraping-fallback',
      ]);
    });
  });
});
