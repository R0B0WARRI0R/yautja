import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { GQLCache, GQLEndpointInfo } from '../../src/intel/gql-cache.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// gql-cache.ts computes CACHE_DIR from APPDATA/HOME at module load time,
// so tests must stub APPDATA and re-import the module per test.
let tmpDir: string;
let cacheDir: string;
let GQLCacheClass: typeof GQLCache;
let cache: GQLCache;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yautja-gql-cache-test-'));
  cacheDir = path.join(tmpDir, '.yautja-gql-cache');
  vi.stubEnv('APPDATA', tmpDir);
  vi.resetModules();
  const mod = await import('../../src/intel/gql-cache.js');
  GQLCacheClass = mod.GQLCache;
  cache = new GQLCacheClass();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GQLCache', () => {
  describe('constructor', () => {
    it('creates the cache directory if it does not exist', () => {
      expect(fs.existsSync(cacheDir)).toBe(true);
    });

    it('does not throw when the directory already exists', () => {
      expect(() => new GQLCacheClass()).not.toThrow();
    });
  });

  describe('set / get', () => {
    it('returns null for an unknown domain', () => {
      expect(cache.get('unknown.com')).toBeNull();
    });

    it('stores and retrieves endpoint info', () => {
      cache.set('example.com', {
        endpoint: 'https://example.com/graphql',
        headers: { authorization: 'Bearer x' },
      });
      const info = cache.get('example.com');
      expect(info).not.toBeNull();
      expect(info!.endpoint).toBe('https://example.com/graphql');
      expect(info!.headers).toEqual({ authorization: 'Bearer x' });
      expect(info!.queries).toEqual({});
      expect(info!.rawQueries).toEqual({});
      expect(typeof info!.updatedAt).toBe('number');
    });

    it('merges headers and queries across successive sets', () => {
      cache.set('example.com', { headers: { a: '1' }, queries: { Op1: 'h1' } });
      cache.set('example.com', { headers: { b: '2' }, queries: { Op2: 'h2' } });
      const info = cache.get('example.com')!;
      expect(info.headers).toEqual({ a: '1', b: '2' });
      expect(info.queries).toEqual({ Op1: 'h1', Op2: 'h2' });
    });

    it('later values win on key conflict', () => {
      cache.set('example.com', { headers: { a: 'old' } });
      cache.set('example.com', { headers: { a: 'new' } });
      expect(cache.get('example.com')!.headers['a']).toBe('new');
    });

    it('keeps the previous endpoint when the new set omits it', () => {
      cache.set('example.com', { endpoint: 'https://example.com/graphql' });
      cache.set('example.com', { headers: { a: '1' } });
      expect(cache.get('example.com')!.endpoint).toBe('https://example.com/graphql');
    });

    it('updates updatedAt on every set', async () => {
      const first = cache.set('example.com', { endpoint: 'e' });
      await new Promise((r) => setTimeout(r, 5));
      const second = cache.set('example.com', { endpoint: 'e' });
      expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    });

    it('persists to disk and a fresh instance reads it back', () => {
      cache.set('example.com', {
        endpoint: 'https://example.com/graphql',
        queries: { GetUser: 'abc123' },
      });
      const file = path.join(cacheDir, 'example.com.json');
      expect(fs.existsSync(file)).toBe(true);
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as GQLEndpointInfo;
      expect(onDisk.endpoint).toBe('https://example.com/graphql');

      const fresh = new GQLCacheClass();
      const info = fresh.get('example.com');
      expect(info).not.toBeNull();
      expect(info!.queries['GetUser']).toBe('abc123');
    });

    it('sanitizes unsafe characters in the domain for the filename', () => {
      cache.set('exa mple/evil:com', { endpoint: 'e' });
      expect(fs.existsSync(path.join(cacheDir, 'exa_mple_evil_com.json'))).toBe(true);
    });

    it('returns null when the persisted file is malformed JSON', () => {
      fs.writeFileSync(path.join(cacheDir, 'broken.com.json'), '{not json');
      expect(cache.get('broken.com')).toBeNull();
    });
  });

  describe('addHash / getHash / getRawQuery', () => {
    it('stores a hash for an operation on a new domain', () => {
      cache.addHash('example.com', 'GetUser', 'hash123');
      expect(cache.getHash('example.com', 'GetUser')).toBe('hash123');
    });

    it('stores the raw query when provided', () => {
      cache.addHash('example.com', 'GetUser', 'hash123', 'query GetUser { id }');
      expect(cache.getRawQuery('example.com', 'GetUser')).toBe('query GetUser { id }');
    });

    it('does not overwrite the raw query when omitted', () => {
      cache.addHash('example.com', 'GetUser', 'h1', 'query { a }');
      cache.addHash('example.com', 'GetUser', 'h2');
      expect(cache.getHash('example.com', 'GetUser')).toBe('h2');
      expect(cache.getRawQuery('example.com', 'GetUser')).toBe('query { a }');
    });

    it('accumulates multiple operations on the same domain', () => {
      cache.addHash('example.com', 'Op1', 'h1');
      cache.addHash('example.com', 'Op2', 'h2');
      expect(cache.getHash('example.com', 'Op1')).toBe('h1');
      expect(cache.getHash('example.com', 'Op2')).toBe('h2');
    });

    it('returns undefined for unknown operation or domain', () => {
      expect(cache.getHash('nope.com', 'Op')).toBeUndefined();
      cache.addHash('example.com', 'Op1', 'h1');
      expect(cache.getHash('example.com', 'Missing')).toBeUndefined();
      expect(cache.getRawQuery('example.com', 'Missing')).toBeUndefined();
    });

    it('persists hashes to disk', () => {
      cache.addHash('example.com', 'GetUser', 'hash123', 'query GetUser { id }');
      const fresh = new GQLCacheClass();
      expect(fresh.getHash('example.com', 'GetUser')).toBe('hash123');
      expect(fresh.getRawQuery('example.com', 'GetUser')).toBe('query GetUser { id }');
    });
  });

  describe('listDomains', () => {
    it('returns an empty list when nothing is cached', () => {
      expect(cache.listDomains()).toEqual([]);
    });

    it('lists cached domains from disk files', () => {
      cache.set('a.com', { endpoint: 'e' });
      cache.set('b.com', { endpoint: 'e' });
      const domains = cache.listDomains().sort();
      expect(domains).toEqual(['a.com', 'b.com']);
    });
  });

  describe('clear', () => {
    it('clear(domain) removes only that domain from memory and disk', () => {
      cache.set('a.com', { endpoint: 'e' });
      cache.set('b.com', { endpoint: 'e' });
      cache.clear('a.com');
      expect(cache.get('a.com')).toBeNull();
      expect(fs.existsSync(path.join(cacheDir, 'a.com.json'))).toBe(false);
      expect(cache.get('b.com')).not.toBeNull();
      expect(fs.existsSync(path.join(cacheDir, 'b.com.json'))).toBe(true);
    });

    it('clear(domain) on an unknown domain does not throw', () => {
      expect(() => cache.clear('ghost.com')).not.toThrow();
    });

    it('clear() removes all domains from memory and disk', () => {
      cache.set('a.com', { endpoint: 'e' });
      cache.set('b.com', { endpoint: 'e' });
      cache.clear();
      expect(cache.get('a.com')).toBeNull();
      expect(cache.get('b.com')).toBeNull();
      expect(fs.readdirSync(cacheDir)).toEqual([]);
    });
  });
});
