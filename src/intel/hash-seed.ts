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
  private rotationsByDomain: Map<string, RotationEvent[]> = new Map();

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

  private rebuildRotations(): void {
    const seen = new Set<string>();
    this.rotations = [];
    for (const list of this.rotationsByDomain.values()) {
      for (const r of list) {
        const k = `${r.operationName}|${r.detectedAt}|${r.oldHash}`;
        if (seen.has(k)) continue;
        seen.add(k);
        this.rotations.push(r);
      }
    }
  }

  load(domain?: string): void {
    try {
      const file = domain ? this.path(domain) : null;
      if (file && fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const seeds: HashSeed[] = data.seeds || [];
        const rotations: RotationEvent[] = data.rotations || [];
        for (const s of seeds) this.seeds.set(`${domain}:${s.operationName}`, s);
        this.rotationsByDomain.set(domain!, rotations);
        this.rebuildRotations();
      } else if (!domain) {
        for (const f of fs.readdirSync(SEED_DIR)) {
          if (!f.endsWith('.json')) continue;
          // Filename is sanitized; prefer the real domain stored in the file.
          let dom = f.replace('.json', '').replace(/_/g, '.');
          try {
            const data = JSON.parse(fs.readFileSync(path.join(SEED_DIR, f), 'utf8'));
            if (typeof data.domain === 'string' && data.domain) dom = data.domain;
          } catch {}
          this.load(dom);
        }
      }
    } catch {}
  }

  save(domain: string): void {
    const domainSeeds: HashSeed[] = [];
    for (const [k, v] of this.seeds) if (k.startsWith(`${domain}:`)) domainSeeds.push(v);
    try {
      fs.writeFileSync(this.path(domain), JSON.stringify({
        domain,
        seeds: domainSeeds,
        rotations: this.rotationsByDomain.get(domain) ?? [],
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
    const prefix = `${domain}:`;
    const out: HashSeed[] = [];
    for (const [k, v] of this.seeds) if (k.startsWith(prefix)) out.push(v);
    return out;
  }

  invalidate(operationName: string, domain: string): boolean {
    const k = `${domain}:${operationName}`;
    const seed = this.seeds.get(k);
    if (!seed) return false;
    this.seeds.delete(k);
    this.recordRotation({
      operationName,
      oldHash: seed.hash,
      detectedAt: Date.now(),
      recovered: false,
    }, domain);
    return true;
  }

  recordRotation(event: RotationEvent, domain?: string): void {
    this.rotations.push(event);
    if (this.rotations.length > 100) this.rotations = this.rotations.slice(-100);
    if (domain) {
      const list = this.rotationsByDomain.get(domain) ?? [];
      list.push(event);
      if (list.length > 100) list.splice(0, list.length - 100);
      this.rotationsByDomain.set(domain, list);
      this.save(domain);
    }
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