import fs from 'fs';
import path from 'path';

export interface SiteProfile {
  domain: string;
  inputs: Record<string, { selector: string; method: 'input' | 'contenteditable'; }>;
  buttons: Record<string, { selector: string; }>;
  updatedAt: number;
}

const MEMORY_DIR = path.join(process.env.APPDATA || process.env.HOME || '/tmp', '.yautja-memory');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class SiteMemory {
  private cache: Map<string, SiteProfile> = new Map();

  constructor() {
    try {
      if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
    } catch {}
  }

  get(domain: string): SiteProfile | null {
    if (this.cache.has(domain)) return this.cache.get(domain)!;
    try {
      const file = path.join(MEMORY_DIR, domain.replace(/[^a-z0-9.-]/gi, '_') + '.json');
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8');
        const profile = JSON.parse(raw) as SiteProfile;
        if (Date.now() - profile.updatedAt < MAX_AGE_MS) {
          this.cache.set(domain, profile);
          return profile;
        }
      }
    } catch {}
    return null;
  }

  save(domain: string, updates: Partial<SiteProfile>): SiteProfile {
    const existing = this.get(domain);
    const merged: SiteProfile = {
      domain,
      inputs: { ...(existing?.inputs || {}), ...(updates.inputs || {}) },
      buttons: { ...(existing?.buttons || {}), ...(updates.buttons || {}) },
      updatedAt: Date.now(),
    };
    this.cache.set(domain, merged);
    try {
      const file = path.join(MEMORY_DIR, domain.replace(/[^a-z0-9.-]/gi, '_') + '.json');
      fs.writeFileSync(file, JSON.stringify(merged, null, 2));
    } catch {}
    return merged;
  }

  clear(domain?: string): void {
    if (domain) {
      this.cache.delete(domain);
      try {
        const file = path.join(MEMORY_DIR, domain.replace(/[^a-z0-9.-]/gi, '_') + '.json');
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {}
    } else {
      this.cache.clear();
      try {
        if (fs.existsSync(MEMORY_DIR)) {
          for (const f of fs.readdirSync(MEMORY_DIR)) {
            if (f.endsWith('.json')) fs.unlinkSync(path.join(MEMORY_DIR, f));
          }
        }
      } catch {}
    }
  }
}
