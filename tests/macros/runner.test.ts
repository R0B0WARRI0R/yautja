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

describe('MacroRunner.run', () => {
  let runner: MacroRunner;
  beforeEach(() => {
    runner = new MacroRunner({} as any);
  });

  it('returns lookup error for unknown macro', async () => {
    const r = await runner.run('nope');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.stage).toBe('lookup');
  });

  it('runs a no-arg macro and returns result + log + elapsedMs', async () => {
    runner.register({
      name: 'hi',
      description: 'greets',
      async run(_args, c) {
        c.log('starting');
        await c.sleep(5);
        c.log('done');
        return 42;
      },
    }, 'builtin');
    const r = await runner.run('hi');
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.result).toBe(42);
      expect(r.log).toEqual(['starting', 'done']);
      expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(r.macro.name).toBe('hi');
    }
  });

  it('validates missing required args before run', async () => {
    runner.register({
      name: 'login',
      description: 'login',
      argsSchema: {
        type: 'object',
        properties: { user: { type: 'string' }, pass: { type: 'string' } },
        required: ['user', 'pass'],
      },
      async run() { return 'ok'; },
    }, 'builtin');
    const r = await runner.run('login', { user: 'bob' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.stage).toBe('validation');
      expect(r.error).toMatch(/pass/);
    }
  });

  it('validates wrong-type arg', async () => {
    runner.register({
      name: 'agecheck',
      description: 'age',
      argsSchema: { type: 'object', properties: { age: { type: 'number' } }, required: ['age'] },
      async run() { return 'ok'; },
    }, 'builtin');
    const r = await runner.run('agecheck', { age: 'twenty' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.stage).toBe('validation');
  });

  it('allows extra args (no additionalProperties:false)', async () => {
    runner.register({
      name: 'echo',
      description: 'echo',
      argsSchema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      async run(args) { return (args as any).x; },
    }, 'builtin');
    const r = await runner.run('echo', { x: 'hello', extra: 1 });
    expect(r.success).toBe(true);
  });

  it('captures thrown error with stack', async () => {
    runner.register({
      name: 'boom',
      description: 'throws',
      async run() { throw new Error('kaboom'); },
    }, 'builtin');
    const r = await runner.run('boom');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.stage).toBe('execution');
      expect(r.error).toBe('kaboom');
      expect(typeof r.stack).toBe('string');
    }
  });

  it('aborts on macro timeoutMs', async () => {
    runner.register({
      name: 'slow',
      description: 'slow',
      timeoutMs: 50,
      async run(_, c) { await c.sleep(500); return 'late'; },
    }, 'builtin');
    const r = await runner.run('slow');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.stage).toBe('timeout');
      expect((r.elapsedMs ?? 0)).toBeGreaterThanOrEqual(45);
    }
  });

  it('per-call timeoutMs overrides macro default', async () => {
    runner.register({
      name: 'medium',
      description: 'medium',
      timeoutMs: 10_000,
      async run(_, c) { await c.sleep(200); return 'done'; },
    }, 'builtin');
    const r = await runner.run('medium', undefined, 50);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.stage).toBe('timeout');
  });
});