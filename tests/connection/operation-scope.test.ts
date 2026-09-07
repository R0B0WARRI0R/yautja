import { describe, expect, it } from 'vitest';
import { OperationManager, currentOperation, assertOperationActive, pinOperationTarget } from '../../src/connection/operation-scope.js';

describe('operation lifetime and targeting', () => {
  it('pins a target, including tabs on the same host', async () => {
    const manager = new OperationManager();
    await manager.run('act', async () => {
      pinOperationTarget(12, 'generation-1');
      expect(() => pinOperationTarget(13, 'generation-1')).toThrow(/target/i);
      expect(() => pinOperationTarget(12, 'generation-2')).toThrow(/generation/i);
    });
  });

  it('revokes late continuations after the overall deadline', async () => {
    const manager = new OperationManager();
    let resume!: () => void;
    let sent = false;
    const result = manager.run('act', async () => {
      await new Promise<void>(resolve => { resume = resolve; });
      assertOperationActive();
      sent = true;
    }, { timeoutMs: 20 });
    await expect(result).rejects.toThrow(/deadline/i);
    resume();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(sent).toBe(false);
  });

  it('cancelled queued work never executes', async () => {
    const manager = new OperationManager();
    let release!: () => void;
    const first = manager.run('first', () => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    let executed = false;
    const second = manager.run('second', async () => { executed = true; }, { requestId: '2' });
    expect(manager.cancel('2')).toBe(true);
    await expect(second).rejects.toThrow(/cancel/i);
    let thirdExecuted = false;
    const third = manager.run('third', async () => { thirdExecuted = true; });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(thirdExecuted).toBe(false);
    release();
    await first;
    await third;
    expect(thirdExecuted).toBe(true);
    expect(executed).toBe(false);
  });

  it('allows nested tools without deadlock and exposes state', async () => {
    const manager = new OperationManager();
    await manager.run('macro', async () => {
      const id = currentOperation()!.id;
      await manager.run('nested', async () => expect(currentOperation()!.id).toBe(id));
    });
    expect(manager.list()[0].state).toBe('succeeded');
  });
});
