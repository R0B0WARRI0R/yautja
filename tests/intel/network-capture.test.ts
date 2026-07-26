import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CapturedRequest, Transport } from '../../src/intel/network-capture.js';

// network-capture computes CAPTURE_DIR from process.env.APPDATA at module load
// time, so each test re-imports the module (vi.resetModules) with APPDATA
// pointing at a fresh temp dir.

class MockTransport implements Transport {
  calls: { method: string; params?: Record<string, any> }[] = [];
  responder: (method: string, params?: Record<string, any>) => any = () => ({});

  async send(method: string, params?: Record<string, any>): Promise<any> {
    this.calls.push({ method, params });
    return this.responder(method, params);
  }
}

type NetworkCaptureType = InstanceType<
  (typeof import('../../src/intel/network-capture.js'))['NetworkCapture']
>;

const TS = Date.UTC(2026, 0, 15, 12, 0, 0); // 2026-01-15

function makeReq(id: string, overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    id,
    url: 'https://example.com/api',
    method: 'POST',
    requestHeaders: { 'content-type': 'application/json' },
    timestamp: TS,
    ...overrides,
  };
}

describe('NetworkCapture', () => {
  let tmpDir: string;
  let captureDir: string;
  let originalAppData: string | undefined;
  let transport: MockTransport;
  let capture: NetworkCaptureType;

  beforeEach(async () => {
    originalAppData = process.env.APPDATA;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yautja-nc-'));
    process.env.APPDATA = tmpDir;
    vi.resetModules();
    const mod = await import('../../src/intel/network-capture.js');
    transport = new MockTransport();
    capture = new mod.NetworkCapture(transport);
    captureDir = path.join(tmpDir, '.yautja-network-captures');
  });

  afterEach(() => {
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('constructor / active state', () => {
    it('creates the capture directory on construction', () => {
      expect(fs.existsSync(captureDir)).toBe(true);
    });

    it('starts inactive; setActive toggles', () => {
      expect(capture.isActive()).toBe(false);
      capture.setActive(true);
      expect(capture.isActive()).toBe(true);
      capture.setActive(false);
      expect(capture.isActive()).toBe(false);
    });
  });

  describe('captureRequestBody', () => {
    it('returns postData from Network.getRequestPostData', async () => {
      transport.responder = () => ({ postData: '{"a":1}' });
      const body = await capture.captureRequestBody('r1');
      expect(body).toBe('{"a":1}');
      expect(transport.calls[0]!.method).toBe('Network.getRequestPostData');
      expect(transport.calls[0]!.params).toEqual({ requestId: 'r1' });
    });

    it('returns null when transport throws', async () => {
      transport.responder = () => {
        throw new Error('no such request');
      };
      expect(await capture.captureRequestBody('r1')).toBeNull();
    });

    it('returns null when postData is missing or empty', async () => {
      transport.responder = () => ({});
      expect(await capture.captureRequestBody('r1')).toBeNull();
      transport.responder = () => ({ postData: '' });
      expect(await capture.captureRequestBody('r1')).toBeNull();
    });

    it('truncates bodies larger than 1MB', async () => {
      transport.responder = () => ({ postData: 'x'.repeat(1024 * 1024 + 100) });
      const body = await capture.captureRequestBody('r1');
      expect(body).toHaveLength(1024 * 1024);
    });
  });

  describe('captureResponseBody', () => {
    it('returns body and isBase64 flag', async () => {
      transport.responder = () => ({ body: 'aGVsbG8=', base64Encoded: true });
      const r = await capture.captureResponseBody('r1');
      expect(r).toEqual({ body: 'aGVsbG8=', isBase64: true });
      expect(transport.calls[0]!.method).toBe('Network.getResponseBody');
    });

    it('defaults isBase64 to false when base64Encoded absent', async () => {
      transport.responder = () => ({ body: 'plain text' });
      const r = await capture.captureResponseBody('r1');
      expect(r).toEqual({ body: 'plain text', isBase64: false });
    });

    it('returns null when body missing and when transport throws', async () => {
      transport.responder = () => ({});
      expect(await capture.captureResponseBody('r1')).toBeNull();
      transport.responder = () => {
        throw new Error('gone');
      };
      expect(await capture.captureResponseBody('r1')).toBeNull();
    });
  });

  describe('storeRequest / persistence', () => {
    it('stores the request in memory but writes no file when inactive', () => {
      capture.storeRequest(makeReq('r1'));
      expect(capture.getAllRequests()).toHaveLength(1);
      expect(fs.readdirSync(captureDir)).toHaveLength(0);
    });

    it('appends a JSONL line when active', () => {
      capture.setActive(true);
      capture.storeRequest(makeReq('r1'));
      const file = path.join(captureDir, 'capture-2026-01-15.jsonl');
      expect(fs.existsSync(file)).toBe(true);
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!);
      expect(parsed.id).toBe('r1');
      expect(parsed.url).toBe('https://example.com/api');
      expect(parsed.timestamp).toBe(TS);
    });

    it('redacts sensitive headers (case-insensitive) in the persisted file', () => {
      capture.setActive(true);
      capture.storeRequest(
        makeReq('r1', {
          requestHeaders: {
            Authorization: 'Bearer secret',
            COOKIE: 'session=abc',
            'X-Api-Key': 'key123',
            'Client-Integrity': 'sig',
            'content-type': 'application/json',
          },
          status: 200,
          responseHeaders: { 'Set-Cookie': 'sid=1', server: 'nginx' },
        }),
      );
      const file = path.join(captureDir, 'capture-2026-01-15.jsonl');
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8').trim());
      expect(parsed.requestHeaders.Authorization).toBe('[REDACTED]');
      expect(parsed.requestHeaders.COOKIE).toBe('[REDACTED]');
      expect(parsed.requestHeaders['X-Api-Key']).toBe('[REDACTED]');
      expect(parsed.requestHeaders['Client-Integrity']).toBe('[REDACTED]');
      expect(parsed.requestHeaders['content-type']).toBe('application/json');
      expect(parsed.responseHeaders['Set-Cookie']).toBe('[REDACTED]');
      expect(parsed.responseHeaders.server).toBe('nginx');
      // raw file must not contain the secrets anywhere
      const raw = fs.readFileSync(file, 'utf8');
      expect(raw).not.toContain('Bearer secret');
      expect(raw).not.toContain('session=abc');
    });

    it('in-memory copy keeps the original (unredacted) headers', () => {
      capture.setActive(true);
      capture.storeRequest(makeReq('r1', { requestHeaders: { authorization: 'Bearer secret' } }));
      const stored = capture.getAllRequests()[0]!;
      expect(stored.requestHeaders.authorization).toBe('Bearer secret');
    });

    it('storing the same id twice overwrites the memory entry', () => {
      capture.storeRequest(makeReq('r1', { url: 'https://a/1' }));
      capture.storeRequest(makeReq('r1', { url: 'https://a/2' }));
      expect(capture.getAllRequests()).toHaveLength(1);
      expect(capture.getAllRequests()[0]!.url).toBe('https://a/2');
    });
  });

  describe('updateRequestStatus', () => {
    it('sets status, responseHeaders and durationMs on a known request', () => {
      capture.storeRequest(makeReq('r1', { timestamp: Date.now() - 50 }));
      capture.updateRequestStatus('r1', 404, { server: 'nginx' });
      const r = capture.getAllRequests()[0]!;
      expect(r.status).toBe(404);
      expect(r.responseHeaders).toEqual({ server: 'nginx' });
      expect(r.durationMs).toBeGreaterThanOrEqual(50);
    });

    it('is a no-op for unknown request ids', () => {
      capture.updateRequestStatus('nope', 200, {});
      expect(capture.getAllRequests()).toHaveLength(0);
    });
  });

  describe('attachBodyToRequest', () => {
    it('attaches request body, sets size and detects matches', () => {
      capture.storeRequest(makeReq('r1'));
      capture.attachBodyToRequest('r1', 'request', 'token=AKIAIOSFODNN7EXAMPLE');
      const r = capture.getAllRequests()[0]!;
      expect(r.requestBody).toBe('token=AKIAIOSFODNN7EXAMPLE');
      expect(r.size).toBe('token=AKIAIOSFODNN7EXAMPLE'.length);
      expect(r.matches).toContain('AWS Key');
    });

    it('attaches response body when type=response', () => {
      capture.storeRequest(makeReq('r1'));
      capture.attachBodyToRequest('r1', 'response', '{"ok":true}');
      const r = capture.getAllRequests()[0]!;
      expect(r.responseBody).toBe('{"ok":true}');
      expect(r.requestBody).toBeUndefined();
    });

    it('is a no-op for unknown request ids', () => {
      capture.attachBodyToRequest('nope', 'request', 'body');
      expect(capture.getAllRequests()).toHaveLength(0);
    });
  });

  describe('detectPatterns', () => {
    it('returns [] for empty input', () => {
      expect(capture.detectPatterns('')).toEqual([]);
    });

    it('detects a JWT', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';
      expect(capture.detectPatterns(jwt)).toContain('JWT');
    });

    it('detects AWS access keys', () => {
      expect(capture.detectPatterns('key: AKIAIOSFODNN7EXAMPLE')).toContain('AWS Key');
    });

    it('detects GitHub tokens', () => {
      const token = 'ghp_' + 'a'.repeat(36);
      expect(capture.detectPatterns(token)).toContain('GitHub Token');
    });

    it('detects Stripe keys', () => {
      const key = 'sk_live_' + 'x'.repeat(24);
      expect(capture.detectPatterns(key)).toContain('Stripe Key');
    });

    it('detects Bearer tokens', () => {
      expect(capture.detectPatterns('Authorization: Bearer ' + 't'.repeat(30))).toContain(
        'Bearer Token',
      );
    });

    it('detects emails', () => {
      expect(capture.detectPatterns('contact user@example.com now')).toContain('Email');
    });

    it('detects Spanish DNI', () => {
      expect(capture.detectPatterns('DNI: 12345678Z')).toContain('Spanish DNI');
    });

    it('detects OAuth codes in URLs', () => {
      expect(capture.detectPatterns('https://app/cb?code=' + 'c'.repeat(25))).toContain(
        'OAuth Code',
      );
    });

    it('detects multiple distinct patterns in one text and dedupes', () => {
      const text = 'email a@b.com and another c@d.es, plus AKIAIOSFODNN7EXAMPLE';
      const matches = capture.detectPatterns(text);
      expect(matches).toContain('Email');
      expect(matches).toContain('AWS Key');
      // each pattern name appears at most once
      expect(new Set(matches).size).toBe(matches.length);
    });

    it('returns [] for text without secrets', () => {
      expect(capture.detectPatterns('{"ok":true,"items":[1,2,3]}')).toEqual([]);
    });
  });

  describe('list', () => {
    beforeEach(() => {
      capture.storeRequest(
        makeReq('r1', { url: 'https://a/api/users', method: 'GET', timestamp: TS }),
      );
      capture.storeRequest(
        makeReq('r2', {
          url: 'https://a/api/orders',
          method: 'POST',
          timestamp: TS + 1000,
          status: 500,
        }),
      );
      capture.storeRequest(
        makeReq('r3', { url: 'https://a/static/app.js', method: 'GET', timestamp: TS + 2000 }),
      );
      capture.attachBodyToRequest('r2', 'request', 'mail me at x@y.com');
    });

    it('returns all requests sorted by timestamp desc when no filters', () => {
      const ids = capture.list().map((r) => r.id);
      expect(ids).toEqual(['r3', 'r2', 'r1']);
    });

    it('filters by urlPattern (substring)', () => {
      const ids = capture.list({ urlPattern: '/api/' }).map((r) => r.id);
      expect(ids).toEqual(['r2', 'r1']);
    });

    it('filters by method', () => {
      const ids = capture.list({ method: 'POST' }).map((r) => r.id);
      expect(ids).toEqual(['r2']);
    });

    it('filters by hasMatches', () => {
      const ids = capture.list({ hasMatches: true }).map((r) => r.id);
      expect(ids).toEqual(['r2']);
    });

    it('filters by status range', () => {
      expect(capture.list({ statusMin: 200 }).map((r) => r.id)).toEqual(['r2']);
      expect(capture.list({ statusMin: 1, statusMax: 499 })).toEqual([]);
      // requests without status are treated as status 0
      expect(capture.list({ statusMax: 0 }).map((r) => r.id)).toEqual(['r3', 'r1']);
    });

    it('applies limit after sorting', () => {
      const ids = capture.list({ limit: 2 }).map((r) => r.id);
      expect(ids).toEqual(['r3', 'r2']);
    });
  });

  describe('clear / stats', () => {
    it('clear empties all stored requests', () => {
      capture.storeRequest(makeReq('r1'));
      capture.storeRequest(makeReq('r2'));
      capture.clear();
      expect(capture.getAllRequests()).toHaveLength(0);
      expect(capture.stats().total).toBe(0);
    });

    it('stats counts totals, bodies, matches and unique match names', () => {
      capture.storeRequest(makeReq('r1'));
      capture.storeRequest(makeReq('r2'));
      capture.storeRequest(makeReq('r3'));
      capture.attachBodyToRequest('r1', 'request', 'plain body');
      capture.attachBodyToRequest('r2', 'response', 'mail a@b.com, key AKIAIOSFODNN7EXAMPLE');
      capture.attachBodyToRequest('r3', 'request', 'also a@b.com');
      const s = capture.stats();
      expect(s.total).toBe(3);
      expect(s.withBody).toBe(3);
      expect(s.withMatches).toBe(2);
      expect(s.uniqueMatches.has('Email')).toBe(true);
      expect(s.uniqueMatches.has('AWS Key')).toBe(true);
      expect(s.uniqueMatches.size).toBe(2);
    });
  });

  describe('listFiles', () => {
    it('lists persisted .jsonl files', () => {
      capture.setActive(true);
      capture.storeRequest(makeReq('r1', { timestamp: TS }));
      capture.storeRequest(makeReq('r2', { timestamp: TS + 24 * 3600 * 1000 }));
      const files = capture.listFiles().sort();
      expect(files).toEqual(['capture-2026-01-15.jsonl', 'capture-2026-01-16.jsonl']);
    });

    it('returns [] when the capture directory does not exist', () => {
      fs.rmSync(captureDir, { recursive: true, force: true });
      expect(capture.listFiles()).toEqual([]);
    });
  });
});
