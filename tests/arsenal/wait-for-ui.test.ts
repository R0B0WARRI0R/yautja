import { describe, it, expect } from 'vitest';
import { waitForUi } from '../../src/arsenal/wait-for-ui.js';
import type { WaitPredicate } from '../../src/arsenal/wait-for-ui.js';

class MockTransport {
  handler: (method: string, params: any) => any = () => ({});
  async send(method: string, params?: any): Promise<any> {
    return this.handler(method, params);
  }
}

/** Transport that resolves Runtime.evaluate by matching expression substrings. */
function transportMatching(rules: Array<[string, () => any]>): MockTransport {
  const t = new MockTransport();
  t.handler = (method, params) => {
    if (method !== 'Runtime.evaluate') return {};
    const expr: string = params?.expression ?? '';
    for (const [substr, fn] of rules) {
      if (expr.includes(substr)) return { result: { value: fn() } };
    }
    return { result: { value: undefined } };
  };
  return t;
}

const FAST = { timeoutMs: 600, pollMs: 15 };

describe('waitForUi', () => {
  it('no predicates → vacuous allOf match with zero elapsed', async () => {
    const t = new MockTransport();
    const r = await waitForUi({ transport: t }, FAST);
    expect(r.matched).toBe('allOf');
    expect(r.elapsedMs).toBeLessThan(50);
  });

  it('selector predicate matches and reports anyOf index', async () => {
    const t = transportMatching([['#ready', () => true]]);
    const r = await waitForUi({ transport: t }, {
      anyOf: [
        { type: 'selector', selector: '#nope' },
        { type: 'selector', selector: '#ready', state: 'visible' },
      ],
      ...FAST,
    });
    expect(r.matched).toBe('anyOf');
    expect(r.which).toBe(1);
  });

  it('urlMatch tests the regex against location.href', async () => {
    const t = transportMatching([['location.href', () => 'https://gemini.google.com/app/chat/123']]);
    const r = await waitForUi({ transport: t }, {
      anyOf: [{ type: 'urlMatch', pattern: 'gemini\\.google\\.com/app' }],
      ...FAST,
    });
    expect(r.matched).toBe('anyOf');
  });

  it('urlMatch with non-matching pattern times out', async () => {
    const t = transportMatching([['location.href', () => 'https://example.com']]);
    const r = await waitForUi({ transport: t }, {
      anyOf: [{ type: 'urlMatch', pattern: 'zzz-no-match' }],
      timeoutMs: 200, pollMs: 15,
    });
    expect(r.matched).toBe('timeout');
    expect(r.elapsedMs).toBeGreaterThanOrEqual(180);
  });

  it('fn predicate: truthy matches, falsy times out', async () => {
    const t = transportMatching([['window.ready === true', () => true]]);
    const ok = await waitForUi({ transport: t }, {
      anyOf: [{ type: 'fn', expression: 'window.ready === true' }],
      ...FAST,
    });
    expect(ok.matched).toBe('anyOf');

    const t2 = transportMatching([['window.ready === true', () => false]]);
    const no = await waitForUi({ transport: t2 }, {
      anyOf: [{ type: 'fn', expression: 'window.ready === true' }],
      timeoutMs: 150, pollMs: 15,
    });
    expect(no.matched).toBe('timeout');
  });

  it('allOf requires every predicate', async () => {
    const t = transportMatching([
      ['#a', () => true],
      ['#b', () => false],
    ]);
    const r = await waitForUi({ transport: t }, {
      allOf: [
        { type: 'selector', selector: '#a' },
        { type: 'selector', selector: '#b' },
      ],
      timeoutMs: 150, pollMs: 15,
    });
    expect(r.matched).toBe('timeout');
  });

  it('ariaBusy value:false matches when nothing is busy', async () => {
    const t = transportMatching([['aria-busy', () => ({ rootBusy: null, descendantBusy: false })]]);
    const r = await waitForUi({ transport: t }, {
      anyOf: [{ type: 'ariaBusy', value: false }],
      ...FAST,
    });
    expect(r.matched).toBe('anyOf');
  });

  it('ariaBusy value:false does not match while a descendant is busy', async () => {
    const t = transportMatching([['aria-busy', () => ({ rootBusy: null, descendantBusy: true })]]);
    const r = await waitForUi({ transport: t }, {
      anyOf: [{ type: 'ariaBusy', value: false }],
      timeoutMs: 150, pollMs: 15,
    });
    expect(r.matched).toBe('timeout');
  });

  it('noPulse fails while .animate-pulse exists, matches when gone', async () => {
    const t = transportMatching([['animate-pulse', () => false]]);
    const r = await waitForUi({ transport: t }, {
      anyOf: [{ type: 'noPulse' }],
      timeoutMs: 150, pollMs: 15,
    });
    expect(r.matched).toBe('timeout');

    const t2 = transportMatching([['animate-pulse', () => true]]);
    const r2 = await waitForUi({ transport: t2 }, {
      anyOf: [{ type: 'noPulse' }],
      ...FAST,
    });
    expect(r2.matched).toBe('anyOf');
  });

  it('textSettled does NOT fire mid-stream, fires after appends stop', async () => {
    // Simulated stream: append every 30ms, 5 rounds, then stop.
    let text = '';
    const started = Date.now();
    let lastAppendAt = started;
    const interval = setInterval(() => {
      text += 'chunk ';
      lastAppendAt = Date.now();
    }, 30);
    setTimeout(() => clearInterval(interval), 150);

    const t = transportMatching([['#answer', () => text]]);
    const r = await waitForUi({ transport: t }, {
      anyOf: [{ type: 'textSettled', selector: '#answer', stableMs: 80 }],
      timeoutMs: 3000, pollMs: 15,
    });
    expect(r.matched).toBe('anyOf');
    // Matched only after the stream stopped + stableMs
    const matchedAt = started + r.elapsedMs;
    expect(matchedAt).toBeGreaterThanOrEqual(lastAppendAt + 70);
    // And definitely not during the streaming phase (~150ms)
    expect(r.elapsedMs).toBeGreaterThan(150);
  });

  it('textSettled never matches on empty text (stream not started)', async () => {
    const t = transportMatching([['#answer', () => '']]);
    const r = await waitForUi({ transport: t }, {
      anyOf: [{ type: 'textSettled', selector: '#answer', stableMs: 50 }],
      timeoutMs: 200, pollMs: 15,
    });
    expect(r.matched).toBe('timeout');
  });

  it('textSettled respects minLength', async () => {
    const t = transportMatching([['#answer', () => 'ab']]);
    const r = await waitForUi({ transport: t }, {
      anyOf: [{ type: 'textSettled', selector: '#answer', stableMs: 40, minLength: 10 }],
      timeoutMs: 200, pollMs: 15,
    });
    expect(r.matched).toBe('timeout');
  });

  it('networkIdle with provider: matches after pending stays 0 for quietMs', async () => {
    const counts = [3, 2, 1, 0];
    let i = 0;
    const getPendingRequests = () => (i < counts.length ? counts[i++]! : 0);
    const t = new MockTransport();
    const r = await waitForUi({ transport: t, getPendingRequests }, {
      anyOf: [{ type: 'networkIdle', quietMs: 60 }],
      timeoutMs: 2000, pollMs: 15,
    });
    expect(r.matched).toBe('anyOf');
    expect(r.elapsedMs).toBeGreaterThanOrEqual(50);
  });

  it('networkIdle without provider degrades to a quiet sleep', async () => {
    const t = new MockTransport();
    const r = await waitForUi({ transport: t }, {
      anyOf: [{ type: 'networkIdle', quietMs: 60 }],
      timeoutMs: 2000, pollMs: 15,
    });
    expect(r.matched).toBe('anyOf');
    expect(r.elapsedMs).toBeGreaterThanOrEqual(50);
  });

  it('timeout predicate in anyOf fires after its ms', async () => {
    const t = new MockTransport();
    const r = await waitForUi({ transport: t }, {
      anyOf: [
        { type: 'fn', expression: 'false' },
        { type: 'timeout', ms: 100 },
      ],
      timeoutMs: 2000, pollMs: 15,
    });
    expect(r.matched).toBe('anyOf');
    expect(r.which).toBe(1);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(90);
  });

  it('submitState idle matches when aria-label signal matches', async () => {
    const t = transportMatching([['document.querySelector', () => ({ found: true, ariaLabel: 'Enviar', innerHTML: '', className: 'reset', disabled: true })]]);
    const r = await waitForUi({ transport: t }, {
      anyOf: [{ type: 'submitState', selector: 'button[aria-label="Enviar"]', state: 'idle', signals: [{ kind: 'ariaLabel', value: 'Enviar' }] }],
      ...FAST,
    });
    expect(r.matched).toBe('anyOf');
  });

  it('submitState idle does not match while button shows streaming label', async () => {
    const t = transportMatching([['document.querySelector', () => ({ found: true, ariaLabel: 'Pausar', innerHTML: '', className: 'reset', disabled: false })]]);
    const r = await waitForUi({ transport: t }, {
      anyOf: [{ type: 'submitState', selector: 'button[aria-label="Enviar"], button[aria-label="Pausar"]', state: 'idle', signals: [{ kind: 'ariaLabel', value: 'Enviar' }] }],
      timeoutMs: 150, pollMs: 15,
    });
    expect(r.matched).toBe('timeout');
  });

  it('submitState streaming matches via iconContains signal', async () => {
    const t = transportMatching([['document.querySelector', () => ({ found: true, ariaLabel: 'Pausar', innerHTML: '<svg class="pause-icon"></svg>', className: 'reset', disabled: false })]]);
    const r = await waitForUi({ transport: t }, {
      anyOf: [{ type: 'submitState', selector: 'button[aria-label="Pausar"]', state: 'streaming', signals: [{ kind: 'iconContains', value: 'pause-icon' }] }],
      ...FAST,
    });
    expect(r.matched).toBe('anyOf');
  });

  it('submitState never matches when the button is absent', async () => {
    const t = transportMatching([['document.querySelector', () => ({ found: false })]]);
    const r = await waitForUi({ transport: t }, {
      anyOf: [{ type: 'submitState', selector: '#no-such-button', state: 'idle', signals: [{ kind: 'ariaLabel', value: 'Enviar' }] }],
      timeoutMs: 150, pollMs: 15,
    });
    expect(r.matched).toBe('timeout');
  });

  it('submitState signals are OR-ed: one match wins', async () => {
    const t = transportMatching([['document.querySelector', () => ({ found: true, ariaLabel: 'Enviar', innerHTML: '', className: 'reset stream-btn', disabled: true })]]);
    const r = await waitForUi({ transport: t }, {
      anyOf: [{ type: 'submitState', selector: 'button', state: 'idle', signals: [{ kind: 'iconContains', value: 'zzz' }, { kind: 'classContains', value: 'stream-btn' }] }],
      ...FAST,
    });
    expect(r.matched).toBe('anyOf');
  });

  it('submitState disabled signal requires the exact flag value', async () => {
    const t = transportMatching([['document.querySelector', () => ({ found: true, ariaLabel: 'Enviar', innerHTML: '', className: '', disabled: false })]]);
    const r = await waitForUi({ transport: t }, {
      anyOf: [{ type: 'submitState', selector: 'button', state: 'idle', signals: [{ kind: 'disabled', value: true }] }],
      timeoutMs: 150, pollMs: 15,
    });
    expect(r.matched).toBe('timeout');
  });

  it('streamSettled installs the observer once, then matches on the page flag', async () => {
    let installs = 0;
    const t = new MockTransport();
    t.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {};
      const expr: string = params?.expression ?? '';
      if (expr.includes('MutationObserver')) {
        installs++;
        return { result: { value: { armed: false, done: false, textLength: 0 } } };
      }
      if (expr.includes('const s = window.__yautjaStream')) {
        return { result: { value: { armed: true, done: true, textLength: 512 } } };
      }
      return { result: { value: undefined } };
    };
    const r = await waitForUi({ transport: t }, {
      anyOf: [{ type: 'streamSettled', selector: '#answer', silenceMs: 400 }],
      ...FAST,
    });
    expect(r.matched).toBe('anyOf');
    expect(installs).toBe(1);
  });

  it('streamSettled does not match while the page flag reports done:false', async () => {
    const t = transportMatching([['MutationObserver', () => ({ armed: false, done: false, textLength: 0 })], ['const s = window.__yautjaStream', () => ({ armed: true, done: false, textLength: 128 })]]);
    const r = await waitForUi({ transport: t }, {
      anyOf: [{ type: 'streamSettled', selector: '#answer', silenceMs: 300, minLength: 10 }],
      timeoutMs: 150, pollMs: 15,
    });
    expect(r.matched).toBe('timeout');
  });

  it('streamSettled retries installation while the page is not ready', async () => {
    const t = transportMatching([['MutationObserver', () => undefined]]);
    const r = await waitForUi({ transport: t }, {
      anyOf: [{ type: 'streamSettled', selector: '#answer', silenceMs: 200 }],
      timeoutMs: 150, pollMs: 15,
    });
    expect(r.matched).toBe('timeout');
  });
});
