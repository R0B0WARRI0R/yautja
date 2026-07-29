import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ActionTranslator } from '../../src/arsenal/translator.js';
import type { Transport } from '../../src/vision/base-sensor.js';
import type { BrowserAction } from '../../src/arsenal/action-types.js';
import { makeError, arsenalToDoctrine } from '../../src/arsenal/errors.js';

class MockTransport implements Transport {
  handlers: Map<string, ((params: any) => void)[]> = new Map();
  sendResponses: Map<string, any> = new Map();
  defaultSendResponse: any = {};
  sendCalls: { method: string; params?: any }[] = [];

  on(event: string, handler: (params: any) => void): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(handler);
    return () => {
      const arr = this.handlers.get(event);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
  }

  async send(method: string, params?: Record<string, any>): Promise<any> {
    this.sendCalls.push({ method, params });
    if (this.sendResponses.has(method)) return this.sendResponses.get(method);
    return this.defaultSendResponse;
  }

  setSendResponse(method: string, response: any): void {
    this.sendResponses.set(method, response);
  }

  sendCallCount(): number {
    return this.sendCalls.length;
  }

  sendCallsFor(method: string): number {
    return this.sendCalls.filter((c) => c.method === method).length;
  }

  callsFor(method: string): { method: string; params?: any }[] {
    return this.sendCalls.filter((c) => c.method === method);
  }

  reset(): void {
    this.sendCalls = [];
    this.sendResponses.clear();
  }
}

describe('ActionTranslator', () => {
  let transport: MockTransport;
  let translator: ActionTranslator;

  beforeEach(() => {
    transport = new MockTransport();
    translator = new ActionTranslator(transport);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('navigation', () => {
    it('navigate sends Page.navigate', async () => {
      transport.setSendResponse('DOM.getDocument', { root: { nodeId: 1 } });
      const r = await translator.execute({ type: 'navigate', url: 'https://example.com' });
      expect(r.ok).toBe(true);
      const navCall = transport.callsFor('Page.navigate');
      expect(navCall.length).toBeGreaterThanOrEqual(1);
      expect(navCall[0]?.params?.url).toBe('https://example.com');
    });

    it('reload sends Page.reload with ignoreCache', async () => {
      const r = await translator.execute({ type: 'reload', ignoreCache: true });
      expect(r.ok).toBe(true);
      const calls = transport.callsFor('Page.reload');
      expect(calls.length).toBe(1);
      expect(calls[0]?.params?.ignoreCache).toBe(true);
    });

    it('reload defaults ignoreCache to false', async () => {
      const r = await translator.execute({ type: 'reload' });
      expect(r.ok).toBe(true);
      const calls = transport.callsFor('Page.reload');
      expect(calls[0]?.params?.ignoreCache).toBe(false);
    });

    it('goForward sends history.forward()', async () => {
      const r = await translator.execute({ type: 'goForward' });
      expect(r.ok).toBe(true);
      const calls = transport.callsFor('Runtime.evaluate');
      expect(calls.length).toBe(1);
      expect(calls[0]?.params?.expression).toBe('history.forward()');
    });

    it('goBack sends history.back()', async () => {
      const r = await translator.execute({ type: 'goBack' });
      expect(r.ok).toBe(true);
      const evals = transport.callsFor('Runtime.evaluate');
      expect(evals.some((c) => c.params?.expression === 'history.back()')).toBe(true);
    });
  });

  describe('click / doubleClick', () => {
    it('click returns SELECTOR_NOT_FOUND when element missing', async () => {
      transport.setSendResponse('DOM.getDocument', { root: { nodeId: 1 } });
      transport.setSendResponse('DOM.querySelector', { nodeId: 0 });
      const r = await translator.execute({ type: 'click', selector: '#missing' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.type).toBe('SELECTOR_NOT_FOUND');
        expect(r.error.message).toContain('#missing');
        expect(r.error.recoveryHint).toContain('findElement');
        expect(r.error.hint).toBe(r.error.recoveryHint);
      }
    });

    it('click sends DOM.focus + mousePressed + mouseReleased when found', async () => {
      transport.setSendResponse('DOM.getDocument', { root: { nodeId: 1 } });
      transport.setSendResponse('DOM.querySelector', { nodeId: 42 });
      const r = await translator.execute({ type: 'click', selector: '#btn' });
      expect(r.ok).toBe(true);
      expect(transport.callsFor('DOM.focus').length).toBe(1);
      expect(transport.callsFor('Input.dispatchMouseEvent').length).toBe(2);
      const focusCall = transport.callsFor('DOM.focus')[0];
      expect(focusCall?.params?.nodeId).toBe(42);
    });

    it('doubleClick sends two mouse pressed/released pairs', async () => {
      transport.setSendResponse('DOM.getDocument', { root: { nodeId: 1 } });
      transport.setSendResponse('DOM.querySelector', { nodeId: 42 });
      const r = await translator.execute({ type: 'doubleClick', selector: '#btn' });
      expect(r.ok).toBe(true);
      expect(transport.callsFor('Input.dispatchMouseEvent').length).toBe(4);
    });

    it('click respects clickCount', async () => {
      transport.setSendResponse('DOM.getDocument', { root: { nodeId: 1 } });
      transport.setSendResponse('DOM.querySelector', { nodeId: 42 });
      const r = await translator.execute({ type: 'click', selector: '#btn', clickCount: 3 });
      expect(r.ok).toBe(true);
      expect(transport.callsFor('Input.dispatchMouseEvent').length).toBe(6);
    });
  });

  describe('hover / focus', () => {
    it('hover returns SELECTOR_NOT_FOUND when missing', async () => {
      transport.setSendResponse('DOM.getDocument', { root: { nodeId: 1 } });
      transport.setSendResponse('DOM.querySelector', { nodeId: 0 });
      const r = await translator.execute({ type: 'hover', selector: '#missing' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.type).toBe('SELECTOR_NOT_FOUND');
    });

    it('hover sends DOM.focus when found', async () => {
      transport.setSendResponse('DOM.getDocument', { root: { nodeId: 1 } });
      transport.setSendResponse('DOM.querySelector', { nodeId: 7 });
      const r = await translator.execute({ type: 'hover', selector: '#x' });
      expect(r.ok).toBe(true);
      expect(transport.callsFor('DOM.focus').length).toBe(1);
    });

    it('focus returns SELECTOR_NOT_FOUND when missing', async () => {
      transport.setSendResponse('DOM.getDocument', { root: { nodeId: 1 } });
      transport.setSendResponse('DOM.querySelector', { nodeId: 0 });
      const r = await translator.execute({ type: 'focus', selector: '#missing' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.type).toBe('SELECTOR_NOT_FOUND');
    });

    it('focus sends DOM.focus when found', async () => {
      transport.setSendResponse('DOM.getDocument', { root: { nodeId: 1 } });
      transport.setSendResponse('DOM.querySelector', { nodeId: 9 });
      const r = await translator.execute({ type: 'focus', selector: '#x' });
      expect(r.ok).toBe(true);
      const c = transport.callsFor('DOM.focus');
      expect(c[0]?.params?.nodeId).toBe(9);
    });
  });

  describe('type', () => {
    it('clears first when clearFirst=true', async () => {
      transport.setSendResponse('DOM.getDocument', { root: { nodeId: 1 } });
      transport.setSendResponse('DOM.querySelector', { nodeId: 5 });
      const r = await translator.execute({ type: 'type', selector: '#inp', text: 'hi', clearFirst: true });
      expect(r.ok).toBe(true);
      const evals = transport.callsFor('Runtime.evaluate');
      expect(evals.length).toBeGreaterThanOrEqual(1);
      expect(evals[0]?.params?.expression).toContain('el.value=');
    });

    it('sends Input.insertText per character', async () => {
      transport.setSendResponse('DOM.getDocument', { root: { nodeId: 1 } });
      transport.setSendResponse('DOM.querySelector', { nodeId: 5 });
      const r = await translator.execute({ type: 'type', selector: '#inp', text: 'abc' });
      expect(r.ok).toBe(true);
      const inserts = transport.callsFor('Input.insertText');
      expect(inserts.length).toBe(3);
      expect(inserts[0]?.params?.text).toBe('a');
      expect(inserts[1]?.params?.text).toBe('b');
      expect(inserts[2]?.params?.text).toBe('c');
    });

    it('returns SELECTOR_NOT_FOUND when selector missing', async () => {
      transport.setSendResponse('DOM.getDocument', { root: { nodeId: 1 } });
      transport.setSendResponse('DOM.querySelector', { nodeId: 0 });
      const r = await translator.execute({ type: 'type', selector: '#missing', text: 'x' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.type).toBe('SELECTOR_NOT_FOUND');
    });
  });

  describe('press', () => {
    it('sends rawKeyDown + keyUp for Enter with no modifiers', async () => {
      const r = await translator.execute({ type: 'press', key: 'Enter' });
      expect(r.ok).toBe(true);
      const calls = transport.callsFor('Input.dispatchKeyEvent');
      expect(calls.length).toBe(2);
      expect(calls[0]?.params?.type).toBe('rawKeyDown');
      expect(calls[0]?.params?.key).toBe('Enter');
      expect(calls[0]?.params?.code).toBe('Enter');
      expect(calls[0]?.params?.windowsVirtualKeyCode).toBe(13);
      expect(calls[0]?.params?.modifiers).toBe(0);
      expect(calls[1]?.params?.type).toBe('keyUp');
    });

    it('combines modifiers (Ctrl+Shift) with CDP bitfield Alt=1 Ctrl=2 Meta=4 Shift=8', async () => {
      const r = await translator.execute({
        type: 'press',
        key: 'a',
        modifiers: { ctrl: true, shift: true },
      });
      expect(r.ok).toBe(true);
      const calls = transport.callsFor('Input.dispatchKeyEvent');
      // keyDown(Control) → keyDown(Shift) → rawKeyDown(a) → keyUp(a) → keyUp(Shift) → keyUp(Control)
      expect(calls.length).toBe(6);
      expect(calls[0]?.params?.key).toBe('Control');
      expect(calls[0]?.params?.modifiers).toBe(2);
      const mainDown = calls.find((c) => c.params?.key === 'a' && c.params?.type === 'rawKeyDown');
      expect(mainDown?.params?.modifiers).toBe(10);
      expect(mainDown?.params?.text).toBeUndefined();
    });

    it('Alt alone maps to bit 1', async () => {
      const r = await translator.execute({ type: 'press', key: 'F4', modifiers: { alt: true } });
      expect(r.ok).toBe(true);
      const calls = transport.callsFor('Input.dispatchKeyEvent');
      expect(calls[0]?.params?.key).toBe('Alt');
      expect(calls[0]?.params?.modifiers).toBe(1);
      const mainDown = calls.find((c) => c.params?.key === 'F4' && c.params?.type === 'rawKeyDown');
      expect(mainDown?.params?.modifiers).toBe(1);
    });

    it('parses chord strings like "Control+V" without text on the main key', async () => {
      const r = await translator.execute({ type: 'press', key: 'Control+V' });
      expect(r.ok).toBe(true);
      const calls = transport.callsFor('Input.dispatchKeyEvent');
      expect(calls.map((c) => `${c.params?.type}:${c.params?.key}`)).toEqual([
        'rawKeyDown:Control',
        'rawKeyDown:v',
        'keyUp:v',
        'keyUp:Control',
      ]);
      expect(calls[1]?.params?.text).toBeUndefined();
      expect(calls[1]?.params?.windowsVirtualKeyCode).toBe(86);
    });

    it('returns INVALID_ARGUMENT for unknown keys', async () => {
      const r = await translator.execute({ type: 'press', key: 'Foosball' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.type).toBe('INVALID_ARGUMENT');
        expect(r.error.message).toContain('Unknown key');
      }
      expect(transport.callsFor('Input.dispatchKeyEvent').length).toBe(0);
    });
  });

  describe('select / check', () => {
    it('select evaluates js and returns SELECTOR_NOT_FOUND when el missing', async () => {
      transport.setSendResponse('Runtime.evaluate', { result: { value: false } });
      const r = await translator.execute({ type: 'select', selector: '#sel', values: ['a'] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.type).toBe('SELECTOR_NOT_FOUND');
    });

    it('select succeeds when element exists', async () => {
      transport.setSendResponse('Runtime.evaluate', { result: { value: true } });
      const r = await translator.execute({ type: 'select', selector: '#sel', values: ['x'] });
      expect(r.ok).toBe(true);
    });

    it('check returns SELECTOR_NOT_FOUND when missing', async () => {
      transport.setSendResponse('Runtime.evaluate', { result: { value: false } });
      const r = await translator.execute({ type: 'check', selector: '#cb', checked: true });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.type).toBe('SELECTOR_NOT_FOUND');
    });

    it('check succeeds when element exists', async () => {
      transport.setSendResponse('Runtime.evaluate', { result: { value: true } });
      const r = await translator.execute({ type: 'check', selector: '#cb', checked: true });
      expect(r.ok).toBe(true);
    });
  });

  describe('scroll', () => {
    it('scrolls window down by default amount', async () => {
      const r = await translator.execute({ type: 'scroll', direction: 'down' });
      expect(r.ok).toBe(true);
      const evals = transport.callsFor('Runtime.evaluate');
      expect(evals[0]?.params?.expression).toContain('window');
      expect(evals[0]?.params?.expression).toContain('scrollBy(0,500)');
    });

    it('scrolls up with negative amount', async () => {
      const r = await translator.execute({ type: 'scroll', direction: 'up', amount: 100 });
      expect(r.ok).toBe(true);
      expect(transport.callsFor('Runtime.evaluate')[0]?.params?.expression).toContain('scrollBy(0,-100)');
    });

    it('scrolls selector element when provided', async () => {
      const r = await translator.execute({ type: 'scroll', direction: 'right', selector: '#box' });
      expect(r.ok).toBe(true);
      expect(transport.callsFor('Runtime.evaluate')[0]?.params?.expression).toContain('#box');
    });
  });

  describe('evaluate / evaluateAsync', () => {
    it('evaluate returns value on success', async () => {
      transport.setSendResponse('Runtime.evaluate', { result: { value: 42 } });
      const r = await translator.execute({ type: 'evaluate', expression: '1+1' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(42);
    });

    it('evaluate returns JS_EVALUATION_ERROR on exceptionDetails', async () => {
      transport.setSendResponse('Runtime.evaluate', {
        exceptionDetails: { text: 'SyntaxError' },
      });
      const r = await translator.execute({ type: 'evaluate', expression: 'bad' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.type).toBe('JS_EVALUATION_ERROR');
        expect(r.error.message).toBe('SyntaxError');
        expect(r.error.recoveryHint).toContain('sintaxis');
        expect(r.error.hint).toBe(r.error.recoveryHint);
      }
    });

    it('evaluateAsync sends with awaitPromise:true', async () => {
      transport.setSendResponse('Runtime.evaluate', { result: { value: 'ok' } });
      const r = await translator.execute({ type: 'evaluateAsync', expression: 'fetch("/x")' });
      expect(r.ok).toBe(true);
      const c = transport.callsFor('Runtime.evaluate')[0];
      expect(c?.params?.awaitPromise).toBe(true);
      expect(c?.params?.returnByValue).toBe(true);
    });

    it('evaluateAsync returns JS_EVALUATION_ERROR on failure', async () => {
      transport.setSendResponse('Runtime.evaluate', { exceptionDetails: { text: 'rejected' } });
      const r = await translator.execute({ type: 'evaluateAsync', expression: 'Promise.reject()' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.type).toBe('JS_EVALUATION_ERROR');
    });
  });

  describe('screenshot / saveSnapshot', () => {
    it('screenshot sends Page.captureScreenshot', async () => {
      transport.setSendResponse('Page.captureScreenshot', { data: 'base64data' });
      const r = await translator.execute({ type: 'screenshot' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe('base64data');
      const c = transport.callsFor('Page.captureScreenshot')[0];
      expect(c?.params?.format).toBe('png');
      expect(c?.params?.captureBeyondViewport).toBe(false);
    });

    it('screenshot respects fullPage and jpeg', async () => {
      transport.setSendResponse('Page.captureScreenshot', { data: 'jpgdata' });
      const r = await translator.execute({ type: 'screenshot', fullPage: true, format: 'jpeg' });
      expect(r.ok).toBe(true);
      const c = transport.callsFor('Page.captureScreenshot')[0];
      expect(c?.params?.format).toBe('jpeg');
      expect(c?.params?.captureBeyondViewport).toBe(true);
    });

    it('saveSnapshot sends Page.captureSnapshot mhtml', async () => {
      transport.setSendResponse('Page.captureSnapshot', { data: 'mhtml-blob' });
      const r = await translator.execute({ type: 'saveSnapshot' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe('mhtml-blob');
      const c = transport.callsFor('Page.captureSnapshot')[0];
      expect(c?.params?.format).toBe('mhtml');
    });

    it('screenshot passes clip (normalized with scale 1) and jpeg quality', async () => {
      transport.setSendResponse('Page.captureScreenshot', { data: 'x' });
      const r = await translator.execute({
        type: 'screenshot',
        format: 'jpeg',
        quality: 70,
        clip: { x: 10, y: 20, width: 300, height: 200 },
      });
      expect(r.ok).toBe(true);
      const c = transport.callsFor('Page.captureScreenshot')[0];
      expect(c?.params?.format).toBe('jpeg');
      expect(c?.params?.quality).toBe(70);
      expect(c?.params?.clip).toEqual({ x: 10, y: 20, width: 300, height: 200, scale: 1 });
    });

    it('screenshot rejects invalid clip with INVALID_ARGUMENT (no CDP call)', async () => {
      const r = await translator.execute({
        type: 'screenshot',
        clip: { x: 0, y: 0, width: 0, height: 10 },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.type).toBe('INVALID_ARGUMENT');
      expect(transport.callsFor('Page.captureScreenshot').length).toBe(0);
    });

    it('screenshot exposes telemetry meta (cdpMs, base64Chars, format)', async () => {
      transport.setSendResponse('Page.captureScreenshot', { data: 'abc123' });
      const r = await translator.execute({ type: 'screenshot' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.meta?.base64Chars).toBe(6);
        expect(typeof r.meta?.cdpMs).toBe('number');
        expect(r.meta?.format).toBe('png');
      }
    });

    it('guardrail: oversized png retries with jpeg 80 and succeeds', async () => {
      const big = 'x'.repeat(900_001);
      transport.send = vi.fn(async (method: string, params?: any) => {
        if (method === 'Page.captureScreenshot') {
          return { data: params?.format === 'png' ? big : 'small' };
        }
        return {};
      });
      const r = await translator.execute({ type: 'screenshot' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value).toBe('small');
        expect(r.meta?.format).toBe('jpeg');
        expect(r.meta?.quality).toBe(80);
      }
      const shots = (transport.send as any).mock.calls.filter(
        (c: any[]) => c[0] === 'Page.captureScreenshot',
      );
      expect(shots.length).toBe(2);
      expect(shots[1][1]).toMatchObject({ format: 'jpeg', quality: 80 });
    });

    it('guardrail: still oversized after jpeg 80 → 60 → SCREENSHOT_TOO_LARGE with hint', async () => {
      const big = 'x'.repeat(900_001);
      transport.send = vi.fn(async () => ({ data: big }));
      const r = await translator.execute({ type: 'screenshot' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.type).toBe('SCREENSHOT_TOO_LARGE');
        expect(r.error.recoverable).toBe(true);
        expect(r.error.hint).toContain('clip');
        expect(r.error.hint).toContain('jpeg');
      }
      const calls = (transport.send as any).mock.calls.filter(
        (c: any[]) => c[0] === 'Page.captureScreenshot',
      );
      expect(calls.length).toBe(3);
      expect(calls[0][1].format).toBe('png');
      expect(calls[1][1]).toMatchObject({ format: 'jpeg', quality: 80 });
      expect(calls[2][1]).toMatchObject({ format: 'jpeg', quality: 60 });
    });
  });

  describe('screenshotZoom', () => {
    it('captures full png then crops in-page via Runtime.evaluate', async () => {
      transport.send = vi.fn(async (method: string, params?: any) => {
        if (method === 'Page.captureScreenshot') return { data: 'fullpng' };
        if (method === 'Runtime.evaluate') {
          expect(params?.awaitPromise).toBe(true);
          expect(params?.expression).toContain('fullpng');
          expect(params?.expression).toContain('"x":10');
          return { result: { value: 'cropped' } };
        }
        return {};
      });
      const r = await translator.execute({
        type: 'screenshotZoom',
        region: { x: 10, y: 20, width: 100, height: 50 },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value).toBe('cropped');
        expect(r.meta?.region).toEqual({ x: 10, y: 20, width: 100, height: 50 });
        expect(r.meta?.base64Chars).toBe(7);
        expect(r.meta?.format).toBe('jpeg');
      }
    });

    it('rejects invalid region with INVALID_ARGUMENT (no CDP call)', async () => {
      const r = await translator.execute({
        type: 'screenshotZoom',
        region: { x: 0, y: 0, width: -5, height: 10 },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.type).toBe('INVALID_ARGUMENT');
    });

    it('empty crop (region outside viewport) is a JS_EVALUATION_ERROR', async () => {
      transport.send = vi.fn(async (method: string) => {
        if (method === 'Page.captureScreenshot') return { data: 'fullpng' };
        if (method === 'Runtime.evaluate') return { result: { value: '' } };
        return {};
      });
      const r = await translator.execute({
        type: 'screenshotZoom',
        region: { x: 9999, y: 9999, width: 100, height: 100 },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.type).toBe('JS_EVALUATION_ERROR');
    });

    it('in-page exception is a JS_EVALUATION_ERROR', async () => {
      transport.send = vi.fn(async (method: string) => {
        if (method === 'Page.captureScreenshot') return { data: 'fullpng' };
        if (method === 'Runtime.evaluate') return { exceptionDetails: { text: 'decode failed' } };
        return {};
      });
      const r = await translator.execute({
        type: 'screenshotZoom',
        region: { x: 0, y: 0, width: 100, height: 100 },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.type).toBe('JS_EVALUATION_ERROR');
        expect(r.error.message).toBe('decode failed');
      }
    });

    it('guardrail: oversized crop retries jpeg 80 → 60 → SCREENSHOT_TOO_LARGE', async () => {
      const big = 'x'.repeat(900_001);
      const evalFormats: string[] = [];
      transport.send = vi.fn(async (method: string, params?: any) => {
        if (method === 'Page.captureScreenshot') return { data: 'fullpng' };
        if (method === 'Runtime.evaluate') {
          const m = params?.expression?.match(/toDataURL\('([^']+)'/);
          if (m) evalFormats.push(m[1]);
          return { result: { value: big } };
        }
        return {};
      });
      const r = await translator.execute({
        type: 'screenshotZoom',
        region: { x: 0, y: 0, width: 100, height: 100 },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.type).toBe('SCREENSHOT_TOO_LARGE');
      expect(evalFormats).toEqual(['image/jpeg', 'image/jpeg', 'image/jpeg']);
    });
  });

  describe('cookies', () => {
    it('getCookies sends Network.getCookies', async () => {
      transport.setSendResponse('Network.getCookies', { cookies: [{ name: 'sid' }] });
      const r = await translator.execute({ type: 'getCookies', urls: ['https://x.com'] });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.value as any[]).length).toBe(1);
      const c = transport.callsFor('Network.getCookies')[0];
      expect(c?.params?.urls).toEqual(['https://x.com']);
    });

    it('setCookie sends Network.setCookie', async () => {
      const r = await translator.execute({
        type: 'setCookie',
        cookie: { name: 'a', value: 'b', domain: 'x.com' },
      });
      expect(r.ok).toBe(true);
      const c = transport.callsFor('Network.setCookie')[0];
      expect(c?.params?.name).toBe('a');
      expect(c?.params?.value).toBe('b');
      expect(c?.params?.domain).toBe('x.com');
      expect(c?.params?.path).toBe('/');
      expect(c?.params?.secure).toBe(false);
      expect(c?.params?.httpOnly).toBe(false);
    });

    it('setCookie honors secure/httpOnly overrides', async () => {
      const r = await translator.execute({
        type: 'setCookie',
        cookie: { name: 'a', value: 'b', domain: 'x.com', secure: true, httpOnly: true },
      });
      expect(r.ok).toBe(true);
      const c = transport.callsFor('Network.setCookie')[0];
      expect(c?.params?.secure).toBe(true);
      expect(c?.params?.httpOnly).toBe(true);
    });

    it('deleteCookies sends Network.deleteCookies', async () => {
      const r = await translator.execute({
        type: 'deleteCookies',
        filter: { name: 'a', domain: 'x.com', path: '/foo' },
      });
      expect(r.ok).toBe(true);
      const c = transport.callsFor('Network.deleteCookies')[0];
      expect(c?.params?.name).toBe('a');
      expect(c?.params?.domain).toBe('x.com');
      expect(c?.params?.path).toBe('/foo');
    });
  });

  describe('localStorage', () => {
    it('getLocalStorage evaluates localStorage.getItem when key given', async () => {
      transport.setSendResponse('Runtime.evaluate', { result: { value: '"hello"' } });
      const r = await translator.execute({ type: 'getLocalStorage', key: 'k' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe('"hello"');
      const c = transport.callsFor('Runtime.evaluate')[0];
      expect(c?.params?.expression).toContain('localStorage.getItem("k")');
    });

    it('getLocalStorage without key stringifies whole storage', async () => {
      transport.setSendResponse('Runtime.evaluate', { result: { value: '{}' } });
      const r = await translator.execute({ type: 'getLocalStorage' });
      expect(r.ok).toBe(true);
      const c = transport.callsFor('Runtime.evaluate')[0];
      expect(c?.params?.expression).toBe('JSON.stringify(localStorage)');
    });

    it('setLocalStorage evaluates localStorage.setItem', async () => {
      const r = await translator.execute({ type: 'setLocalStorage', key: 'k', value: 'v' });
      expect(r.ok).toBe(true);
      const c = transport.callsFor('Runtime.evaluate')[0];
      expect(c?.params?.expression).toContain('localStorage.setItem("k", "v")');
    });

    it('clearStorage type=all clears local + session', async () => {
      const r = await translator.execute({ type: 'clearStorage', storageType: 'all' });
      expect(r.ok).toBe(true);
      const evals = transport.callsFor('Runtime.evaluate');
      const exprs = evals.map((c) => c.params?.expression);
      expect(exprs).toContain('localStorage.clear()');
      expect(exprs).toContain('sessionStorage.clear()');
    });

    it('clearStorage type=local clears only local', async () => {
      const r = await translator.execute({ type: 'clearStorage', storageType: 'local' });
      expect(r.ok).toBe(true);
      const evals = transport.callsFor('Runtime.evaluate');
      const exprs = evals.map((c) => c.params?.expression);
      expect(exprs).toContain('localStorage.clear()');
      expect(exprs).not.toContain('sessionStorage.clear()');
    });

    it('clearStorage type=session clears only session', async () => {
      const r = await translator.execute({ type: 'clearStorage', storageType: 'session' });
      expect(r.ok).toBe(true);
      const evals = transport.callsFor('Runtime.evaluate');
      const exprs = evals.map((c) => c.params?.expression);
      expect(exprs).toContain('sessionStorage.clear()');
      expect(exprs).not.toContain('localStorage.clear()');
    });
  });

  describe('inspection delegation', () => {
    it('inspect returns delegate=true', async () => {
      const r = await translator.execute({ type: 'inspect', domain: 'network' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect((r.value as any).delegate).toBe(true);
        expect((r.value as any).action.type).toBe('inspect');
      }
    });

    it('observe returns delegate=true', async () => {
      const r = await translator.execute({ type: 'observe', question: 'why' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect((r.value as any).delegate).toBe(true);
        expect((r.value as any).action.type).toBe('observe');
      }
    });

    it('diff returns delegate=true', async () => {
      const r = await translator.execute({ type: 'diff' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect((r.value as any).delegate).toBe(true);
        expect((r.value as any).action.type).toBe('diff');
      }
    });
  });

  describe('wait', () => {
    it('wait selector returns true when element appears', async () => {
      vi.useFakeTimers();
      let call = 0;
      // P12: selector waits poll via Runtime.evaluate (waitForUi engine)
      transport.send = vi.fn(async (method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && (params?.expression ?? '').includes('#x')) {
          call++;
          return { result: { value: call >= 3 } };
        }
        return {};
      });
      const p = translator.execute({ type: 'wait', condition: { kind: 'selector', selector: '#x' }, timeoutMs: 5000 });
      await vi.advanceTimersByTimeAsync(2000);
      const r = await p;
      expect(r.ok).toBe(true);
    });

    it('wait selector state=hidden returns true when element gone', async () => {
      vi.useFakeTimers();
      transport.send = vi.fn(async (method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && (params?.expression ?? '').includes('#gone')) {
          return { result: { value: true } };
        }
        return {};
      });
      const p = translator.execute({
        type: 'wait',
        condition: { kind: 'selector', selector: '#gone', state: 'hidden' },
        timeoutMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(1500);
      const r = await p;
      expect(r.ok).toBe(true);
    });

    it('wait timeout returns true after ms', async () => {
      vi.useFakeTimers();
      const p = translator.execute({ type: 'wait', condition: { kind: 'timeout', ms: 500 }, timeoutMs: 5000 });
      await vi.advanceTimersByTimeAsync(2000);
      const r = await p;
      expect(r.ok).toBe(true);
    });

    it('wait function polls until fn returns true', async () => {
      vi.useFakeTimers();
      let call = 0;
      transport.send = vi.fn(async (method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && params?.expression === 'ready()') {
          call++;
          return { result: { value: call >= 2 } };
        }
        return {};
      });
      const p = translator.execute({ type: 'wait', condition: { kind: 'function', fn: 'ready()' }, timeoutMs: 5000 });
      await vi.advanceTimersByTimeAsync(2000);
      const r = await p;
      expect(r.ok).toBe(true);
    });

    it('wait returns TIMEOUT when condition never met', async () => {
      vi.useFakeTimers();
      transport.send = vi.fn(async (method: string) => {
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelector') return { nodeId: 0 };
        return {};
      });
      const p = translator.execute({ type: 'wait', condition: { kind: 'selector', selector: '#never' }, timeoutMs: 500 });
      await vi.advanceTimersByTimeAsync(2000);
      const r = await p;
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.type).toBe('TIMEOUT');
        expect(r.error.recoverable).toBe(true);
      }
    });
  });

  describe('refs (element map)', () => {
    it('click with ref resolves in-page and clicks at the element center', async () => {
      transport.setSendResponse('Runtime.evaluate', {
        result: { value: JSON.stringify({ ok: true, x: 120, y: 40 }) },
      });
      const r = await translator.execute({ type: 'click', ref: 'e3' });
      expect(r.ok).toBe(true);
      const evals = transport.callsFor('Runtime.evaluate');
      expect(evals.length).toBe(1);
      expect(evals[0]?.params?.expression).toContain('__yjElementMap');
      expect(evals[0]?.params?.expression).toContain('"e3"');
      const mouse = transport.callsFor('Input.dispatchMouseEvent');
      expect(mouse.length).toBe(2);
      expect(mouse[0]?.params?.x).toBe(120);
      expect(mouse[0]?.params?.y).toBe(40);
      expect(transport.callsFor('DOM.focus').length).toBe(0);
    });

    it('click with stale ref returns REF_NOT_FOUND with observe hint', async () => {
      transport.setSendResponse('Runtime.evaluate', {
        result: { value: JSON.stringify({ ok: false }) },
      });
      const r = await translator.execute({ type: 'click', ref: 'e9' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.type).toBe('REF_NOT_FOUND');
        expect(r.error.recoverable).toBe(true);
        expect(r.error.hint).toContain('observe');
        expect(r.error.hint).toContain('refs frescas');
      }
      expect(transport.callsFor('Input.dispatchMouseEvent').length).toBe(0);
    });

    it('click with neither selector nor ref is INVALID_ARGUMENT (no CDP call)', async () => {
      const r = await translator.execute({ type: 'click' } as any);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.type).toBe('INVALID_ARGUMENT');
      expect(transport.sendCallCount()).toBe(0);
    });

    it('focus with ref focuses in-page via the resolve script', async () => {
      transport.setSendResponse('Runtime.evaluate', {
        result: { value: JSON.stringify({ ok: true, x: 1, y: 2 }) },
      });
      const r = await translator.execute({ type: 'focus', ref: 'e2' });
      expect(r.ok).toBe(true);
      const js = transport.callsFor('Runtime.evaluate')[0]?.params?.expression;
      expect(js).toContain('el.focus()');
      expect(transport.callsFor('DOM.focus').length).toBe(0);
    });

    it('type with ref focuses + clears in-page, then inserts text', async () => {
      transport.setSendResponse('Runtime.evaluate', {
        result: { value: JSON.stringify({ ok: true, x: 1, y: 2 }) },
      });
      const r = await translator.execute({ type: 'type', ref: 'e4', text: 'hi', clearFirst: true });
      expect(r.ok).toBe(true);
      const js = transport.callsFor('Runtime.evaluate')[0]?.params?.expression;
      expect(js).toContain('el.focus()');
      expect(js).toContain("el.value = ''");
      const inserts = transport.callsFor('Input.insertText');
      expect(inserts.length).toBe(2);
      expect(transport.callsFor('DOM.querySelector').length).toBe(0);
    });

    it('type with stale ref returns REF_NOT_FOUND and types nothing', async () => {
      transport.setSendResponse('Runtime.evaluate', {
        result: { value: JSON.stringify({ ok: false }) },
      });
      const r = await translator.execute({ type: 'type', ref: 'e4', text: 'hi' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.type).toBe('REF_NOT_FOUND');
      expect(transport.callsFor('Input.insertText').length).toBe(0);
    });
  });

  describe('form_input', () => {
    it('sets a text input and returns previous/new', async () => {
      transport.setSendResponse('Runtime.evaluate', {
        result: { value: JSON.stringify({ ok: true, previous: 'old', new: 'new@x.com', sensitive: false, tag: 'INPUT', inputType: 'text' }) },
      });
      const r = await translator.execute({ type: 'form_input', selector: '#email', value: 'new@x.com' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect((r.value as any).previous).toBe('old');
        expect((r.value as any).new).toBe('new@x.com');
      }
      const js = transport.callsFor('Runtime.evaluate')[0]?.params?.expression;
      expect(js).toContain('document.querySelector("#email")');
      expect(js).toContain("new Event('input', { bubbles: true })");
    });

    it('redacts previous/new for sensitive fields', async () => {
      transport.setSendResponse('Runtime.evaluate', {
        result: { value: JSON.stringify({ ok: true, previous: '[value redacted]', new: '[value redacted]', sensitive: true, tag: 'INPUT', inputType: 'password' }) },
      });
      const r = await translator.execute({ type: 'form_input', selector: '#pw', value: 's3cret' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect((r.value as any).previous).toBe('[value redacted]');
        expect((r.value as any).new).toBe('[value redacted]');
        expect((r.value as any).sensitive).toBe(true);
      }
    });

    it('resolves by ref and maps stale refs to REF_NOT_FOUND', async () => {
      transport.setSendResponse('Runtime.evaluate', {
        result: { value: JSON.stringify({ error: 'REF_NOT_FOUND' }) },
      });
      const r = await translator.execute({ type: 'form_input', ref: 'e8', value: 'x' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.type).toBe('REF_NOT_FOUND');
        expect(r.error.hint).toContain('observe');
      }
      const js = transport.callsFor('Runtime.evaluate')[0]?.params?.expression;
      expect(js).toContain('__yjElementMap');
    });

    it('select with unknown option fails listing available options', async () => {
      transport.setSendResponse('Runtime.evaluate', {
        result: { value: JSON.stringify({ error: 'NO_OPTION', options: ['es', 'en', 'fr'] }) },
      });
      const r = await translator.execute({ type: 'form_input', selector: '#lang', value: 'de' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.type).toBe('INVALID_ARGUMENT');
        expect(r.error.message).toContain('es, en, fr');
        expect(r.error.hint).toContain('Available');
      }
    });

    it('checkbox with non-boolean value is a guided BAD_VALUE error', async () => {
      transport.setSendResponse('Runtime.evaluate', {
        result: { value: JSON.stringify({ error: 'BAD_VALUE', expected: 'boolean', inputType: 'checkbox' }) },
      });
      const r = await translator.execute({ type: 'form_input', selector: '#cb', value: 'yes' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.type).toBe('INVALID_ARGUMENT');
        expect(r.error.message).toContain('boolean');
        expect(r.error.hint).toContain('boolean');
      }
    });

    it('non-form element maps to ELEMENT_NOT_INTERACTABLE', async () => {
      transport.setSendResponse('Runtime.evaluate', {
        result: { value: JSON.stringify({ error: 'NOT_INPUT' }) },
      });
      const r = await translator.execute({ type: 'form_input', selector: '#div', value: 'x' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.type).toBe('ELEMENT_NOT_INTERACTABLE');
    });

    it('missing selector and ref is INVALID_ARGUMENT (no CDP call)', async () => {
      const r = await translator.execute({ type: 'form_input', value: 'x' } as any);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.type).toBe('INVALID_ARGUMENT');
      expect(transport.sendCallCount()).toBe(0);
    });
  });

  describe('error wrapping', () => {
    it('unknown action type returns UNSUPPORTED_ACTION', async () => {
      const action = { type: 'totallyFake' } as unknown as BrowserAction;
      const r = await translator.execute(action);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.type).toBe('UNSUPPORTED_ACTION');
    });

    it('CDP throw wraps in CDP_COMMAND_FAILED', async () => {
      transport.send = vi.fn(async () => {
        throw new Error('boom');
      });
      const r = await translator.execute({ type: 'reload' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.type).toBe('CDP_COMMAND_FAILED');
        expect(r.error.message).toBe('boom');
        expect(r.error.recoverable).toBe(true);
      }
    });
  });
});

describe('makeError', () => {
  it('SELECTOR_NOT_FOUND is not recoverable', () => {
    const e = makeError('SELECTOR_NOT_FOUND', 'x');
    expect(e.recoverable).toBe(false);
  });

  it('NAVIGATION_TIMEOUT is recoverable', () => {
    const e = makeError('NAVIGATION_TIMEOUT', 'x');
    expect(e.recoverable).toBe(true);
  });

  it('REF_NOT_FOUND is recoverable with the observe hint by default', () => {
    const e = makeError('REF_NOT_FOUND', 'stale ref e7');
    expect(e.recoverable).toBe(true);
    expect(e.hint).toContain('observe');
    expect(e.recoveryHint).toBe(e.hint);
  });

  it('REF_NOT_FOUND classifies to YJ.ACT.DOM_TARGET_STALE', () => {
    const e = arsenalToDoctrine(makeError('REF_NOT_FOUND', 'stale ref e7'));
    expect(e.code).toBe('YJ.ACT.DOM_TARGET_STALE');
    expect(e.message).toBe('stale ref e7');
  });

  it('includes recoveryHint when provided', () => {
    const e = makeError('JS_EVALUATION_ERROR', 'bad', 'check syntax');
    expect(e.recoveryHint).toBe('check syntax');
  });

  it('recoveryHint undefined when omitted', () => {
    const e = makeError('TIMEOUT', 'slow');
    expect(e.recoveryHint).toBeUndefined();
  });
});