import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AudioSensor, type ConsoleEntry } from '../../src/vision/audio.js';
import type { Transport } from '../../src/vision/base-sensor.js';

class MockTransport implements Transport {
  handlers: Map<string, ((params: any) => void)[]> = new Map();

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

function consoleEvent(type: string, args: any[], stackTrace?: any[]): any {
  return {
    type,
    args,
    executionContextId: 1,
    timestamp: 1.0,
    stackTrace: stackTrace ?? [{ url: 'http://x/main.js', lineNumber: 42, columnNumber: 3 }],
  };
}

function exceptionEvent(text: string, url?: string, lineNumber?: number, frames?: any[]): any {
  return {
    exceptionDetails: {
      text,
      url,
      lineNumber,
      stackTrace: {
        callFrames: frames ?? [
          { functionName: 'foo', url: 'http://x/app.js', lineNumber: 10, columnNumber: 5 },
          { functionName: 'bar', url: 'http://x/app.js', lineNumber: 20, columnNumber: 1 },
        ],
      },
    },
  };
}

describe('AudioSensor', () => {
  let transport: MockTransport;
  let sensor: AudioSensor;

  beforeEach(() => {
    transport = new MockTransport();
    sensor = new AudioSensor(transport);
    sensor.subscribe();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('subscribe', () => {
    it('registers Runtime.consoleAPICalled handler', () => {
      expect(transport.handlerCount('Runtime.consoleAPICalled')).toBe(1);
    });

    it('registers Runtime.exceptionThrown handler', () => {
      expect(transport.handlerCount('Runtime.exceptionThrown')).toBe(1);
    });
  });

  describe('consoleAPICalled', () => {
    it('type=error creates error entry', () => {
      transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: 'boom' }]));
      const entries = sensor.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.level).toBe('error');
      expect(entries[0]!.text).toBe('boom');
      expect(entries[0]!.count).toBe(1);
      expect(entries[0]!.url).toBe('http://x/main.js');
      expect(entries[0]!.lineNumber).toBe(42);
    });

    it('type=warning creates warning entry', () => {
      transport.emit('Runtime.consoleAPICalled', consoleEvent('warning', [{ type: 'string', value: 'careful' }]));
      const entries = sensor.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.level).toBe('warning');
      expect(entries[0]!.text).toBe('careful');
    });

    it('type=log creates log entry', () => {
      transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [{ type: 'string', value: 'hi' }]));
      const entries = sensor.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.level).toBe('log');
    });

    it('type=info creates info entry', () => {
      transport.emit('Runtime.consoleAPICalled', consoleEvent('info', [{ type: 'string', value: 'hello' }]));
      const entries = sensor.getEntries();
      expect(entries[0]!.level).toBe('info');
    });

    it('type=debug creates debug entry', () => {
      transport.emit('Runtime.consoleAPICalled', consoleEvent('debug', [{ type: 'string', value: 'trace' }]));
      const entries = sensor.getEntries();
      expect(entries[0]!.level).toBe('debug');
    });

    it('unknown type defaults to log', () => {
      transport.emit('Runtime.consoleAPICalled', consoleEvent('table', [{ type: 'string', value: 'x' }]));
      const entries = sensor.getEntries();
      expect(entries[0]!.level).toBe('log');
    });
  });

  describe('exceptionThrown', () => {
    it('creates error entry with stackTrace', () => {
      transport.emit('Runtime.exceptionThrown', exceptionEvent('TypeError: bad'));
      const entries = sensor.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.level).toBe('error');
      expect(entries[0]!.text).toBe('TypeError: bad');
      expect(entries[0]!.stackTrace).toContain('foo@http://x/app.js:10');
      expect(entries[0]!.stackTrace).toContain('bar@http://x/app.js:20');
    });

    it('falls back to exception.description when text missing', () => {
      transport.emit('Runtime.exceptionThrown', {
        exceptionDetails: {
          exception: { description: 'Cannot read property' },
        },
      });
      const entries = sensor.getEntries();
      expect(entries[0]!.text).toBe('Cannot read property');
    });

    it('falls back to "Uncaught exception" when both missing', () => {
      transport.emit('Runtime.exceptionThrown', { exceptionDetails: {} });
      const entries = sensor.getEntries();
      expect(entries[0]!.text).toBe('Uncaught exception');
    });

    it('includes url and lineNumber from exceptionDetails', () => {
      transport.emit('Runtime.exceptionThrown', exceptionEvent('Boom', 'http://x/main.js', 99, []));
      const entries = sensor.getEntries();
      expect(entries[0]!.url).toBe('http://x/main.js');
      expect(entries[0]!.lineNumber).toBe(99);
    });
  });

  describe('formatArgs (via emitted entries)', () => {
    it('handles string args', () => {
      transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [{ type: 'string', value: 'hello' }]));
      expect(sensor.getEntries()[0]!.text).toBe('hello');
    });

    it('handles number args', () => {
      transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [{ type: 'number', value: 42 }]));
      expect(sensor.getEntries()[0]!.text).toBe('42');
    });

    it('handles multiple args by joining with space', () => {
      transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [
        { type: 'string', value: 'count:' },
        { type: 'number', value: 7 },
      ]));
      expect(sensor.getEntries()[0]!.text).toBe('count: 7');
    });

    it('handles object args with preview', () => {
      transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [{
        type: 'object',
        preview: {
          properties: [
            { name: 'foo', value: '1' },
            { name: 'bar', value: '2' },
          ],
        },
      }]));
      expect(sensor.getEntries()[0]!.text).toBe('foo: 1, bar: 2');
    });

    it('handles object args without preview (uses description/value)', () => {
      transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [{
        type: 'object',
        description: 'MyObj',
      }]));
      expect(sensor.getEntries()[0]!.text).toBe('MyObj');
    });

    it('handles undefined args gracefully', () => {
      transport.emit('Runtime.consoleAPICalled', { type: 'log', args: undefined, timestamp: 1.0 });
      expect(sensor.getEntries()[0]!.text).toBe('');
    });
  });

  describe('dedup', () => {
    it('same message within window increments count, no new entry', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1000));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: 'repeat' }]));
      vi.setSystemTime(new Date(1500));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: 'repeat' }]));
      vi.setSystemTime(new Date(1900));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: 'repeat' }]));

      const entries = sensor.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.count).toBe(3);
    });

    it('same message after window creates new entry', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1000));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: 'repeat' }]));
      vi.setSystemTime(new Date(3500));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: 'repeat' }]));

      const entries = sensor.getEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0]!.count).toBe(1);
      expect(entries[1]!.count).toBe(1);
    });

    it('different text but same level are tracked separately', () => {
      transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: 'a' }]));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: 'b' }]));
      expect(sensor.getEntries()).toHaveLength(2);
    });

    it('same text but different level are tracked separately', () => {
      transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: 'x' }]));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('warning', [{ type: 'string', value: 'x' }]));
      expect(sensor.getEntries()).toHaveLength(2);
    });

    it('counts dedup in summary', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1000));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: 'repeat' }]));
      vi.setSystemTime(new Date(1100));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: 'repeat' }]));
      vi.setSystemTime(new Date(1200));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: 'repeat' }]));

      const summary = await sensor.summarize();
      expect(summary.dedupCount).toBe(2);
      expect(summary.total).toBe(1);
    });
  });

  describe('maxEntries eviction', () => {
    it('evicts oldest when exceeding maxEntries', () => {
      const small = new AudioSensor(transport, { maxEntries: 3 });
      small.subscribe();
      transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [{ type: 'string', value: 'a' }]));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [{ type: 'string', value: 'b' }]));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [{ type: 'string', value: 'c' }]));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [{ type: 'string', value: 'd' }]));

      const entries = small.getEntries();
      expect(entries).toHaveLength(3);
      expect(entries.map((e) => e.text)).toEqual(['b', 'c', 'd']);
    });

    it('eviction removes from dedupMap so evicted key can be re-added', () => {
      const small = new AudioSensor(transport, { maxEntries: 3 });
      small.subscribe();
      transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [{ type: 'string', value: 'a' }]));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [{ type: 'string', value: 'b' }]));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [{ type: 'string', value: 'c' }]));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [{ type: 'string', value: 'd' }]));
      expect(small.getEntries()).toHaveLength(3);
      expect(small.getEntries().map((e) => e.text)).toEqual(['b', 'c', 'd']);

      vi.useFakeTimers();
      vi.setSystemTime(new Date(5000));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [{ type: 'string', value: 'a' }]));
      const entries = small.getEntries();
      expect(entries).toHaveLength(3);
      expect(entries[2]!.text).toBe('a');
      expect(entries[2]!.count).toBe(1);
    });
  });

  describe('summarize', () => {
    it('groups entries by level correctly', async () => {
      transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: 'e1' }]));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('warning', [{ type: 'string', value: 'w1' }]));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [{ type: 'string', value: 'l1' }]));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('info', [{ type: 'string', value: 'i1' }]));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('debug', [{ type: 'string', value: 'd1' }]));
      transport.emit('Runtime.exceptionThrown', exceptionEvent('Boom'));

      const summary = await sensor.summarize();
      expect(summary.total).toBe(6);
      expect(summary.errors).toHaveLength(2);
      expect(summary.warnings).toHaveLength(1);
      expect(summary.logs).toHaveLength(3);
      expect(summary.uncaughtExceptions).toHaveLength(1);
    });

    it('returns zeros for empty state', async () => {
      const summary = await sensor.summarize();
      expect(summary.total).toBe(0);
      expect(summary.errors).toHaveLength(0);
      expect(summary.warnings).toHaveLength(0);
      expect(summary.logs).toHaveLength(0);
      expect(summary.uncaughtExceptions).toHaveLength(0);
      expect(summary.dedupCount).toBe(0);
    });

    it('uncaughtExceptions contains only entries with stackTrace', async () => {
      transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: 'normal error' }]));
      transport.emit('Runtime.exceptionThrown', exceptionEvent('exception'));
      const summary = await sensor.summarize();
      expect(summary.uncaughtExceptions).toHaveLength(1);
      expect(summary.uncaughtExceptions[0]!.text).toBe('exception');
    });
  });

  describe('getAnomalies', () => {
    it('returns warning when more than 5 errors', async () => {
      for (let i = 0; i < 6; i++) {
        transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: `e${i}` }]));
      }
      const anomalies = await sensor.getAnomalies();
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0]!.domain).toBe('console');
      expect(anomalies[0]!.severity).toBe('warning');
      expect(anomalies[0]!.message).toContain('6');
    });

    it('returns empty when <= 5 errors', async () => {
      for (let i = 0; i < 5; i++) {
        transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: `e${i}` }]));
      }
      const anomalies = await sensor.getAnomalies();
      expect(anomalies).toHaveLength(0);
    });

    it('does not count deduped duplicates toward >5 threshold', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1000));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: 'same' }]));
      for (let i = 0; i < 10; i++) {
        vi.setSystemTime(new Date(1000 + i * 10));
        transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: 'same' }]));
      }
      const anomalies = await sensor.getAnomalies();
      expect(anomalies).toHaveLength(0);
    });
  });

  describe('clear', () => {
    it('empties all entries, dedupMap, and dedupCount', async () => {
      transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: 'e' }]));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [{ type: 'string', value: 'e' }]));
      expect(sensor.getEntries()).toHaveLength(2);

      sensor.clear();
      expect(sensor.getEntries()).toHaveLength(0);

      const summary = await sensor.summarize();
      expect(summary.total).toBe(0);
      expect(summary.dedupCount).toBe(0);
    });

    it('after clear, same message creates new entry (not deduped)', () => {
      transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: 'x' }]));
      sensor.clear();
      transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: 'x' }]));
      const entries = sensor.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.count).toBe(1);
    });
  });

  describe('readEntries', () => {
    it('errorsOnly filters to error level', () => {
      transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: 'e1' }]));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('warning', [{ type: 'string', value: 'w1' }]));
      transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [{ type: 'string', value: 'l1' }]));
      transport.emit('Runtime.exceptionThrown', exceptionEvent('Boom'));
      const entries = sensor.readEntries({ errorsOnly: true });
      expect(entries.map((e) => e.text)).toEqual(['e1', 'Boom']);
    });

    it('max returns the most recent N entries', () => {
      for (let i = 0; i < 5; i++) {
        transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [{ type: 'string', value: `m${i}` }]));
      }
      const entries = sensor.readEntries({ max: 2 });
      expect(entries.map((e) => e.text)).toEqual(['m3', 'm4']);
    });

    it('default max is 100', () => {
      for (let i = 0; i < 150; i++) {
        transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [{ type: 'string', value: `m${i}` }]));
      }
      const entries = sensor.readEntries();
      expect(entries).toHaveLength(100);
      expect(entries[0]!.text).toBe('m50');
      expect(entries[99]!.text).toBe('m149');
    });

    it('does not mutate the buffer (read then read again)', () => {
      transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [{ type: 'string', value: 'x' }]));
      expect(sensor.readEntries()).toHaveLength(1);
      expect(sensor.readEntries()).toHaveLength(1);
    });

    it('clear empties the buffer for incremental reads', () => {
      transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [{ type: 'string', value: 'x' }]));
      sensor.clear();
      expect(sensor.readEntries()).toHaveLength(0);
    });
  });

  describe('ring buffer retention', () => {
    it('retains 500 entries by default', () => {
      for (let i = 0; i < 600; i++) {
        transport.emit('Runtime.consoleAPICalled', consoleEvent('log', [{ type: 'string', value: `m${i}` }]));
      }
      const entries = sensor.getEntries();
      expect(entries).toHaveLength(500);
      expect(entries[0]!.text).toBe('m100');
      expect(entries[499]!.text).toBe('m599');
    });
  });

  describe('lifecycle', () => {
    it('unsubscribe stops processing consoleAPICalled', () => {
      sensor.unsubscribe();
      transport.emit('Runtime.consoleAPICalled', consoleEvent('error', [{ type: 'string', value: 'after-unsub' }]));
      expect(sensor.getEntries()).toHaveLength(0);
    });

    it('unsubscribe stops processing exceptionThrown', () => {
      sensor.unsubscribe();
      transport.emit('Runtime.exceptionThrown', exceptionEvent('after-unsub'));
      expect(sensor.getEntries()).toHaveLength(0);
    });

    it('unsubscribe removes handlers from transport', () => {
      expect(transport.handlerCount('Runtime.consoleAPICalled')).toBe(1);
      sensor.unsubscribe();
      expect(transport.handlerCount('Runtime.consoleAPICalled')).toBe(0);
      expect(transport.handlerCount('Runtime.exceptionThrown')).toBe(0);
    });

    it('subscribe is idempotent', () => {
      sensor.subscribe();
      sensor.subscribe();
      expect(transport.handlerCount('Runtime.consoleAPICalled')).toBe(1);
    });
  });
});