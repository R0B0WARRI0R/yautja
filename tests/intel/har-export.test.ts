import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildHar, filterEntries, exportHarToFile } from '../../src/intel/har-export.js';
import type { CapturedRequest } from '../../src/intel/network-capture.js';

function entry(overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    id: 'r1',
    url: 'https://api.example.com/v1/users',
    method: 'GET',
    requestHeaders: { authorization: 'Bearer secret-token-123456789', accept: 'application/json' },
    status: 200,
    responseHeaders: { 'content-type': 'application/json', 'set-cookie': 'sess=abc' },
    responseBody: '{"users":[]}',
    timestamp: 1_700_000_000_000,
    durationMs: 42,
    ...overrides,
  };
}

describe('buildHar', () => {
  it('produces a HAR 1.2-valid minimal structure', () => {
    const har = buildHar([entry()], { redact: true }) as any;
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator.name).toBe('yautja');
    expect(har.log.entries).toHaveLength(1);
    const e = har.log.entries[0];
    expect(e.request.method).toBe('GET');
    expect(e.request.url).toBe('https://api.example.com/v1/users');
    expect(e.response.status).toBe(200);
    expect(e.response.content.text).toBe('{"users":[]}');
    expect(e.startedDateTime).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('redact: drops authorization/cookie/set-cookie headers', () => {
    const har = buildHar([entry()], { redact: true }) as any;
    const e = har.log.entries[0];
    const reqHeaderNames = e.request.headers.map((h: any) => h.name);
    const resHeaderNames = e.response.headers.map((h: any) => h.name);
    expect(reqHeaderNames).not.toContain('authorization');
    expect(reqHeaderNames).toContain('accept');
    expect(resHeaderNames).not.toContain('set-cookie');
  });

  it('redact: masks secrets in bodies', () => {
    const har = buildHar([entry({ responseBody: 'token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c' })], { redact: true }) as any;
    expect(har.log.entries[0].response.content.text).toContain('REDACTED');
  });

  it('redact:false keeps headers and raw body', () => {
    const har = buildHar([entry()], { redact: false }) as any;
    const names = har.log.entries[0].request.headers.map((h: any) => h.name);
    expect(names).toContain('authorization');
  });

  it('large bodies become a sha256 stub (no silent truncation)', () => {
    const har = buildHar([entry({ responseBody: 'x'.repeat(100_000) })], { redact: true }) as any;
    const content = har.log.entries[0].response.content;
    expect(content.text).toBeUndefined();
    expect(content.comment).toContain('sha256:');
    expect(content.size).toBe(100_000);
  });
});

describe('filterEntries', () => {
  const entries = [
    entry({ id: '1', url: 'https://a.com/api/x', method: 'GET', timestamp: Date.now() }),
    entry({ id: '2', url: 'https://a.com/api/y', method: 'POST', timestamp: Date.now() - 10_000 }),
    entry({ id: '3', url: 'https://b.com/api/x', method: 'GET', timestamp: Date.now() - 100_000 }),
  ];

  it('filters by urlIncludes, method and time window', () => {
    expect(filterEntries(entries, { urlIncludes: 'a.com' })).toHaveLength(2);
    expect(filterEntries(entries, { method: 'POST' })).toHaveLength(1);
    expect(filterEntries(entries, { sinceMs: 50_000 })).toHaveLength(2);
  });
});

describe('exportHarToFile', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yautja-har-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('writes a parseable HAR file', () => {
    const out = exportHarToFile([entry()], dir, 'api.example.com', { redact: true });
    expect(out.entries).toBe(1);
    expect(out.bytes).toBeGreaterThan(100);
    const parsed = JSON.parse(fs.readFileSync(out.path, 'utf8'));
    expect(parsed.log.version).toBe('1.2');
    expect(out.path).toContain('api.example.com');
  });
});
