import { describe, it, expect, beforeEach } from 'vitest';
import {
  WorkingMemory,
  computeDiff,
  type BrowserState,
  type StateDiff,
} from '../../src/memory/browser-state.js';
import type { NetworkSummary } from '../../src/vision/thermal.js';
import type { DOMSummary } from '../../src/vision/em.js';
import type { ConsoleSummary } from '../../src/vision/audio.js';
import type { PerformanceSummary } from '../../src/vision/motion.js';
import type { SecuritySummary } from '../../src/vision/threat.js';

function makeNetwork(overrides: Partial<NetworkSummary> = {}): NetworkSummary {
  return {
    total: 10,
    completed: 8,
    failed: 1,
    pending: 1,
    byType: {},
    byStatus: {},
    slow: [],
    failedRequests: [],
    webSockets: [],
    apiCalls: [],
    totalEncodedBytes: 1024,
    totalDecodedBytes: 2048,
    ...overrides,
  };
}

function makeDOM(overrides: Partial<DOMSummary> = {}): DOMSummary {
  return {
    url: 'https://example.com',
    semantic: {
      pageType: 'dashboard',
      title: 'Dashboard',
      headings: ['Hello'],
      mainContentPreview: 'content',
      language: 'en',
    },
    interactive: {
      buttons: [],
      links: [],
      inputs: [],
      total: 0,
    },
    structural: {
      totalElements: 100,
      depth: 5,
      iframes: 0,
      images: 2,
      scripts: 3,
      forms: 1,
      stylesheets: 1,
    },
    ...overrides,
  };
}

function makeConsole(overrides: Partial<ConsoleSummary> = {}): ConsoleSummary {
  return {
    total: 0,
    errors: [],
    warnings: [],
    logs: [],
    uncaughtExceptions: [],
    dedupCount: 0,
    ...overrides,
  };
}

function makePerf(overrides: Partial<PerformanceSummary> = {}): PerformanceSummary {
  return {
    metrics: [],
    jsHeapUsedMB: 50.0,
    jsHeapTotalMB: 100.0,
    domNodes: 500,
    layoutCount: 10,
    recalcStyleCount: 20,
    scriptDurationMs: 100,
    taskDurationMs: 200,
    jsHeapTrend: 'stable',
    longTaskCount: 0,
    timestamp: 0,
    ...overrides,
  };
}

function makeSecurity(overrides: Partial<SecuritySummary> = {}): SecuritySummary {
  return {
    state: 'secure',
    schemeIsCryptographic: true,
    explanations: [],
    mixedContentRequests: 0,
    cspViolations: 0,
    certificateErrors: 0,
    blockedRequests: [],
    totalThreats: 0,
    ...overrides,
  };
}

function makeState(overrides: Partial<BrowserState> = {}): BrowserState {
  return {
    url: 'https://example.com/page1',
    title: 'Page One',
    readyState: 'complete',
    timestamp: 1000,
    network: makeNetwork(),
    dom: makeDOM(),
    console: makeConsole(),
    performance: makePerf(),
    security: makeSecurity(),
    ...overrides,
  };
}

describe('WorkingMemory', () => {
  let mem: WorkingMemory;

  beforeEach(() => {
    mem = new WorkingMemory(3);
  });

  describe('lifecycle', () => {
    it('snapshot returns null before first update', () => {
      expect(mem.snapshot()).toBeNull();
    });

    it('update sets current state', () => {
      const s = makeState({ url: 'https://a.com' });
      mem.update(s);
      expect(mem.snapshot()).toBe(s);
    });

    it('update pushes previous state to history', () => {
      const a = makeState({ url: 'https://a.com' });
      const b = makeState({ url: 'https://b.com' });
      mem.update(a);
      mem.update(b);
      expect(mem.snapshot()).toBe(b);
      expect(mem.getHistory()).toHaveLength(1);
      expect(mem.getHistory()[0]).toBe(a);
    });

    it('clear resets everything', () => {
      mem.update(makeState());
      mem.update(makeState());
      mem.clear();
      expect(mem.snapshot()).toBeNull();
      expect(mem.getHistory()).toEqual([]);
      expect(mem.size).toBe(0);
    });
  });

  describe('history', () => {
    it('returns oldest-to-newest array', () => {
      mem.update(makeState({ url: 'a' }));
      mem.update(makeState({ url: 'b' }));
      mem.update(makeState({ url: 'c' }));
      const hist = mem.getHistory();
      expect(hist.map((s) => s.url)).toEqual(['a', 'b']);
      expect(mem.snapshot()?.url).toBe('c');
    });

    it('respects maxSnapshots (eviction)', () => {
      const m = new WorkingMemory(2);
      m.update(makeState({ url: 'a' }));
      m.update(makeState({ url: 'b' }));
      m.update(makeState({ url: 'c' }));
      m.update(makeState({ url: 'd' }));
      expect(m.size).toBe(3);
      expect(m.getHistory().map((s) => s.url)).toEqual(['b', 'c']);
      expect(m.snapshot()?.url).toBe('d');
    });

    it('size returns current + history count', () => {
      const fresh = new WorkingMemory(5);
      expect(fresh.size).toBe(0);
      mem.update(makeState());
      expect(mem.size).toBe((mem.snapshot() ? 1 : 0) + mem.getHistory().length);
      mem.update(makeState());
      expect(mem.size).toBe((mem.snapshot() ? 1 : 0) + mem.getHistory().length);
      mem.update(makeState());
      expect(mem.size).toBe((mem.snapshot() ? 1 : 0) + mem.getHistory().length);
      mem.update(makeState());
      expect(mem.size).toBe((mem.snapshot() ? 1 : 0) + mem.getHistory().length);
      mem.update(makeState());
      expect(mem.size).toBe((mem.snapshot() ? 1 : 0) + mem.getHistory().length);
    });
  });

  describe('diff — no args', () => {
    it('compares current vs most recent history entry', () => {
      mem.update(makeState({ url: 'https://old.com' }));
      mem.update(makeState({ url: 'https://new.com' }));
      const d = mem.diff();
      expect(d).not.toBeNull();
      expect(d!.fields).toContain('url');
    });

    it('returns null when no history exists', () => {
      mem.update(makeState());
      expect(mem.diff()).toBeNull();
    });

    it('returns null when no current state', () => {
      expect(mem.diff()).toBeNull();
    });

    it('returns null when only one update happened (no history yet)', () => {
      mem.update(makeState());
      expect(mem.snapshot()).not.toBeNull();
      expect(mem.diff()).toBeNull();
    });
  });

  describe('diff — explicit before/after', () => {
    it('computes diff between explicit states', () => {
      const before = makeState({ url: 'x' });
      const after = makeState({ url: 'y' });
      const d = mem.diff(before, after);
      expect(d).not.toBeNull();
      expect(d!.fields).toContain('url');
    });

    it('returns null when before is null and no history', () => {
      const after = makeState();
      expect(mem.diff(undefined, after)).toBeNull();
    });
  });

  describe('diff — field detection', () => {
    it('detects url change', () => {
      const d = mem.diff(makeState({ url: 'a' }), makeState({ url: 'b' }));
      expect(d!.fields).toContain('url');
    });

    it('detects title change', () => {
      const d = mem.diff(makeState({ title: 'A' }), makeState({ title: 'B' }));
      expect(d!.fields).toContain('title');
    });

    it('detects readyState change', () => {
      const d = mem.diff(
        makeState({ readyState: 'loading' }),
        makeState({ readyState: 'complete' }),
      );
      expect(d!.fields).toContain('readyState');
    });

    it('detects network total change', () => {
      const before = makeState({ network: makeNetwork({ total: 5 }) });
      const after = makeState({ network: makeNetwork({ total: 8 }) });
      const d = mem.diff(before, after);
      expect(d!.fields).toContain('network.total');
      expect(d!.network.requestsDelta).toBe(3);
    });

    it('detects network completed change', () => {
      const before = makeState({ network: makeNetwork({ completed: 5 }) });
      const after = makeState({ network: makeNetwork({ completed: 9 }) });
      const d = mem.diff(before, after);
      expect(d!.fields).toContain('network.completed');
      expect(d!.network.completedDelta).toBe(4);
    });

    it('detects network failed change', () => {
      const before = makeState({ network: makeNetwork({ failed: 0 }) });
      const after = makeState({ network: makeNetwork({ failed: 3 }) });
      const d = mem.diff(before, after);
      expect(d!.fields).toContain('network.failed');
      expect(d!.network.failedDelta).toBe(3);
    });

    it('detects console error change via length delta', () => {
      const before = makeState({
        console: makeConsole({ errors: [{ level: 'error', text: 'e1', count: 1, timestamp: 0 }] }),
      });
      const after = makeState({
        console: makeConsole({
          errors: [
            { level: 'error', text: 'e1', count: 1, timestamp: 0 },
            { level: 'error', text: 'e2', count: 1, timestamp: 1 },
          ],
        }),
      });
      const d = mem.diff(before, after);
      expect(d!.fields).toContain('console.errors');
      expect(d!.console.errorsDelta).toBe(1);
    });

    it('detects console warning change via length delta', () => {
      const before = makeState({
        console: makeConsole({ warnings: [] }),
      });
      const after = makeState({
        console: makeConsole({
          warnings: [{ level: 'warning', text: 'w1', count: 1, timestamp: 0 }],
        }),
      });
      const d = mem.diff(before, after);
      expect(d!.fields).toContain('console.warnings');
      expect(d!.console.warningsDelta).toBe(1);
    });

    it('detects heap change', () => {
      const before = makeState({ performance: makePerf({ jsHeapUsedMB: 50.0 }) });
      const after = makeState({ performance: makePerf({ jsHeapUsedMB: 55.0 }) });
      const d = mem.diff(before, after);
      expect(d!.fields).toContain('performance.heap');
      expect(d!.performance.heapDeltaMB).toBe(5);
    });

    it('detects domNodes change', () => {
      const before = makeState({ performance: makePerf({ domNodes: 100 }) });
      const after = makeState({ performance: makePerf({ domNodes: 150 }) });
      const d = mem.diff(before, after);
      expect(d!.fields).toContain('performance.domNodes');
      expect(d!.performance.domNodesDelta).toBe(50);
    });

    it('detects security state change', () => {
      const before = makeState({
        security: makeSecurity({ state: 'secure', totalThreats: 0 }),
      });
      const after = makeState({
        security: makeSecurity({ state: 'insecure', totalThreats: 1 }),
      });
      const d = mem.diff(before, after);
      expect(d!.fields).toContain('security.state');
      expect(d!.security.stateChanged).toBe(true);
      expect(d!.security.oldState).toBe('secure');
      expect(d!.security.newState).toBe('insecure');
    });

    it('detects security threats delta', () => {
      const before = makeState({ security: makeSecurity({ totalThreats: 2 }) });
      const after = makeState({ security: makeSecurity({ totalThreats: 7 }) });
      const d = mem.diff(before, after);
      expect(d!.fields).toContain('security.threats');
      expect(d!.security.threatsDelta).toBe(5);
    });

    it('detects pageType change', () => {
      const before = makeState({
        dom: makeDOM({ semantic: { ...makeDOM().semantic, pageType: 'dashboard' } }),
      });
      const after = makeState({
        dom: makeDOM({ semantic: { ...makeDOM().semantic, pageType: 'article' } }),
      });
      const d = mem.diff(before, after);
      expect(d!.fields).toContain('dom.pageType');
      expect(d!.dom.pageTypeChanged).toBe(true);
      expect(d!.dom.oldPageType).toBe('dashboard');
      expect(d!.dom.newPageType).toBe('article');
    });

    it('detects interactive elements change via total', () => {
      const before = makeState({
        dom: makeDOM({ interactive: { ...makeDOM().interactive, total: 5 } }),
      });
      const after = makeState({
        dom: makeDOM({ interactive: { ...makeDOM().interactive, total: 9 } }),
      });
      const d = mem.diff(before, after);
      expect(d!.fields).toContain('dom.interactive');
      expect(d!.dom.interactiveElementsDelta).toBe(4);
    });

    it('fields array lists all changed fields when many change', () => {
      const before = makeState({
        url: 'a',
        title: 'A',
        network: makeNetwork({ total: 1 }),
        security: makeSecurity({ state: 'secure', totalThreats: 0 }),
      });
      const after = makeState({
        url: 'b',
        title: 'B',
        network: makeNetwork({ total: 2 }),
        security: makeSecurity({ state: 'insecure', totalThreats: 1 }),
      });
      const d = mem.diff(before, after);
      expect(d!.fields).toContain('url');
      expect(d!.fields).toContain('title');
      expect(d!.fields).toContain('network.total');
      expect(d!.fields).toContain('security.state');
      expect(d!.fields).toContain('security.threats');
    });
  });

  describe('handles realistic 5-sensor state', () => {
    it('update + diff round-trip with all 5 sensor summaries', () => {
      const before = makeState({
        url: 'https://app.example.com/login',
        title: 'Login',
        network: makeNetwork({ total: 5, completed: 4, failed: 1 }),
        console: makeConsole({
          errors: [{ level: 'error', text: 'e', count: 1, timestamp: 0 }],
        }),
        performance: makePerf({ jsHeapUsedMB: 30, domNodes: 200 }),
        security: makeSecurity({ state: 'secure', totalThreats: 0 }),
      });
      const after = makeState({
        url: 'https://app.example.com/dashboard',
        title: 'Dashboard',
        network: makeNetwork({ total: 15, completed: 14, failed: 1 }),
        console: makeConsole({
          errors: [
            { level: 'error', text: 'e', count: 1, timestamp: 0 },
            { level: 'error', text: 'e2', count: 1, timestamp: 1 },
          ],
        }),
        performance: makePerf({ jsHeapUsedMB: 35, domNodes: 250 }),
        security: makeSecurity({ state: 'secure', totalThreats: 1 }),
      });
      mem.update(before);
      mem.update(after);
      const d = mem.diff();
      expect(d).not.toBeNull();
      expect(d!.fields).toContain('url');
      expect(d!.fields).toContain('title');
      expect(d!.fields).toContain('network.total');
      expect(d!.fields).toContain('console.errors');
      expect(d!.fields).toContain('performance.heap');
      expect(d!.fields).toContain('performance.domNodes');
      expect(d!.fields).toContain('security.threats');
    });
  });
});

describe('computeDiff', () => {
  it('identical states produce all-zero deltas and empty fields', () => {
    const s = makeState();
    const d = computeDiff(s, s);
    expect(d.fields).toEqual([]);
    expect(d.network).toEqual({
      requestsDelta: 0,
      completedDelta: 0,
      failedDelta: 0,
      newSlow: 0,
      newFailed: 0,
    });
    expect(d.console).toEqual({ errorsDelta: 0, warningsDelta: 0 });
    expect(d.performance).toEqual({ heapDeltaMB: 0, domNodesDelta: 0 });
    expect(d.security).toEqual({
      threatsDelta: 0,
      stateChanged: false,
      oldState: undefined,
      newState: undefined,
    });
    expect(d.dom).toEqual({
      pageTypeChanged: false,
      oldPageType: undefined,
      newPageType: undefined,
      interactiveElementsDelta: 0,
    });
  });

  it('negative deltas (items removed) tracked correctly', () => {
    const before = makeState({
      network: makeNetwork({ total: 10 }),
      console: makeConsole({
        errors: [
          { level: 'error', text: 'a', count: 1, timestamp: 0 },
          { level: 'error', text: 'b', count: 1, timestamp: 1 },
        ],
      }),
    });
    const after = makeState({
      network: makeNetwork({ total: 6 }),
      console: makeConsole({
        errors: [{ level: 'error', text: 'a', count: 1, timestamp: 0 }],
      }),
    });
    const d = computeDiff(before, after);
    expect(d.network.requestsDelta).toBe(-4);
    expect(d.console.errorsDelta).toBe(-1);
  });

  it('newSlow is floored at zero when slow shrinks', () => {
    const slowTxn = {
      id: 't',
      state: 'completed' as const,
      redirectChain: [],
      request: {
        url: 'u',
        method: 'GET',
        headers: {},
        resourceType: 'Fetch' as const,
        initiatorType: 'fetch',
        hasUserGesture: false,
      },
      dataChunks: 1,
      isWebSocket: false,
      isSSE: false,
      startedAt: 0,
      durationMs: 5000,
    };
    const before = makeState({
      network: makeNetwork({ slow: [slowTxn, slowTxn] }),
    });
    const after = makeState({
      network: makeNetwork({ slow: [slowTxn] }),
    });
    const d = computeDiff(before, after);
    expect(d.network.newSlow).toBe(0);
  });

  it('newFailed is floored at zero when failedRequests shrinks', () => {
    const failedTxn = {
      id: 't',
      state: 'failed' as const,
      redirectChain: [],
      request: {
        url: 'u',
        method: 'GET',
        headers: {},
        resourceType: 'Fetch' as const,
        initiatorType: 'fetch',
        hasUserGesture: false,
      },
      error: { canceled: false, errorText: 'x' },
      dataChunks: 0,
      isWebSocket: false,
      isSSE: false,
      startedAt: 0,
    };
    const before = makeState({
      network: makeNetwork({ failedRequests: [failedTxn, failedTxn] }),
    });
    const after = makeState({
      network: makeNetwork({ failedRequests: [failedTxn] }),
    });
    const d = computeDiff(before, after);
    expect(d.network.newFailed).toBe(0);
  });

  it('large delta values do not overflow or lose precision unexpectedly', () => {
    const before = makeState({
      performance: makePerf({ jsHeapUsedMB: 0, domNodes: 0 }),
    });
    const after = makeState({
      performance: makePerf({ jsHeapUsedMB: 9999.9, domNodes: 1_000_000 }),
    });
    const d = computeDiff(before, after);
    expect(d.performance.heapDeltaMB).toBe(9999.9);
    expect(d.performance.domNodesDelta).toBe(1_000_000);
    expect(Number.isFinite(d.performance.heapDeltaMB)).toBe(true);
    expect(Number.isFinite(d.performance.domNodesDelta)).toBe(true);
  });

  it('heap delta is rounded to 1 decimal place', () => {
    const before = makeState({ performance: makePerf({ jsHeapUsedMB: 10.0 }) });
    const after = makeState({ performance: makePerf({ jsHeapUsedMB: 10.123456 }) });
    const d = computeDiff(before, after);
    expect(d.performance.heapDeltaMB).toBe(0.1);
  });
});

describe('StateDiff shape', () => {
  it('matches declared interface (compile-time + runtime shape)', () => {
    const d = computeDiff(makeState(), makeState({ url: 'changed' }));
    const expectedKeys = ['fields', 'network', 'console', 'performance', 'security', 'dom'];
    for (const k of expectedKeys) {
      expect(d).toHaveProperty(k);
    }
    const networkKeys = ['requestsDelta', 'completedDelta', 'failedDelta', 'newSlow', 'newFailed'];
    for (const k of networkKeys) {
      expect(d.network).toHaveProperty(k);
    }
    const consoleKeys = ['errorsDelta', 'warningsDelta'];
    for (const k of consoleKeys) {
      expect(d.console).toHaveProperty(k);
    }
    const perfKeys = ['heapDeltaMB', 'domNodesDelta'];
    for (const k of perfKeys) {
      expect(d.performance).toHaveProperty(k);
    }
    const securityKeys = ['threatsDelta', 'stateChanged', 'oldState', 'newState'];
    for (const k of securityKeys) {
      expect(d.security).toHaveProperty(k);
    }
    const domKeys = ['pageTypeChanged', 'oldPageType', 'newPageType', 'interactiveElementsDelta'];
    for (const k of domKeys) {
      expect(d.dom).toHaveProperty(k);
    }
    void {} as StateDiff;
  });
});
