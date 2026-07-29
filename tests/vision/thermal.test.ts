import { describe, it, expect, beforeEach } from 'vitest';
import {
  ThermalSensor,
  type Transport,
  type NetworkTransaction,
} from '../../src/vision/thermal.js';

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

  async send(_method: string, _params?: Record<string, any>): Promise<any> {
    return {};
  }
}

function req(requestId: string, url: string, overrides: Record<string, any> = {}): any {
  return {
    requestId,
    request: {
      url,
      method: 'GET',
      headers: {},
      ...overrides.request,
    },
    timestamp: 1.0,
    type: 'Document',
    initiator: { type: 'other' },
    hasUserGesture: false,
    ...overrides,
  };
}

function resp(overrides: Record<string, any> = {}): any {
  return {
    url: 'http://example.com',
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    mimeType: 'application/json',
    encodedDataSize: 1024,
    decodedBodySize: 2048,
    timing: {
      requestTime: 1.0,
      dnsStart: 1.001,
      dnsEnd: 1.005,
      connectStart: 1.006,
      connectEnd: 1.020,
      sslStart: 1.021,
      sslEnd: 1.040,
      sendStart: 1.041,
      sendEnd: 1.050,
      receiveHeadersEnd: 1.100,
    },
    fromDiskCache: false,
    fromServiceWorker: false,
    remoteIPAddress: '127.0.0.1',
    remotePort: 443,
    ...overrides,
  };
}

describe('BaseSensor', () => {
  describe('subscribe / unsubscribe / active', () => {
    it('subscribe sets active=true', () => {
      const t = new MockTransport();
      const sensor = new ThermalSensor(t);
      expect(sensor.active).toBe(false);
      sensor.subscribe();
      expect(sensor.active).toBe(true);
    });

    it('unsubscribe sets active=false and removes handlers', () => {
      const t = new MockTransport();
      const sensor = new ThermalSensor(t);
      sensor.subscribe();
      expect(t.handlerCount('Network.requestWillBeSent')).toBeGreaterThan(0);
      sensor.unsubscribe();
      expect(sensor.active).toBe(false);
      expect(t.handlerCount('Network.requestWillBeSent')).toBe(0);
      expect(t.handlerCount('Network.responseReceived')).toBe(0);
      expect(t.handlerCount('Network.loadingFinished')).toBe(0);
    });

    it('subscribe is idempotent — calling twice does not double-register', () => {
      const t = new MockTransport();
      const sensor = new ThermalSensor(t);
      sensor.subscribe();
      const count = t.handlerCount('Network.requestWillBeSent');
      sensor.subscribe();
      expect(t.handlerCount('Network.requestWillBeSent')).toBe(count);
    });

    it('on() helper tracks unsubscriptions and clears them on unsubscribe', () => {
      const t = new MockTransport();
      const sensor = new ThermalSensor(t);
      sensor.subscribe();
      const before = t.handlerCount('Network.requestWillBeSent');
      sensor.unsubscribe();
      expect(t.handlerCount('Network.requestWillBeSent')).toBe(0);
      expect(before).toBeGreaterThan(0);
    });
  });
});

describe('ThermalSensor', () => {
  let transport: MockTransport;
  let sensor: ThermalSensor;

  beforeEach(() => {
    transport = new MockTransport();
    sensor = new ThermalSensor(transport);
    sensor.subscribe();
  });

  describe('event correlation', () => {
    it('requestWillBeSent creates a pending transaction', () => {
      transport.emit('Network.requestWillBeSent', req('r1', 'http://a/x'));
      const txns = sensor.getTransactions();
      expect(txns).toHaveLength(1);
      expect(txns[0]!.id).toBe('r1');
      expect(txns[0]!.state).toBe('pending');
      expect(txns[0]!.request.url).toBe('http://a/x');
      expect(txns[0]!.request.method).toBe('GET');
      expect(txns[0]!.startedAt).toBe(1.0);
    });

    it('responseReceived updates to receiving state with response info', () => {
      transport.emit('Network.requestWillBeSent', req('r1', 'http://a/x'));
      transport.emit('Network.responseReceived', { requestId: 'r1', response: resp() });
      const t = sensor.getTransactions()[0]!;
      expect(t.state).toBe('receiving');
      expect(t.response).toBeDefined();
      expect(t.response!.status).toBe(200);
      expect(t.response!.mimeType).toBe('application/json');
      expect(t.response!.remoteIP).toBe('127.0.0.1');
    });

    it('loadingFinished marks completed and sets duration', () => {
      transport.emit('Network.requestWillBeSent', req('r1', 'http://a/x', { timestamp: 1.0 }));
      transport.emit('Network.responseReceived', { requestId: 'r1', response: resp() });
      transport.emit('Network.loadingFinished', { requestId: 'r1', timestamp: 1.5 });
      const t = sensor.getTransactions()[0]!;
      expect(t.state).toBe('completed');
      expect(t.finishedAt).toBe(1.5);
      expect(t.durationMs).toBe(500);
    });

    it('loadingFailed marks failed with error info', () => {
      transport.emit('Network.requestWillBeSent', req('r1', 'http://a/x'));
      transport.emit('Network.loadingFailed', {
        requestId: 'r1',
        timestamp: 1.2,
        errorText: 'net::ERR_NAME_NOT_RESOLVED',
        canceled: false,
        url: 'http://a/x',
        blockedReason: 'inspector',
      });
      const t = sensor.getTransactions()[0]!;
      expect(t.state).toBe('failed');
      expect(t.error).toBeDefined();
      expect(t.error!.errorText).toBe('net::ERR_NAME_NOT_RESOLVED');
      expect(t.error!.canceled).toBe(false);
      expect(t.error!.blockedReason).toBe('inspector');
      expect(t.error!.failedUrl).toBe('http://a/x');
      expect(t.durationMs).toBe(200);
    });

    it('requestServedFromCache marks cached and sets fromCache', () => {
      transport.emit('Network.requestWillBeSent', req('r1', 'http://a/x'));
      transport.emit('Network.responseReceived', { requestId: 'r1', response: resp() });
      transport.emit('Network.requestServedFromCache', { requestId: 'r1' });
      const t = sensor.getTransactions()[0]!;
      expect(t.state).toBe('cached');
      expect(t.response!.fromCache).toBe(true);
    });

    it('data: URL creates a completed transaction immediately', () => {
      transport.emit(
        'Network.requestWillBeSent',
        req('r1', 'data:text/html,<h1>x</h1>', { timestamp: 1.0 }),
      );
      const t = sensor.getTransactions()[0]!;
      expect(t.state).toBe('completed');
      expect(t.finishedAt).toBe(1.0);
      expect(t.durationMs).toBe(0);
    });

    it('blob: URL creates a completed transaction immediately', () => {
      transport.emit(
        'Network.requestWillBeSent',
        req('r1', 'blob:http://example.com/uuid', { timestamp: 1.0 }),
      );
      const t = sensor.getTransactions()[0]!;
      expect(t.state).toBe('completed');
      expect(t.durationMs).toBe(0);
    });

    it('redirect: requestWillBeSent with redirectResponse updates redirectChain', () => {
      transport.emit('Network.requestWillBeSent', req('r1', 'http://a/original'));
      transport.emit('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'http://a/final', method: 'GET', headers: {} },
        timestamp: 1.1,
        type: 'Document',
        initiator: { type: 'redirect' },
        hasUserGesture: false,
        redirectResponse: resp({ status: 301, statusText: 'Moved Permanently' }),
      });
      const t = sensor.getTransactions()[0]!;
      expect(t.request.url).toBe('http://a/final');
      expect(t.redirectChain).toEqual(['http://a/original']);
      expect(t.response).toBeDefined();
      expect(t.response!.status).toBe(301);
    });

    it('webSocketCreated sets isWebSocket=true and creates synthetic transaction if missing', () => {
      transport.emit('Network.webSocketCreated', {
        requestId: 'ws1',
        url: 'ws://example.com/socket',
      });
      const t = sensor.getTransactions()[0]!;
      expect(t.isWebSocket).toBe(true);
      expect(t.request.url).toBe('ws://example.com/socket');
      expect(t.request.method).toBe('GET');
    });

    it('multiple dataReceived increments dataChunks', () => {
      transport.emit('Network.requestWillBeSent', req('r1', 'http://a/x'));
      transport.emit('Network.dataReceived', { requestId: 'r1', dataLength: 100 });
      transport.emit('Network.dataReceived', { requestId: 'r1', dataLength: 200 });
      transport.emit('Network.dataReceived', { requestId: 'r1', dataLength: 300 });
      expect(sensor.getTransactions()[0]!.dataChunks).toBe(3);
    });

    it('full lifecycle: request -> response -> data -> finished produces correct transaction', () => {
      transport.emit('Network.requestWillBeSent', req('r1', 'http://a/api', {
        request: { url: 'http://a/api', method: 'POST', headers: { 'x-foo': 'bar' }, postData: '{"a":1}' },
        type: 'Fetch',
        initiator: { type: 'script', url: 'http://a/main.js' },
        hasUserGesture: true,
        timestamp: 1.0,
      }));
      transport.emit('Network.responseReceived', {
        requestId: 'r1',
        response: resp({ mimeType: 'application/json', status: 201 }),
      });
      transport.emit('Network.dataReceived', { requestId: 'r1', dataLength: 50 });
      transport.emit('Network.dataReceived', { requestId: 'r1', dataLength: 50 });
      transport.emit('Network.loadingFinished', { requestId: 'r1', timestamp: 1.3 });

      const t = sensor.getTransactions()[0]!;
      expect(t.state).toBe('completed');
      expect(t.request.method).toBe('POST');
      expect(t.request.postData).toBe('{"a":1}');
      expect(t.request.resourceType).toBe('Fetch');
      expect(t.request.initiatorType).toBe('script');
      expect(t.request.initiatorUrl).toBe('http://a/main.js');
      expect(t.request.hasUserGesture).toBe(true);
      expect(t.response!.status).toBe(201);
      expect(t.response!.mimeType).toBe('application/json');
      expect(t.dataChunks).toBe(2);
      expect(t.durationMs).toBe(300);
    });
  });

  describe('summarize', () => {
    function emitComplete(url: string, opts: any = {}): void {
      transport.emit('Network.requestWillBeSent', req(opts.id ?? 'r', url, {
        timestamp: opts.start ?? 1.0,
        type: opts.type ?? 'Document',
      }));
      transport.emit('Network.responseReceived', {
        requestId: opts.id ?? 'r',
        response: resp({
          status: opts.status ?? 200,
          mimeType: opts.mimeType ?? 'text/html',
          encodedDataSize: opts.encoded ?? 0,
          decodedBodySize: opts.decoded ?? 0,
        }),
      });
      transport.emit('Network.loadingFinished', {
        requestId: opts.id ?? 'r',
        timestamp: (opts.start ?? 1.0) + (opts.duration ?? 0.1),
      });
    }

    it('returns correct counts (total, completed, failed, pending)', async () => {
      emitComplete('http://a/1', { id: 'r1' });
      emitComplete('http://a/2', { id: 'r2' });
      transport.emit('Network.requestWillBeSent', req('r3', 'http://a/3'));
      transport.emit('Network.requestWillBeSent', req('r4', 'http://a/4'));
      transport.emit('Network.loadingFailed', {
        requestId: 'r4',
        timestamp: 1.0,
        errorText: 'failed',
      });

      const s = await sensor.summarize();
      expect(s.total).toBe(4);
      expect(s.completed).toBe(2);
      expect(s.failed).toBe(1);
      expect(s.pending).toBe(1);
    });

    it('groups by resourceType', async () => {
      emitComplete('http://a/x', { id: 'r1', type: 'Document' });
      emitComplete('http://a/y.js', { id: 'r2', type: 'Script' });
      emitComplete('http://a/z.js', { id: 'r3', type: 'Script' });
      emitComplete('http://a/img.png', { id: 'r4', type: 'Image' });
      const s = await sensor.summarize();
      expect(s.byType['Document']).toBe(1);
      expect(s.byType['Script']).toBe(2);
      expect(s.byType['Image']).toBe(1);
    });

    it('groups by status category (2xx, 3xx, 4xx, 5xx)', async () => {
      emitComplete('http://a/1', { id: 'r1', status: 200 });
      emitComplete('http://a/2', { id: 'r2', status: 301 });
      emitComplete('http://a/3', { id: 'r3', status: 404 });
      emitComplete('http://a/4', { id: 'r4', status: 500 });
      const s = await sensor.summarize();
      expect(s.byStatus['2xx']).toBe(1);
      expect(s.byStatus['3xx']).toBe(1);
      expect(s.byStatus['4xx']).toBe(1);
      expect(s.byStatus['5xx']).toBe(1);
    });

    it('identifies slow requests (above threshold) sorted by duration desc', async () => {
      emitComplete('http://a/fast', { id: 'r1', duration: 0.05 });
      emitComplete('http://a/slow', { id: 'r2', duration: 3.0 });
      emitComplete('http://a/slower', { id: 'r3', duration: 5.0 });
      const s = await sensor.summarize({ slowThresholdMs: 1000 });
      expect(s.slow).toHaveLength(2);
      expect(s.slow[0]!.request.url).toBe('http://a/slower');
      expect(s.slow[1]!.request.url).toBe('http://a/slow');
    });

    it('identifies API calls (XHR/Fetch with JSON mime)', async () => {
      emitComplete('http://a/api/users', { id: 'r1', type: 'XHR', mimeType: 'application/json' });
      emitComplete('http://a/api/items', { id: 'r2', type: 'Fetch', mimeType: 'application/json' });
      emitComplete('http://a/main.js', { id: 'r3', type: 'Script', mimeType: 'application/javascript' });
      emitComplete('http://a/x.html', { id: 'r4', type: 'Document', mimeType: 'text/html' });
      const s = await sensor.summarize();
      expect(s.apiCalls).toHaveLength(2);
      const urls = s.apiCalls.map((t: NetworkTransaction) => t.request.url).sort();
      expect(urls).toEqual(['http://a/api/items', 'http://a/api/users']);
    });

    it('calculates total bytes across completed transactions', async () => {
      emitComplete('http://a/1', { id: 'r1', encoded: 100, decoded: 200 });
      emitComplete('http://a/2', { id: 'r2', encoded: 300, decoded: 600 });
      const s = await sensor.summarize();
      expect(s.totalEncodedBytes).toBe(400);
      expect(s.totalDecodedBytes).toBe(800);
    });

    it('filters by urlContains', async () => {
      emitComplete('http://a/api/users', { id: 'r1' });
      emitComplete('http://a/static/main.js', { id: 'r2' });
      emitComplete('http://a/api/orders', { id: 'r3' });
      const s = await sensor.summarize({ urlContains: '/api/' });
      expect(s.total).toBe(2);
      expect(s.completed).toBe(2);
    });

    it('filters by resourceType', async () => {
      emitComplete('http://a/1', { id: 'r1', type: 'Document' });
      emitComplete('http://a/2.js', { id: 'r2', type: 'Script' });
      emitComplete('http://a/3.js', { id: 'r3', type: 'Script' });
      const s = await sensor.summarize({ resourceType: 'Script' });
      expect(s.total).toBe(2);
    });
  });

  describe('lifecycle', () => {
    it('clear() empties all transactions', () => {
      transport.emit('Network.requestWillBeSent', req('r1', 'http://a/1'));
      transport.emit('Network.requestWillBeSent', req('r2', 'http://a/2'));
      expect(sensor.getTransactions()).toHaveLength(2);
      sensor.clear();
      expect(sensor.getTransactions()).toHaveLength(0);
    });

    it('eviction removes oldest when maxTransactions exceeded', () => {
      const small = new ThermalSensor(transport, { maxTransactions: 3 });
      small.subscribe();
      transport.emit('Network.requestWillBeSent', req('r1', 'http://a/1', { timestamp: 1.0 }));
      transport.emit('Network.requestWillBeSent', req('r2', 'http://a/2', { timestamp: 2.0 }));
      transport.emit('Network.requestWillBeSent', req('r3', 'http://a/3', { timestamp: 3.0 }));
      transport.emit('Network.requestWillBeSent', req('r4', 'http://a/4', { timestamp: 4.0 }));
      const ids = small.getTransactions().map((t) => t.id);
      expect(ids).toEqual(['r2', 'r3', 'r4']);
    });

    it('unsubscribe stops processing events', () => {
      sensor.unsubscribe();
      transport.emit('Network.requestWillBeSent', req('r1', 'http://a/1'));
      expect(sensor.getTransactions()).toHaveLength(0);
    });
  });

  describe('getAnomalies', () => {
    it('detects high failure rate (>30%) when total > 5', () => {
      for (let i = 0; i < 10; i++) {
        const id = `r${i}`;
        transport.emit('Network.requestWillBeSent', req(id, `http://a/${id}`));
        if (i < 4) {
          transport.emit('Network.loadingFailed', {
            requestId: id,
            timestamp: 1.0,
            errorText: 'fail',
          });
        }
      }
      const anomalies = sensor.getAnomalies();
      const failAnomaly = anomalies.find((a) => a.message.includes('failed'));
      expect(failAnomaly).toBeDefined();
      expect(failAnomaly!.severity).toBe('warning');
      expect(failAnomaly!.domain).toBe('network');
    });

    it('does not flag failure rate when total <= 5', () => {
      transport.emit('Network.requestWillBeSent', req('r1', 'http://a/1'));
      transport.emit('Network.loadingFailed', { requestId: 'r1', timestamp: 1.0, errorText: 'fail' });
      transport.emit('Network.requestWillBeSent', req('r2', 'http://a/2'));
      transport.emit('Network.loadingFailed', { requestId: 'r2', timestamp: 1.0, errorText: 'fail' });
      const anomalies = sensor.getAnomalies();
      const failAnomaly = anomalies.find((a) => a.message.includes('failed'));
      expect(failAnomaly).toBeUndefined();
    });

    it('detects very slow requests (> 10s) as warning', () => {
      transport.emit('Network.requestWillBeSent', req('r1', 'http://a/very-slow', { timestamp: 1.0 }));
      transport.emit('Network.responseReceived', { requestId: 'r1', response: resp() });
      transport.emit('Network.loadingFinished', { requestId: 'r1', timestamp: 12.0 });
      const anomalies = sensor.getAnomalies();
      const slow = anomalies.find((a) => a.message.includes('took'));
      expect(slow).toBeDefined();
      expect(slow!.severity).toBe('warning');
      expect(slow!.data).toMatchObject({ durationMs: 11000 });
    });
  });

  describe('readTransactions', () => {
    it('urlContains filters by URL substring', () => {
      transport.emit('Network.requestWillBeSent', req('r1', 'http://a/api/users'));
      transport.emit('Network.requestWillBeSent', req('r2', 'http://a/static/app.js'));
      transport.emit('Network.requestWillBeSent', req('r3', 'http://a/api/orders'));
      const txns = sensor.readTransactions({ urlContains: '/api/' });
      expect(txns.map((t) => t.id)).toEqual(['r1', 'r3']);
    });

    it('max returns the most recent N transactions', () => {
      for (let i = 0; i < 5; i++) {
        transport.emit('Network.requestWillBeSent', req(`r${i}`, `http://a/${i}`, { timestamp: i + 1 }));
      }
      const txns = sensor.readTransactions({ max: 2 });
      expect(txns.map((t) => t.id)).toEqual(['r3', 'r4']);
    });

    it('default max is 100', () => {
      for (let i = 0; i < 150; i++) {
        transport.emit('Network.requestWillBeSent', req(`r${i}`, `http://a/${i}`, { timestamp: i + 1 }));
      }
      const txns = sensor.readTransactions();
      expect(txns).toHaveLength(100);
      expect(txns[0]!.id).toBe('r50');
      expect(txns[99]!.id).toBe('r149');
    });

    it('filter combines with max', () => {
      for (let i = 0; i < 6; i++) {
        transport.emit('Network.requestWillBeSent', req(`r${i}`, `http://a/api/${i}`, { timestamp: i + 1 }));
      }
      transport.emit('Network.requestWillBeSent', req('other', 'http://a/static/x', { timestamp: 10 }));
      const txns = sensor.readTransactions({ urlContains: '/api/', max: 3 });
      expect(txns.map((t) => t.id)).toEqual(['r3', 'r4', 'r5']);
    });

    it('does not mutate the buffer (read then read again)', () => {
      transport.emit('Network.requestWillBeSent', req('r1', 'http://a/1'));
      expect(sensor.readTransactions()).toHaveLength(1);
      expect(sensor.readTransactions()).toHaveLength(1);
    });

    it('clear empties the buffer for incremental reads', () => {
      transport.emit('Network.requestWillBeSent', req('r1', 'http://a/1'));
      sensor.clear();
      expect(sensor.readTransactions()).toHaveLength(0);
    });
  });

  describe('ring buffer retention', () => {
    it('retains 500 transactions by default', () => {
      for (let i = 0; i < 600; i++) {
        transport.emit('Network.requestWillBeSent', req(`r${i}`, `http://a/${i}`, { timestamp: i + 1 }));
      }
      const txns = sensor.getTransactions();
      expect(txns).toHaveLength(500);
      expect(txns[0]!.id).toBe('r100');
      expect(txns[499]!.id).toBe('r599');
    });
  });
});