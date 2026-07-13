import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MotionSensor } from '../../src/vision/motion.js';
import type { Transport } from '../../src/vision/base-sensor.js';

class MockTransport implements Transport {
  handlers: Map<string, ((params: any) => void)[]> = new Map();
  sendResponses: Map<string, any> = new Map();
  defaultSendResponse: any = { metrics: [] };
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

  emit(event: string, params: any): void {
    const arr = this.handlers.get(event);
    if (arr) for (const h of arr) h(params);
  }

  handlerCount(event: string): number {
    return this.handlers.get(event)?.length ?? 0;
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
}

function perfMetric(name: string, value: number): any {
  return { name, value };
}

function bytesForMB(mb: number): number {
  return mb * 1024 * 1024;
}

describe('MotionSensor', () => {
  let transport: MockTransport;
  let sensor: MotionSensor;

  beforeEach(() => {
    transport = new MockTransport();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('subscribe', () => {
    it('calls Performance.getMetrics on subscribe', async () => {
      sensor = new MotionSensor(transport);
      sensor.subscribe();
      await Promise.resolve();
      expect(transport.sendCallCount()).toBeGreaterThan(0);
      expect(transport.sendCallsFor('Performance.getMetrics')).toBeGreaterThanOrEqual(1);
    });

    it('starts a poll interval on subscribe', async () => {
      vi.useFakeTimers();
      sensor = new MotionSensor(transport);
      sensor.subscribe();
      await Promise.resolve();
      const afterSubscribe = transport.sendCallCount();

      vi.advanceTimersByTime(2000);
      await Promise.resolve();
      expect(transport.sendCallCount()).toBeGreaterThan(afterSubscribe);
    });
  });

  describe('summarize', () => {
    it('returns correct metrics from getMetrics result', async () => {
      transport.setSendResponse('Performance.getMetrics', {
        metrics: [
          perfMetric('JSHeapUsedSize', bytesForMB(50)),
          perfMetric('JSHeapTotalSize', bytesForMB(100)),
          perfMetric('Nodes', 1234),
          perfMetric('LayoutCount', 5),
          perfMetric('RecalcStyleCount', 7),
        ],
      });
      sensor = new MotionSensor(transport);
      sensor.subscribe();
      await Promise.resolve();

      const summary = await sensor.summarize();
      const names = summary.metrics.map((m) => m.name);
      expect(names).toContain('JSHeapUsedSize');
      expect(names).toContain('JSHeapTotalSize');
      expect(names).toContain('Nodes');
      expect(names).toContain('LayoutCount');
      expect(names).toContain('RecalcStyleCount');
    });

    it('converts heap bytes to MB', async () => {
      transport.setSendResponse('Performance.getMetrics', {
        metrics: [
          perfMetric('JSHeapUsedSize', bytesForMB(50)),
          perfMetric('JSHeapTotalSize', bytesForMB(120)),
        ],
      });
      sensor = new MotionSensor(transport);
      sensor.subscribe();
      await Promise.resolve();

      const summary = await sensor.summarize();
      expect(summary.jsHeapUsedMB).toBe(50);
      expect(summary.jsHeapTotalMB).toBe(120);
    });

    it('converts durations from seconds to ms', async () => {
      transport.setSendResponse('Performance.getMetrics', {
        metrics: [
          perfMetric('ScriptDuration', 1.5),
          perfMetric('TaskDuration', 2.5),
        ],
      });
      sensor = new MotionSensor(transport);
      sensor.subscribe();
      await Promise.resolve();

      const summary = await sensor.summarize();
      expect(summary.scriptDurationMs).toBe(1500);
      expect(summary.taskDurationMs).toBe(2500);
    });

    it('detects heap growth trend (growing)', async () => {
      transport.setSendResponse('Performance.getMetrics', {
        metrics: [perfMetric('JSHeapUsedSize', bytesForMB(50))],
      });
      sensor = new MotionSensor(transport);
      sensor.subscribe();
      await Promise.resolve();

      const first = await sensor.summarize();
      expect(first.jsHeapTrend).toBe('stable');

      transport.setSendResponse('Performance.getMetrics', {
        metrics: [perfMetric('JSHeapUsedSize', bytesForMB(70))],
      });
      sensor['poll'] = sensor['poll'].bind(sensor);
      const pollPromise = sensor['poll']();
      await pollPromise;

      const second = await sensor.summarize();
      expect(second.jsHeapTrend).toBe('growing');
    });

    it('detects heap shrink trend (shrinking)', async () => {
      transport.setSendResponse('Performance.getMetrics', {
        metrics: [perfMetric('JSHeapUsedSize', bytesForMB(80))],
      });
      sensor = new MotionSensor(transport);
      sensor.subscribe();
      await Promise.resolve();

      const first = await sensor.summarize();
      expect(first.jsHeapTrend).toBe('stable');

      transport.setSendResponse('Performance.getMetrics', {
        metrics: [perfMetric('JSHeapUsedSize', bytesForMB(50))],
      });
      await sensor['poll']();

      const second = await sensor.summarize();
      expect(second.jsHeapTrend).toBe('shrinking');
    });

    it('returns stable when heap unchanged', async () => {
      transport.setSendResponse('Performance.getMetrics', {
        metrics: [perfMetric('JSHeapUsedSize', bytesForMB(50))],
      });
      sensor = new MotionSensor(transport);
      sensor.subscribe();
      await Promise.resolve();

      await sensor.summarize();
      await sensor.summarize();
      const third = await sensor.summarize();
      expect(third.jsHeapTrend).toBe('stable');
    });

    it('handles empty metrics gracefully (returns zeros)', async () => {
      sensor = new MotionSensor(transport);
      sensor.subscribe();
      await Promise.resolve();

      const summary = await sensor.summarize();
      expect(summary.metrics).toEqual([]);
      expect(summary.jsHeapUsedMB).toBe(0);
      expect(summary.jsHeapTotalMB).toBe(0);
      expect(summary.domNodes).toBe(0);
      expect(summary.layoutCount).toBe(0);
      expect(summary.recalcStyleCount).toBe(0);
      expect(summary.scriptDurationMs).toBe(0);
      expect(summary.taskDurationMs).toBe(0);
      expect(summary.jsHeapTrend).toBe('stable');
      expect(summary.longTaskCount).toBe(0);
      expect(typeof summary.timestamp).toBe('number');
    });
  });

  describe('getAnomalies', () => {
    it('warns on heap > 100MB', async () => {
      transport.setSendResponse('Performance.getMetrics', {
        metrics: [perfMetric('JSHeapUsedSize', bytesForMB(150))],
      });
      sensor = new MotionSensor(transport);
      sensor.subscribe();
      await Promise.resolve();

      const anomalies = await sensor.getAnomalies();
      const heapAnomaly = anomalies.find((a) => a.message.includes('heap'));
      expect(heapAnomaly).toBeDefined();
      expect(heapAnomaly!.severity).toBe('warning');
      expect(heapAnomaly!.domain).toBe('performance');
    });

    it('critical on heap > 200MB', async () => {
      transport.setSendResponse('Performance.getMetrics', {
        metrics: [perfMetric('JSHeapUsedSize', bytesForMB(250))],
      });
      sensor = new MotionSensor(transport);
      sensor.subscribe();
      await Promise.resolve();

      const anomalies = await sensor.getAnomalies();
      const heapAnomaly = anomalies.find((a) => a.message.includes('heap'));
      expect(heapAnomaly).toBeDefined();
      expect(heapAnomaly!.severity).toBe('critical');
    });

    it('warns on growing heap trend', async () => {
      transport.setSendResponse('Performance.getMetrics', {
        metrics: [perfMetric('JSHeapUsedSize', bytesForMB(50))],
      });
      sensor = new MotionSensor(transport);
      sensor.subscribe();
      await Promise.resolve();

      await sensor.summarize();

      transport.setSendResponse('Performance.getMetrics', {
        metrics: [perfMetric('JSHeapUsedSize', bytesForMB(80))],
      });
      await sensor['poll']();

      const anomalies = await sensor.getAnomalies();
      const leakAnomaly = anomalies.find((a) => a.message.includes('leak') || a.message.includes('growing'));
      expect(leakAnomaly).toBeDefined();
      expect(leakAnomaly!.severity).toBe('warning');
    });
  });

  describe('clear', () => {
    it('resets all state', async () => {
      transport.setSendResponse('Performance.getMetrics', {
        metrics: [perfMetric('JSHeapUsedSize', bytesForMB(80))],
      });
      sensor = new MotionSensor(transport);
      sensor.subscribe();
      await Promise.resolve();

      await sensor.summarize();

      sensor.clear();

      transport.setSendResponse('Performance.getMetrics', {
        metrics: [perfMetric('JSHeapUsedSize', bytesForMB(50))],
      });
      await sensor['poll']();

      const summary = await sensor.summarize();
      expect(summary.jsHeapTrend).toBe('stable');
      expect(summary.jsHeapUsedMB).toBe(50);
    });
  });

  describe('unsubscribe', () => {
    it('clears poll timer', async () => {
      vi.useFakeTimers();
      sensor = new MotionSensor(transport);
      sensor.subscribe();
      await Promise.resolve();
      const beforeUnsub = transport.sendCallCount();

      sensor.unsubscribe();
      vi.advanceTimersByTime(10000);
      await Promise.resolve();

      expect(transport.sendCallCount()).toBe(beforeUnsub);
    });

    it('is idempotent', () => {
      sensor = new MotionSensor(transport);
      sensor.subscribe();
      sensor.unsubscribe();
      expect(() => sensor.unsubscribe()).not.toThrow();
      expect(sensor.active).toBe(false);
    });
  });
});
