/**
 * EconomicSensor (P13) — "budget/quota" view of the current domain.
 *
 * Minimal viable: pluggable quota readers per profile id. Perplexity reads
 * the pplx.metadata cookie (passive, OPSEC-safe); Gemini reports unknown
 * (no auto-navigation to /usage — non-goal).
 */

import type { SiteProfileStore } from '../doctrine/site-profile.js';
import type { PreflightContext } from '../doctrine/preflight.js';
import { parsePplxMetadata } from '../doctrine/quota-readers/perplexity.js';
import type { PerplexityQuota } from '../doctrine/quota-readers/perplexity.js';
import { readGeminiQuota } from '../doctrine/quota-readers/gemini.js';

export interface EconomicSummary {
  domainProfile: string;
  quota: PerplexityQuota | { source: 'unknown' };
  estimatedCostOfNextTypeSubmit: '1_query' | 'none' | 'unknown';
}

export class EconomicSensor {
  private profiles: SiteProfileStore;
  private ctx: PreflightContext;

  constructor(profiles: SiteProfileStore, ctx: PreflightContext) {
    this.profiles = profiles;
    this.ctx = ctx;
  }

  async summarize(url: string): Promise<EconomicSummary> {
    const profile = this.profiles.match(url);

    let quota: EconomicSummary['quota'] = { source: 'unknown' };
    if (profile.id === 'perplexity') {
      const cookies = await this.ctx.getCookies().catch(() => []);
      const cookie = cookies.find((c) => c.name === 'pplx.metadata');
      quota = parsePplxMetadata(cookie?.value);
    } else if (profile.id === 'gemini') {
      quota = readGeminiQuota();
    }

    const estimatedCostOfNextTypeSubmit: EconomicSummary['estimatedCostOfNextTypeSubmit'] =
      profile.rules.maxAgentQueriesPerSession !== undefined ? '1_query'
      : profile.id === 'default' ? 'unknown'
      : 'unknown';

    return { domainProfile: profile.id, quota, estimatedCostOfNextTypeSubmit };
  }
}
