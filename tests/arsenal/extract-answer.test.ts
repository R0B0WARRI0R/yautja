import { describe, it, expect } from 'vitest';
import { extractAnswer, chunkText, buildExtractionScript } from '../../src/arsenal/extract-answer.js';

class MockTransport {
  handler: (method: string, params: any) => any = () => ({});
  async send(method: string, params?: any): Promise<any> {
    return this.handler(method, params);
  }
}

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkText('hello', 100)).toEqual(['hello']);
  });

  it('splits long text with no silent truncation', () => {
    const text = 'x'.repeat(20_000);
    const chunks = chunkText(text, 6000);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.join('')).toBe(text);
    for (const c of chunks.slice(0, -1)) expect(c.length).toBeLessThanOrEqual(6000);
  });

  it('prefers paragraph boundaries near the limit', () => {
    const text = 'a'.repeat(900) + '\n' + 'b'.repeat(900);
    const chunks = chunkText(text, 1000);
    expect(chunks[0]).toBe('a'.repeat(900));
    expect(chunks[1]).toBe('b'.repeat(900));
  });

  it('hard-cuts when there is no useful newline', () => {
    const text = 'x'.repeat(100);
    const chunks = chunkText(text, 30);
    expect(chunks.length).toBe(4);
    expect(chunks.join('')).toBe(text);
  });

  it('size 0 returns the whole text as one chunk', () => {
    expect(chunkText('abc', 0)).toEqual(['abc']);
  });
});

describe('buildExtractionScript — against fake DOM', () => {
  function fakeDoc(scrubbed: string) {
    const clone: any = {
      innerText: scrubbed,
      textContent: scrubbed,
      querySelectorAll: (_s: string) => [{ remove: () => {} }],
    };
    const main: any = { cloneNode: () => clone };
    return {
      querySelector: (sel: string) => (sel === 'main' ? main : null),
      body: main,
    };
  }

  it('extracts scrubbed innerText from the root', () => {
    const script = buildExtractionScript('main', ['nav', 'button']);
    const doc = fakeDoc('The answer body\n\nwithout buttons');
    const out = new Function('document', `return (${script});`)(doc);
    expect(out).toBe('The answer body\n\nwithout buttons');
  });

  it('collapses 3+ newlines', () => {
    const script = buildExtractionScript('main', []);
    const doc = fakeDoc('para one\n\n\n\n\npara two');
    const out = new Function('document', `return (${script});`)(doc);
    expect(out).toBe('para one\n\npara two');
  });
});

describe('extractAnswer', () => {
  it('waitUntil:now extracts immediately with chunking by default', async () => {
    const t = new MockTransport();
    t.handler = () => ({ result: { value: 'a'.repeat(13_000) } });
    const r = await extractAnswer({ transport: t }, { waitUntil: 'now' });
    expect(r.length).toBe(13_000);
    expect(r.chunks!.length).toBeGreaterThanOrEqual(2);
    expect(r.text).toBe(r.chunks![0]);
    expect(r.truncated).toBe(false);
    expect(r.settled).toBe(true);
  });

  it('chunkChars:0 returns a single blob', async () => {
    const t = new MockTransport();
    t.handler = () => ({ result: { value: 'b'.repeat(9_000) } });
    const r = await extractAnswer({ transport: t }, { waitUntil: 'now', chunkChars: 0 });
    expect(r.chunks).toBeUndefined();
    expect(r.text).toBe('b'.repeat(9_000));
  });

  it('maxChars safety cap sets truncated (no silent cut)', async () => {
    const t = new MockTransport();
    t.handler = () => ({ result: { value: 'c'.repeat(500) } });
    const r = await extractAnswer({ transport: t }, { waitUntil: 'now', maxChars: 100, chunkChars: 0 });
    expect(r.truncated).toBe(true);
    expect(r.length).toBe(100);
  });

  it('waitUntil:settled waits for the stream to finish (3 phases) and extracts the final text', async () => {
    // Simulated streaming answer: 3 phases, then stable.
    let phase = 0;
    const phases = ['partial ans', 'partial answer with mo', 'partial answer with more — FINAL'];
    const timers = [40, 80, 120].map((ms, i) =>
      setTimeout(() => { phase = i + 1; }, ms),
    );
    const t = new MockTransport();
    t.handler = (method, params) => {
      const expr: string = params?.expression ?? '';
      if (expr.includes('innerText') && expr.includes('#answer') && !expr.includes('cloneNode')) {
        // textSettled read
        return { result: { value: phases[Math.min(phase, phases.length - 1)] } };
      }
      if (expr.includes('aria-busy')) return { result: { value: null } };
      if (expr.includes('cloneNode')) {
        // extraction script → final text
        return { result: { value: phases[phases.length - 1] } };
      }
      return { result: { value: undefined } };
    };
    const r = await extractAnswer({ transport: t }, {
      root: '#answer',
      waitUntil: 'settled',
      stableMs: 60,
      pollMs: 15,
      chunkChars: 0,
    });
    for (const timer of timers) clearTimeout(timer);
    expect(r.settled).toBe(true);
    expect(r.text).toBe('partial answer with more — FINAL');
    // waited at least until the last phase landed
    expect(r.waitedMs).toBeGreaterThanOrEqual(100);
  });

  it('waitUntil:settled on an endless stream extracts anyway with settled:false', async () => {
    let tick = 0;
    const t = new MockTransport();
    t.handler = (method, params) => {
      const expr: string = params?.expression ?? '';
      if (expr.includes('innerText') && expr.includes('#answer') && !expr.includes('cloneNode')) {
        return { result: { value: `growing text ${tick++}` } };
      }
      if (expr.includes('aria-busy')) return { result: { value: null } };
      if (expr.includes('cloneNode')) return { result: { value: 'whatever was there' } };
      return { result: { value: undefined } };
    };
    const r = await extractAnswer({ transport: t }, {
      root: '#answer',
      waitUntil: 'settled',
      stableMs: 60,
      pollMs: 15,
      timeoutMs: 250,
      chunkChars: 0,
    });
    expect(r.settled).toBe(false);
    expect(r.text).toBe('whatever was there');
  });
});
