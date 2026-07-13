import type { BrowserState, StateDiff } from '../memory/browser-state.js';
import type { Anomaly } from '../vision/base-sensor.js';
import type { Observation } from './observation.js';
import { buildObservation } from './observation.js';
import { selectDomains, scoreDomain } from './relevance.js';
export { anomalyAttention } from './strategies/anomaly.js';
export { diffAttention } from './strategies/diff.js';
export { overviewAttention } from './strategies/overview.js';

export interface RouterContext {
  lastActionTime?: number;
  beforeState?: BrowserState;
}

export class AttentionRouter {
  private anomalyThreshold = 0.5;

  observe(
    question: string,
    state: BrowserState,
    anomalies: Anomaly[],
    diff?: StateDiff | null,
    ctx?: RouterContext,
    maxTokens?: number,
  ): Observation {
    const isPostAction = ctx?.lastActionTime != null && (Date.now() - ctx.lastActionTime) < 10000;
    const hasAnomalies = anomalies.length > 0;
    const hasDiff = isPostAction && diff && diff.fields.length > 0;

    return buildObservation({
      question,
      state,
      diff: hasDiff ? diff : null,
      anomalies: hasAnomalies ? anomalies : undefined,
      maxTokens,
    });
  }

  isGenericQuestion(question: string): boolean {
    const domains = selectDomains(question);
    return domains.length === 0 || (domains.length === 5 && scoreDomain(question, 'network') < this.anomalyThreshold);
  }
}
