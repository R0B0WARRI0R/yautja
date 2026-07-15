import { describe, it, expect } from 'vitest';
import { RetryEngine, calculateBackoff, type RetryPolicy } from '../../src/doctrine/retry-engine.js';

describe('Retry Engine', () => {
  const samplePolicy: RetryPolicy = {
    policy_id: 'act.click.v1',
    max_attempts: 3,
    backoff: { kind: 'exponential_jitter', base_ms: 100, max_ms: 1000 },
    retry_on: ['YJ.ACT.DOM_TARGET_STALE', 'YJ.NET.REQUEST_TIMEOUT'],
    never_retry_on: ['YJ.OPSEC.ANOMALY_RISK_ELEVATED', 'YJ.ACT.ACTION_NOT_IDEMPOTENT'],
    escalation: ['RETRY_SAME', 'REOBSERVE_THEN_RETRY', 'ROLLBACK_TO_CHECKPOINT', 'ABORT'],
  };

  describe('calculateBackoff', () => {
    it('returns base_ms for attempt 1', () => {
      const delay = calculateBackoff(samplePolicy.backoff, 1);
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThanOrEqual(200);
    });

    it('exponentially increases', () => {
      const d1 = calculateBackoff(samplePolicy.backoff, 1);
      const d2 = calculateBackoff(samplePolicy.backoff, 2);
      const d3 = calculateBackoff(samplePolicy.backoff, 3);
      expect(d2).toBeGreaterThan(d1 * 0.5);
      expect(d3).toBeGreaterThan(d2 * 0.5);
    });

    it('respects max_ms cap', () => {
      const delay = calculateBackoff(samplePolicy.backoff, 10);
      expect(delay).toBeLessThanOrEqual(1000);
    });
  });

  describe('RetryEngine.shouldRetry', () => {
    const engine = new RetryEngine(samplePolicy);

    it('allows retry for code in retry_on', () => {
      expect(engine.shouldRetry('YJ.ACT.DOM_TARGET_STALE', 1)).toBe(true);
    });

    it('denies retry for code in never_retry_on', () => {
      expect(engine.shouldRetry('YJ.OPSEC.ANOMALY_RISK_ELEVATED', 1)).toBe(false);
    });

    it('denies retry when max_attempts exceeded', () => {
      expect(engine.shouldRetry('YJ.NET.REQUEST_TIMEOUT', 3)).toBe(false);
    });

    it('denies retry for codes not in retry_on', () => {
      expect(engine.shouldRetry('YJ.PROTOCOL.INVALID_ARGUMENT', 1)).toBe(false);
    });
  });

  describe('RetryEngine.nextEscalation', () => {
    const engine = new RetryEngine(samplePolicy);

    it('returns first escalation for attempt 1', () => {
      expect(engine.nextEscalation(1)).toBe('RETRY_SAME');
    });

    it('returns second escalation for attempt 2', () => {
      expect(engine.nextEscalation(2)).toBe('REOBSERVE_THEN_RETRY');
    });

    it('returns ABORT when escalations exhausted', () => {
      expect(engine.nextEscalation(5)).toBe('ABORT');
    });
  });
});
