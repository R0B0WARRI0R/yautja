import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// SiteMemory computes MEMORY_DIR from APPDATA at module load — stub it.
let tmp: string;

describe('SiteMemory v2', () => {
  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yautja-sitemem-'));
    vi.stubEnv('APPDATA', tmp);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function makeMemory() {
    const { SiteMemory } = await import('../../src/memory/site-memory.js');
    return new SiteMemory();
  }

  it('v1 entries (selector/method only) still work via get and getInput', async () => {
    const mem = await makeMemory();
    mem.save('example.com', { inputs: { search: { selector: '#q', method: 'input' } } });
    expect(mem.get('example.com')!.inputs.search!.selector).toBe('#q');
    expect(mem.getInput('example.com', 'search')!.selector).toBe('#q');
  });

  it('recordHit bumps hits and lastHit', async () => {
    const mem = await makeMemory();
    mem.save('example.com', { inputs: { search: { selector: '#q', method: 'input' } } });
    mem.recordHit('example.com', 'search');
    mem.recordHit('example.com', 'search');
    const entry = mem.getInput('example.com', 'search')!;
    expect(entry.hits).toBe(2);
    expect(entry.lastHit).toBeTruthy();
  });

  it('recordHit on unknown entry is a no-op', async () => {
    const mem = await makeMemory();
    expect(() => mem.recordHit('example.com', 'ghost')).not.toThrow();
  });

  it('expired entry (old lastHit beyond ttlDays) is not returned by getInput', async () => {
    const mem = await makeMemory();
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    mem.save('example.com', {
      inputs: {
        search: { selector: '#q', method: 'input', hits: 5, lastHit: old, ttlDays: 7 },
      },
    });
    expect(mem.getInput('example.com', 'search')).toBeNull();
    // ...but the raw profile still loads (file-level MAX_AGE not hit)
    expect(mem.get('example.com')!.inputs.search).toBeDefined();
  });

  it('custom ttlDays keeps a recent entry fresh', async () => {
    const mem = await makeMemory();
    const recent = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    mem.save('example.com', {
      inputs: {
        search: { selector: '#q', method: 'input', lastHit: recent, ttlDays: 30 },
      },
    });
    expect(mem.getInput('example.com', 'search')).not.toBeNull();
  });

  it('v2 fields (strategies, buildVersion) persist to disk', async () => {
    const mem = await makeMemory();
    mem.save('example.com', {
      inputs: {
        search: {
          selector: '#q',
          method: 'input',
          strategies: [
            { kind: 'aria', value: 'Search', score: 0.9 },
            { kind: 'css', value: '#q', score: 0.7 },
          ],
          buildVersion: 'boq_20260709',
        },
      },
    });
    const file = path.join(tmp, '.yautja-memory', 'example.com.json');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk.inputs.search.strategies).toHaveLength(2);
    expect(onDisk.inputs.search.buildVersion).toBe('boq_20260709');
  });

  it('persists across instances (disk round-trip)', async () => {
    const mem1 = await makeMemory();
    mem1.save('example.com', { inputs: { search: { selector: '#q', method: 'input' } } });
    vi.resetModules();
    const mem2 = await makeMemory();
    expect(mem2.getInput('example.com', 'search')!.selector).toBe('#q');
  });
});
