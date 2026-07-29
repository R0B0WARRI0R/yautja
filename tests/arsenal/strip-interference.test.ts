import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildStripInterferenceScript,
  parseStripResult,
  isStripInterferenceEnabled,
  stripInterference,
  STRIP_KILL_SWITCH_KEY,
} from '../../src/arsenal/strip-interference.js';
import { clearKillSwitchCache } from '../../src/arsenal/kill-switch.js';

// La caché de kill switches es module-global: hay que aislarla entre tests.
beforeEach(() => clearKillSwitchCache());

describe('buildStripInterferenceScript', () => {
  it('targets chrome-extension iframes and keeps the Yautja Bridge id', () => {
    const js = buildStripInterferenceScript('yautjabridgeid123');
    expect(js).toContain('iframe[src^="chrome-extension://"]');
    expect(js).toContain('"yautjabridgeid123"');
    expect(js).toContain('host !== SELF');
    expect(js).toContain('f.remove()');
    expect(js).toContain('removed');
    expect(js).toContain('hosts');
  });

  it('with an empty self id it strips every extension iframe', () => {
    const js = buildStripInterferenceScript('');
    expect(js).toContain('const SELF = "";');
  });
});

describe('parseStripResult', () => {
  it('parses a well-formed payload', () => {
    expect(parseStripResult({ removed: 2, hosts: ['aaa', 'bbb'] })).toEqual({
      removed: 2,
      hosts: ['aaa', 'bbb'],
    });
  });

  it('is tolerant with malformed payloads', () => {
    expect(parseStripResult(null)).toEqual({ removed: 0, hosts: [] });
    expect(parseStripResult('nope')).toEqual({ removed: 0, hosts: [] });
    expect(parseStripResult({ removed: 'x', hosts: 'y' })).toEqual({ removed: 0, hosts: [] });
    expect(parseStripResult({ removed: 1, hosts: ['a', 5] })).toEqual({ removed: 1, hosts: ['a'] });
  });
});

describe('isStripInterferenceEnabled (kill switch yjStripInterference)', () => {
  it('defaults to true when the key is absent', async () => {
    const storage = { storageGet: vi.fn(async () => undefined) };
    expect(await isStripInterferenceEnabled(storage)).toBe(true);
    expect(storage.storageGet).toHaveBeenCalledWith(STRIP_KILL_SWITCH_KEY);
  });

  it('is disabled only by an explicit false', async () => {
    expect(await isStripInterferenceEnabled({ storageGet: async () => false })).toBe(false);
    clearKillSwitchCache(); // la lectura queda cacheada 5s: aislar cada escenario
    expect(await isStripInterferenceEnabled({ storageGet: async () => true })).toBe(true);
    clearKillSwitchCache();
    expect(await isStripInterferenceEnabled({ storageGet: async () => 0 })).toBe(true);
  });

  it('fails open when storage read throws', async () => {
    const storage = { storageGet: vi.fn(async () => { throw new Error('no storage'); }) };
    expect(await isStripInterferenceEnabled(storage)).toBe(true);
  });
});

describe('stripInterference', () => {
  it('evaluates the script and returns the parsed result', async () => {
    const send = vi.fn(async (_m: string, _p?: any) => ({
      result: { value: { removed: 2, hosts: ['evil-ext', 'other-ext'] } },
    }));
    const r = await stripInterference({ send }, 'yautjabridgeid123');
    expect(r).toEqual({ removed: 2, hosts: ['evil-ext', 'other-ext'] });
    const call = send.mock.calls[0]!;
    expect(call[0]).toBe('Runtime.evaluate');
    expect(call[1].expression).toContain('"yautjabridgeid123"');
    expect(call[1].returnByValue).toBe(true);
  });

  it('returns zeros on exceptionDetails (non-fatal)', async () => {
    const send = vi.fn(async () => ({ exceptionDetails: { text: 'ReferenceError' } }));
    expect(await stripInterference({ send }, '')).toEqual({ removed: 0, hosts: [] });
  });

  it('returns zeros when the transport throws (non-fatal)', async () => {
    const send = vi.fn(async () => { throw new Error('cdp down'); });
    expect(await stripInterference({ send }, '')).toEqual({ removed: 0, hosts: [] });
  });
});
