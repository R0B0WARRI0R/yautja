import { HashSeedDB, HashSeed, RotationEvent } from './hash-seed.js';
import { PatternDetector, DetectionSignal } from './pattern-detector.js';
import { HashLearner, LearningResult } from './hash-learner.js';
import { BrowserInterceptorManager } from './browser-interceptor.js';

export interface LearningLoopStatus {
  interceptorActive: boolean;
  interceptorScriptId?: string;
  seedsCount: number;
  rotationsDetected: number;
  recentSignals: DetectionSignal[];
  biofilmCells?: number;
  lastLearnedAt?: number;
}

export interface Transport {
  send(method: string, params?: Record<string, any>): Promise<any>;
}

export class LearningLoop {
  private transport: Transport;
  private seedDB: HashSeedDB;
  private patternDetector: PatternDetector;
  private hashLearner: HashLearner;
  private browserInterceptor: BrowserInterceptorManager;
  private lastLearnedAt: number = 0;
  private monitorInterval?: NodeJS.Timeout;

  constructor(
    transport: Transport,
    seedDB: HashSeedDB,
    patternDetector: PatternDetector,
    hashLearner: HashLearner,
    browserInterceptor: BrowserInterceptorManager
  ) {
    this.transport = transport;
    this.seedDB = seedDB;
    this.patternDetector = patternDetector;
    this.hashLearner = hashLearner;
    this.browserInterceptor = browserInterceptor;
  }

  async startInterceptor(): Promise<boolean> {
    return await this.browserInterceptor.install();
  }

  async stopInterceptor(): Promise<void> {
    await this.browserInterceptor.uninstall();
  }

  async acquireHash(operationName: string, domain: string, queryTemplate?: string, endpoint?: string, headers?: Record<string, string>): Promise<LearningResult> {
    const result = await this.hashLearner.acquire(operationName, domain, queryTemplate, endpoint, headers);
    if (result.success && result.hash) {
      this.lastLearnedAt = Date.now();
      if (queryTemplate) {
        const seed = this.seedDB.get(operationName, domain);
        if (!seed || seed.hash !== result.hash) {
          const updated: HashSeed = seed ? {
            ...seed, hash: result.hash, hashPrefix: HashSeedDB.hashPrefix(result.hash),
            capturedAt: Date.now(), lastValidatedAt: Date.now(),
            rotationCount: (seed.rotationCount || 0) + 1,
            source: result.source as HashSeed['source'],
          } : {
            operationName,
            hash: result.hash,
            hashPrefix: HashSeedDB.hashPrefix(result.hash),
            queryTemplate,
            variables: [],
            signatureFields: [],
            capturedAt: Date.now(),
            lastValidatedAt: Date.now(),
            ttlDays: 30,
            rotationCount: 0,
            source: result.source as HashSeed['source'],
          };
          this.seedDB.set(updated, domain);
          this.seedDB.recordRotation({
            operationName,
            oldHash: seed?.hash || '',
            detectedAt: Date.now(),
            recovered: true,
            newHash: result.hash,
          }, domain);
        }
      }
    }
    return result;
  }

  async monitorTick(): Promise<DetectionSignal[]> {
    let captured: any[] = [];
    if (this.browserInterceptor.isActive()) {
      captured = await this.browserInterceptor.pullCaptures();
    }

    let lastResult: any = null;
    try {
      const capturedRaw = await this.transport.send('getCapturedGql', { limit: 50 });
      if (capturedRaw?.result?.items) {
        captured = captured.concat(capturedRaw.result.items);
      }
    } catch {}

    const url = await this.fetchCurrentUrl();
    let domain = '';
    try { domain = new URL(url).hostname; } catch {}
    const signals = await this.patternDetector.detect(domain, undefined, lastResult, captured);

    if (signals.length > 0) {
      for (const sig of signals) {
        if (sig.type === 'persisted-not-found' && sig.data) {
          const op = sig.data.operationName;
          if (op && this.seedDB.get(op, domain)) {
            // invalidate() already records the rotation with the real oldHash.
            this.seedDB.invalidate(op, domain);
          }
        }
      }
    }
    return signals;
  }

  startMonitor(intervalMs = 30000): void {
    if (this.monitorInterval) return;
    this.monitorInterval = setInterval(() => {
      this.monitorTick().catch(() => {});
    }, intervalMs);
  }

  stopMonitor(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = undefined;
    }
  }

  getStatus(): LearningLoopStatus {
    return {
      interceptorActive: this.browserInterceptor.isActive(),
      interceptorScriptId: this.browserInterceptor.getStatus().active ? 'installed' : undefined,
      seedsCount: this.seedDB.list().length,
      rotationsDetected: this.seedDB.getRotations().length,
      recentSignals: this.patternDetector.getSignals(),
      lastLearnedAt: this.lastLearnedAt,
    };
  }

  getSeeds(domain?: string): HashSeed[] {
    return this.seedDB.list(domain);
  }

  getRotations(limit = 20): RotationEvent[] {
    return this.seedDB.getRotations(limit);
  }

  async fetchCurrentUrl(): Promise<string> {
    try {
      const r = await this.transport.send('Runtime.evaluate', {
        expression: 'location.href',
        returnByValue: true,
      });
      return r?.result?.value || '';
    } catch { return ''; }
  }
}