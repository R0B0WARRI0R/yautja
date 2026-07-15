import type { YautjaResponse } from './types.js';

interface RegistryEntry<T = unknown> {
  result: YautjaResponse<T>;
  expiresAt: number;
}

export interface IdempotencyConfig {
  defaultTtlMs: number;
}

export class IdempotencyRegistry {
  private entries = new Map<string, RegistryEntry>();
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
  ): void {
    const ttl = ttlMs ?? this.config.defaultTtlMs;
    this.entries.set(key, {
      result: result as YautjaResponse<unknown>,
      expiresAt: Date.now() + ttl,
    });
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