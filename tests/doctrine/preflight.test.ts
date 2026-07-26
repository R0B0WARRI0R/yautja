import { describe, it, expect } from 'vitest';
import { runPreflight, mapPreflightCode } from '../../src/doctrine/preflight.js';
import { SiteProfileSchema } from '../../src/doctrine/site-profile.js';

function makeProfile(preFlight: any[]) {
  return SiteProfileSchema.parse({
    id: 'test',
    version: 1,
    match: { hosts: ['test.com'] },
    preFlight,
  });
}

const PPLX_COOKIE = encodeURIComponent(JSON.stringify({ qcd: 20, other: 'x' }));

describe('runPreflight', () => {
  it('passes with no checks', async () => {
    const r = await runPreflight(makeProfile([]), { getCookies: async () => [] });
    expect(r.pass).toBe(true);
  });

  it('cookieJson reads and decodes a uriComponent cookie', async () => {
    const profile = makeProfile([
      { id: 'read_quota_cookie', type: 'cookieJson', name: 'pplx.metadata', decode: 'uriComponent' },
    ]);
    const r = await runPreflight(profile, {
      getCookies: async () => [{ name: 'pplx.metadata', value: PPLX_COOKIE }],
    });
    expect(r.pass).toBe(true);
    expect((r.results.read_quota_cookie as any).qcd).toBe(20);
  });

  it('cookie missing → results null, preflight still passes (abortIf decides)', async () => {
    const profile = makeProfile([
      { id: 'read_quota_cookie', type: 'cookieJson', name: 'pplx.metadata', decode: 'uriComponent' },
      { id: 'abort_if_qcd_high', type: 'abortIf', path: 'preFlight.results.read_quota_cookie.qcd', op: '>', value: 15, code: 'QUOTA_EXHAUSTED' },
    ]);
    const r = await runPreflight(profile, { getCookies: async () => [] });
    expect(r.pass).toBe(true); // no cookie → no number → no abort
    expect(r.results.read_quota_cookie).toBeNull();
  });

  it('abortIf with qcd 20 > 15 → QUOTA_EXHAUSTED abort', async () => {
    const profile = makeProfile([
      { id: 'read_quota_cookie', type: 'cookieJson', name: 'pplx.metadata', decode: 'uriComponent' },
      { id: 'abort_if_qcd_high', type: 'abortIf', path: 'preFlight.results.read_quota_cookie.qcd', op: '>', value: 15, code: 'QUOTA_EXHAUSTED' },
    ]);
    const r = await runPreflight(profile, {
      getCookies: async () => [{ name: 'pplx.metadata', value: PPLX_COOKIE }],
    });
    expect(r.pass).toBe(false);
    expect(r.abortCode).toBe('QUOTA_EXHAUSTED');
    expect(r.reasons[r.reasons.length - 1]).toContain('abort');
  });

  it('abortIf with qcd 5 → pass', async () => {
    const profile = makeProfile([
      { id: 'read_quota_cookie', type: 'cookieJson', name: 'pplx.metadata', decode: 'uriComponent' },
      { id: 'abort_if_qcd_high', type: 'abortIf', path: 'preFlight.results.read_quota_cookie.qcd', op: '>', value: 15, code: 'QUOTA_EXHAUSTED' },
    ]);
    const r = await runPreflight(profile, {
      getCookies: async () => [{ name: 'pplx.metadata', value: encodeURIComponent(JSON.stringify({ qcd: 5 })) }],
    });
    expect(r.pass).toBe(true);
  });

  it('abortIf operators work', async () => {
    for (const [op, value, cookie, expected] of [
      ['>=', 20, { qcd: 20 }, false],
      ['<', 15, { qcd: 5 }, false],
      ['==', 20, { qcd: 20 }, false],
      ['!=', 20, { qcd: 5 }, false],
      ['>', 20, { qcd: 20 }, true], // not greater → pass
    ] as const) {
      const profile = makeProfile([
        { id: 'c', type: 'cookieJson', name: 'pplx.metadata', decode: 'uriComponent' },
        { id: 'a', type: 'abortIf', path: 'preFlight.results.c.qcd', op, value, code: 'QUOTA_EXHAUSTED' },
      ]);
      const r = await runPreflight(profile, {
        getCookies: async () => [{ name: 'pplx.metadata', value: encodeURIComponent(JSON.stringify(cookie)) }],
      });
      expect(r.pass, `${cookie.qcd} ${op} ${value}`).toBe(expected);
    }
  });
});

describe('mapPreflightCode', () => {
  it('maps short aliases to registry codes', () => {
    expect(mapPreflightCode('QUOTA_EXHAUSTED')).toBe('YJ.POLICY.QUOTA_EXHAUSTED');
    expect(mapPreflightCode('CAPTCHA_DETECTED')).toBe('YJ.OPSEC.CAPTCHA_DETECTED');
    expect(mapPreflightCode('GATE_DENIED')).toBe('YJ.POLICY.GATE_DENIED');
  });

  it('passes through full YJ codes and defaults unknowns to GATE_DENIED', () => {
    expect(mapPreflightCode('YJ.ACT.WAIT_TIMEOUT')).toBe('YJ.ACT.WAIT_TIMEOUT');
    expect(mapPreflightCode('SOMETHING_ELSE')).toBe('YJ.POLICY.GATE_DENIED');
  });
});
