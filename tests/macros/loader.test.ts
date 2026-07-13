import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MacroRunner } from '../../src/macros/runner.js';
import { loadBuiltins, loadUserMacros } from '../../src/macros/loader.js';
import type { MacroContext } from '../../src/macros/types.js';

const mockCtx: MacroContext = {
  openTab: vi.fn(async () => '{}'), switchTab: vi.fn(async () => '{}'),
  closeTab: vi.fn(async () => '{}'), reattach: vi.fn(async () => '{}'),
  observe: vi.fn(async () => '{}'), inspect: vi.fn(async () => '{}'),
  diff: vi.fn(async () => '{}'), act: vi.fn(async () => '{}'),
  findElement: vi.fn(async () => '{}'), findClick: vi.fn(async () => '{}'),
  findType: vi.fn(async () => '{}'), smartType: vi.fn(async () => '{}'),
  techScan: vi.fn(async () => '{}'), stealthCheck: vi.fn(async () => '{}'),
  stealthEnable: vi.fn(async () => '{}'), stealthDisable: vi.fn(async () => '{}'),
  interceptEnable: vi.fn(async () => '{}'), interceptAddRule: vi.fn(async () => '{}'),
  interceptDisable: vi.fn(async () => '{}'), interceptLog: vi.fn(async () => '{}'),
  captureList: vi.fn(async () => '{}'), captureRequest: vi.fn(async () => '{}'),
  captureResponse: vi.fn(async () => '{}'), osintHarvest: vi.fn(async () => '{}'),
  netIntel: vi.fn(async () => '{}'), gqlQuery: vi.fn(async () => '{}'),
  siteMemory: vi.fn(async () => '{}'), siteMemoryClear: vi.fn(async () => '{}'),
  wsWatch: vi.fn(async () => '{}'), wsFrames: vi.fn(async () => '{}'),
  sleep: vi.fn(async () => {}), log: vi.fn(),
};

describe('loadBuiltins', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yautja-builtin-'));
    process.env.YAUTJA_BUILTIN_DIR = dir;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.YAUTJA_BUILTIN_DIR;
  });

  it('loads a valid macro .js file', async () => {
    const file = path.join(dir, 'greet.js');
    fs.writeFileSync(file, `
      export default {
        name: 'greet',
        description: 'says hi',
        async run() { return 'hi'; },
      };
    `);
    const runner = new MacroRunner(mockCtx as any);
    const result = await loadBuiltins(runner);
    expect(result.loaded).toEqual(['greet']);
    expect(result.skipped).toEqual([]);
    expect(runner.list().map(m => m.name)).toContain('greet');
  });

  it('skips runner.js, types.js, index.js, loader.js', async () => {
    for (const n of ['runner', 'types', 'index', 'loader']) {
      fs.writeFileSync(path.join(dir, n + '.js'), `export default {};`);
    }
    const runner = new MacroRunner(mockCtx as any);
    const result = await loadBuiltins(runner);
    expect(result.loaded).toEqual([]);
    expect(result.skipped.length).toBe(0);
  });

  it('records malformed file in skipped, continues loading others', async () => {
    fs.writeFileSync(path.join(dir, 'broken.js'), `export default {};`);
    fs.writeFileSync(path.join(dir, 'good.js'), `
      export default { name: 'good', description: 'ok', async run() { return 1; } };
    `);
    const runner = new MacroRunner(mockCtx as any);
    const result = await loadBuiltins(runner);
    expect(result.loaded).toEqual(['good']);
    expect(result.skipped).toEqual(['broken.js']);
  });

  it('skips directory that does not exist silently', async () => {
    process.env.YAUTJA_BUILTIN_DIR = path.join(dir, 'nonexistent');
    const runner = new MacroRunner(mockCtx as any);
    const result = await loadBuiltins(runner);
    expect(result.loaded).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});

describe('loadUserMacros', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yautja-user-'));
    process.env.YAUTJA_USER_DIR = dir;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.YAUTJA_USER_DIR;
  });

  it('loads .js file with cache-busting query param', async () => {
    fs.writeFileSync(path.join(dir, 'scrape.js'), `
      export default { name: 'scrape', description: 'scrapes', async run() { return 'data'; } };
    `);
    const runner = new MacroRunner(mockCtx as any);
    const result = await loadUserMacros(runner);
    expect(result.loaded).toEqual(['scrape']);
    expect(runner.get('scrape')?.source).toBe('user');
    expect(runner.get('scrape')?.file).toBe(path.join(dir, 'scrape.js'));
  });

  it('skips hidden files (starting with .)', async () => {
    fs.writeFileSync(path.join(dir, '.hidden.js'), `export default {};`);
    const runner = new MacroRunner(mockCtx as any);
    const result = await loadUserMacros(runner);
    expect(result.loaded).toEqual([]);
  });

  it('creates user dir if missing, loads nothing', async () => {
    process.env.YAUTJA_USER_DIR = path.join(dir, 'newdir');
    const runner = new MacroRunner(mockCtx as any);
    const result = await loadUserMacros(runner);
    expect(result.loaded).toEqual([]);
    expect(fs.existsSync(process.env.YAUTJA_USER_DIR!)).toBe(true);
  });

  it('skips malformed file, records in skipped', async () => {
    fs.writeFileSync(path.join(dir, 'bad.js'), `throw new Error('syntax');`);
    const runner = new MacroRunner(mockCtx as any);
    const result = await loadUserMacros(runner);
    expect(result.skipped).toEqual(['bad.js']);
  });
});