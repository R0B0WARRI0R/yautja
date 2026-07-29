import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  isFeatureEnabled,
  clearKillSwitchCache,
  KILL_SWITCH_CACHE_TTL_MS,
} from '../../src/arsenal/kill-switch.js';

describe('isFeatureEnabled (kill switches)', () => {
  beforeEach(() => clearKillSwitchCache());

  it('defaults to true when the key is absent', async () => {
    const storage = { storageGet: vi.fn(async () => undefined) };
    expect(await isFeatureEnabled(storage, 'yjTestFlag')).toBe(true);
    expect(storage.storageGet).toHaveBeenCalledWith('yjTestFlag');
  });

  it('is disabled only by an explicit false', async () => {
    expect(await isFeatureEnabled({ storageGet: async () => false }, 'k1')).toBe(false);
    expect(await isFeatureEnabled({ storageGet: async () => true }, 'k2')).toBe(true);
    expect(await isFeatureEnabled({ storageGet: async () => 0 }, 'k3')).toBe(true); // no-boolean → default
  });

  it('honours a non-default default (default: false)', async () => {
    expect(await isFeatureEnabled({ storageGet: async () => undefined }, 'k4', { default: false })).toBe(false);
    expect(await isFeatureEnabled({ storageGet: async () => true }, 'k5', { default: false })).toBe(true);
  });

  it('fails open (returns default) when storage read throws, without caching', async () => {
    const storage = { storageGet: vi.fn(async () => { throw new Error('no storage'); }) };
    expect(await isFeatureEnabled(storage, 'k6')).toBe(true);
    expect(await isFeatureEnabled(storage, 'k6', { default: false })).toBe(false);
    expect(storage.storageGet).toHaveBeenCalledTimes(2); // el fallo no se cachea
  });

  it('caches reads per key for the TTL window', async () => {
    const storage = { storageGet: vi.fn(async () => false) };
    expect(await isFeatureEnabled(storage, 'k7')).toBe(false);
    expect(await isFeatureEnabled(storage, 'k7')).toBe(false);
    expect(storage.storageGet).toHaveBeenCalledTimes(1);
  });

  it('expires the cache after the TTL', async () => {
    let t = 1_000;
    const storage = { storageGet: vi.fn(async () => true) };
    const opts = { now: () => t };
    await isFeatureEnabled(storage, 'k8', opts);
    t += KILL_SWITCH_CACHE_TTL_MS + 1;
    await isFeatureEnabled(storage, 'k8', opts);
    expect(storage.storageGet).toHaveBeenCalledTimes(2);
  });

  it('ttlMs: 0 disables the cache', async () => {
    const storage = { storageGet: vi.fn(async () => true) };
    await isFeatureEnabled(storage, 'k9', { ttlMs: 0 });
    await isFeatureEnabled(storage, 'k9', { ttlMs: 0 });
    expect(storage.storageGet).toHaveBeenCalledTimes(2);
  });

  it('clearKillSwitchCache forces a fresh read', async () => {
    const storage = { storageGet: vi.fn(async () => true) };
    await isFeatureEnabled(storage, 'k10');
    clearKillSwitchCache();
    await isFeatureEnabled(storage, 'k10');
    expect(storage.storageGet).toHaveBeenCalledTimes(2);
  });
});
