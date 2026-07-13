import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ThreatSensor } from '../../src/vision/threat.js';
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

  async send(_method: string, _params?: Record<string, any>): Promise<any> {
    return {};
  }
}

describe('ThreatSensor', () => {
  let transport: MockTransport;
  let sensor: ThreatSensor;

  beforeEach(() => {
    transport = new MockTransport();
    sensor = new ThreatSensor(transport);
    sensor.subscribe();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('subscribe', () => {
    it('registers Security.securityStateChanged handler', () => {
      expect(transport.handlerCount('Security.securityStateChanged')).toBe(1);
    });

    it('registers Security.certificateError handler', () => {
      expect(transport.handlerCount('Security.certificateError')).toBe(1);
    });

    it('registers Network.requestWillBeSent handler', () => {
      expect(transport.handlerCount('Network.requestWillBeSent')).toBe(1);
    });

    it('registers Network.loadingFailed handler', () => {
      expect(transport.handlerCount('Network.loadingFailed')).toBe(1);
    });
  });

  describe('securityStateChanged', () => {
    it('updates state and explanations', async () => {
      transport.emit('Security.securityStateChanged', {
        securityState: 'insecure',
        schemeIsCryptographic: false,
        explanations: [
          {
            securityState: 'insecure',
            title: 'Mixed content',
            summary: 'HTTP on HTTPS',
            description: 'Page loads some resources over HTTP',
            certificate: ['bad-cert-1'],
            recommendation: 'Use HTTPS for all resources',
          },
        ],
      });

      const summary = await sensor.summarize();
      expect(summary.state).toBe('insecure');
      expect(summary.schemeIsCryptographic).toBe(false);
      expect(summary.explanations).toHaveLength(1);
      expect(summary.explanations[0]!.title).toBe('Mixed content');
      expect(summary.explanations[0]!.summary).toBe('HTTP on HTTPS');
      expect(summary.explanations[0]!.description).toBe('Page loads some resources over HTTP');
      expect(summary.explanations[0]!.certificate).toEqual(['bad-cert-1']);
      expect(summary.explanations[0]!.recommendation).toBe('Use HTTPS for all resources');
    });

    it('defaults missing fields', async () => {
      transport.emit('Security.securityStateChanged', {
        explanations: [{}],
      });

      const summary = await sensor.summarize();
      expect(summary.state).toBe('info');
      expect(summary.explanations[0]!.securityState).toBe('info');
      expect(summary.explanations[0]!.title).toBe('');
      expect(summary.explanations[0]!.summary).toBe('');
      expect(summary.explanations[0]!.description).toBe('');
    });
  });

  describe('certificateError', () => {
    it('increments certificateErrors count', async () => {
      transport.emit('Security.certificateError', { eventId: 1, errorType: 'net::ERR_CERT_AUTHORITY_INVALID', requestId: 'r1' });
      transport.emit('Security.certificateError', { eventId: 2, errorType: 'net::ERR_CERT_DATE_INVALID', requestId: 'r2' });

      const summary = await sensor.summarize();
      expect(summary.certificateErrors).toBe(2);
    });
  });

  describe('mixed content', () => {
    it('https page + http resource increments count', async () => {
      transport.emit('Network.requestWillBeSent', { type: 'Document', request: { url: 'https://example.com/' } });
      transport.emit('Network.requestWillBeSent', { request: { url: 'http://example.com/img.png' } });
      transport.emit('Network.requestWillBeSent', { request: { url: 'http://example.com/script.js' } });

      const summary = await sensor.summarize();
      expect(summary.mixedContentRequests).toBe(2);
    });

    it('https page + https resource does NOT increment', async () => {
      transport.emit('Network.requestWillBeSent', { type: 'Document', request: { url: 'https://example.com/' } });
      transport.emit('Network.requestWillBeSent', { request: { url: 'https://example.com/img.png' } });

      const summary = await sensor.summarize();
      expect(summary.mixedContentRequests).toBe(0);
    });

    it('http page + http resource does NOT increment', async () => {
      transport.emit('Network.requestWillBeSent', { type: 'Document', request: { url: 'http://example.com/' } });
      transport.emit('Network.requestWillBeSent', { request: { url: 'http://example.com/img.png' } });

      const summary = await sensor.summarize();
      expect(summary.mixedContentRequests).toBe(0);
    });
  });

  describe('loadingFailed', () => {
    it('CSP blockedReason increments cspViolations', async () => {
      transport.emit('Network.loadingFailed', { requestId: 'r1', blockedReason: 'csp' });
      transport.emit('Network.loadingFailed', { requestId: 'r2', blockedReason: 'CSP-violation' });

      const summary = await sensor.summarize();
      expect(summary.cspViolations).toBe(2);
      expect(summary.blockedRequests).toHaveLength(2);
    });

    it('non-CSP blockedReason does NOT increment cspViolations', async () => {
      transport.emit('Network.loadingFailed', { requestId: 'r1', blockedReason: 'cors' });
      transport.emit('Network.loadingFailed', { requestId: 'r2', blockedReason: 'mixed-content' });
      transport.emit('Network.loadingFailed', { requestId: 'r3', blockedReason: 'origin' });

      const summary = await sensor.summarize();
      expect(summary.cspViolations).toBe(0);
      expect(summary.blockedRequests).toHaveLength(3);
    });

    it('without blockedReason is ignored', async () => {
      transport.emit('Network.loadingFailed', { requestId: 'r1', errorText: 'net::ERR_FAILED' });

      const summary = await sensor.summarize();
      expect(summary.blockedRequests).toHaveLength(0);
    });

    it('CSP violation is not double-counted in totalThreats', async () => {
      transport.emit('Network.loadingFailed', { requestId: 'r1', url: 'http://x/blocked', blockedReason: 'csp' });

      const summary = await sensor.summarize();
      expect(summary.cspViolations).toBe(1);
      expect(summary.blockedRequests).toHaveLength(1);
      expect(summary.totalThreats).toBe(1);
    });
  });

  describe('blockedRequests cap', () => {
    it('capped at maxBlockedRequests with FIFO eviction', async () => {
      const small = new ThreatSensor(transport, { maxBlockedRequests: 3 });
      small.subscribe();

      transport.emit('Network.loadingFailed', { requestId: '1', url: 'http://a/1', blockedReason: 'csp' });
      transport.emit('Network.loadingFailed', { requestId: '2', url: 'http://a/2', blockedReason: 'csp' });
      transport.emit('Network.loadingFailed', { requestId: '3', url: 'http://a/3', blockedReason: 'csp' });
      transport.emit('Network.loadingFailed', { requestId: '4', url: 'http://a/4', blockedReason: 'csp' });
      transport.emit('Network.loadingFailed', { requestId: '5', url: 'http://a/5', blockedReason: 'csp' });

      const summary = await small.summarize();
      expect(summary.blockedRequests).toHaveLength(3);
      expect(summary.blockedRequests[0]!.url).toBe('http://a/3');
      expect(summary.blockedRequests[1]!.url).toBe('http://a/4');
      expect(summary.blockedRequests[2]!.url).toBe('http://a/5');
    });
  });

  describe('summarize', () => {
    it('returns correct counts and totalThreats', async () => {
      transport.emit('Security.securityStateChanged', { securityState: 'insecure', schemeIsCryptographic: false, explanations: [] });
      transport.emit('Security.certificateError', { eventId: 1, errorType: 'x', requestId: 'r1' });
      transport.emit('Network.requestWillBeSent', { type: 'Document', request: { url: 'https://x.com/' } });
      transport.emit('Network.requestWillBeSent', { request: { url: 'http://x.com/img.png' } });
      transport.emit('Network.requestWillBeSent', { request: { url: 'http://x.com/script.js' } });
      transport.emit('Network.loadingFailed', { requestId: 'r1', url: 'http://x/blocked1', blockedReason: 'csp' });
      transport.emit('Network.loadingFailed', { requestId: 'r2', url: 'http://x/blocked2', blockedReason: 'cors' });

      const summary = await sensor.summarize();
      expect(summary.state).toBe('insecure');
      expect(summary.schemeIsCryptographic).toBe(false);
      expect(summary.mixedContentRequests).toBe(2);
      expect(summary.cspViolations).toBe(1);
      expect(summary.certificateErrors).toBe(1);
      expect(summary.blockedRequests).toHaveLength(2);
      expect(summary.totalThreats).toBe(2 + 1 + 1 + 1);
    });

    it('returns default values for empty state', async () => {
      const fresh = new ThreatSensor(transport);
      const summary = await fresh.summarize();
      expect(summary.state).toBe('info');
      expect(summary.schemeIsCryptographic).toBe(false);
      expect(summary.explanations).toEqual([]);
      expect(summary.mixedContentRequests).toBe(0);
      expect(summary.cspViolations).toBe(0);
      expect(summary.certificateErrors).toBe(0);
      expect(summary.blockedRequests).toEqual([]);
      expect(summary.totalThreats).toBe(0);
    });
  });

  describe('getAnomalies', () => {
    it('critical on insecure state', async () => {
      transport.emit('Security.securityStateChanged', { securityState: 'insecure', schemeIsCryptographic: false, explanations: [] });

      const anomalies = await sensor.getAnomalies();
      const stateAnomaly = anomalies.find((a) => a.message.includes('insecure'));
      expect(stateAnomaly).toBeDefined();
      expect(stateAnomaly!.severity).toBe('critical');
      expect(stateAnomaly!.domain).toBe('security');
    });

    it('critical on broken state', async () => {
      transport.emit('Security.securityStateChanged', { securityState: 'broken', schemeIsCryptographic: false, explanations: [] });

      const anomalies = await sensor.getAnomalies();
      const stateAnomaly = anomalies.find((a) => a.message.includes('broken'));
      expect(stateAnomaly).toBeDefined();
      expect(stateAnomaly!.severity).toBe('critical');
    });

    it('critical on certificate errors', async () => {
      transport.emit('Security.certificateError', { eventId: 1, errorType: 'x', requestId: 'r1' });

      const anomalies = await sensor.getAnomalies();
      const certAnomaly = anomalies.find((a) => a.message.includes('certificate'));
      expect(certAnomaly).toBeDefined();
      expect(certAnomaly!.severity).toBe('critical');
    });

    it('warning on mixed content', async () => {
      transport.emit('Network.requestWillBeSent', { type: 'Document', request: { url: 'https://x.com/' } });
      transport.emit('Network.requestWillBeSent', { request: { url: 'http://x.com/img.png' } });

      const anomalies = await sensor.getAnomalies();
      const mcAnomaly = anomalies.find((a) => a.message.includes('mixed content'));
      expect(mcAnomaly).toBeDefined();
      expect(mcAnomaly!.severity).toBe('warning');
    });

    it('warning on CSP violations', async () => {
      transport.emit('Network.loadingFailed', { requestId: 'r1', blockedReason: 'csp' });

      const anomalies = await sensor.getAnomalies();
      const cspAnomaly = anomalies.find((a) => a.message.includes('CSP'));
      expect(cspAnomaly).toBeDefined();
      expect(cspAnomaly!.severity).toBe('warning');
    });

    it('empty when secure with no issues', async () => {
      transport.emit('Security.securityStateChanged', { securityState: 'secure', schemeIsCryptographic: true, explanations: [] });

      const anomalies = await sensor.getAnomalies();
      expect(anomalies).toHaveLength(0);
    });
  });

  describe('clear', () => {
    it('resets all state', async () => {
      transport.emit('Security.securityStateChanged', { securityState: 'insecure', schemeIsCryptographic: false, explanations: [{ securityState: 'insecure', title: 'x', summary: 'y', description: 'z' }] });
      transport.emit('Security.certificateError', { eventId: 1, errorType: 'x', requestId: 'r1' });
      transport.emit('Network.requestWillBeSent', { type: 'Document', request: { url: 'https://x.com/' } });
      transport.emit('Network.requestWillBeSent', { request: { url: 'http://x.com/img.png' } });
      transport.emit('Network.loadingFailed', { requestId: 'r1', url: 'http://x/b', blockedReason: 'csp' });

      sensor.clear();

      const summary = await sensor.summarize();
      expect(summary.state).toBe('info');
      expect(summary.explanations).toEqual([]);
      expect(summary.certificateErrors).toBe(0);
      expect(summary.blockedRequests).toEqual([]);
      expect(summary.mixedContentRequests).toBe(0);
      expect(summary.cspViolations).toBe(0);
      expect(summary.totalThreats).toBe(0);
    });
  });

  describe('unsubscribe', () => {
    it('stops processing events', async () => {
      sensor.unsubscribe();
      transport.emit('Security.securityStateChanged', { securityState: 'insecure', schemeIsCryptographic: false, explanations: [] });
      transport.emit('Security.certificateError', { eventId: 1, errorType: 'x', requestId: 'r1' });
      transport.emit('Network.loadingFailed', { requestId: 'r1', blockedReason: 'csp' });

      const summary = await sensor.summarize();
      expect(summary.state).toBe('info');
      expect(summary.certificateErrors).toBe(0);
      expect(summary.cspViolations).toBe(0);
    });

    it('removes handlers from transport', () => {
      expect(transport.handlerCount('Security.securityStateChanged')).toBe(1);
      expect(transport.handlerCount('Network.requestWillBeSent')).toBe(1);
      sensor.unsubscribe();
      expect(transport.handlerCount('Security.securityStateChanged')).toBe(0);
      expect(transport.handlerCount('Security.certificateError')).toBe(0);
      expect(transport.handlerCount('Network.requestWillBeSent')).toBe(0);
      expect(transport.handlerCount('Network.loadingFailed')).toBe(0);
    });
  });
});
