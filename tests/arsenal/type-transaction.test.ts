import { describe, it, expect, beforeEach } from 'vitest';
import { runTypeTransaction, STEALTH_CHAR_LIMIT } from '../../src/arsenal/type-transaction.js';
import { InputSessionMemory } from '../../src/memory/input-session.js';

class MockTransport {
  calls: { method: string; params: any }[] = [];
  responder: (method: string, params: any) => any = () => ({});
  async send(method: string, params?: any): Promise<any> {
    this.calls.push({ method, params });
    return this.responder(method, params);
  }
  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
  countExpr(substr: string): number {
    return this.calls.filter((c) => (c.params?.expression ?? '').includes(substr)).length;
  }
}

/** Simulated page: a single input whose value behaves like a real chat box. */
function makePage(opts: { initial?: string; clearOnSubmit?: boolean; corruptType?: boolean; notFound?: boolean; notClearable?: boolean } = {}) {
  const state = {
    value: opts.initial ?? '',
    submitted: false,
    clearOnSubmit: opts.clearOnSubmit ?? true,
    corruptType: opts.corruptType ?? false,
  };
  const responder = (method: string, params: any): any => {
    const expr: string = params?.expression ?? '';
    if (method === 'Runtime.evaluate' && expr.includes('strategyUsed')) {
      // ensureEmpty script
      if (opts.notFound) return { result: { value: JSON.stringify({ found: false }) } };
      const wasClean = state.value.trim() === '';
      const afterClean = opts.notClearable ? false : true;
      if (afterClean) state.value = '';
      return { result: { value: JSON.stringify({ found: true, wasClean, afterClean, strategyUsed: wasClean ? 'none' : 'execCommand', residual: wasClean ? '' : 'junk' }) } };
    }
    if (method === 'Runtime.evaluate' && expr.includes('activeElement')) {
      return { result: { value: true } };
    }
    if (method === 'Runtime.evaluate' && expr.includes("execCommand('insertText'")) {
      const m = expr.match(/insertText', false, ("(?:[^"\\]|\\.)*")\)/);
      state.value = state.corruptType ? '###partial###' : m ? JSON.parse(m[1]) : '';
      return { result: { value: 'ok' } };
    }
    if (method === 'Runtime.evaluate' && expr.includes('KeyboardEvent')) {
      state.submitted = true;
      if (state.clearOnSubmit) state.value = '';
      return { result: { value: true } };
    }
    if (method === 'Runtime.evaluate') {
      return { result: { value: state.value } };
    }
    if (method === 'Input.insertText') {
      state.value = state.corruptType ? '###partial###' : params.text;
      return {};
    }
    if (method === 'Input.dispatchKeyEvent') {
      if (params.key === 'Enter') {
        if (params.type === 'keyDown') {
          state.submitted = true;
          if (state.clearOnSubmit) state.value = '';
        }
      } else if (params.text && params.type === 'keyDown') {
        state.value += params.text;
      }
      return {};
    }
    return {};
  };
  return { state, responder };
}

const SEL = '#prompt-box';

function baseOpts(overrides: Record<string, any> = {}) {
  return {
    selector: SEL,
    text: 'hello world',
    submit: true,
    stealth: false,
    transactional: true,
    verify: true,
    clearFirst: true,
    onPartial: 'rollback' as const,
    isContentEditable: false,
    ...overrides,
  };
}

describe('runTypeTransaction', () => {
  let transport: MockTransport;
  let inputSession: InputSessionMemory;

  beforeEach(() => {
    transport = new MockTransport();
    inputSession = new InputSessionMemory();
  });

  function setup(pageOpts?: Parameters<typeof makePage>[0]) {
    const page = makePage(pageOpts);
    transport.responder = page.responder;
    return page.state;
  }

  async function run(opts: Record<string, any> = {}) {
    return runTypeTransaction({ transport, inputSession, tabId: 1 }, baseOpts(opts));
  }

  it('happy path input: clean → insert → verify → submit → commit', async () => {
    setup();
    const r = await run();
    expect('value' in r).toBe(true);
    if ('value' in r) {
      expect(r.value).toMatchObject({ typed: true, verified: true, submitted: true, rolledBack: false, stealthUsed: false, cleaned: false });
    }
    // commit lifts any previous block
    expect(inputSession.isBlocked(1, SEL)).toBe(false);
  });

  it('long text uses one-shot insertText even with stealth on (r2 hybrid)', async () => {
    setup();
    const longText = 'x'.repeat(STEALTH_CHAR_LIMIT + 50);
    const r = await run({ text: longText, stealth: true });
    expect('value' in r && r.value.stealthUsed).toBe(false);
    expect(transport.count('Input.insertText')).toBe(1);
    const call = transport.calls.find((c) => c.method === 'Input.insertText');
    expect(call!.params.text).toBe(longText);
  });

  it('short text with stealth uses per-char key events with the full text', async () => {
    setup();
    const r = await run({ text: 'hi', stealth: true });
    expect('value' in r && r.value.stealthUsed).toBe(true);
    expect(transport.count('Input.insertText')).toBe(0);
    // 2 events per char + 2 for Enter
    expect(transport.count('Input.dispatchKeyEvent')).toBe(2 * 2 + 2);
  });

  it('contenteditable: execCommand insertText + page KeyboardEvent submit, never stealth', async () => {
    const state = setup();
    const r = await run({ isContentEditable: true, stealth: true, text: 'prompt for gemini' });
    expect('value' in r && r.value.verified).toBe(true);
    expect('value' in r && r.value.stealthUsed).toBe(false);
    expect(transport.countExpr("execCommand('insertText'")).toBe(1);
    expect(transport.countExpr('KeyboardEvent')).toBe(1);
    expect(state.submitted).toBe(true);
  });

  it('cleans residual content before typing (cleaned: true)', async () => {
    setup({ initial: 'previous draft' });
    const r = await run();
    expect('value' in r && r.value.cleaned).toBe(true);
  });

  it('partial type + onPartial=rollback: rolls back and returns TYPE_PARTIAL, then blocks blind retry', async () => {
    setup({ corruptType: true });
    const r = await run();
    expect('error' in r && r.error.code).toBe('YJ.ACT.TYPE_PARTIAL');
    // rollback ran a second ensureEmpty
    expect(transport.countExpr('strategyUsed')).toBe(2);
    expect(inputSession.isBlocked(1, SEL)).toBe(true);

    // blind retry without clearFirst → TYPE_RETRY_BLOCKED
    const r2 = await run({ clearFirst: false });
    expect('error' in r2 && r2.error.code).toBe('YJ.ACT.TYPE_RETRY_BLOCKED');
  });

  it('retry with clearFirst (default) is allowed despite a recent partial — doctrine retry loop works', async () => {
    setup({ corruptType: true });
    await run();
    expect(inputSession.isBlocked(1, SEL)).toBe(true);
    // same call again with clearFirst on → not blocked by the anti-retry rule
    const r2 = await run();
    expect('error' in r2 && r2.error.code).toBe('YJ.ACT.TYPE_PARTIAL'); // still corrupt, but NOT retry-blocked
  });

  it('onPartial=leave: reports verified:false and still submits', async () => {
    setup({ corruptType: true });
    const r = await run({ onPartial: 'leave' });
    expect('value' in r).toBe(true);
    if ('value' in r) {
      expect(r.value.verified).toBe(false);
      expect(r.value.submitted).toBe(true);
    }
  });

  it('onPartial=error: fails without running a rollback clean', async () => {
    setup({ corruptType: true });
    const r = await run({ onPartial: 'error' });
    expect('error' in r && r.error.code).toBe('YJ.ACT.TYPE_PARTIAL');
    expect(transport.countExpr('strategyUsed')).toBe(1); // only the preflight clean
  });

  it('element not found during preflight → DOM_TARGET_NOT_FOUND', async () => {
    setup({ notFound: true });
    const r = await run();
    expect('error' in r && r.error.code).toBe('YJ.ACT.DOM_TARGET_NOT_FOUND');
  });

  it('input not clearable → INPUT_NOT_CLEARABLE and records the failure', async () => {
    setup({ notClearable: true, initial: 'sticky' });
    const r = await run();
    expect('error' in r && r.error.code).toBe('YJ.ACT.INPUT_NOT_CLEARABLE');
    expect(inputSession.lastFailure(1, SEL)?.code).toBe('YJ.ACT.INPUT_NOT_CLEARABLE');
  });

  it('element that rejects typing → TYPE_REJECTED', async () => {
    setup();
    transport.responder = ((orig) => (method: string, params: any) => {
      const expr: string = params?.expression ?? '';
      if (method === 'Runtime.evaluate' && expr.includes('activeElement')) return { result: { value: false } };
      return orig(method, params);
    })(transport.responder);
    const r = await run();
    expect('error' in r && r.error.code).toBe('YJ.ACT.TYPE_REJECTED');
  });

  it('submit that leaves the text untouched → SUBMIT_NO_EFFECT', async () => {
    setup({ clearOnSubmit: false });
    const r = await run();
    expect('error' in r && r.error.code).toBe('YJ.ACT.SUBMIT_NO_EFFECT');
  });

  it('successful commit after a failure lifts the retry block', async () => {
    setup({ corruptType: true });
    await run();
    expect(inputSession.isBlocked(1, SEL)).toBe(true);
    // fix the page, retry with clearFirst
    setup({ corruptType: false });
    const r2 = await run();
    expect('value' in r2).toBe(true);
    expect(inputSession.isBlocked(1, SEL)).toBe(false);
  });
});
