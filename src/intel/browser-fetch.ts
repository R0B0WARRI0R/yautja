/**
 * browserFetch (P14) — fetch executed in the page context with the tab's
 * own cookie jar (same-origin session, real CORS behavior), plus redaction
 * and body caps.
 *
 * The gating decision happens in helmet (SessionGates); this module only
 * executes and sanitizes:
 *   - request headers are screened against DISALLOWED_REQUEST_HEADERS
 *     (host/cookie/auth overrides and IP-spoofing headers) so a tool
 *     call cannot break virtual-host routing, leak session cookies, or
 *     forge source IP for rate-limit bypass
 *   - request body and timeout are clamped (MAX_REQUEST_BODY_CHARS,
 *     MAX_TIMEOUT_MS) so the LLM cannot pin the tab at 0 ms / hold
 *     the chrome fetch open for hours / send a 100 MB payload that
 *     would OOM the server
 *   - sensitive response headers are dropped (set-cookie, authorization…)
 *   - secret patterns in the body are masked by default (redactResponse)
 *     so an `Authorization` echo never reaches the LLM unredacted
 *   - response body capped at maxBodyChars with a truncated flag
 *     (no silent cuts)
 */

/** Max request body in characters. Above this, reject before issuing fetch. */
export const MAX_REQUEST_BODY_CHARS = 5_000_000; // 5 MB — well above any realistic API payload
/** Timeout floor (anything shorter races the script evaluation itself). */
export const MIN_TIMEOUT_MS = 100;
/** Timeout ceiling (60s; default is 15s). Prevents tab-pin via 24h timeouts. */
export const MAX_TIMEOUT_MS = 60_000;

/**
 * Headers the LLM is forbidden from setting on a tool-issued fetch.
 * Each one is a known SSRF / credential-leak / audit-trail-forgery
 * vector that the gate system does NOT otherwise police. Names are
 * compared case-insensitively per RFC 7230 §3.2.
 */
export const DISALLOWED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'host',                  // virtual-host routing override → classic SSRF
  'cookie',                // arbitrary session injection
  'authorization',         // creds forwarded to a different host
  'proxy-authorization',   // proxy creds
  'x-api-key',             // API key
  'x-forwarded-for',       // source-IP spoofing (audit/rate-limit)
  'x-real-ip',             // source-IP spoofing (nginx)
  'x-client-ip',           // source-IP spoofing
  'x-originating-ip',      // source-IP spoofing
  'forwarded',             // RFC 7239 source-IP spoofing
  'cf-connecting-ip',      // Cloudflare-specific IP spoofing
  'true-client-ip',        // Akamai / Cloudflare Enterprise IP spoofing
]);

export interface Transport {
  send(method: string, params?: Record<string, any>): Promise<any>;
}

export interface BrowserFetchOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  credentials?: 'include' | 'omit';
  timeoutMs?: number;
  redactResponse?: boolean;
  maxBodyChars?: number;
}

export interface BrowserFetchResult {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyBytes?: number;
  timingMs: number;
  truncated: boolean;
  error?: string;
}

const SENSITIVE_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'set-cookie2',
  'authorization',
  'proxy-authorization',
  'x-api-key',
]);

const SECRET_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT
  /Bearer\s+[A-Za-z0-9._~+/=-]{10,}/gi,
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI-style keys
  /ghp_[A-Za-z0-9]{20,}/g, // GitHub PAT
];

/** Mask secret patterns in a response body before it reaches the LLM. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m) => `${m.slice(0, 6)}…REDACTED…`);
  }
  return out;
}

/**
 * Return { ok:true } when every request header is allowed; otherwise
 * { ok:false, error } naming the first offending header. The error
 * message echoes the header NAME only (not the value, which could
 * carry the secret the LLM is trying to exfiltrate).
 */
export function validateRequestHeaders(
  headers: Record<string, string> | undefined,
): { ok: true } | { ok: false; error: string } {
  if (!headers) return { ok: true };
  for (const k of Object.keys(headers)) {
    if (DISALLOWED_REQUEST_HEADERS.has(k.toLowerCase())) {
      return {
        ok: false,
        error: `Header "${k}" is reserved — tools cannot set Host/Cookie/Authorization/X-Forwarded-*/X-Real-IP/X-Api-Key (would break audit, leak creds, or spoof origin).`,
      };
    }
  }
  return { ok: true };
}

/**
 * Clamp timeout and request-body size. Returns the CLAMPED values
 * (so the caller never has to reason about defaults) plus an error
 * for inputs that exceed hard limits.
 */
export function validateRequestBounds(opts: {
  body?: string;
  timeoutMs?: number;
}): {
  ok: true;
  timeoutMs: number;
  body: string | undefined;
} | { ok: false; error: string } {
  if (opts.body !== undefined && opts.body.length > MAX_REQUEST_BODY_CHARS) {
    return {
      ok: false,
      error: `Request body too large: ${opts.body.length} chars (max ${MAX_REQUEST_BODY_CHARS}). Refusing to issue page-side fetch.`,
    };
  }
  let timeoutMs = opts.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs)) {
    return { ok: false, error: `timeoutMs must be a finite number (got ${String(opts.timeoutMs)})` };
  }
  if (timeoutMs < MIN_TIMEOUT_MS) timeoutMs = MIN_TIMEOUT_MS;
  if (timeoutMs > MAX_TIMEOUT_MS) timeoutMs = MAX_TIMEOUT_MS;
  return { ok: true, timeoutMs, body: opts.body };
}

export function buildFetchScript(opts: BrowserFetchOptions): string {
  const init: Record<string, unknown> = {
    method: (opts.method ?? 'GET').toUpperCase(),
    credentials: opts.credentials ?? 'include',
    signal: '%%SIGNAL%%',
  };
  if (opts.headers) init.headers = opts.headers;
  if (opts.body !== undefined) init.body = opts.body;
  const initJson = JSON.stringify(init).replace('"%%SIGNAL%%"', 'ctrl.signal');
  return `(async () => {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ${opts.timeoutMs ?? 15000});
  try {
    const res = await fetch(${JSON.stringify(opts.url)}, ${initJson});
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    const body = await res.text();
    clearTimeout(timer);
    return JSON.stringify({ ok: true, status: res.status, statusText: res.statusText, headers, body, timingMs: Date.now() - started });
  } catch (e) {
    clearTimeout(timer);
    return JSON.stringify({ ok: false, error: String((e && e.message) || e), timingMs: Date.now() - started });
  }
})()`;
}

export async function browserFetch(transport: Transport, opts: BrowserFetchOptions): Promise<BrowserFetchResult> {
  // Reject request-header overrides before issuing the page-side fetch.
  // The gate system covers the URL/host allowlist but not these headers.
  const headCheck = validateRequestHeaders(opts.headers);
  if (!headCheck.ok) {
    return { ok: false, timingMs: 0, truncated: false, error: headCheck.error };
  }
  // Clamp body size and timeout so the LLM can't pin the tab at 0 ms
  // or hold the chrome fetch open for hours.
  const bounds = validateRequestBounds({ body: opts.body, timeoutMs: opts.timeoutMs });
  if (!bounds.ok) {
    return { ok: false, timingMs: 0, truncated: false, error: bounds.error };
  }
  const r = await transport.send('Runtime.evaluate', {
    expression: buildFetchScript({ ...opts, body: bounds.body, timeoutMs: bounds.timeoutMs }),
    awaitPromise: true,
    returnByValue: true,
  });
  const raw = r?.result?.value;
  if (typeof raw !== 'string' || raw === '') {
    return { ok: false, timingMs: 0, truncated: false, error: 'No result from page fetch (detached?)' };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, timingMs: 0, truncated: false, error: 'Malformed fetch result from page' };
  }
  if (!parsed.ok) {
    return { ok: false, timingMs: parsed.timingMs ?? 0, truncated: false, error: parsed.error ?? 'fetch failed' };
  }

  // Sanitize headers
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries<string>(parsed.headers ?? {})) {
    if (SENSITIVE_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
    headers[k] = v;
  }

  let body: string = typeof parsed.body === 'string' ? parsed.body : '';
  const bodyBytes = body.length;
  if (opts.redactResponse !== false) {
    body = scrubSecrets(body);
  }
  const maxBodyChars = opts.maxBodyChars ?? 200_000;
  const truncated = body.length > maxBodyChars;
  if (truncated) body = body.slice(0, maxBodyChars);

  return {
    ok: true,
    status: parsed.status,
    statusText: parsed.statusText,
    headers,
    body,
    bodyBytes,
    timingMs: parsed.timingMs ?? 0,
    truncated,
  };
}
