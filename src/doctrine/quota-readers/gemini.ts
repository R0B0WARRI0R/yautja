/**
 * Gemini quota reader (P13 economic sensor) — stub.
 *
 * Gemini exposes usage only on the /usage page, and auto-navigating there
 * is a P13 non-goal (it would burn OPSEC budget). Until a passive signal
 * exists, quota for gemini.google.com is reported as unknown.
 */

export interface GeminiQuota {
  source: 'unknown';
  remainingHint?: string;
}

export function readGeminiQuota(): GeminiQuota {
  return { source: 'unknown' };
}
