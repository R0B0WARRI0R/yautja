import { describe, expect, it, vi } from 'vitest';
import { MacroRunner } from '../../src/macros/runner.js';
import { ExtensionServer } from '../../src/connection/extension-server.js';
import { RecoveryMachine } from '../../src/doctrine/recovery-machine.js';
import { IdempotencyRegistry } from '../../src/doctrine/idempotency.js';
import { StateIntegrityTracker } from '../../src/doctrine/state-integrity.js';
import { DEFAULT_RETRY_POLICIES } from '../../src/doctrine/retry-engine.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe('macro deadline regression', () => {
  it('blocks a late action even when the macro uses its own wait', async () => {
    const wait = deferred();
    const done = deferred();
    const act = vi.fn(async () => '{}');
    const runner = new MacroRunner({ act } as any);
    runner.register({ name: 'late', description: 'test', async run(_, ctx) {
      await wait.promise;
      try { await ctx.act({ type: 'click', selector: '#send' }); }
      catch { /* a macro may catch cancellation; the host must remain untouched */ }
      finally { done.resolve(); }
    } }, 'builtin');
    expect(await runner.run('late', {}, 10)).toMatchObject({ success: false, stage: 'timeout' });
    wait.resolve();
    await done.promise;
    expect(act).not.toHaveBeenCalled();
  });

  it('cancels ctx.sleep and refuses a caught cancellation followed by callTool', async () => {
    const done = deferred();
    const callTool = vi.fn(async () => '{}');
    const runner = new MacroRunner({ callTool } as any);
    runner.register({ name: 'sleeping', description: 'test', async run(_, ctx) {
      try { await ctx.sleep(60_000); } catch { /* deliberately continue */ }
      try { await ctx.callTool('act', { action: { type: 'click' } }); } catch {}
      done.resolve();
    } }, 'builtin');
    expect(await runner.run('sleeping', {}, 10)).toMatchObject({ success: false, stage: 'timeout' });
    await done.promise;
    expect(callTool).not.toHaveBeenCalled();
  });

  it('blocks subsequent transport commands inside an already started tool', async () => {
    const wait = deferred();
    const done = deferred();
    const sendToBroker = vi.fn(async () => ({}));
    const server = new ExtensionServer(0);
    server.setBrokerClient({ isRegistered: () => true, sendToBroker, onStatusChange: () => {} } as any);
    const runner = new MacroRunner({ callTool: async () => {
      await wait.promise;
      try { await (server as any).sendCommand({ type: 'closeTab', tabId: 1 }); }
      finally { done.resolve(); }
      return '{}';
    } } as any);
    runner.register({ name: 'inflight', description: 'test', run: (_, ctx) => ctx.callTool('test') }, 'builtin');
    expect(await runner.run('inflight', {}, 10)).toMatchObject({ stage: 'timeout' });
    wait.resolve();
    await done.promise;
    expect(sendToBroker).not.toHaveBeenCalled();
    // Unrelated work in this process must remain usable.
    await (server as any).sendCommand({ type: 'listTabs' });
    expect(sendToBroker).toHaveBeenCalledTimes(1);
  });

  it('revokes a saved context after success', async () => {
    let saved: any;
    const act = vi.fn(async () => '{}');
    const runner = new MacroRunner({ act } as any);
    runner.register({ name: 'saved', description: 'test', async run(_, ctx) { saved = ctx; return 'ok'; } }, 'builtin');
    expect(await runner.run('saved')).toMatchObject({ success: true });
    expect(() => saved.act({ type: 'click' })).toThrow('Macro execution has ended');
    expect(act).not.toHaveBeenCalled();
  });

  it('propagates parent timeout into a nested macro', async () => {
    const wait = deferred();
    const done = deferred();
    const act = vi.fn(async () => '{}');
    const runner = new MacroRunner({ act, callTool: async () => JSON.stringify(await runner.run('child', {}, 60_000)) } as any);
    runner.register({ name: 'child', description: 'test', async run(_, ctx) {
      await wait.promise;
      try { await ctx.act({ type: 'click', selector: '#send' }); } catch {}
      finally { done.resolve(); }
    } }, 'builtin');
    runner.register({ name: 'parent', description: 'test', run: (_, ctx) => ctx.callTool('macro_run') }, 'builtin');
    expect(await runner.run('parent', {}, 10)).toMatchObject({ stage: 'timeout' });
    wait.resolve();
    await done.promise;
    expect(act).not.toHaveBeenCalled();
  });
});

describe('concurrent idempotency regression', () => {
  function setup() {
    return new RecoveryMachine({
      tracker: new StateIntegrityTracker('test-session'),
      idempotency: new IdempotencyRegistry({ defaultTtlMs: 60_000 }),
      policies: DEFAULT_RETRY_POLICIES,
    });
  }
  const base = { tool: 'smartType', action_type: 'type', policy_key: 'act.type', trace_id: 'test', idempotency_key: 'same' };

  it('executes and verifies a simultaneous request only once', async () => {
    const machine = setup();
    const wait = deferred();
    const fn = vi.fn(async () => { await wait.promise; return { value: 'submitted' }; });
    const verify = vi.fn(async () => true);
    const first = machine.execute({ ...base, fn, verify });
    const second = machine.execute({ ...base, fn, verify });
    wait.resolve();
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(results[1]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('does not reuse another session result', async () => {
    const machine = setup();
    const fn = vi.fn(async () => ({ value: 'ok' }));
    await machine.execute({ ...base, session_id: 'a', fn });
    await machine.execute({ ...base, session_id: 'b', fn });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rejects conflicting arguments or targets while pending and after success', async () => {
    const machine = setup();
    const wait = deferred();
    const fn = vi.fn(async () => { await wait.promise; return { value: 'ok' }; });
    const original = { ...base, tab_id: 1, idempotency_input: { text: 'first' }, fn };
    const first = machine.execute(original);
    const conflict = await machine.execute({ ...original, idempotency_input: { text: 'different' } });
    expect(conflict).toMatchObject({ ok: false, error: { code: 'YJ.PROTOCOL.INVALID_ARGUMENT' } });
    wait.resolve();
    await first;
    expect(await machine.execute({ ...original, tab_id: 2 })).toMatchObject({ ok: false });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('releases the pending slot after an exception', async () => {
    const machine = setup();
    await expect(machine.execute({ ...base, fn: async () => { throw new Error('failed'); } })).rejects.toThrow('failed');
    expect(await machine.execute({ ...base, fn: async () => ({ value: 'retry' }) })).toMatchObject({ ok: true });
  });

  it('shares failures with waiters but permits a later retry', async () => {
    const machine = setup();
    const fn = vi.fn(async () => ({ error: { code: 'YJ.PROTOCOL.INVALID_ARGUMENT' } }));
    const results = await Promise.all([machine.execute({ ...base, fn }), machine.execute({ ...base, fn })]);
    expect(results.every(result => !result.ok)).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await machine.execute({ ...base, fn: async () => ({ value: 'retry' }) })).toMatchObject({ ok: true });
  });

  it('ignores JSON key order and keeps cached results isolated from caller mutation', async () => {
    const machine = setup();
    const fn = vi.fn(async () => ({ value: { submitted: true } }));
    const result = await machine.execute({ ...base, idempotency_input: { a: 1, b: 2 }, fn });
    (result.result as any).submitted = false;
    const cached = await machine.execute({ ...base, idempotency_input: { b: 2, a: 1 }, fn });
    expect(cached.result).toEqual({ submitted: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
