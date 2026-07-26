import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { HashSeedDB, HashSeed, RotationEvent } from '../../src/intel/hash-seed.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// hash-seed.ts computes SEED_DIR from APPDATA/HOME at module load time,
// so tests must stub APPDATA and re-import the module per test.
let tmpDir: string;
let seedDir: string;
let HashSeedDBClass: typeof HashSeedDB;
let db: HashSeedDB;

function seed(overrides: Partial<HashSeed> = {}): HashSeed {
  return {
    operationName: 'GetUser',
    hash: 'a'.repeat(64),
    hashPrefix: 'a'.repeat(16),
    queryTemplate: 'query GetUser { id }',
    variables: ['id'],
    signatureFields: ['operationName', 'query'],
    capturedAt: Date.now(),
    lastValidatedAt: Date.now(),
    ttlDays: 30,
    rotationCount: 0,
    source: 'browser',
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yautja-hash-seed-test-'));
  seedDir = path.join(tmpDir, '.yautja-hash-seeds');
  vi.stubEnv('APPDATA', tmpDir);
  vi.resetModules();
  const mod = await import('../../src/intel/hash-seed.js');
  HashSeedDBClass = mod.HashSeedDB;
  db = new HashSeedDBClass();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('HashSeedDB', () => {
  describe('constructor', () => {
    it('creates the seed directory if it does not exist', () => {
      expect(fs.existsSync(seedDir)).toBe(true);
    });

    it('loads existing seed files from disk', () => {
      const first = new HashSeedDBClass();
      first.set(seed(), 'example.com');
      const second = new HashSeedDBClass();
      expect(second.get('GetUser', 'example.com')).not.toBeNull();
    });
  });

  describe('set / get', () => {
    it('returns null for an unknown operation/domain', () => {
      expect(db.get('Nope', 'example.com')).toBeNull();
      db.set(seed(), 'example.com');
      expect(db.get('Nope', 'example.com')).toBeNull();
      expect(db.get('GetUser', 'other.com')).toBeNull();
    });

    it('stores and retrieves a seed', () => {
      const s = seed();
      db.set(s, 'example.com');
      expect(db.get('GetUser', 'example.com')).toEqual(s);
    });

    it('keys seeds by domain and operationName independently', () => {
      db.set(seed({ operationName: 'Op1' }), 'a.com');
      db.set(seed({ operationName: 'Op1' }), 'b.com');
      db.set(seed({ operationName: 'Op2' }), 'a.com');
      expect(db.list()).toHaveLength(3);
    });

    it('persists to disk with seeds and rotations', () => {
      db.set(seed(), 'example.com');
      const file = path.join(seedDir, 'example.com.json');
      expect(fs.existsSync(file)).toBe(true);
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(onDisk.seeds).toHaveLength(1);
      expect(onDisk.seeds[0].operationName).toBe('GetUser');
      expect(onDisk.rotations).toEqual([]);
      expect(typeof onDisk.updatedAt).toBe('number');
    });

    it('overwrites an existing seed for the same domain+operation', () => {
      db.set(seed({ hash: 'old' }), 'example.com');
      db.set(seed({ hash: 'new' }), 'example.com');
      expect(db.get('GetUser', 'example.com')!.hash).toBe('new');
      expect(db.list()).toHaveLength(1);
    });
  });

  describe('list', () => {
    it('returns an empty array when there are no seeds', () => {
      expect(db.list()).toEqual([]);
    });

    it('without domain returns all seeds', () => {
      db.set(seed({ operationName: 'Op1' }), 'a.com');
      db.set(seed({ operationName: 'Op2' }), 'b.com');
      const ops = db.list().map((s) => s.operationName).sort();
      expect(ops).toEqual(['Op1', 'Op2']);
    });

    it('with domain returns only seeds from that domain', () => {
      db.set(seed({ operationName: 'Full' }), 'a.com');
      db.set(seed({ operationName: 'NoTemplate', queryTemplate: '' }), 'a.com');
      db.set(seed({ operationName: 'OtherDomain' }), 'b.com');
      const ops = db.list('a.com').map((s) => s.operationName).sort();
      expect(ops).toEqual(['Full', 'NoTemplate']);
    });
  });

  describe('invalidate', () => {
    it('returns false and records nothing for an unknown seed', () => {
      expect(db.invalidate('Nope', 'example.com')).toBe(false);
      expect(db.getRotations()).toEqual([]);
    });

    it('removes the seed and returns true', () => {
      db.set(seed(), 'example.com');
      expect(db.invalidate('GetUser', 'example.com')).toBe(true);
      expect(db.get('GetUser', 'example.com')).toBeNull();
    });

    it('records a rotation event with the invalidated seed hash and recovered=false', () => {
      db.set(seed({ hash: 'realhash' }), 'example.com');
      db.invalidate('GetUser', 'example.com');
      const rotations = db.getRotations();
      expect(rotations).toHaveLength(1);
      expect(rotations[0]!.operationName).toBe('GetUser');
      expect(rotations[0]!.oldHash).toBe('realhash');
      expect(rotations[0]!.recovered).toBe(false);
      expect(typeof rotations[0]!.detectedAt).toBe('number');
    });

    it('persists the invalidation to disk', () => {
      db.set(seed(), 'example.com');
      db.invalidate('GetUser', 'example.com');
      const fresh = new HashSeedDBClass();
      expect(fresh.get('GetUser', 'example.com')).toBeNull();
      expect(fresh.getRotations()).toHaveLength(1);
    });
  });

  describe('recordRotation / getRotations', () => {
    function rotation(overrides: Partial<RotationEvent> = {}): RotationEvent {
      return {
        operationName: 'GetUser',
        oldHash: 'old',
        detectedAt: Date.now(),
        recovered: false,
        ...overrides,
      };
    }

    it('appends rotation events', () => {
      db.recordRotation(rotation({ operationName: 'Op1' }));
      db.recordRotation(rotation({ operationName: 'Op2' }));
      expect(db.getRotations().map((r) => r.operationName)).toEqual(['Op1', 'Op2']);
    });

    it('keeps newHash on recovered events', () => {
      db.recordRotation(rotation({ recovered: true, newHash: 'newhash' }));
      expect(db.getRotations()[0]!.newHash).toBe('newhash');
    });

    it('getRotations(limit) returns only the most recent events', () => {
      for (let i = 0; i < 5; i++) db.recordRotation(rotation({ operationName: `Op${i}` }));
      const last3 = db.getRotations(3);
      expect(last3.map((r) => r.operationName)).toEqual(['Op2', 'Op3', 'Op4']);
    });

    it('trims history to the last 100 events', () => {
      for (let i = 0; i < 105; i++) db.recordRotation(rotation({ operationName: `Op${i}` }));
      const all = db.getRotations(1000);
      expect(all).toHaveLength(100);
      expect(all[0]!.operationName).toBe('Op5');
      expect(all[99]!.operationName).toBe('Op104');
    });
  });

  describe('load', () => {
    it('swallows malformed JSON files without throwing', () => {
      fs.writeFileSync(path.join(seedDir, 'broken.com.json'), '{nope');
      expect(() => new HashSeedDBClass()).not.toThrow();
    });

    it('load(domain) loads seeds for a single domain', () => {
      const first = new HashSeedDBClass();
      first.set(seed({ operationName: 'OpA' }), 'a.com');
      first.set(seed({ operationName: 'OpB' }), 'b.com');

      const second = new HashSeedDBClass();
      second.load('a.com');
      expect(second.get('OpA', 'a.com')).not.toBeNull();
    });

    it('tolerates files with missing seeds/rotations fields', () => {
      fs.writeFileSync(path.join(seedDir, 'empty.com.json'), '{}');
      expect(() => new HashSeedDBClass()).not.toThrow();
      expect(db.list()).toEqual([]);
    });
  });

  describe('statics', () => {
    it('computeHash returns the sha256 hex digest of the query', () => {
      const query = 'query GetUser { id }';
      const expected = crypto.createHash('sha256').update(query).digest('hex');
      expect(HashSeedDBClass.computeHash(query)).toBe(expected);
    });

    it('computeHash is deterministic and input-sensitive', () => {
      expect(HashSeedDBClass.computeHash('a')).toBe(HashSeedDBClass.computeHash('a'));
      expect(HashSeedDBClass.computeHash('a')).not.toBe(HashSeedDBClass.computeHash('b'));
    });

    it('hashPrefix returns the first 16 characters', () => {
      const hash = 'abcdef0123456789' + 'f'.repeat(48);
      expect(HashSeedDBClass.hashPrefix(hash)).toBe('abcdef0123456789');
      expect(HashSeedDBClass.hashPrefix(hash)).toHaveLength(16);
    });
  });
});
