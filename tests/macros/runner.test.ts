import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MacroRunner } from '../../src/macros/runner.js';
import type { MacroContext, MacroDef } from '../../src/macros/types.js';

function makeMockCtx(): MacroContext {
  return {
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
}

const sampleDef: MacroDef = { name: 'sample', description: 'A sample macro', async run() { return 'done'; } };

describe('MacroRunner registry', () => {
  let runner: MacroRunner;
  beforeEach(() => {
    runner = new MacroRunner({} as any); // host unused in Task 2
  });

  it('registers a macro and lists it as builtin by default', () => {
    runner.register(sampleDef, 'builtin');
    const list = runner.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'sample', source: 'builtin', hasArgs: false });
  });

  it('registers with argsSchema and reports hasArgs=true', () => {
    runner.register({
      name: 'login',
      description: 'login flow',
      argsSchema: { type: 'object', properties: { user: { type: 'string' } }, required: ['user'] },
      async run() { return 'ok'; },
    }, 'builtin');
    expect(runner.list()[0].hasArgs).toBe(true);
  });

  it('get returns the entry; unknown returns undefined', () => {
    runner.register(sampleDef, 'builtin');
    expect(runner.get('sample')?.def.name).toBe('sample');
    expect(runner.get('nope')).toBeUndefined();
  });

  it('unregister removes and returns true; false if absent', () => {
    runner.register(sampleDef, 'builtin');
    expect(runner.unregister('sample')).toBe(true);
    expect(runner.list()).toHaveLength(0);
    expect(runner.unregister('sample')).toBe(false);
  });

  it('re-registering same name overwrites', () => {
    runner.register(sampleDef, 'builtin');
    runner.register({ ...sampleDef, description: 'updated' }, 'user');
    expect(runner.list()).toHaveLength(1);
    expect(runner.list()[0].description).toBe('updated');
    expect(runner.list()[0].source).toBe('user');
  });
});