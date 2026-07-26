/**
 * browserFetch (P14) — fetch executed in the page context with the tab's
 * own cookie jar (same-origin session, real CORS behavior), plus redaction
 * and body caps.
 *
 * The gating decision happens in helmet (SessionGates); this module only
 * executes and sanitizes:
 *   - sensitive response headers are dropped (set-cookie, authorization…)
 *   - secret patterns in the body are masked by default (redactResponse)
 *     so an `Authorization` echo never reaches the LLM unredacted
 *   - body capped at maxBodyChars with a truncated flag (no silent cuts)
 */

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
  const r = await transport.send('Runtime.evaluate', {
    expression: buildFetchScript(opts),
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
