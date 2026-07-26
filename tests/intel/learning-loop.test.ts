import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GQLClient } from '../../src/intel/gql-client.js';

type HashSeedDBClass = typeof import('../../src/intel/hash-seed.js').HashSeedDB;
type HashSeedDBInstance = import('../../src/intel/hash-seed.js').HashSeedDB;
type HashSeed = import('../../src/intel/hash-seed.js').HashSeed;
type PatternDetectorClass = typeof import('../../src/intel/pattern-detector.js').PatternDetector;
type PatternDetectorInstance = import('../../src/intel/pattern-detector.js').PatternDetector;
type DetectionSignal = import('../../src/intel/pattern-detector.js').DetectionSignal;
type BrowserInterceptorClass = typeof import('../../src/intel/browser-interceptor.js').BrowserInterceptorManager;
type BrowserInterceptorInstance = import('../../src/intel/browser-interceptor.js').BrowserInterceptorManager;
type LearningLoopClass = typeof import('../../src/intel/learning-loop.js').LearningLoop;
type HashLearnerInstance = import('../../src/intel/hash-learner.js').HashLearner;
type LearningResult = import('../../src/intel/hash-learner.js').LearningResult;

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const DOMAIN = 'example.com';

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

  callsTo(method: string): { method: string; params?: Record<string, any> }[] {
    return this.calls.filter(c => c.method === method);
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

/** Responde Runtime.evaluate según la expresión evaluada (location.href, capture buffer, manifest). */
function runtimeResponder(url: string, extra?: (expr: string) => any) {
  return (method: string, params?: Record<string, any>) => {
    if (method !== 'Runtime.evaluate') return undefined;
    const expr: string = params?.expression ?? '';
    if (expr === 'location.href') return { result: { value: url } };
    const v = extra?.(expr);
    return v !== undefined ? v : undefined;
  };
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

function stubLearner(result: LearningResult): { learner: HashLearnerInstance; acquire: ReturnType<typeof vi.fn> } {
  const acquire = vi.fn(async () => result);
  return { learner: { acquire } as unknown as HashLearnerInstance, acquire };
}

describe('LearningLoop', () => {
  let tmpDir: string;
  let HashSeedDB: HashSeedDBClass;
  let PatternDetector: PatternDetectorClass;
  let BrowserInterceptorManager: BrowserInterceptorClass;
  let LearningLoop: LearningLoopClass;
  let seedDB: HashSeedDBInstance;
  let detector: PatternDetectorInstance;
  let interceptor: BrowserInterceptorInstance;
  let transport: MockTransport;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'yautja-learning-loop-'));
    process.env.APPDATA = tmpDir;
    vi.resetModules();
    ({ HashSeedDB } = await import('../../src/intel/hash-seed.js'));
    ({ PatternDetector } = await import('../../src/intel/pattern-detector.js'));
    ({ BrowserInterceptorManager } = await import('../../src/intel/browser-interceptor.js'));
    ({ LearningLoop } = await import('../../src/intel/learning-loop.js'));
    seedDB = new HashSeedDB();
    transport = new MockTransport();
    detector = new PatternDetector(transport, seedDB);
    interceptor = new BrowserInterceptorManager(transport);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterAll(() => {
    if (ORIGINAL_APPDATA === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = ORIGINAL_APPDATA;
  });

  function makeLoop(learner: HashLearnerInstance, det: PatternDetectorInstance = detector) {
    return new LearningLoop(transport, seedDB, det, learner, interceptor);
  }

  describe('ciclo de vida del interceptor', () => {
    it('startInterceptor instala el script persistente y reporta activo', async () => {
      transport.respondWith((method) =>
        method === 'Page.addScriptToEvaluateOnNewDocument' ? { result: { identifier: 'script-1' } } : undefined);
      const { learner } = stubLearner({ success: false, source: 'none', attempts: [], latencyMs: 0 });
      const loop = makeLoop(learner);

      const ok = await loop.startInterceptor();

      expect(ok).toBe(true);
      expect(transport.callsTo('Page.addScriptToEvaluateOnNewDocument')).toHaveLength(1);
      const status = loop.getStatus();
      expect(status.interceptorActive).toBe(true);
      expect(status.interceptorScriptId).toBe('installed');
    });

    it('startInterceptor es idempotente (no reinstala si ya está activo)', async () => {
      transport.respondWith((method) =>
        method === 'Page.addScriptToEvaluateOnNewDocument' ? { result: { identifier: 'script-1' } } : undefined);
      const { learner } = stubLearner({ success: false, source: 'none', attempts: [], latencyMs: 0 });
      const loop = makeLoop(learner);

      await loop.startInterceptor();
      await loop.startInterceptor();

      expect(transport.callsTo('Page.addScriptToEvaluateOnNewDocument')).toHaveLength(1);
    });

    it('startInterceptor devuelve false cuando el transport falla', async () => {
      transport.respondWith(() => { throw new Error('CDP down'); });
      const { learner } = stubLearner({ success: false, source: 'none', attempts: [], latencyMs: 0 });
      const loop = makeLoop(learner);

      const ok = await loop.startInterceptor();

      expect(ok).toBe(false);
      expect(loop.getStatus().interceptorActive).toBe(false);
    });

    it('stopInterceptor elimina el script instalado y desactiva', async () => {
      transport.respondWith((method) =>
        method === 'Page.addScriptToEvaluateOnNewDocument' ? { result: { identifier: 'script-1' } } : undefined);
      const { learner } = stubLearner({ success: false, source: 'none', attempts: [], latencyMs: 0 });
      const loop = makeLoop(learner);
      await loop.startInterceptor();

      await loop.stopInterceptor();

      const removals = transport.callsTo('Page.removeScriptToEvaluateOnNewDocument');
      expect(removals).toHaveLength(1);
      expect(removals[0]!.params).toEqual({ identifier: 'script-1' });
      expect(loop.getStatus().interceptorActive).toBe(false);
    });
  });

  describe('acquireHash', () => {
    it('éxito sin queryTemplate: actualiza lastLearnedAt pero no toca seeds ni rotaciones', async () => {
      const { learner } = stubLearner({ success: true, hash: HASH_B, source: 'external', attempts: [], latencyMs: 5 });
      const loop = makeLoop(learner);

      const r = await loop.acquireHash('ViewerCount', DOMAIN);

      expect(r.success).toBe(true);
      expect(loop.getStatus().lastLearnedAt).toBeGreaterThan(0);
      expect(seedDB.get('ViewerCount', DOMAIN)).toBeNull();
      expect(seedDB.getRotations()).toHaveLength(0);
    });

    it('éxito con queryTemplate y sin seed previa: crea seed y registra rotación recuperada', async () => {
      const { learner } = stubLearner({ success: true, hash: HASH_B, source: 'browser', attempts: [], latencyMs: 5 });
      const loop = makeLoop(learner);

      await loop.acquireHash('ViewerCount', DOMAIN, 'query ViewerCount { x }');

      const seed = seedDB.get('ViewerCount', DOMAIN);
      expect(seed?.hash).toBe(HASH_B);
      expect(seed?.hashPrefix).toBe(HASH_B.substring(0, 16));
      expect(seed?.source).toBe('browser');
      expect(seed?.rotationCount).toBe(0);
      const rotations = seedDB.getRotations();
      expect(rotations).toHaveLength(1);
      expect(rotations[0]).toMatchObject({
        operationName: 'ViewerCount',
        oldHash: '',
        recovered: true,
        newHash: HASH_B,
      });
    });

    it('éxito con queryTemplate y seed con el mismo hash: no registra rotación', async () => {
      seedDB.set(makeSeed({ hash: HASH_A }), DOMAIN);
      const { learner } = stubLearner({ success: true, hash: HASH_A, source: 'cache', attempts: [], latencyMs: 5 });
      const loop = makeLoop(learner);

      await loop.acquireHash('ViewerCount', DOMAIN, 'query ViewerCount { x }');

      expect(seedDB.getRotations()).toHaveLength(0);
      expect(seedDB.get('ViewerCount', DOMAIN)?.rotationCount).toBe(0);
    });

    it('éxito con queryTemplate y seed distinta: actualiza seed e incrementa rotationCount', async () => {
      seedDB.set(makeSeed({ hash: HASH_A, rotationCount: 2 }), DOMAIN);
      const { learner } = stubLearner({ success: true, hash: HASH_B, source: 'inference', attempts: [], latencyMs: 5 });
      const loop = makeLoop(learner);

      await loop.acquireHash('ViewerCount', DOMAIN, 'query ViewerCount { x }');

      const seed = seedDB.get('ViewerCount', DOMAIN);
      expect(seed?.hash).toBe(HASH_B);
      expect(seed?.rotationCount).toBe(3);
      expect(seed?.source).toBe('inference');
      const rotations = seedDB.getRotations();
      expect(rotations).toHaveLength(1);
      expect(rotations[0]).toMatchObject({
        oldHash: HASH_A,
        newHash: HASH_B,
        recovered: true,
      });
    });

    it('fallo: no actualiza lastLearnedAt ni seeds', async () => {
      const { learner } = stubLearner({ success: false, source: 'none', attempts: ['x'], latencyMs: 1 });
      const loop = makeLoop(learner);

      const r = await loop.acquireHash('ViewerCount', DOMAIN, 'query ViewerCount { x }');

      expect(r.success).toBe(false);
      expect(loop.getStatus().lastLearnedAt).toBe(0);
      expect(seedDB.get('ViewerCount', DOMAIN)).toBeNull();
    });

    it('pasa todos los parámetros al learner subyacente', async () => {
      const { learner, acquire } = stubLearner({ success: false, source: 'none', attempts: [], latencyMs: 0 });
      const loop = makeLoop(learner);
      const headers = { 'Client-Id': 'abc' };

      await loop.acquireHash('Op', DOMAIN, 'query Op { y }', 'https://api.example.com/gql', headers);

      expect(acquire).toHaveBeenCalledWith('Op', DOMAIN, 'query Op { y }', 'https://api.example.com/gql', headers);
    });
  });

  describe('monitorTick', () => {
    it('sin interceptor activo y sin capturas devuelve cero señales', async () => {
      transport.respondWith(runtimeResponder('https://example.com/page'));
      const { learner } = stubLearner({ success: false, source: 'none', attempts: [], latencyMs: 0 });
      const loop = makeLoop(learner);

      const signals = await loop.monitorTick();

      expect(signals).toEqual([]);
      expect(loop.getStatus().recentSignals).toEqual([]);
    });

    it('detecta hash distinto en capturas de getCapturedGql (captured-different)', async () => {
      seedDB.set(makeSeed({ hash: HASH_A }), DOMAIN);
      transport.respondWith(runtimeResponder('https://example.com/page'));
      transport.respondWith((method) =>
        method === 'getCapturedGql'
          ? { result: { items: [{ ops: ['ViewerCount'], hash: HASH_B }] } }
          : undefined);
      const { learner } = stubLearner({ success: false, source: 'none', attempts: [], latencyMs: 0 });
      const loop = makeLoop(learner);

      const signals = await loop.monitorTick();

      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({
        type: 'captured-different',
        severity: 'warning',
        data: { domain: DOMAIN, operationName: 'ViewerCount', oldHash: HASH_A, newHash: HASH_B },
      });
      expect(loop.getStatus().recentSignals).toHaveLength(1);
    });

    it('con interceptor activo hace pull de las capturas del buffer del navegador', async () => {
      seedDB.set(makeSeed({ hash: HASH_A }), DOMAIN);
      transport.respondWith((method) =>
        method === 'Page.addScriptToEvaluateOnNewDocument' ? { result: { identifier: 's1' } } : undefined);
      transport.respondWith(runtimeResponder('https://example.com/page', (expr) => {
        if (expr.includes('__yautjaBrowserCapture')) {
          return { result: { value: JSON.stringify([{ op: 'ViewerCount', hash: HASH_B, timestamp: 1 }]) } };
        }
        return undefined;
      }));
      const { learner } = stubLearner({ success: false, source: 'none', attempts: [], latencyMs: 0 });
      const loop = makeLoop(learner);
      await loop.startInterceptor();

      const signals = await loop.monitorTick();

      // El pull alimenta el buffer del interceptor (shape {op, hash})...
      expect(interceptor.getLatestForOp('ViewerCount')).toEqual({ hash: HASH_B, timestamp: 1 });
      expect(interceptor.getStatus().capturedCount).toBe(1);
      // ...y PatternDetector acepta tanto {ops: []} como {op}, así que la
      // captura del interceptor genera señal captured-different (seed con HASH_A).
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({
        type: 'captured-different',
        severity: 'warning',
        data: { domain: DOMAIN, operationName: 'ViewerCount', oldHash: HASH_A, newHash: HASH_B },
      });
    });

    it('sobrevive a un getCapturedGql que lanza', async () => {
      transport.respondWith(runtimeResponder('https://example.com/page'));
      transport.respondWith((method) => {
        if (method === 'getCapturedGql') throw new Error('no buffer');
        return undefined;
      });
      const { learner } = stubLearner({ success: false, source: 'none', attempts: [], latencyMs: 0 });
      const loop = makeLoop(learner);

      const signals = await loop.monitorTick();

      expect(signals).toEqual([]);
    });

    it('con dominio twitch, un cambio de buildId genera señal bundle-changed', async () => {
      let buildId = 'build-1';
      transport.respondWith(runtimeResponder('https://www.twitch.tv/somechannel', (expr) => {
        if (expr.includes('assets.twitch.tv/config/manifest.json')) {
          return { result: { value: JSON.stringify({ channels: [{ releases: [{ buildId }] }] }) } };
        }
        return undefined;
      }));
      const { learner } = stubLearner({ success: false, source: 'none', attempts: [], latencyMs: 0 });
      const loop = makeLoop(learner);

      // Primer tick: registra el buildId conocido sin señal
      const first = await loop.monitorTick();
      expect(first).toEqual([]);

      // Segundo tick con buildId distinto: rotación del bundle
      buildId = 'build-2';
      const second = await loop.monitorTick();
      expect(second).toHaveLength(1);
      expect(second[0]).toMatchObject({
        type: 'bundle-changed',
        severity: 'critical',
        data: { oldBuildId: 'build-1', newBuildId: 'build-2' },
      });
    });

    it('señal persisted-not-found invalida la seed conocida y registra rotación no recuperada', async () => {
      seedDB.set(makeSeed(), DOMAIN);
      const signal: DetectionSignal = {
        type: 'persisted-not-found',
        severity: 'critical',
        message: 'hash no longer valid',
        data: { domain: DOMAIN, operationName: 'ViewerCount' },
        timestamp: Date.now(),
      };
      const stubDetector = {
        detect: vi.fn(async () => [signal]),
        getSignals: vi.fn(() => [signal]),
      } as unknown as PatternDetectorInstance;
      transport.respondWith(runtimeResponder('https://example.com/page'));
      const { learner } = stubLearner({ success: false, source: 'none', attempts: [], latencyMs: 0 });
      const loop = makeLoop(learner, stubDetector);

      const signals = await loop.monitorTick();

      expect(signals).toHaveLength(1);
      expect(seedDB.get('ViewerCount', DOMAIN)).toBeNull();
      const rotations = seedDB.getRotations();
      expect(rotations.some(r => r.operationName === 'ViewerCount' && r.recovered === false)).toBe(true);
    });

    it('señal persisted-not-found sin seed conocida no registra rotación extra', async () => {
      const signal: DetectionSignal = {
        type: 'persisted-not-found',
        severity: 'critical',
        message: 'hash no longer valid',
        data: { domain: DOMAIN, operationName: 'ViewerCount' },
        timestamp: Date.now(),
      };
      const stubDetector = {
        detect: vi.fn(async () => [signal]),
        getSignals: vi.fn(() => [signal]),
      } as unknown as PatternDetectorInstance;
      transport.respondWith(runtimeResponder('https://example.com/page'));
      const { learner } = stubLearner({ success: false, source: 'none', attempts: [], latencyMs: 0 });
      const loop = makeLoop(learner, stubDetector);

      await loop.monitorTick();

      expect(seedDB.getRotations()).toHaveLength(0);
    });
  });

  describe('planificación del monitor', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('startMonitor ejecuta monitorTick en cada intervalo y stopMonitor lo detiene', async () => {
      vi.useFakeTimers();
      transport.respondWith(runtimeResponder('https://example.com/page'));
      const { learner } = stubLearner({ success: false, source: 'none', attempts: [], latencyMs: 0 });
      const loop = makeLoop(learner);
      const spy = vi.spyOn(loop, 'monitorTick');

      loop.startMonitor(1000);
      await vi.advanceTimersByTimeAsync(3000);
      expect(spy).toHaveBeenCalledTimes(3);

      loop.stopMonitor();
      await vi.advanceTimersByTimeAsync(3000);
      expect(spy).toHaveBeenCalledTimes(3);
    });

    it('startMonitor es idempotente (no duplica el intervalo)', async () => {
      vi.useFakeTimers();
      transport.respondWith(runtimeResponder('https://example.com/page'));
      const { learner } = stubLearner({ success: false, source: 'none', attempts: [], latencyMs: 0 });
      const loop = makeLoop(learner);
      const spy = vi.spyOn(loop, 'monitorTick');

      loop.startMonitor(1000);
      loop.startMonitor(1000);
      await vi.advanceTimersByTimeAsync(2000);

      expect(spy).toHaveBeenCalledTimes(2);
      loop.stopMonitor();
    });

    it('los errores de monitorTick dentro del intervalo se tragan', async () => {
      vi.useFakeTimers();
      const { learner } = stubLearner({ success: false, source: 'none', attempts: [], latencyMs: 0 });
      const loop = makeLoop(learner);
      vi.spyOn(loop, 'monitorTick').mockRejectedValue(new Error('boom'));

      loop.startMonitor(1000);
      await vi.advanceTimersByTimeAsync(2000);
      loop.stopMonitor();
      // Si llegamos aquí sin unhandled rejection, el catch funciona
    });
  });

  describe('estado y accesores', () => {
    it('getStatus agrega interceptor, seeds, rotaciones, señales y lastLearnedAt', async () => {
      seedDB.set(makeSeed({ operationName: 'Op1' }), DOMAIN);
      seedDB.set(makeSeed({ operationName: 'Op2' }), DOMAIN);
      seedDB.recordRotation({ operationName: 'Op1', oldHash: '', detectedAt: Date.now(), recovered: false });
      const { learner } = stubLearner({ success: true, hash: HASH_B, source: 'external', attempts: [], latencyMs: 1 });
      const loop = makeLoop(learner);

      const before = loop.getStatus();
      expect(before.interceptorActive).toBe(false);
      expect(before.interceptorScriptId).toBeUndefined();
      expect(before.seedsCount).toBe(2);
      expect(before.rotationsDetected).toBe(1);
      expect(before.recentSignals).toEqual([]);
      expect(before.lastLearnedAt).toBe(0);

      await loop.acquireHash('Op1', DOMAIN);
      expect(loop.getStatus().lastLearnedAt).toBeGreaterThan(0);
    });

    it('getSeeds delega en seedDB.list', async () => {
      seedDB.set(makeSeed({ operationName: 'Op1' }), DOMAIN);
      const { learner } = stubLearner({ success: false, source: 'none', attempts: [], latencyMs: 0 });
      const loop = makeLoop(learner);

      expect(loop.getSeeds(DOMAIN)).toHaveLength(1);
      expect(loop.getSeeds()).toHaveLength(1);
      expect(loop.getSeeds(DOMAIN)[0]!.operationName).toBe('Op1');
    });

    it('getRotations delega en seedDB con límite por defecto 20', async () => {
      for (let i = 0; i < 25; i++) {
        seedDB.recordRotation({ operationName: `Op${i}`, oldHash: '', detectedAt: i, recovered: false });
      }
      const { learner } = stubLearner({ success: false, source: 'none', attempts: [], latencyMs: 0 });
      const loop = makeLoop(learner);

      expect(loop.getRotations()).toHaveLength(20);
      expect(loop.getRotations(5)).toHaveLength(5);
      expect(loop.getRotations(5)[4]!.operationName).toBe('Op24');
    });

    it('fetchCurrentUrl devuelve la URL del navegador', async () => {
      transport.respondWith(runtimeResponder('https://example.com/abc'));
      const { learner } = stubLearner({ success: false, source: 'none', attempts: [], latencyMs: 0 });
      const loop = makeLoop(learner);

      expect(await loop.fetchCurrentUrl()).toBe('https://example.com/abc');
    });

    it('fetchCurrentUrl devuelve cadena vacía si el transport falla', async () => {
      transport.respondWith(() => { throw new Error('CDP down'); });
      const { learner } = stubLearner({ success: false, source: 'none', attempts: [], latencyMs: 0 });
      const loop = makeLoop(learner);

      expect(await loop.fetchCurrentUrl()).toBe('');
    });
  });

  describe('integración con HashLearner real', () => {
    it('acquireHash usa el learner real y refleja el aprendizaje en el estado', async () => {
      const { HashLearner } = await import('../../src/intel/hash-learner.js');
      const gql = { query: vi.fn(async () => ({ success: true, method: 'persisted' })) } as unknown as GQLClient;
      const realLearner = new HashLearner(transport, seedDB, gql);
      const loop = makeLoop(realLearner);
      seedDB.set(makeSeed(), DOMAIN);

      const r = await loop.acquireHash('ViewerCount', DOMAIN);

      expect(r.success).toBe(true);
      expect(r.source).toBe('cache');
      expect(loop.getStatus().lastLearnedAt).toBeGreaterThan(0);
    });
  });
});
