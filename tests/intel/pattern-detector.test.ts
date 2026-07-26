import { describe, it, expect, beforeEach } from 'vitest';
import {
  PatternDetector,
  type Transport,
} from '../../src/intel/pattern-detector.js';
import type { HashSeedDB, HashSeed } from '../../src/intel/hash-seed.js';

class MockTransport implements Transport {
  calls: { method: string; params?: Record<string, any> }[] = [];
  responses: Map<string, any> = new Map();
  throwOn: Set<string> = new Set();

  async send(method: string, params?: Record<string, any>): Promise<any> {
    this.calls.push({ method, params });
    if (this.throwOn.has(method)) throw new Error(`${method} failed`);
    return this.responses.get(method) ?? {};
  }
}

function makeSeedDB(seeds: Record<string, string> = {}): HashSeedDB {
  // keys are `${domain}:${operationName}` -> known hash
  return {
    get(operationName: string, domain: string): HashSeed | null {
      const hash = seeds[`${domain}:${operationName}`];
      return hash ? ({ operationName, hash } as HashSeed) : null;
    },
  } as unknown as HashSeedDB;
}

function manifestResponse(buildId: string | null): any {
  return {
    result: {
      value: buildId === null
        ? null
        : JSON.stringify({ channels: [{ releases: [{ buildId }] }] }),
    },
  };
}

describe('PatternDetector', () => {
  let transport: MockTransport;

  beforeEach(() => {
    transport = new MockTransport();
  });

  describe('signal: persisted-not-found', () => {
    it('emits critical signal when errors contain exact PersistedQueryNotFound', async () => {
      const detector = new PatternDetector(transport, makeSeedDB());
      const signals = await detector.detect('example.com', 'MyOp', {
        errors: [{ message: 'PersistedQueryNotFound' }],
      });
      expect(signals).toHaveLength(1);
      expect(signals[0]!.type).toBe('persisted-not-found');
      expect(signals[0]!.severity).toBe('critical');
      expect(signals[0]!.message).toContain('MyOp');
      expect(signals[0]!.message).toContain('example.com');
      expect(signals[0]!.data).toMatchObject({
        domain: 'example.com',
        operationName: 'MyOp',
      });
      expect(typeof signals[0]!.timestamp).toBe('number');
    });

    it('matches error messages that include PersistedQuery as substring', async () => {
      const detector = new PatternDetector(transport, makeSeedDB());
      const signals = await detector.detect('example.com', 'MyOp', {
        errors: [{ message: 'PersistedQuery hash mismatch' }],
      });
      expect(signals).toHaveLength(1);
      expect(signals[0]!.type).toBe('persisted-not-found');
    });

    it('does not emit when operationName is not provided', async () => {
      const detector = new PatternDetector(transport, makeSeedDB());
      const signals = await detector.detect('example.com', undefined, {
        errors: [{ message: 'PersistedQueryNotFound' }],
      });
      expect(signals).toHaveLength(0);
    });

    it('does not emit for unrelated errors', async () => {
      const detector = new PatternDetector(transport, makeSeedDB());
      const signals = await detector.detect('example.com', 'MyOp', {
        errors: [{ message: 'Some other GraphQL error' }],
      });
      expect(signals).toHaveLength(0);
    });

    it('does not emit when lastResult is missing or has no errors', async () => {
      const detector = new PatternDetector(transport, makeSeedDB());
      expect(await detector.detect('example.com', 'MyOp')).toHaveLength(0);
      expect(await detector.detect('example.com', 'MyOp', null)).toHaveLength(0);
      expect(await detector.detect('example.com', 'MyOp', { data: {} })).toHaveLength(0);
    });
  });

  describe('signal: captured-different', () => {
    it('emits warning when captured hash differs from known seed', async () => {
      const detector = new PatternDetector(
        transport,
        makeSeedDB({ 'example.com:MyOp': 'old-hash' }),
      );
      const signals = await detector.detect('example.com', undefined, undefined, [
        { hash: 'new-hash', ops: ['MyOp'] },
      ]);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.type).toBe('captured-different');
      expect(signals[0]!.severity).toBe('warning');
      expect(signals[0]!.data).toMatchObject({
        domain: 'example.com',
        operationName: 'MyOp',
        oldHash: 'old-hash',
        newHash: 'new-hash',
      });
    });

    it('does not emit when captured hash matches the seed', async () => {
      const detector = new PatternDetector(
        transport,
        makeSeedDB({ 'example.com:MyOp': 'same-hash' }),
      );
      const signals = await detector.detect('example.com', undefined, undefined, [
        { hash: 'same-hash', ops: ['MyOp'] },
      ]);
      expect(signals).toHaveLength(0);
    });

    it('does not emit when there is no known seed for the operation', async () => {
      const detector = new PatternDetector(transport, makeSeedDB());
      const signals = await detector.detect('example.com', undefined, undefined, [
        { hash: 'some-hash', ops: ['UnknownOp'] },
      ]);
      expect(signals).toHaveLength(0);
    });

    it('scopes seed lookup by domain', async () => {
      const detector = new PatternDetector(
        transport,
        makeSeedDB({ 'other.com:MyOp': 'old-hash' }),
      );
      const signals = await detector.detect('example.com', undefined, undefined, [
        { hash: 'new-hash', ops: ['MyOp'] },
      ]);
      expect(signals).toHaveLength(0);
    });

    it('skips captures without hash or with empty ops', async () => {
      const detector = new PatternDetector(
        transport,
        makeSeedDB({ 'example.com:MyOp': 'old-hash' }),
      );
      const signals = await detector.detect('example.com', undefined, undefined, [
        { ops: ['MyOp'] },
        { hash: 'new-hash', ops: [] },
        { hash: 'new-hash' },
      ]);
      expect(signals).toHaveLength(0);
    });

    it('does nothing with an empty capturedGql array', async () => {
      const detector = new PatternDetector(
        transport,
        makeSeedDB({ 'example.com:MyOp': 'old-hash' }),
      );
      const signals = await detector.detect('example.com', undefined, undefined, []);
      expect(signals).toHaveLength(0);
    });

    it('reports multiple differing captures independently', async () => {
      const detector = new PatternDetector(
        transport,
        makeSeedDB({ 'example.com:OpA': 'a1', 'example.com:OpB': 'b1' }),
      );
      const signals = await detector.detect('example.com', undefined, undefined, [
        { hash: 'a2', ops: ['OpA'] },
        { hash: 'b1', ops: ['OpB'] },
        { hash: 'b2', ops: ['OpB'] },
      ]);
      expect(signals).toHaveLength(2);
      expect(signals.map((s) => s.data.operationName)).toEqual(['OpA', 'OpB']);
    });
  });

  describe('signal: bundle-changed (twitch manifest)', () => {
    it('does not call the transport for non-twitch domains', async () => {
      const detector = new PatternDetector(transport, makeSeedDB());
      await detector.detect('example.com');
      expect(transport.calls).toHaveLength(0);
    });

    it('stores the first observed buildId without emitting a signal', async () => {
      transport.responses.set('Runtime.evaluate', manifestResponse('build-1'));
      const detector = new PatternDetector(transport, makeSeedDB());
      const signals = await detector.detect('www.twitch.tv');
      expect(signals).toHaveLength(0);
      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0]!.method).toBe('Runtime.evaluate');
      expect(transport.calls[0]!.params!.expression).toContain('manifest.json');
    });

    it('emits critical signal when the buildId changes between calls', async () => {
      transport.responses.set('Runtime.evaluate', manifestResponse('build-1'));
      const detector = new PatternDetector(transport, makeSeedDB());
      await detector.detect('www.twitch.tv');
      transport.responses.set('Runtime.evaluate', manifestResponse('build-2'));
      const signals = await detector.detect('www.twitch.tv');
      expect(signals).toHaveLength(1);
      expect(signals[0]!.type).toBe('bundle-changed');
      expect(signals[0]!.severity).toBe('critical');
      expect(signals[0]!.data).toMatchObject({
        domain: 'www.twitch.tv',
        oldBuildId: 'build-1',
        newBuildId: 'build-2',
      });
    });

    it('does not emit when the buildId is unchanged', async () => {
      transport.responses.set('Runtime.evaluate', manifestResponse('build-1'));
      const detector = new PatternDetector(transport, makeSeedDB());
      await detector.detect('www.twitch.tv');
      const signals = await detector.detect('www.twitch.tv');
      expect(signals).toHaveLength(0);
    });

    it('tracks buildId per domain', async () => {
      transport.responses.set('Runtime.evaluate', manifestResponse('build-1'));
      const detector = new PatternDetector(transport, makeSeedDB());
      await detector.detect('www.twitch.tv');
      // different twitch domain starts with its own baseline: no signal
      const signals = await detector.detect('m.twitch.tv');
      expect(signals).toHaveLength(0);
    });

    it('ignores a null manifest value (fetch failed in page)', async () => {
      transport.responses.set('Runtime.evaluate', manifestResponse(null));
      const detector = new PatternDetector(transport, makeSeedDB());
      const signals = await detector.detect('www.twitch.tv');
      expect(signals).toHaveLength(0);
    });

    it('ignores malformed JSON in the manifest', async () => {
      transport.responses.set('Runtime.evaluate', {
        result: { value: 'not-json{{{' },
      });
      const detector = new PatternDetector(transport, makeSeedDB());
      const signals = await detector.detect('www.twitch.tv');
      expect(signals).toHaveLength(0);
    });

    it('ignores manifests without a buildId', async () => {
      transport.responses.set('Runtime.evaluate', {
        result: { value: JSON.stringify({ channels: [{ releases: [] }] }) },
      });
      const detector = new PatternDetector(transport, makeSeedDB());
      const signals = await detector.detect('www.twitch.tv');
      expect(signals).toHaveLength(0);
    });

    it('swallows transport errors', async () => {
      transport.throwOn.add('Runtime.evaluate');
      const detector = new PatternDetector(transport, makeSeedDB());
      const signals = await detector.detect('www.twitch.tv');
      expect(signals).toHaveLength(0);
    });
  });

  describe('combined signals and state', () => {
    it('can report persisted-not-found and captured-different together', async () => {
      const detector = new PatternDetector(
        transport,
        makeSeedDB({ 'example.com:MyOp': 'old-hash' }),
      );
      const signals = await detector.detect(
        'example.com',
        'MyOp',
        { errors: [{ message: 'PersistedQueryNotFound' }] },
        [{ hash: 'new-hash', ops: ['MyOp'] }],
      );
      expect(signals).toHaveLength(2);
      expect(signals.map((s) => s.type)).toEqual([
        'persisted-not-found',
        'captured-different',
      ]);
    });

    it('getSignals returns the signals from the last detect call', async () => {
      const detector = new PatternDetector(transport, makeSeedDB());
      expect(detector.getSignals()).toEqual([]);
      const signals = await detector.detect('example.com', 'MyOp', {
        errors: [{ message: 'PersistedQueryNotFound' }],
      });
      expect(detector.getSignals()).toBe(signals);
    });

    it('detect replaces signals from the previous call', async () => {
      const detector = new PatternDetector(transport, makeSeedDB());
      await detector.detect('example.com', 'MyOp', {
        errors: [{ message: 'PersistedQueryNotFound' }],
      });
      expect(detector.getSignals()).toHaveLength(1);
      await detector.detect('example.com', 'MyOp');
      expect(detector.getSignals()).toHaveLength(0);
    });

    it('clearSignals empties the stored signals', async () => {
      const detector = new PatternDetector(transport, makeSeedDB());
      await detector.detect('example.com', 'MyOp', {
        errors: [{ message: 'PersistedQueryNotFound' }],
      });
      detector.clearSignals();
      expect(detector.getSignals()).toEqual([]);
    });
  });
});
