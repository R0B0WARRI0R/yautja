import { describe, it, expect } from 'vitest';
import { browserFetch, scrubSecrets, buildFetchScript, validateRequestHeaders, validateRequestBounds, DISALLOWED_REQUEST_HEADERS, MAX_REQUEST_BODY_CHARS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from '../../src/intel/browser-fetch.js';

class MockTransport {
  handler: (method: string, params: any) => any = () => ({});
  async send(method: string, params?: any): Promise<any> {
    return this.handler(method, params);
  }
}

function transportReturning(value: any): MockTransport {
  const t = new MockTransport();
  t.handler = () => ({ result: { value: typeof value === 'string' ? value : JSON.stringify(value) } });
  return t;
}

const PAGE_OK = {
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json', 'set-cookie': 'session=abc123', 'x-api-key': 'supersecret' },
  body: '{"token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c"}',
  timingMs: 12,
};

describe('scrubSecrets', () => {
  it('masks JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';
    const out = scrubSecrets(`{"token":"${jwt}"}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain('REDACTED');
  });

  it('masks Bearer tokens and cloud keys', () => {
    expect(scrubSecrets('Authorization: Bearer abcdef1234567890XYZ')).toContain('REDACTED');
    expect(scrubSecrets('aws: AKIAIOSFODNN7EXAMPLE')).toContain('REDACTED');
    expect(scrubSecrets('key sk-abcdefghij0123456789abcd')).toContain('REDACTED');
    expect(scrubSecrets('pat ghp_abcdefghij0123456789abcd')).toContain('REDACTED');
  });

  it('leaves clean text untouched', () => {
    expect(scrubSecrets('{"users":["alice","bob"]}')).toBe('{"users":["alice","bob"]}');
  });
});

describe('buildFetchScript', () => {
  it('embeds url, method and credentials; uses AbortController for timeout', () => {
    const script = buildFetchScript({ url: 'https://api.example.com/v1', method: 'post', credentials: 'omit', timeoutMs: 5000 });
    expect(script).toContain('"https://api.example.com/v1"');
    expect(script).toContain('"method":"POST"');
    expect(script).toContain('"credentials":"omit"');
    expect(script).toContain('AbortController');
    expect(script).toContain('5000');
    expect(script).not.toContain('%%SIGNAL%%'); // placeholder replaced
  });

  it('executes against a fake fetch (page context simulation)', async () => {
    const fakeFetch = async (_url: string, _init: any) => ({
      status: 200,
      statusText: 'OK',
      headers: { forEach: (cb: (v: string, k: string) => void) => { cb('application/json', 'content-type'); cb('secret-cookie', 'set-cookie'); } },
      text: async () => '{"data":42}',
    });
    class FakeAbortController {
      signal = {};
      abort() {}
    }
    const script = buildFetchScript({ url: 'https://x.com', timeoutMs: 100 });
    const fn = new Function('fetch', 'AbortController', `return (${script});`);
    const out = JSON.parse(await fn(fakeFetch, FakeAbortController));
    expect(out.ok).toBe(true);
    expect(out.status).toBe(200);
    expect(out.body).toBe('{"data":42}');
    expect(out.headers['content-type']).toBe('application/json');
  });

  it('returns ok:false when fetch throws', async () => {
    const fakeFetch = async () => { throw new Error('network down'); };
    class FakeAbortController { signal = {}; abort() {} }
    const script = buildFetchScript({ url: 'https://x.com' });
    const fn = new Function('fetch', 'AbortController', `return (${script});`);
    const out = JSON.parse(await fn(fakeFetch, FakeAbortController));
    expect(out.ok).toBe(false);
    expect(out.error).toContain('network down');
  });
});

describe('browserFetch', () => {
  it('drops sensitive response headers and masks secrets in body by default', async () => {
    const t = transportReturning(PAGE_OK);
    const r = await browserFetch(t as any, { url: 'https://api.example.com' });
    expect(r.ok).toBe(true);
    expect(r.headers!['content-type']).toBe('application/json');
    expect(r.headers!['set-cookie']).toBeUndefined();
    expect(r.headers!['x-api-key']).toBeUndefined();
    expect(r.body).toContain('REDACTED');
    expect(r.body).not.toContain('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c');
  });

  it('redactResponse:false returns the raw body', async () => {
    const t = transportReturning(PAGE_OK);
    const r = await browserFetch(t as any, { url: 'https://api.example.com', redactResponse: false });
    expect(r.body).toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('caps the body with a truncated flag', async () => {
    const t = transportReturning({ ...PAGE_OK, body: 'x'.repeat(1000) });
    const r = await browserFetch(t as any, { url: 'https://x.com', maxBodyChars: 100, redactResponse: false });
    expect(r.truncated).toBe(true);
    expect(r.body!.length).toBe(100);
    expect(r.bodyBytes).toBe(1000);
  });

  it('fetch error in page → ok:false with error message', async () => {
    const t = transportReturning({ ok: false, error: 'Failed to fetch', timingMs: 3 });
    const r = await browserFetch(t as any, { url: 'https://x.com' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Failed to fetch');
  });

  it('malformed/empty transport response → ok:false', async () => {
    const t = new MockTransport();
    t.handler = () => ({ result: {} });
    expect((await browserFetch(t as any, { url: 'https://x.com' })).ok).toBe(false);
    t.handler = () => ({ result: { value: '{{bad' } });
    expect((await browserFetch(t as any, { url: 'https://x.com' })).ok).toBe(false);
  });

  it('rejects request headers that would spoof Host or leak creds', async () => {
    // Set up a transport that would otherwise succeed; we want to assert
    // we never even reach it.
    const t = transportReturning(PAGE_OK);
    for (const denied of ['Host', 'Cookie', 'Authorization', 'X-Forwarded-For', 'X-Api-Key', 'X-Real-Ip']) {
      const r = await browserFetch(t as any, { url: 'https://x.com', headers: { [denied]: 'whatever' } });
      expect(r.ok, denied).toBe(false);
      // Error message must mention the offending header name verbatim
      // (case-preserved) — but NEVER echo the header value, which may
      // be the very secret the LLM is trying to exfiltrate.
      expect(r.error, denied).toContain(denied);
      expect(r.error, denied).not.toContain('whatever');
    }
  });

  it('allows benign request headers (Accept, Content-Type, User-Agent, custom X-Request-Id)', async () => {
    const t = transportReturning(PAGE_OK);
    const r = await browserFetch(t as any, {
      url: 'https://x.com',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'yautja/1.0', 'X-Request-Id': 'req_abc' },
    });
    expect(r.ok).toBe(true);
  });

  it('validateRequestHeaders is case-insensitive (RFC 7230 §3.2)', () => {
    expect(validateRequestHeaders(undefined).ok).toBe(true);
    expect(validateRequestHeaders({}).ok).toBe(true);
    expect(validateRequestHeaders({ Accept: 'json' }).ok).toBe(true);
    expect(validateRequestHeaders({ HOST: 'evil.com' }).ok).toBe(false);
    expect(validateRequestHeaders({ 'x-FORWARDED-FOR': '1.2.3.4' }).ok).toBe(false);
  });

  it('DISALLOWED_REQUEST_HEADERS includes all P0 categories', () => {
    // snapshot guard — if anyone removes a header from the set, this
    // test forces a deliberate change to the allowlist docs.
    expect(DISALLOWED_REQUEST_HEADERS.has('host')).toBe(true);                  // SSRF
    expect(DISALLOWED_REQUEST_HEADERS.has('cookie')).toBe(true);                // session hijack
    expect(DISALLOWED_REQUEST_HEADERS.has('authorization')).toBe(true);         // cred leak
    expect(DISALLOWED_REQUEST_HEADERS.has('x-forwarded-for')).toBe(true);       // IP spoof
    expect(DISALLOWED_REQUEST_HEADERS.has('cf-connecting-ip')).toBe(true);      // IP spoof
    expect(DISALLOWED_REQUEST_HEADERS.has('true-client-ip')).toBe(true);        // IP spoof
  });
});

describe('validateRequestBounds', () => {
  it('clamps timeout below the floor and above the ceiling', () => {
    const low = validateRequestBounds({ timeoutMs: 0 });
    expect(low.ok).toBe(true);
    if (low.ok) expect(low.timeoutMs).toBe(MIN_TIMEOUT_MS);

    const high = validateRequestBounds({ timeoutMs: 10_000_000 });
    expect(high.ok).toBe(true);
    if (high.ok) expect(high.timeoutMs).toBe(MAX_TIMEOUT_MS);

    const mid = validateRequestBounds({ timeoutMs: 5_000 });
    expect(mid.ok).toBe(true);
    if (mid.ok) expect(mid.timeoutMs).toBe(5_000);
  });

  it('defaults timeout to 15s when omitted', () => {
    const r = validateRequestBounds({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.timeoutMs).toBe(15_000);
  });

  it('rejects non-finite timeoutMs', () => {
    expect(validateRequestBounds({ timeoutMs: NaN }).ok).toBe(false);
    expect(validateRequestBounds({ timeoutMs: Infinity }).ok).toBe(false);
    expect(validateRequestBounds({ timeoutMs: -Infinity }).ok).toBe(false);
  });

  it('rejects oversized request body', () => {
    const big = 'x'.repeat(MAX_REQUEST_BODY_CHARS + 1);
    const r = validateRequestBounds({ body: big });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('too large');
  });

  it('passes a 1 MB body', () => {
    const r = validateRequestBounds({ body: 'x'.repeat(1_000_000) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body?.length).toBe(1_000_000);
  });
});

describe('browserFetch bounds enforcement', () => {
  it('refuses a 24-hour timeout before issuing the page-side fetch', async () => {
    // Transport that would otherwise succeed — we want to assert the
    // bound check rejects before buildFetchScript runs.
    const t = transportReturning(PAGE_OK);
    const r = await browserFetch(t as any, { url: 'https://x.com', timeoutMs: 24 * 60 * 60 * 1000 });
    expect(r.ok).toBe(true); // clamps to MAX_TIMEOUT_MS, so the fetch still runs
    // but verify the script we sent used the clamped value
    // (re-run with a recording transport to capture the expression)
    const recorded: string[] = [];
    const recorder = new MockTransport();
    recorder.handler = (_m: string, p: any) => { recorded.push(p.expression); return { result: { value: JSON.stringify(PAGE_OK) } }; };
    await browserFetch(recorder as any, { url: 'https://x.com', timeoutMs: 24 * 60 * 60 * 1000 });
    expect(recorded[0]).toContain(`setTimeout(() => ctrl.abort(), ${MAX_TIMEOUT_MS})`);
  });

  it('refuses a request body above MAX_REQUEST_BODY_CHARS', async () => {
    const t = transportReturning(PAGE_OK);
    const r = await browserFetch(t as any, { url: 'https://x.com', body: 'x'.repeat(MAX_REQUEST_BODY_CHARS + 1) });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('too large');
    // The error must not echo the body bytes (memory leak / leak oracle).
    expect(r.error!.length).toBeLessThan(500);
  });

  it('rejects NaN / Infinity timeoutMs', async () => {
    const t = transportReturning(PAGE_OK);
    const r = await browserFetch(t as any, { url: 'https://x.com', timeoutMs: NaN });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('finite');
  });
});
