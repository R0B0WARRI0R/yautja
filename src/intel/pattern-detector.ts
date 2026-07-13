import { HashSeedDB } from './hash-seed.js';

export interface DetectionSignal {
  type: 'persisted-not-found' | 'hash-changed' | 'bundle-changed' | 'captured-different';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  data?: any;
  timestamp: number;
}

export interface Transport {
  send(method: string, params?: Record<string, any>): Promise<any>;
}

export class PatternDetector {
  private transport: Transport;
  private seedDB: HashSeedDB;
  private signals: DetectionSignal[] = [];
  private knownBuildId: Map<string, string> = new Map();
  private lastKnownHashes: Map<string, string> = new Map();

  constructor(transport: Transport, seedDB: HashSeedDB) {
    this.transport = transport;
    this.seedDB = seedDB;
  }

  async detect(domain: string, operationName?: string, lastResult?: any, capturedGql?: any[]): Promise<DetectionSignal[]> {
    const detected: DetectionSignal[] = [];

    // Signal 1: PersistedQueryNotFound in last result
    if (lastResult?.errors) {
      const isPersistedNotFound = lastResult.errors.some((e: any) =>
        e.message === 'PersistedQueryNotFound' || e.message?.includes('PersistedQuery')
      );
      if (isPersistedNotFound && operationName) {
        detected.push({
          type: 'persisted-not-found',
          severity: 'critical',
          message: `Hash for ${operationName} on ${domain} is no longer valid (PersistedQueryNotFound)`,
          data: { domain, operationName, errors: lastResult.errors },
          timestamp: Date.now(),
        });
      }
    }

    // Signal 2: Captured GQL has different hash than known
    if (capturedGql && capturedGql.length > 0) {
      for (const cap of capturedGql) {
        if (!cap.hash || !cap.ops || cap.ops.length === 0) continue;
        const opName = cap.ops[0];
        const knownSeed = this.seedDB.get(opName, domain);
        if (knownSeed && knownSeed.hash !== cap.hash) {
          detected.push({
            type: 'captured-different',
            severity: 'warning',
            message: `New hash for ${opName} differs from cached seed`,
            data: { domain, operationName: opName, oldHash: knownSeed.hash, newHash: cap.hash },
            timestamp: Date.now(),
          });
          this.lastKnownHashes.set(`${domain}:${opName}`, cap.hash);
        } else if (!knownSeed) {
          this.lastKnownHashes.set(`${domain}:${opName}`, cap.hash);
        }
      }
    }

    // Signal 3: Twitch manifest build ID changed
    if (domain.includes('twitch')) {
      try {
        const r = await this.transport.send('Runtime.evaluate', {
          expression: `fetch('https://assets.twitch.tv/config/manifest.json', { cache: 'no-cache' }).then(r => r.text()).catch(() => null)`,
          awaitPromise: true,
          returnByValue: true,
        });
        if (r?.result?.value) {
          const m = JSON.parse(r.result.value);
          const buildId = m?.channels?.[0]?.releases?.[0]?.buildId;
          if (buildId) {
            const last = this.knownBuildId.get(domain);
            if (last && last !== buildId) {
              detected.push({
                type: 'bundle-changed',
                severity: 'critical',
                message: `Twitch frontend bundle changed: ${last} -> ${buildId}. Hashes likely rotated.`,
                data: { domain, oldBuildId: last, newBuildId: buildId },
                timestamp: Date.now(),
              });
            }
            this.knownBuildId.set(domain, buildId);
          }
        }
      } catch {}
    }

    this.signals = detected;
    return detected;
  }

  getSignals(): DetectionSignal[] {
    return this.signals;
  }

  clearSignals(): void {
    this.signals = [];
  }
}