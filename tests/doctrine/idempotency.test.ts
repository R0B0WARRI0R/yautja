import { describe, it, expect, beforeEach } from 'vitest';
import { IdempotencyRegistry } from '../../src/doctrine/idempotency.js';

describe('IdempotencyRegistry', () => {
  let registry: IdempotencyRegistry;

  beforeEach(() => {
    registry = new IdempotencyRegistry({ defaultTtlMs: 1000 });
  });

  it('returns undefined for unknown key', () => {
    expect(registry.get('ik_unknown')).toBeUndefined();
  });

  it('stores and retrieves a result', () => {
    const key = 'ik_123';
    const result = { ok: true as const, result: 'cached' };
    registry.set(key, result);
    expect(registry.get(key)).toEqual(result);
  });

  it('expires entries after TTL', async () => {
    const key = 'ik_expired';
    registry.set(key, { ok: true, result: 'old' });
    await new Promise(r => setTimeout(r, 1100));
    expect(registry.get(key)).toBeUndefined();
  });

  it('supports custom TTL per entry', async () => {
    const key = 'ik_custom';
    registry.set(key, { ok: true, result: 'data' }, 100);
    await new Promise(r => setTimeout(r, 150));
    expect(registry.get(key)).toBeUndefined();
  });

  it('purges expired entries on cleanup', () => {
    // Set expired entry by manipulating internal clock
    registry.set('ik_old', { ok: true, result: 'x' }, -1);
    registry.set('ik_fresh', { ok: true, result: 'y' });
    registry.purge();
    expect(registry.get('ik_old')).toBeUndefined();
    expect(registry.get('ik_fresh')).toBeDefined();
  });
});