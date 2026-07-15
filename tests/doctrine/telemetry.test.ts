import { describe, it, expect, beforeEach } from 'vitest';
import { TelemetryCollector, type RecoveryOutcome } from '../../src/doctrine/telemetry.js';

describe('TelemetryCollector', () => {
  let telemetry: TelemetryCollector;

  beforeEach(() => {
    telemetry = new TelemetryCollector();
  });

  it('records a recovery outcome', () => {
    telemetry.record({
      trace_id: 'tr_1',
      operation_id: 'op_1',
      original_error_code: 'YJ.ACT.DOM_TARGET_STALE',
      recovery_strategy: 'REOBSERVE_THEN_RETRY',
      attempts: 2,
      outcome: 'recovered',
      time_to_recover_ms: 500,
      context_cost_delta_tokens: 200,
      deviated_from_recommendation: false,
    });
    expect(telemetry.count()).toBe(1);
  });

  it('queries outcomes by error code', () => {
    telemetry.record({
      trace_id: 'tr_1', operation_id: 'op_1',
      original_error_code: 'YJ.ACT.DOM_TARGET_STALE',
      recovery_strategy: 'REOBSERVE_THEN_RETRY', attempts: 2,
      outcome: 'recovered', time_to_recover_ms: 500,
      context_cost_delta_tokens: 200, deviated_from_recommendation: false,
    });
    telemetry.record({
      trace_id: 'tr_2', operation_id: 'op_2',
      original_error_code: 'YJ.NET.REQUEST_TIMEOUT',
      recovery_strategy: 'RETRY_SAME', attempts: 3,
      outcome: 'failed', time_to_recover_ms: 3000,
      context_cost_delta_tokens: 0, deviated_from_recommendation: false,
    });
    const staleOutcomes = telemetry.query({ code: 'YJ.ACT.DOM_TARGET_STALE' });
    expect(staleOutcomes).toHaveLength(1);
    expect(staleOutcomes[0].outcome).toBe('recovered');
  });

  it('computes recovery success rate', () => {
    for (let i = 0; i < 4; i++) {
      telemetry.record({
        trace_id: `tr_${i}`, operation_id: `op_${i}`,
        original_error_code: 'YJ.ACT.DOM_TARGET_STALE',
        recovery_strategy: 'REOBSERVE_THEN_RETRY', attempts: 2,
        outcome: i < 3 ? 'recovered' : 'failed',
        time_to_recover_ms: 500, context_cost_delta_tokens: 100,
        deviated_from_recommendation: false,
      });
    }
    const stats = telemetry.stats({ code: 'YJ.ACT.DOM_TARGET_STALE' });
    expect(stats.total).toBe(4);
    expect(stats.recovered).toBe(3);
    expect(stats.successRate).toBe(0.75);
  });
});