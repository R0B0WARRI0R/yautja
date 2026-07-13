import type { BrowserState } from '../../memory/browser-state.js';
import type { SensorDomain } from '../relevance.js';
import { selectDomains } from '../relevance.js';
import { formatDomain } from '../observation.js';

export function queryAttention(question: string, state: BrowserState, maxTokens: number): { domains: SensorDomain[]; text: string } {
  const domains = selectDomains(question);
  const lines: string[] = [];
  for (const domain of domains) {
    lines.push(formatDomain(domain, state, maxTokens / domains.length));
  }
  return { domains, text: lines.join('\n') };
}
