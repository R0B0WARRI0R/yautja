import { describe, it, expect } from 'vitest';
import { ensureEmpty, buildEnsureEmptyScript } from '../../src/arsenal/ensure-empty.js';

class MockTransport {
  calls: { method: string; params: any }[] = [];
  responder: (method: string, params: any) => any = () => ({});
  async send(method: string, params?: any): Promise<any> {
    this.calls.push({ method, params });
    return this.responder(method, params);
  }
}

// ─── Fake DOM to execute the real script ──────────────────────

function makeFakeDocument(el: any) {
  const document: any = {
    activeElement: null,
    querySelector: (_sel: string) => el,
    createRange: () => ({ selectNodeContents: (_e: any) => {} }),
    execCommand: (_cmd: string) => document._execCommand(_cmd),
    _execCommand: (_cmd: string) => true,
  };
  const window: any = {
    getSelection: () => ({ removeAllRanges: () => {}, addRange: (_r: any) => {} }),
  };
  return { document, window };
}

class FakeInputEvent {
  type: string;
  opts: any;
  constructor(type: string, opts?: any) { this.type = type; this.opts = opts; }
}
class FakeEvent {
  type: string;
  opts: any;
  constructor(type: string, opts?: any) { this.type = type; this.opts = opts; }
}

function runScript(script: string, el: any, execDelete: (el: any) => boolean, extra: any = {}) {
  const { document, window } = makeFakeDocument(el);
  document._execCommand = (cmd: string) => (cmd === 'delete' ? execDelete(el) : true);
  const fn = new Function(
    'document', 'window', 'InputEvent', 'Event', 'HTMLInputElement', 'HTMLTextAreaElement',
    `return (${script});`,
  );
  return JSON.parse(
    fn(document, window, FakeInputEvent, FakeEvent, extra.HTMLInputElement, extra.HTMLTextAreaElement),
  );
}

function makeCEEl(text: string) {
  // Linked accessors: like the real DOM, clearing innerHTML also clears
  // innerText/textContent (they all reflect the same content).
  const state = { t: text };
  const el: any = {
    isContentEditable: true,
    getAttribute: (a: string) => (a === 'contenteditable' ? 'true' : null),
    focus: () => {},
    dispatchEvent: () => true,
  };
  for (const prop of ['innerText', 'textContent', 'innerHTML']) {
    Object.defineProperty(el, prop, {
      get: () => state.t,
      set: (v: string) => { state.t = v; },
    });
  }
  return el;
}

class FakeHTMLInputElement {
  isContentEditable = false;
  textContent = '';
  private _value: string;
  constructor(initial: string) { this._value = initial; }
  get value() { return this._value; }
  set value(v: string) { this._value = v; }
  focus() {}
  select() {}
  getAttribute() { return null; }
  dispatchEvent() { return true; }
}

describe('ensureEmpty — script against fake DOM', () => {
  it('clean element: wasClean true, no strategy used', () => {
    const el = makeCEEl('');
    const out = runScript(buildEnsureEmptyScript('#box', 'auto'), el, () => true);
    expect(out).toMatchObject({ found: true, wasClean: true, afterClean: true, strategyUsed: 'none', residual: '' });
  });

  it('dirty contenteditable: execCommand delete cleans it (React-like chat box)', () => {
    const el = makeCEEl('residual prompt');
    const out = runScript(buildEnsureEmptyScript('#box', 'auto'), el, (e) => {
      e.innerText = ''; e.textContent = ''; e.innerHTML = '';
      return true;
    });
    expect(out.wasClean).toBe(false);
    expect(out.afterClean).toBe(true);
    expect(out.strategyUsed).toBe('execCommand');
    expect(out.residual).toBe('residual prompt');
  });

  it('stubborn contenteditable (Angular-like re-render): falls back to force', () => {
    const el = makeCEEl('sticky text');
    // execCommand delete does NOT clear (framework re-renders)
    const out = runScript(buildEnsureEmptyScript('#box', 'auto'), el, () => true);
    expect(out.afterClean).toBe(true);
    expect(out.strategyUsed).toBe('force');
    expect(el.innerHTML).toBe('');
  });

  it('execCommand strategy only: reports afterClean false when delete fails, no force fallback', () => {
    const el = makeCEEl('sticky');
    const out = runScript(buildEnsureEmptyScript('#box', 'execCommand'), el, () => true);
    expect(out.afterClean).toBe(false);
    expect(out.strategyUsed).toBe('execCommand');
  });

  it('input with React-controlled value: force uses the native value setter', () => {
    const el = new FakeHTMLInputElement('react value');
    // execCommand delete does nothing to a controlled input
    const out = runScript(buildEnsureEmptyScript('#inp', 'auto'), el, () => true, { HTMLInputElement: FakeHTMLInputElement });
    expect(out.afterClean).toBe(true);
    expect(out.strategyUsed).toBe('force');
    expect(el.value).toBe('');
  });

  it('missing element: found false', () => {
    const out = runScript(buildEnsureEmptyScript('#nope', 'auto'), null, () => true);
    expect(out.found).toBe(false);
  });

  it('password input: residual is redacted in-page and flagged sensitive', () => {
    const el: any = new FakeHTMLInputElement('s3cret-pw');
    el.type = 'password';
    const out = runScript(buildEnsureEmptyScript('#pw', 'auto'), el, (e) => { e.value = ''; return true; }, { HTMLInputElement: FakeHTMLInputElement });
    expect(out.sensitive).toBe(true);
    expect(out.residual).toBe('[value redacted]');
    expect(out.residual).not.toContain('s3cret');
    expect(out.afterClean).toBe(true);
  });

  it('autocomplete=cc-number input: residual is redacted', () => {
    const el: any = new FakeHTMLInputElement('4111 1111 1111 1111');
    el.type = 'text';
    el.getAttribute = (a: string) => (a === 'autocomplete' ? 'cc-number' : null);
    const out = runScript(buildEnsureEmptyScript('#cc', 'auto'), el, (e) => { e.value = ''; return true; }, { HTMLInputElement: FakeHTMLInputElement });
    expect(out.sensitive).toBe(true);
    expect(out.residual).toBe('[value redacted]');
  });

  it('non-sensitive input: residual stays in clear and sensitive is false', () => {
    const el: any = new FakeHTMLInputElement('public text');
    el.type = 'text';
    const out = runScript(buildEnsureEmptyScript('#q', 'auto'), el, (e) => { e.value = ''; return true; }, { HTMLInputElement: FakeHTMLInputElement });
    expect(out.sensitive).toBe(false);
    expect(out.residual).toBe('public text');
  });
});

describe('ensureEmpty — transport wrapper', () => {
  it('sends Runtime.evaluate with the selector and strategy embedded', async () => {
    const t = new MockTransport();
    t.responder = () => ({ result: { value: JSON.stringify({ found: true, wasClean: true, afterClean: true, strategyUsed: 'none', residual: '' }) } });
    const r = await ensureEmpty(t as any, '#editor', 'force');
    expect(t.calls[0]!.method).toBe('Runtime.evaluate');
    expect(t.calls[0]!.params.expression).toContain('#editor');
    expect(t.calls[0]!.params.expression).toContain('"force"');
    expect(r).toMatchObject({ found: true, wasClean: true, afterClean: true, selectorResolved: '#editor' });
  });

  it('parses the script result into EnsureEmptyResult', async () => {
    const t = new MockTransport();
    t.responder = () => ({ result: { value: JSON.stringify({ found: true, wasClean: false, afterClean: true, strategyUsed: 'execCommand', residual: 'abc' }) } });
    const r = await ensureEmpty(t as any, '#x');
    expect(r).toEqual({ found: true, wasClean: false, afterClean: true, strategyUsed: 'execCommand', selectorResolved: '#x', residual: 'abc' });
  });

  it('returns found:false on empty/malformed transport responses', async () => {
    const t = new MockTransport();
    t.responder = () => ({ result: {} });
    expect((await ensureEmpty(t as any, '#x')).found).toBe(false);
    t.responder = () => ({ result: { value: 'not json{{' } });
    expect((await ensureEmpty(t as any, '#x')).found).toBe(false);
    t.responder = () => ({});
    expect((await ensureEmpty(t as any, '#x')).found).toBe(false);
  });

  it('redacts residual in TS when the script flags sensitive (belt-and-braces)', async () => {
    const t = new MockTransport();
    // Even if an old injected script leaked the raw residual with the flag,
    // the TS boundary must redact it.
    t.responder = () => ({ result: { value: JSON.stringify({ found: true, wasClean: false, afterClean: true, strategyUsed: 'execCommand', residual: 's3cret-pw', sensitive: true }) } });
    const r = await ensureEmpty(t as any, '#pw');
    expect(r.residual).toBe('[value redacted]');
  });

  it('keeps residual in clear when sensitive flag is absent/false', async () => {
    const t = new MockTransport();
    t.responder = () => ({ result: { value: JSON.stringify({ found: true, wasClean: false, afterClean: true, strategyUsed: 'execCommand', residual: 'public', sensitive: false }) } });
    expect((await ensureEmpty(t as any, '#q')).residual).toBe('public');
    t.responder = () => ({ result: { value: JSON.stringify({ found: true, wasClean: false, afterClean: true, strategyUsed: 'execCommand', residual: 'legacy' }) } });
    expect((await ensureEmpty(t as any, '#q')).residual).toBe('legacy');
  });
});
