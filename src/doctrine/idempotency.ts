import type { YautjaResponse } from './types.js';

interface RegistryEntry<T = unknown> {
  result: YautjaResponse<T>;
  expiresAt: number;
  fingerprint?: string;
}

export class IdempotencyConflictError extends Error {
  constructor() { super('Idempotency key already used with different operation arguments or target'); }
}

export interface IdempotencyConfig {
  defaultTtlMs: number;
}

export class IdempotencyRegistry {
  private entries = new Map<string, RegistryEntry>();
  private pending = new Map<string, { fingerprint: string; promise: Promise<YautjaResponse<unknown>> }>();
  private config: IdempotencyConfig;

  constructor(config: IdempotencyConfig) {
    this.config = config;
  }

  get<T = unknown>(key: string): YautjaResponse<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.result as YautjaResponse<T>;
  }

  set<T = unknown>(
    key: string,
    result: YautjaResponse<T>,
    ttlMs?: number,
    fingerprint?: string,
  ): void {
    const ttl = ttlMs ?? this.config.defaultTtlMs;
    this.entries.set(key, {
      result: result as YautjaResponse<unknown>,
      expiresAt: Date.now() + ttl,
      fingerprint,
    });
  }

  /** Reserve before invoking fn; the TTL starts only after successful completion. */
  async run<T>(key: string, fingerprint: string, fn: () => Promise<YautjaResponse<T>>): Promise<YautjaResponse<T>> {
    const inflight = this.pending.get(key);
    if (inflight) {
      if (inflight.fingerprint !== fingerprint) throw new IdempotencyConflictError();
      return structuredClone(await inflight.promise) as YautjaResponse<T>;
    }
    const cached = this.get<T>(key);
    if (cached) {
      if (this.entries.get(key)?.fingerprint !== fingerprint) throw new IdempotencyConflictError();
      return structuredClone(cached);
    }
    // Defer fn to a microtask so even re-entrant callers see the reservation.
    const promise = Promise.resolve().then(fn);
    this.pending.set(key, { fingerprint, promise });
    try {
      const result = await promise;
      if (result.ok) this.set(key, structuredClone(result), undefined, fingerprint);
      return structuredClone(result);
    } finally {
      this.pending.delete(key);
    }
  }

  purge(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now > entry.expiresAt) {
        this.entries.delete(key);
      }
    }
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
