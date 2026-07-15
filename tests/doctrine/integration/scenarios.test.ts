import { describe, it, expect } from 'vitest';
import { RecoveryMachine } from '../../../src/doctrine/recovery-machine.js';
import { StateIntegrityTracker } from '../../../src/doctrine/state-integrity.js';
import { IdempotencyRegistry } from '../../../src/doctrine/idempotency.js';
import { TelemetryCollector } from '../../../src/doctrine/telemetry.js';
import { DEFAULT_RETRY_POLICIES } from '../../../src/doctrine/retry-engine.js';
import { MVP_CODES } from '../../../src/doctrine/registry.js';

function setupMachine() {
  const tracker = new StateIntegrityTracker('ses_integration');
  const idem = new IdempotencyRegistry({ defaultTtlMs: 60000 });
  const telemetry = new TelemetryCollector();
  tracker.markKnown('cp_init');
  const machine = new RecoveryMachine({
    tracker, idempotency: idem, policies: DEFAULT_RETRY_POLICIES,
  });
  return { machine, tracker, idem, telemetry };
}

describe('Integration: all 12 MVP error codes', () => {
  for (const def of MVP_CODES) {
    it(`${def.code} (${def.severity}) is producible and classified`, async () => {
      const { machine } = setupMachine();

      const result = await machine.execute({
        tool: 'yautja_act',
        action_type: 'click',
        policy_key: 'act.click',
        trace_id: 'tr_integration',
        fn: async () => ({ error: { code: def.code } }),
        verify: async () => true,
      });

      expect(result.ok).toBe(false);
      if (!result.ok && result.error) {
        expect(result.error.code).toBe(def.code);
        expect(result.error.severity).toBe(def.severity);
        expect(result.error.retryable).toBe(def.retryable);
        expect(result.error.category).toBe(def.category);
        expect(result.error.introduced_in).toBe('1.0');
        expect(result.error.message).toBeTruthy();
        expect(result.error.agent_summary).toBeTruthy();
        expect(result.error.recovery.allowed.length).toBeGreaterThan(0);
        expect(result.error.recovery.recommended).toBeTruthy();
      }
    });
  }

  it('terminal code does not retry (1 call only)', async () => {
    const { machine } = setupMachine();
    let calls = 0;
    const result = await machine.execute({
      tool: 'yautja_act',
      action_type: 'click',
      policy_key: 'act.click',
      trace_id: 'tr_term',
      fn: async () => {
        calls++;
        return { error: { code: 'YJ.OPSEC.ANOMALY_RISK_ELEVATED' } };
      },
      verify: async () => true,
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('transient code retries up to max_attempts', async () => {
    const { machine } = setupMachine();
    let calls = 0;
    await machine.execute({
      tool: 'yautja_act',
      action_type: 'click',
      policy_key: 'default',
      trace_id: 'tr_transient',
      fn: async () => {
        calls++;
        return { error: { code: 'YJ.NET.REQUEST_TIMEOUT' } };
      },
      verify: async () => true,
    });
    expect(calls).toBe(2);
  });

  it('recoverable code retries then can succeed', async () => {
    const { machine } = setupMachine();
    let calls = 0;
    const result = await machine.execute({
      tool: 'yautja_act',
      action_type: 'click',
      policy_key: 'act.click',
      trace_id: 'tr_recover',
      fn: async () => {
        calls++;
        if (calls < 2) return { error: { code: 'YJ.ACT.DOM_TARGET_STALE' } };
        return { value: 'success' };
      },
      verify: async () => true,
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });
});
