import fs from 'fs';
import path from 'path';

/**
 * Site memory v2 (P18 hardening) — per-domain selector cache with
 * multi-strategy signatures, hit tracking and per-entry TTL.
 *
 * v1 entries ({selector, method}) keep working unchanged: the v2 fields
 * are optional and old files load as-is. Per-entry expiry uses ttlDays
 * (default 7); whole-file MAX_AGE is kept as a second safety net.
 */

export interface InputStrategy {
  kind: 'aria' | 'css' | 'text' | 'role';
  value: string;
  score: number;
}

export interface InputEntry {
  selector: string;
  method: 'input' | 'contenteditable';
  strategies?: InputStrategy[];
  buildVersion?: string;
  hits?: number;
  lastHit?: string;
  ttlDays?: number;
}

export interface SiteProfile {
  domain: string;
  inputs: Record<string, InputEntry>;
  buttons: Record<string, { selector: string }>;
  updatedAt: number;
}

const MEMORY_DIR = path.join(process.env.APPDATA || process.env.HOME || '/tmp', '.yautja-memory');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ENTRY_TTL_DAYS = 7;

function isEntryFresh(entry: InputEntry, now = Date.now()): boolean {
  if (!entry.lastHit) return true; // never used → rely on file-level MAX_AGE
  const ttl = (entry.ttlDays ?? DEFAULT_ENTRY_TTL_DAYS) * 24 * 60 * 60 * 1000;
  return now - Date.parse(entry.lastHit) < ttl;
}

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

  /** Get a fresh (non-expired) input entry for a query key. */
  getInput(domain: string, query: string): InputEntry | null {
    const profile = this.get(domain);
    const entry = profile?.inputs?.[query];
    if (!entry || !isEntryFresh(entry)) return null;
    return entry;
  }

  /** Record a cache hit: bumps hits + lastHit and persists. */
  recordHit(domain: string, query: string): void {
    const profile = this.get(domain);
    const entry = profile?.inputs?.[query];
    if (!profile || !entry) return;
    entry.hits = (entry.hits ?? 0) + 1;
    entry.lastHit = new Date().toISOString();
    this.save(domain, { inputs: { [query]: entry } });
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
