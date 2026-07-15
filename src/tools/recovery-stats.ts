import type { TelemetryCollector, QueryFilter, OutcomeStats } from '../doctrine/telemetry.js';

export interface RecoveryStatsInput {
  code?: string;
  strategy?: string;
  since?: number;
}

export interface RecoveryStatsOutput {
  stats: OutcomeStats;
  recent_outcomes: number;
}

export function createRecoveryStatsTool(telemetry: TelemetryCollector) {
  return function recoveryStats(input: RecoveryStatsInput): RecoveryStatsOutput {
    const filter: QueryFilter = {
      code: input.code,
      strategy: input.strategy,
      since: input.since,
    };
    return {
      stats: telemetry.stats(filter),
      recent_outcomes: telemetry.query(filter).slice(-10).length,
    };
  };
}