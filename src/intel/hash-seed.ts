import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface HashSeed {
  operationName: string;
  hash: string;
  hashPrefix: string;
  queryTemplate: string;
  variables: string[];
  signatureFields: string[];
  capturedAt: number;
  lastValidatedAt: number;
  ttlDays: number;
  rotationCount: number;
  source: 'cache' | 'external' | 'browser' | 'inference' | 'scraping';
}

export interface RotationEvent {
  operationName: string;
  oldHash: string;
  detectedAt: number;
  recovered: boolean;
  newHash?: string;
}

const SEED_DIR = path.join(process.env.APPDATA || process.env.HOME || '/tmp', '.yautja-hash-seeds');

export class HashSeedDB {
  private seeds: Map<string, HashSeed> = new Map();
  private rotations: RotationEvent[] = [];

  constructor() {
    try { if (!fs.existsSync(SEED_DIR)) fs.mkdirSync(SEED_DIR, { recursive: true }); } catch {}
    this.load();
  }

  private key(domain: string): string {
    return domain.replace(/[^a-z0-9.-]/gi, '_') + '.json';
  }

  private path(domain: string): string {
    return path.join(SEED_DIR, this.key(domain));
  }

  load(domain?: string): void {
    try {
      const file = domain ? this.path(domain) : null;
      if (file && fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const seeds: HashSeed[] = data.seeds || [];
        const rotations: RotationEvent[] = data.rotations || [];
        for (const s of seeds) this.seeds.set(`${domain}:${s.operationName}`, s);
        this.rotations = rotations;
      } else if (!domain) {
        for (const f of fs.readdirSync(SEED_DIR)) {
          if (f.endsWith('.json')) {
            const dom = f.replace('.json', '').replace(/_/g, '.');
            this.load(dom);
          }
        }
      }
    } catch {}
  }

  save(domain: string): void {
    const domainSeeds: HashSeed[] = [];
    for (const [k, v] of this.seeds) if (k.startsWith(`${domain}:`)) domainSeeds.push(v);
    try {
      fs.writeFileSync(this.path(domain), JSON.stringify({
        seeds: domainSeeds,
        rotations: this.rotations,
        updatedAt: Date.now(),
      }, null, 2));
    } catch {}
  }

  set(seed: HashSeed, domain: string): void {
    const k = `${domain}:${seed.operationName}`;
    this.seeds.set(k, seed);
    this.save(domain);
  }

  get(operationName: string, domain: string): HashSeed | null {
    return this.seeds.get(`${domain}:${operationName}`) || null;
  }

  list(domain?: string): HashSeed[] {
    if (!domain) return Array.from(this.seeds.values());
    return Array.from(this.seeds.values()).filter(s => s.queryTemplate && s.operationName);
  }

  invalidate(operationName: string, domain: string): boolean {
    const k = `${domain}:${operationName}`;
    const existed = this.seeds.delete(k);
    if (existed) {
      this.rotations.push({
        operationName,
        oldHash: '',
        detectedAt: Date.now(),
        recovered: false,
      });
      this.save(domain);
    }
    return existed;
  }

  recordRotation(event: RotationEvent): void {
    this.rotations.push(event);
    if (event.recovered) {
      this.rotations[this.rotations.length - 1].newHash = event.newHash;
    }
    if (this.rotations.length > 100) this.rotations = this.rotations.slice(-100);
  }

  getRotations(limit = 20): RotationEvent[] {
    return this.rotations.slice(-limit);
  }

  static computeHash(query: string): string {
    return crypto.createHash('sha256').update(query).digest('hex');
  }

  static hashPrefix(hash: string): string {
    return hash.substring(0, 16);
  }
}