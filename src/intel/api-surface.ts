/**
 * apiSurface (P15) — machine-readable endpoint surface for api-recon.
 *
 * Sources:
 *   network — captured requests (NetworkCapture), grouped by method +
 *             normalized path (/users/123 → /users/{id}).
 *   bundles — JS bundles already loaded in the page: same-session GET of
 *             document.scripts[src] + regex for /api/ paths with an asset
 *             denylist. Passive-ish (static assets only).
 *
 * Confidence: network 0.9, bundle 0.5; +0.1 per extra source (cap 0.99).
 */

import type { CapturedRequest } from './network-capture.js';

export interface ApiEndpoint {
  method: string;
  path: string;
  origin: string;
  authHint: 'none' | 'cookie' | 'bearer' | 'unknown';
  from: Array<'network' | 'bundle' | 'openapi' | 'graphql'>;
  confidence: number;
  sampleStatus?: number;
}

const ASSET_DENYLIST = /\.(js|css|png|jpe?g|gif|svg|woff2?|ico|map|json|webp|avif|mp4|webm)(\?|$)/i;
const API_PATH_REGEX = /["'`](\/api\/[A-Za-z0-9_.\-/{}:]+)["'`]/g;

/** Normalize dynamic path segments: /users/123/posts/a9f8-… → /users/{id}/posts/{id} */
export function normalizePath(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return '{id}';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '{id}';
      if (/^[0-9a-f]{16,}$/i.test(seg)) return '{id}';
      return seg;
    })
    .join('/');
}

function authHintOf(headers: Record<string, string>): ApiEndpoint['authHint'] {
  const names = Object.keys(headers).map((h) => h.toLowerCase());
  if (names.includes('authorization')) return 'bearer';
  if (names.includes('cookie')) return 'cookie';
  return 'none';
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Endpoints observed in captured network traffic. */
export function surfaceFromNetwork(entries: CapturedRequest[]): ApiEndpoint[] {
  const map = new Map<string, ApiEndpoint>();
  for (const e of entries) {
    let pathname = '';
    try { pathname = new URL(e.url).pathname; } catch { continue; }
    if (ASSET_DENYLIST.test(pathname)) continue;
    const path = normalizePath(pathname);
    const key = `${e.method.toUpperCase()} ${originOf(e.url)}${path}`;
    const existing = map.get(key);
    if (existing) {
      existing.sampleStatus = e.status ?? existing.sampleStatus;
      if (existing.authHint === 'none') existing.authHint = authHintOf(e.requestHeaders);
    } else {
      map.set(key, {
        method: e.method.toUpperCase(),
        path,
        origin: originOf(e.url),
        authHint: authHintOf(e.requestHeaders),
        from: ['network'],
        confidence: 0.9,
        sampleStatus: e.status,
      });
    }
  }
  return Array.from(map.values());
}

/** Extract /api/ paths referenced in a JS bundle text. */
export function extractPathsFromBundle(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(API_PATH_REGEX)) {
    const p = m[1]!;
    if (ASSET_DENYLIST.test(p)) continue;
    out.add(normalizePath(p));
  }
  return Array.from(out);
}

/** Page-side script: fetch loaded bundles (same session) and regex /api/ paths. */
export function buildBundleScanScript(maxBundles = 10, maxChars = 2_000_000): string {
  return `(async () => {
  const srcs = Array.from(document.scripts).map(s => s.src).filter(Boolean).slice(0, ${maxBundles});
  const found = {};
  for (const src of srcs) {
    try {
      const res = await fetch(src, { credentials: 'include' });
      const text = (await res.text()).slice(0, ${maxChars});
      const re = /["'\`](\\/api\\/[A-Za-z0-9_.\\-\\/{}:]+)["'\`]/g;
      let m;
      while ((m = re.exec(text)) !== null) { found[m[1]] = true; }
    } catch (e) {}
  }
  return JSON.stringify({ paths: Object.keys(found), bundlesScanned: srcs.length });
})()`;
}

/** Merge endpoint lists, combining sources and boosting confidence. */
export function mergeEndpoints(lists: ApiEndpoint[][]): ApiEndpoint[] {
  const map = new Map<string, ApiEndpoint>();

  const findFuzzy = (ep: ApiEndpoint): ApiEndpoint | undefined => {
    // Bundle endpoints carry method '*' — match on origin+path only.
    for (const existing of map.values()) {
      if (existing.origin !== ep.origin || existing.path !== ep.path) continue;
      if (ep.method === '*' || existing.method === '*' || existing.method === ep.method) {
        return existing;
      }
    }
    return undefined;
  };

  for (const list of lists) {
    for (const ep of list) {
      const existing = findFuzzy(ep);
      if (existing) {
        for (const f of ep.from) {
          if (!existing.from.includes(f)) {
            existing.from.push(f);
            existing.confidence = Math.min(0.99, existing.confidence + 0.1);
          }
        }
        existing.sampleStatus = existing.sampleStatus ?? ep.sampleStatus;
        // A concrete method upgrades a wildcard entry
        if (existing.method === '*' && ep.method !== '*') existing.method = ep.method;
      } else {
        map.set(`${ep.method} ${ep.origin}${ep.path}`, { ...ep, from: [...ep.from] });
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => b.confidence - a.confidence);
}
