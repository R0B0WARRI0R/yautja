/**
 * Preflight (P13) — run a profile's preFlight checks before an expensive
 * action (type/submit, navigate, intercept). Aborts BEFORE burning quota.
 *
 * Check types:
 *   cookieJson — read a cookie, decode it, JSON.parse it, store under
 *                results[id] for later checks.
 *   abortIf    — compare a numeric value at a dotted path
 *                ("preFlight.results.<checkId>.<field>") with op/value;
 *                when the comparison holds, the preflight FAILS with the
 *                check's code (e.g. QUOTA_EXHAUSTED).
 */

import type { SiteProfile } from './site-profile.js';

export interface CookieLike {
  name: string;
  value: string;
}

export interface PreflightContext {
  getCookies: () => Promise<CookieLike[]>;
}

export interface PreflightResult {
  pass: boolean;
  reasons: string[];
  /** Short code from the failing check (e.g. "QUOTA_EXHAUSTED"). */
  abortCode?: string;
  results: Record<string, unknown>;
}

/** Map a short profile code to a full registry code. */
export function mapPreflightCode(short: string): string {
  if (short.startsWith('YJ.')) return short;
  const aliases: Record<string, string> = {
    QUOTA_EXHAUSTED: 'YJ.POLICY.QUOTA_EXHAUSTED',
    CAPTCHA_DETECTED: 'YJ.OPSEC.CAPTCHA_DETECTED',
    GATE_DENIED: 'YJ.POLICY.GATE_DENIED',
  };
  return aliases[short] ?? 'YJ.POLICY.GATE_DENIED';
}

function decodeCookieValue(value: string, decode: 'uriComponent' | 'base64' | 'none'): unknown {
  try {
    let v = value;
    if (decode === 'uriComponent') v = decodeURIComponent(v);
    if (decode === 'base64') v = Buffer.from(v, 'base64').toString('utf8');
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function resolvePath(root: unknown, dottedPath: string): unknown {
  // Paths look like "preFlight.results.<checkId>.<field>[.<subfield>...]"
  const parts = dottedPath.split('.');
  let cur: any = { preFlight: { results: root } };
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function compare(a: number, op: string, b: number): boolean {
  switch (op) {
    case '>': return a > b;
    case '>=': return a >= b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '==': return a === b;
    case '!=': return a !== b;
    default: return false;
  }
}

export async function runPreflight(profile: SiteProfile, ctx: PreflightContext): Promise<PreflightResult> {
  const results: Record<string, unknown> = {};
  const reasons: string[] = [];

  for (const check of profile.preFlight) {
    if (check.type === 'cookieJson') {
      const cookies = await ctx.getCookies().catch(() => [] as CookieLike[]);
      const cookie = cookies.find((c) => c.name === check.name);
      if (!cookie) {
        results[check.id] = null;
        reasons.push(`cookie ${check.name} not found`);
        continue;
      }
      const decoded = decodeCookieValue(cookie.value, check.decode);
      results[check.id] = decoded;
      reasons.push(decoded === null ? `cookie ${check.name} undecodable` : `cookie ${check.name} read`);
    } else if (check.type === 'abortIf') {
      const value = resolvePath(results, check.path);
      if (typeof value === 'number' && compare(value, check.op, check.value)) {
        reasons.push(`${check.id}: ${check.path} = ${value} ${check.op} ${check.value} → abort`);
        return { pass: false, reasons, abortCode: check.code, results };
      }
      reasons.push(`${check.id}: ok (${String(value)})`);
    }
  }

  return { pass: true, reasons, results };
}
