import { describe, it, expect } from 'vitest';
import {
  surfaceFromNetwork,
  extractPathsFromBundle,
  normalizePath,
  mergeEndpoints,
  buildBundleScanScript,
} from '../../src/intel/api-surface.js';
import type { CapturedRequest } from '../../src/intel/network-capture.js';

function req(url: string, method = 'GET', headers: Record<string, string> = {}, status = 200): CapturedRequest {
  return { id: Math.random().toString(36).slice(2), url, method, requestHeaders: headers, status, timestamp: Date.now() };
}

describe('normalizePath', () => {
  it('replaces numeric, uuid and hex segments with {id}', () => {
    expect(normalizePath('/api/users/123')).toBe('/api/users/{id}');
    expect(normalizePath('/api/items/a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe('/api/items/{id}');
    expect(normalizePath('/api/sessions/a1b2c3d4e5f60718')).toBe('/api/sessions/{id}');
    expect(normalizePath('/api/users')).toBe('/api/users');
  });
});

describe('surfaceFromNetwork', () => {
  it('lists the 3 /api calls of the fixture SPA with from:network (acceptance)', () => {
    const entries = [
      req('https://app.example.com/api/users'),
      req('https://app.example.com/api/users/123', 'GET', { cookie: 'sess=1' }),
      req('https://app.example.com/api/orders', 'POST', { authorization: 'Bearer x' }, 201),
      req('https://app.example.com/static/app.js'), // asset → excluded
    ];
    const surface = surfaceFromNetwork(entries);
    expect(surface).toHaveLength(3);
    for (const ep of surface) {
      expect(ep.from).toContain('network');
      expect(ep.confidence).toBe(0.9);
    }
    expect(surface.find((e) => e.path === '/api/users/{id}')?.authHint).toBe('cookie');
    expect(surface.find((e) => e.path === '/api/orders')?.authHint).toBe('bearer');
    expect(surface.find((e) => e.path === '/api/users')?.authHint).toBe('none');
  });

  it('groups repeated calls to the same normalized path', () => {
    const entries = [
      req('https://app.example.com/api/users/1'),
      req('https://app.example.com/api/users/2'),
      req('https://app.example.com/api/users/3'),
    ];
    const surface = surfaceFromNetwork(entries);
    expect(surface).toHaveLength(1);
    expect(surface[0]!.path).toBe('/api/users/{id}');
  });
});

describe('extractPathsFromBundle', () => {
  it('finds /api/auth/me in a bundle string (acceptance)', () => {
    const bundle = `var x=1;fetch("/api/auth/me");fetch('/api/v2/items');import("/static/chunk.js")`;
    const paths = extractPathsFromBundle(bundle);
    expect(paths).toContain('/api/auth/me');
    expect(paths).toContain('/api/v2/items');
    expect(paths).not.toContain('/static/chunk.js');
  });

  it('normalizes ids inside bundle paths', () => {
    expect(extractPathsFromBundle('get("/api/users/123/profile")')).toContain('/api/users/{id}/profile');
  });
});

describe('mergeEndpoints', () => {
  it('merges sources and boosts confidence', () => {
    const network = surfaceFromNetwork([req('https://app.example.com/api/users')]);
    const bundle = [{
      method: '*', path: '/api/users', origin: 'https://app.example.com',
      authHint: 'unknown' as const, from: ['bundle' as const], confidence: 0.5,
    }];
    const merged = mergeEndpoints([network, bundle]);
    const ep = merged.find((e) => e.path === '/api/users');
    expect(ep!.from).toContain('network');
    expect(ep!.from).toContain('bundle');
    expect(ep!.confidence).toBeGreaterThan(0.9);
  });
});

describe('buildBundleScanScript', () => {
  it('runs against a fake document/fetch and extracts paths', async () => {
    const script = buildBundleScanScript();
    const fakeDocument = { scripts: [{ src: 'https://app.example.com/app.js' }] };
    const fakeFetch = async () => ({ text: async () => 'fetch("/api/auth/me");fetch("/api/data")' });
    const out = JSON.parse(await new Function('document', 'fetch', `return (${script});`)(fakeDocument, fakeFetch));
    expect(out.paths).toContain('/api/auth/me');
    expect(out.paths).toContain('/api/data');
    expect(out.bundlesScanned).toBe(1);
  });
});
