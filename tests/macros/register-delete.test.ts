import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MacroRunner } from '../../src/macros/runner.js';
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

describe('MacroRunner.registerUserMacro', () => {
  let dir: string;
  let runner: MacroRunner;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yautja-reg-'));
    process.env.YAUTJA_USER_DIR = dir;
    runner = new MacroRunner(mockCtx as any);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.YAUTJA_USER_DIR;
  });

  const validSource = `export default { name: 'demo', description: 'demo', async run() { return 1; } };`;

  it('writes file, imports, registers with source=user', async () => {
    const r = await runner.registerUserMacro('demo', validSource);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.source).toBe('user');
      expect(fs.existsSync(r.file)).toBe(true);
    }
    expect(runner.get('demo')?.source).toBe('user');
  });

  it('rejects invalid name', async () => {
    const r = await runner.registerUserMacro('Bad Name!', validSource);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.stage).toBe('validation');
  });

  it('refuses existing macro without overwrite=true', async () => {
    await runner.registerUserMacro('demo', validSource);
    const r = await runner.registerUserMacro('demo', validSource);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.stage).toBe('persistence');
  });

  it('overwrites with overwrite=true', async () => {
    await runner.registerUserMacro('demo', validSource);
    const r = await runner.registerUserMacro('demo', validSource, true);
    expect(r.success).toBe(true);
  });

  it('rejects source with no default export (shape)', async () => {
    const r = await runner.registerUserMacro('badshape', `export const x = 1;`);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.stage).toBe('shape');
    expect(runner.get('badshape')).toBeUndefined();
  });

  it('rejects source that throws on import', async () => {
    const r = await runner.registerUserMacro('badsrc', `throw new Error('boom');`);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.stage).toBe('import');
  });
});

describe('MacroRunner.deleteUserMacro', () => {
  let dir: string;
  let runner: MacroRunner;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yautja-del-'));
    process.env.YAUTJA_USER_DIR = dir;
    runner = new MacroRunner(mockCtx as any);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.YAUTJA_USER_DIR;
  });

  it('deletes existing user macro and removes file', async () => {
    await runner.registerUserMacro('demo', `export default { name: 'demo', description: 'd', async run() { return 1; } };`);
    expect(fs.existsSync(path.join(dir, 'demo.js'))).toBe(true);

    const r = await runner.deleteUserMacro('demo');
    expect(r.success).toBe(true);
    if (r.success) expect(fs.existsSync(r.removedFile)).toBe(false);
    expect(runner.get('demo')).toBeUndefined();
  });

  it('refuses to delete built-in macro', async () => {
    runner.register({ name: 'builtin1', description: 'b', async run() { return 0; } }, 'builtin');
    const r = await runner.deleteUserMacro('builtin1');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.stage).toBe('permission');
    expect(runner.get('builtin1')).toBeDefined();
  });

  it('returns lookup error for unknown macro', async () => {
    const r = await runner.deleteUserMacro('ghost');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.stage).toBe('lookup');
  });

  it('returns io error if file missing but registry has it', async () => {
    runner.register(
      { name: 'phantom', description: 'p', async run() { return 0; } },
      'user',
      path.join(dir, 'phantom.js'),
    );
    const r = await runner.deleteUserMacro('phantom');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.stage).toBe('io');
    expect(runner.get('phantom')).toBeUndefined();
  });
});