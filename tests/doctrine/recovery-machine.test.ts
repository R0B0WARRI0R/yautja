import { describe, it, expect, vi } from 'vitest';
import { RecoveryMachine } from '../../src/doctrine/recovery-machine.js';
import { StateIntegrityTracker } from '../../src/doctrine/state-integrity.js';
import { IdempotencyRegistry } from '../../src/doctrine/idempotency.js';
import { DEFAULT_RETRY_POLICIES } from '../../src/doctrine/retry-engine.js';

describe('RecoveryMachine', () => {
  function setup() {
    const tracker = new StateIntegrityTracker('ses_test');
    const idem = new IdempotencyRegistry({ defaultTtlMs: 60000 });
    const machine = new RecoveryMachine({
      tracker,
      idempotency: idem,
      policies: DEFAULT_RETRY_POLICIES,
    });
    return { machine, tracker, idem };
  }

  it('returns success for a passing operation', async () => {
    const { machine } = setup();
    const result = await machine.execute({
      tool: 'yautja_act',
      action_type: 'click',
      policy_key: 'act.click',
      trace_id: 'tr_test',
      fn: async () => ({ value: 'clicked' }),
      verify: async () => true,
    });
    expect(result.ok).toBe(true);
    expect(result.result).toBe('clicked');
    expect(result.operation.attempt).toBe(1);
  });

  it('retries on recoverable error then succeeds', async () => {
    const { machine } = setup();
    let calls = 0;
    const result = await machine.execute({
      tool: 'yautja_act',
      action_type: 'click',
      policy_key: 'act.click',
      trace_id: 'tr_test',
      fn: async () => {
        calls++;
        if (calls === 1) {
          return { error: { code: 'YJ.ACT.DOM_TARGET_STALE' } };
        }
        return { value: 'clicked' };
      },
      verify: async () => true,
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('aborts on terminal error', async () => {
    const { machine } = setup();
    const result = await machine.execute({
      tool: 'yautja_act',
      action_type: 'click',
      policy_key: 'act.click',
      trace_id: 'tr_test',
      fn: async () => ({ error: { code: 'YJ.OPSEC.ANOMALY_RISK_ELEVATED' } }),
      verify: async () => true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error!.code).toBe('YJ.OPSEC.ANOMALY_RISK_ELEVATED');
      expect(result.error!.severity).toBe('terminal');
    }
  });

  it('respects max_attempts', async () => {
    const { machine } = setup();
    let calls = 0;
    const result = await machine.execute({
      tool: 'yautja_act',
      action_type: 'click',
      policy_key: 'act.click',
      trace_id: 'tr_test',
      fn: async () => {
        calls++;
        return { error: { code: 'YJ.ACT.DOM_TARGET_STALE' } };
      },
      verify: async () => true,
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(3); // max_attempts for act.click
  });

  it('blocks when state is contaminated', async () => {
    const { machine, tracker } = setup();
    tracker.markContaminated('test contamination');
    const result = await machine.execute({
      tool: 'yautja_act',
      action_type: 'click',
      policy_key: 'act.click',
      trace_id: 'tr_test',
      fn: async () => ({ value: 'should not reach' }),
      verify: async () => true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error!.code).toBe('YJ.OPSEC.ANOMALY_RISK_ELEVATED');
    }
  });

  it('returns cached result for same idempotency_key', async () => {
    const { machine } = setup();
    const fn = vi.fn(async () => ({ value: 'first' }));
    const opts = {
      tool: 'yautja_act',
      action_type: 'click',
      policy_key: 'act.click',
      trace_id: 'tr_test',
      idempotency_key: 'ik_test_1',
      fn,
      verify: async () => true,
    };
    const r1 = await machine.execute(opts);
    const r2 = await machine.execute(opts);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1); // not called second time
  });
});
