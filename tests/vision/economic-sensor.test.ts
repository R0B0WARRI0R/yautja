import { describe, it, expect } from 'vitest';
import { parsePplxMetadata } from '../../src/doctrine/quota-readers/perplexity.js';
import { readGeminiQuota } from '../../src/doctrine/quota-readers/gemini.js';
import { EconomicSensor } from '../../src/vision/economic-sensor.js';
import { SiteProfileStore } from '../../src/doctrine/site-profile.js';
import { fileURLToPath } from 'url';

const SHIPPED_DIR = fileURLToPath(new URL('../../profiles', import.meta.url));

describe('parsePplxMetadata', () => {
  it('parses qcd from the uriComponent cookie', () => {
    const cookie = encodeURIComponent(JSON.stringify({ qcd: 7 }));
    const q = parsePplxMetadata(cookie);
    expect(q.source).toBe('cookie:pplx.metadata');
    expect(q.qcd).toBe(7);
    expect(q.remainingHint).toBe('ok');
  });

  it('remainingHint escalates with qcd', () => {
    expect(parsePplxMetadata(encodeURIComponent('{"qcd":12}')).remainingHint).toBe('low');
    expect(parsePplxMetadata(encodeURIComponent('{"qcd":20}')).remainingHint).toBe('exhausted');
  });

  it('unknown on missing/corrupt cookie', () => {
    expect(parsePplxMetadata(null).source).toBe('unknown');
    expect(parsePplxMetadata('not-json%%%').source).toBe('unknown');
    expect(parsePplxMetadata('').source).toBe('unknown');
  });
});

describe('readGeminiQuota', () => {
  it('reports unknown (no auto-navigation to /usage)', () => {
    expect(readGeminiQuota().source).toBe('unknown');
  });
});

describe('EconomicSensor', () => {
  const store = new SiteProfileStore([SHIPPED_DIR]);

  it('perplexity: reads quota from the cookie', async () => {
    const sensor = new EconomicSensor(store, {
      getCookies: async () => [{ name: 'pplx.metadata', value: encodeURIComponent('{"qcd":3}') }],
    });
    const s = await sensor.summarize('https://www.perplexity.ai/search/abc');
    expect(s.domainProfile).toBe('perplexity');
    expect(s.quota.source).toBe('cookie:pplx.metadata');
    expect((s.quota as any).qcd).toBe(3);
    expect(s.estimatedCostOfNextTypeSubmit).toBe('1_query');
  });

  it('gemini: profile matched, quota unknown', async () => {
    const sensor = new EconomicSensor(store, { getCookies: async () => [] });
    const s = await sensor.summarize('https://gemini.google.com/app');
    expect(s.domainProfile).toBe('gemini');
    expect(s.quota.source).toBe('unknown');
  });

  it('default domain: default profile, unknown quota', async () => {
    const sensor = new EconomicSensor(store, { getCookies: async () => [] });
    const s = await sensor.summarize('https://example.com/');
    expect(s.domainProfile).toBe('default');
    expect(s.quota.source).toBe('unknown');
    expect(s.estimatedCostOfNextTypeSubmit).toBe('unknown');
  });

  it('survives getCookies failure', async () => {
    const sensor = new EconomicSensor(store, {
      getCookies: async () => { throw new Error('cdp down'); },
    });
    const s = await sensor.summarize('https://www.perplexity.ai/');
    expect(s.quota.source).toBe('unknown');
  });
});
