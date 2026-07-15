export interface BackoffPolicy {
  kind: 'exponential_jitter' | 'fixed' | 'linear';
  base_ms: number;
  max_ms: number;
}

export interface RetryPolicy {
  policy_id: string;
  max_attempts: number;
  backoff: BackoffPolicy;
  retry_on: string[];
  never_retry_on: string[];
  escalation: string[];
}

export function calculateBackoff(policy: BackoffPolicy, attempt: number): number {
  switch (policy.kind) {
    case 'fixed':
      return policy.base_ms;
    case 'linear':
      return Math.min(policy.base_ms * attempt, policy.max_ms);
    case 'exponential_jitter':
    default: {
      const exponential = policy.base_ms * Math.pow(2, attempt - 1);
      const capped = Math.min(exponential, policy.max_ms);
      const jitter = capped * 0.25 * Math.random();
      return Math.min(Math.floor(capped + jitter), policy.max_ms);
    }
  }
}

export class RetryEngine {
  private policy: RetryPolicy;

  constructor(policy: RetryPolicy) {
    this.policy = policy;
  }

  shouldRetry(code: string, attempt: number): boolean {
    if (attempt >= this.policy.max_attempts) return false;
    if (this.policy.never_retry_on.includes(code)) return false;
    if (!this.policy.retry_on.includes(code)) return false;
    return true;
  }

  nextEscalation(attempt: number): string {
    const idx = Math.min(attempt - 1, this.policy.escalation.length - 1);
    return this.policy.escalation[idx];
  }

  getDelay(attempt: number): number {
    return calculateBackoff(this.policy.backoff, attempt);
  }
}

export const DEFAULT_RETRY_POLICIES: Record<string, RetryPolicy> = {
  'act.click': {
    policy_id: 'act.click.v1',
    max_attempts: 3,
    backoff: { kind: 'exponential_jitter', base_ms: 250, max_ms: 2000 },
    retry_on: ['YJ.ACT.DOM_TARGET_STALE', 'YJ.ACT.DOM_TARGET_NOT_FOUND'],
    never_retry_on: ['YJ.OPSEC.ANOMALY_RISK_ELEVATED', 'YJ.ACT.ACTION_NOT_IDEMPOTENT'],
    escalation: ['RETRY_SAME', 'REOBSERVE_THEN_RETRY', 'ABORT'],
  },
  'act.type': {
    policy_id: 'act.type.v1',
    max_attempts: 2,
    backoff: { kind: 'exponential_jitter', base_ms: 500, max_ms: 3000 },
    retry_on: ['YJ.ACT.DOM_TARGET_STALE'],
    never_retry_on: ['YJ.ACT.ACTION_NOT_IDEMPOTENT', 'YJ.OPSEC.ANOMALY_RISK_ELEVATED'],
    escalation: ['RETRY_SAME', 'ABORT'],
  },
  'act.navigate': {
    policy_id: 'act.navigate.v1',
    max_attempts: 2,
    backoff: { kind: 'fixed', base_ms: 1000, max_ms: 1000 },
    retry_on: ['YJ.NET.REQUEST_TIMEOUT'],
    never_retry_on: ['YJ.OPSEC.ANOMALY_RISK_ELEVATED'],
    escalation: ['RETRY_SAME', 'ABORT'],
  },
  'default': {
    policy_id: 'default.v1',
    max_attempts: 2,
    backoff: { kind: 'exponential_jitter', base_ms: 500, max_ms: 5000 },
    retry_on: ['YJ.NET.REQUEST_TIMEOUT', 'YJ.CAPTURE.WINDOW_EXPIRED'],
    never_retry_on: ['YJ.OPSEC.ANOMALY_RISK_ELEVATED', 'YJ.POLICY.DOMAIN_PERMISSION_REQUIRED'],
    escalation: ['RETRY_SAME', 'ABORT'],
  },
};
