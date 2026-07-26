import { describe, it, expect } from 'vitest';
import { trustedClick, buildClickPointScript } from '../../src/arsenal/trusted-input.js';

class MockTransport {
  calls: { method: string; params: any }[] = [];
  handler: (method: string, params: any) => any = () => ({});
  async send(method: string, params?: any): Promise<any> {
    this.calls.push({ method, params });
    return this.handler(method, params);
  }
}

describe('trustedClick', () => {
  it('resolves the click point and dispatches pressed+released via Input domain', async () => {
    const t = new MockTransport();
    t.handler = (method, params) => {
      if (method === 'Runtime.evaluate') return { result: { value: { x: 120.5, y: 340 } } };
      return {};
    };
    const r = await trustedClick(t as any, { selector: '#btn' });
    expect(r.ok).toBe(true);
    const events = t.calls.filter((c) => c.method === 'Input.dispatchMouseEvent');
    expect(events).toHaveLength(2);
    expect(events[0]!.params).toMatchObject({ type: 'mousePressed', x: 120.5, y: 340, button: 'left', clickCount: 1 });
    expect(events[1]!.params).toMatchObject({ type: 'mouseReleased', x: 120.5, y: 340 });
  });

  it('honors button and clickCount', async () => {
    const t = new MockTransport();
    t.handler = (method) => (method === 'Runtime.evaluate' ? { result: { value: { x: 1, y: 2 } } } : {});
    await trustedClick(t as any, { selector: '#btn', button: 'right', clickCount: 2 });
    const pressed = t.calls.filter((c) => c.params?.type === 'mousePressed');
    expect(pressed).toHaveLength(2);
    expect(pressed[0]!.params.button).toBe('right');
    expect(pressed[1]!.params.clickCount).toBe(2);
  });

  it('element not found or zero-size → not_found (no dispatch)', async () => {
    const t = new MockTransport();
    t.handler = () => ({ result: { value: null } });
    const r = await trustedClick(t as any, { selector: '#ghost' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found');
    expect(t.calls.filter((c) => c.method === 'Input.dispatchMouseEvent')).toHaveLength(0);
  });

  it('dispatch failure → dispatch_failed (typed, never fake success)', async () => {
    const t = new MockTransport();
    t.handler = (method) => {
      if (method === 'Runtime.evaluate') return { result: { value: { x: 1, y: 2 } } };
      if (method === 'Input.dispatchMouseEvent') throw new Error('cdp broken');
      return {};
    };
    const r = await trustedClick(t as any, { selector: '#btn' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('dispatch_failed');
  });
});

describe('buildClickPointScript', () => {
  it('computes the element center in a fake DOM', () => {
    const el = { getBoundingClientRect: () => ({ left: 100, top: 50, width: 40, height: 20 }) };
    const document = { querySelector: () => el };
    const out = new Function('document', `return (${buildClickPointScript('#x')});`)(document);
    expect(out).toEqual({ x: 120, y: 60 });
  });

  it('returns null for missing or zero-size elements', () => {
    const document = { querySelector: () => null };
    expect(new Function('document', `return (${buildClickPointScript('#x')});`)(document)).toBeNull();
    const doc2 = { querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) }) };
    expect(new Function('document', `return (${buildClickPointScript('#x')});`)(doc2)).toBeNull();
  });
});
