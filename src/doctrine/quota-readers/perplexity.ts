/**
 * Perplexity quota reader (P13 economic sensor).
 *
 * Reads the `pplx.metadata` cookie (URI-component-encoded JSON). The `qcd`
 * field tracks the query count burn the operator cares about (see
 * investigacion/perplexity-opsec-y-baneos.md). Never calls the live
 * /rest endpoint — cookie-only, per OPSEC guidance.
 */

export interface PerplexityQuota {
  source: 'cookie:pplx.metadata' | 'unknown';
  qcd?: number;
  remainingHint?: string;
}

export function parsePplxMetadata(cookieValue: string | null | undefined): PerplexityQuota {
  if (!cookieValue) return { source: 'unknown' };
  try {
    const decoded = JSON.parse(decodeURIComponent(cookieValue));
    const quota: PerplexityQuota = { source: 'cookie:pplx.metadata' };
    if (typeof decoded?.qcd === 'number') {
      quota.qcd = decoded.qcd;
      quota.remainingHint = decoded.qcd > 15 ? 'exhausted' : decoded.qcd > 10 ? 'low' : 'ok';
    }
    return quota;
  } catch {
    return { source: 'unknown' };
  }
}
