import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TraceStore } from '../../src/doctrine/trace-store.js';
import { rmSync, existsSync } from 'node:fs';
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

  it('lists traces for cleanup', () => {
    const expired = store.findExpired(0);
    expect(Array.isArray(expired)).toBe(true);
  });
});