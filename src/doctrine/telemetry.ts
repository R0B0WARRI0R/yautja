export interface RecoveryOutcome {
  trace_id: string;
  operation_id: string;
  original_error_code: string;
  recovery_strategy: string;
  attempts: number;
  outcome: 'recovered' | 'recovered_with_degradation' | 'failed' | 'deviated';
  time_to_recover_ms: number;
  context_cost_delta_tokens: number;
  deviated_from_recommendation: boolean;
}

export interface OutcomeStats {
  total: number;
  recovered: number;
  failed: number;
  deviated: number;
  successRate: number;
  avgTimeToRecoverMs: number;
  avgContextCostTokens: number;
}

export interface QueryFilter {
  code?: string;
  strategy?: string;
  tool?: string;
  since?: number;
}

export class TelemetryCollector {
  private outcomes: RecoveryOutcome[] = [];

  record(outcome: RecoveryOutcome): void {
    this.outcomes.push(outcome);
  }

  count(): number {
    return this.outcomes.length;
  }

  query(filter: QueryFilter): RecoveryOutcome[] {
    return this.outcomes.filter(o => {
      if (filter.code && o.original_error_code !== filter.code) return false;
      if (filter.strategy && o.recovery_strategy !== filter.strategy) return false;
      if (filter.since && o.trace_id < `tr_${filter.since}`) return false;
      return true;
    });
  }

  stats(filter: QueryFilter): OutcomeStats {
    const filtered = this.query(filter);
    if (filtered.length === 0) {
      return {
        total: 0, recovered: 0, failed: 0, deviated: 0,
        successRate: 0, avgTimeToRecoverMs: 0, avgContextCostTokens: 0,
      };
    }
    const recovered = filtered.filter(o => o.outcome === 'recovered' || o.outcome === 'recovered_with_degradation').length;
    const failed = filtered.filter(o => o.outcome === 'failed').length;
    const deviated = filtered.filter(o => o.outcome === 'deviated').length;
    const avgTime = filtered.reduce((s, o) => s + o.time_to_recover_ms, 0) / filtered.length;
    const avgCost = filtered.reduce((s, o) => s + o.context_cost_delta_tokens, 0) / filtered.length;
    return {
      total: filtered.length,
      recovered,
      failed,
      deviated,
      successRate: recovered / filtered.length,
      avgTimeToRecoverMs: Math.round(avgTime),
      avgContextCostTokens: Math.round(avgCost),
    };
  }

  clear(): void {
    this.outcomes = [];
  }
}