import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EMSensor, type DOMSummary } from '../../src/vision/em.js';
import type { Transport } from '../../src/vision/base-sensor.js';

class MockTransport implements Transport {
  handlers: Map<string, ((params: any) => void)[]> = new Map();
  send = vi.fn();

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

  emit(event: string, params: any): void {
    const arr = this.handlers.get(event);
    if (arr) for (const h of arr) h(params);
  }

  handlerCount(event: string): number {
    return this.handlers.get(event)?.length ?? 0;
  }
}

function makeSummary(overrides: Partial<DOMSummary> = {}): DOMSummary {
  return {
    url: 'http://example.com',
    semantic: {
      pageType: 'article',
      title: 'Example',
      headings: ['h1'],
      mainContentPreview: 'body text',
      language: 'en',
    },
    interactive: { buttons: [], links: [], inputs: [], total: 0 },
    structural: { totalElements: 10, depth: 3, iframes: 0, images: 1, scripts: 2, forms: 0, stylesheets: 1 },
    ...overrides,
  };
}

function setEvaluateResponse(transport: MockTransport, summary: DOMSummary): void {
  const json = JSON.stringify(summary);
  transport.send.mockResolvedValue({
    result: { type: 'string', value: json },
  });
}

describe('EMSensor', () => {
  let transport: MockTransport;
  let sensor: EMSensor;

  beforeEach(() => {
    transport = new MockTransport();
    sensor = new EMSensor(transport);
    transport.send.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('subscribe', () => {
    it('registers Page.frameNavigated handler', () => {
      sensor.subscribe();
      expect(transport.handlerCount('Page.frameNavigated')).toBe(1);
    });

    it('registers Page.loadEventFired handler', () => {
      sensor.subscribe();
      expect(transport.handlerCount('Page.loadEventFired')).toBe(1);
    });

    it('does not register Runtime.consoleAPICalled (em is DOM-only)', () => {
      sensor.subscribe();
      expect(transport.handlerCount('Runtime.consoleAPICalled')).toBe(0);
    });
  });

  describe('summarize', () => {
    it('calls Runtime.evaluate with returnByValue: true', async () => {
      setEvaluateResponse(transport, makeSummary());
      sensor.subscribe();
      await sensor.summarize();
      expect(transport.send).toHaveBeenCalledTimes(1);
      expect(transport.send).toHaveBeenCalledWith(
        'Runtime.evaluate',
        expect.objectContaining({ returnByValue: true }),
      );
    });

    it('expression contains the extraction function wrapper', async () => {
      setEvaluateResponse(transport, makeSummary());
      sensor.subscribe();
      await sensor.summarize();
      const call = transport.send.mock.calls[0]!;
      const params = call[1] as Record<string, any>;
      expect(params.expression).toContain('(function()');
      expect(params.expression).toContain('return JSON.stringify');
      expect(params.expression).toContain('getSelector');
      expect(params.expression).toContain('visible');
    });

    it('returns parsed DOMSummary', async () => {
      const expected = makeSummary({ url: 'http://test/page', semantic: { pageType: 'login', title: 'Sign In', headings: ['Login'], mainContentPreview: '...', language: 'en' } });
      setEvaluateResponse(transport, expected);
      sensor.subscribe();
      const s = await sensor.summarize();
      expect(s).toEqual(expected);
      expect(s.url).toBe('http://test/page');
      expect(s.semantic.pageType).toBe('login');
    });

    it('throws if Runtime.evaluate returns no data', async () => {
      transport.send.mockResolvedValue({ result: { value: null } });
      sensor.subscribe();
      await expect(sensor.summarize()).rejects.toThrow('Runtime.evaluate returned no data');
    });

    it('throws if Runtime.evaluate returns no result wrapper', async () => {
      transport.send.mockResolvedValue({});
      sensor.subscribe();
      await expect(sensor.summarize()).rejects.toThrow('Runtime.evaluate returned no data');
    });
  });

  describe('caching', () => {
    it('caches result within cacheTtlMs - single send call', async () => {
      setEvaluateResponse(transport, makeSummary());
      sensor.subscribe();
      const a = await sensor.summarize();
      const b = await sensor.summarize();
      const c = await sensor.summarize();
      expect(transport.send).toHaveBeenCalledTimes(1);
      expect(a).toBe(b);
      expect(b).toBe(c);
    });

    it('invalidates cache after cacheTtlMs', async () => {
      setEvaluateResponse(transport, makeSummary());
      sensor.subscribe();
      await sensor.summarize();
      vi.useFakeTimers();
      vi.advanceTimersByTime(2001);
      await sensor.summarize();
      expect(transport.send).toHaveBeenCalledTimes(2);
    });

    it('respects custom cacheTtlMs', async () => {
      setEvaluateResponse(transport, makeSummary());
      const customSensor = new EMSensor(transport, { cacheTtlMs: 100 });
      customSensor.subscribe();
      await customSensor.summarize();
      vi.useFakeTimers();
      vi.advanceTimersByTime(101);
      await customSensor.summarize();
      expect(transport.send).toHaveBeenCalledTimes(2);
    });

    it('does not invalidate cache before cacheTtlMs with custom value', async () => {
      setEvaluateResponse(transport, makeSummary());
      const customSensor = new EMSensor(transport, { cacheTtlMs: 500 });
      customSensor.subscribe();
      await customSensor.summarize();
      vi.useFakeTimers();
      vi.advanceTimersByTime(499);
      await customSensor.summarize();
      expect(transport.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('cache invalidation on events', () => {
    it('invalidates cache on Page.frameNavigated', async () => {
      setEvaluateResponse(transport, makeSummary());
      sensor.subscribe();
      await sensor.summarize();
      expect(transport.send).toHaveBeenCalledTimes(1);
      transport.emit('Page.frameNavigated', { frameId: 'f1' });
      await sensor.summarize();
      expect(transport.send).toHaveBeenCalledTimes(2);
    });

    it('invalidates cache on Page.loadEventFired', async () => {
      setEvaluateResponse(transport, makeSummary());
      sensor.subscribe();
      await sensor.summarize();
      expect(transport.send).toHaveBeenCalledTimes(1);
      transport.emit('Page.loadEventFired', { timestamp: 1.0 });
      await sensor.summarize();
      expect(transport.send).toHaveBeenCalledTimes(2);
    });

    it('cache survives unsubscribe/resubscribe cycle (handlers removed)', async () => {
      setEvaluateResponse(transport, makeSummary());
      sensor.subscribe();
      await sensor.summarize();
      sensor.unsubscribe();
      sensor.subscribe();
      const before = transport.send.mock.calls.length;
      await sensor.summarize();
      expect(transport.send.mock.calls.length).toBe(before);
    });
  });

  describe('getAnomalies', () => {
    it('returns warning for error page type', async () => {
      setEvaluateResponse(transport, makeSummary({ semantic: { pageType: 'error', title: '404 Not Found', headings: [], mainContentPreview: '', language: 'en' } }));
      sensor.subscribe();
      const anomalies = await sensor.getAnomalies();
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0]!.domain).toBe('dom');
      expect(anomalies[0]!.severity).toBe('warning');
      expect(anomalies[0]!.message).toContain('404 Not Found');
    });

    it('returns empty for normal page', async () => {
      setEvaluateResponse(transport, makeSummary({ semantic: { pageType: 'article', title: 'Hello', headings: [], mainContentPreview: '', language: 'en' } }));
      sensor.subscribe();
      const anomalies = await sensor.getAnomalies();
      expect(anomalies).toHaveLength(0);
    });

    it('returns empty for unknown page type', async () => {
      setEvaluateResponse(transport, makeSummary({ semantic: { pageType: 'unknown', title: 'X', headings: [], mainContentPreview: '', language: 'en' } }));
      sensor.subscribe();
      const anomalies = await sensor.getAnomalies();
      expect(anomalies).toHaveLength(0);
    });
  });

  describe('clear', () => {
    it('resets cache so next summarize calls send again', async () => {
      setEvaluateResponse(transport, makeSummary());
      sensor.subscribe();
      await sensor.summarize();
      expect(transport.send).toHaveBeenCalledTimes(1);
      sensor.clear();
      await sensor.summarize();
      expect(transport.send).toHaveBeenCalledTimes(2);
    });
  });
});