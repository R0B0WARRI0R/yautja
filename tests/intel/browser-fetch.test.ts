import { describe, it, expect } from 'vitest';
import { browserFetch, scrubSecrets, buildFetchScript } from '../../src/intel/browser-fetch.js';

class MockTransport {
  handler: (method: string, params: any) => any = () => ({});
  async send(method: string, params?: any): Promise<any> {
    return this.handler(method, params);
  }
}

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
});
