import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TraceStore } from '../../src/doctrine/trace-store.js';
import { rmSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = join(process.cwd(), 'tests', 'tmp-traces');

describe('TraceStore', () => {
  let store: TraceStore;

  beforeEach(() => {
    store = new TraceStore({ rootDir: TEST_DIR, ttlDays: 7 });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('saves and reads a DOM snapshot', async () => {
    const uri = await store.saveDomSnapshot('tr_test', 1, '<html>snapshot</html>');
    expect(uri).toBe(`resource://yautja/traces/tr_test/dom/1`);
    const content = await store.readResource(uri);
    expect(content).toBe('<html>snapshot</html>');
  });

  it('saves and reads network window', async () => {
    const uri = await store.saveNetworkWindow('tr_test', '[{"url":"http://x"}]');
    expect(uri).toContain('network');
    const content = await store.readResource(uri);
    expect(content).toContain('http://x');
  });

  it('returns null for non-existent resource', async () => {
    const content = await store.readResource('resource://yautja/traces/tr_bogus/dom/999');
    expect(content).toBeNull();
  });

  it('lists traces for cleanup', async () => {
    const expired = await store.findExpired(0);
    expect(Array.isArray(expired)).toBe(true);
  });

  it('purgeExpired removes traces older than the TTL', async () => {
    await store.saveNetworkWindow('tr_old', '{"net":true}');
    await store.saveNetworkWindow('tr_new', '{"net":true}');
    // Age tr_old artificially (31 days)
    const past = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(join(TEST_DIR, 'tr_old'), past, past);

    const purged = await store.purgeExpired(7);
    expect(purged).toContain('tr_old');
    expect(purged).not.toContain('tr_new');
    expect(await store.listTraces()).toEqual(['tr_new']);
  });

  describe('path-traversal hardening (pass-2)', () => {
    it('rejects traceId containing ..', async () => {
      await store.saveNetworkWindow('tr_real', '{"x":1}');
      const r = await store.readResource('resource://yautja/traces/..%2F..%2Fetc/passwd/network');
      expect(r).toBeNull();
      const r2 = await store.readResource('resource://yautja/traces/../network');
      expect(r2).toBeNull();
    });

    it('rejects rest segments containing ..', async () => {
      await store.saveDomSnapshot('tr_real', 1, '<html/>');
      const r = await store.readResource('resource://yautja/traces/tr_real/../dom/1');
      expect(r).toBeNull();
      const r2 = await store.readResource('resource://yautja/traces/tr_real/dom/../1');
      expect(r2).toBeNull();
    });

    it('rejects forward-slash injection in rest (more than 2 segments)', async () => {
      const r = await store.readResource('resource://yautja/traces/tr_x/dom/1/extra/path');
      expect(r).toBeNull();
    });

    it('rejects path traversal to parent rootDir via /network on .. traceId', async () => {
      // The classic attack: read <rootDirParent>/network.json
      const r = await store.readResource('resource://yautja/traces/../network');
      expect(r).toBeNull();
    });

    it('still reads a legitimate dom/0.json after hardening', async () => {
      const uri = await store.saveDomSnapshot('tr_safe', 0, '<html>safe</html>');
      const r = await store.readResource(uri);
      expect(r).toBe('<html>safe</html>');
    });

    it('rejects segments with characters outside [A-Za-z0-9_.-]', async () => {
      // Backslash, semicolon, space, unicode confusables
      const cases = [
        'resource://yautja/traces/tr_x/dom/0%2F..',
        'resource://yautja/traces/tr x/dom/0',     // space in traceId
        'resource://yautja/traces/tr_x/dom;rm/0', // semicolon injection
      ];
      for (const u of cases) {
        expect(await store.readResource(u), u).toBeNull();
      }
    });
  });
});