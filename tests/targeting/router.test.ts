import { describe, it, expect } from 'vitest';
import { AttentionRouter } from '../../src/targeting/router.js';
import { buildObservation } from '../../src/targeting/observation.js';
import { queryAttention } from '../../src/targeting/strategies/query.js';
import { anomalyAttention } from '../../src/targeting/strategies/anomaly.js';
import { diffAttention } from '../../src/targeting/strategies/diff.js';
import { overviewAttention } from '../../src/targeting/strategies/overview.js';
import type { BrowserState, StateDiff } from '../../src/memory/browser-state.js';
import type { NetworkSummary } from '../../src/vision/thermal.js';
import type { DOMSummary } from '../../src/vision/em.js';
import type { ConsoleSummary } from '../../src/vision/audio.js';
import type { PerformanceSummary } from '../../src/vision/motion.js';
import type { SecuritySummary } from '../../src/vision/threat.js';
import type { Anomaly, NetworkTransaction } from '../../src/vision/base-sensor.js';

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
      buttons: [
        { tag: 'BUTTON', text: 'Submit', selector: '#submit', visible: true, disabled: false },
        { tag: 'BUTTON', text: 'Cancel', selector: '#cancel', visible: true, disabled: false },
      ],
      links: [],
      inputs: [],
      total: 2,
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

function makeDiff(overrides: Partial<StateDiff> = {}): StateDiff {
  return {
    fields: ['url'],
    network: {
      requestsDelta: 5,
      completedDelta: 4,
      failedDelta: 1,
      newSlow: 0,
      newFailed: 1,
    },
    console: { errorsDelta: 0, warningsDelta: 0 },
    performance: { heapDeltaMB: 0, domNodesDelta: 0 },
    security: { threatsDelta: 0, stateChanged: false },
    dom: { pageTypeChanged: false, interactiveElementsDelta: 0 },
    ...overrides,
  };
}

function makeTransaction(overrides: Partial<NetworkTransaction> = {}): NetworkTransaction {
  return {
    id: 'tx-1',
    state: 'completed',
    redirectChain: [],
    request: {
      url: 'https://api.example.com/data',
      method: 'GET',
      headers: {},
      resourceType: 'Fetch',
      initiatorType: 'fetch',
      hasUserGesture: false,
    },
    dataChunks: 1,
    isWebSocket: false,
    isSSE: false,
    startedAt: 0,
    finishedAt: 1000,
    durationMs: 5000,
    ...overrides,
  };
}

describe('AttentionRouter.observe', () => {
  const router = new AttentionRouter();

  it('returns overview for generic question', () => {
    const obs = router.observe('hi there', makeState(), []);
    expect(obs.kind).toBe('overview');
    expect(obs.domains).toEqual(['network', 'dom', 'console', 'performance', 'security']);
  });

  it('returns domain_focused for specific question', () => {
    const obs = router.observe('why is this slow', makeState(), []);
    expect(obs.kind).toBe('domain_focused');
    expect(obs.domains).toContain('performance');
  });

  it('includes anomalies when present', () => {
    const anomalies: Anomaly[] = [
      { domain: 'security', severity: 'critical', message: 'broken SSL', timestamp: 0 },
    ];
    const obs = router.observe('show me the page', makeState(), anomalies);
    expect(obs.text).toContain('ANOMALIES');
    expect(obs.text).toContain('broken SSL');
  });

  it('includes diff when post-action context provided', () => {
    const obs = router.observe(
      'what changed',
      makeState(),
      [],
      makeDiff({ fields: ['network.total'] }),
      { lastActionTime: Date.now() - 1000 },
    );
    expect(obs.text).toContain('CHANGES');
  });

  it('omits diff when no recent action', () => {
    const obs = router.observe(
      'what is happening',
      makeState(),
      [],
      makeDiff({ fields: ['network.total'] }),
      { lastActionTime: Date.now() - 60000 },
    );
    expect(obs.text).not.toContain('CHANGES SINCE LAST ACTION');
  });

  it('omits diff when no context provided', () => {
    const obs = router.observe(
      'what is happening',
      makeState(),
      [],
      makeDiff({ fields: ['network.total'] }),
    );
    expect(obs.text).not.toContain('CHANGES SINCE LAST ACTION');
  });

  it('respects maxTokens budget', () => {
    const obs = router.observe('show everything', makeState(), [], null, undefined, 200);
    expect(obs.tokenEstimate).toBeLessThan(300);
  });

  it('truncates with inspect hint when budget exceeded', () => {
    const state = makeState();
    const obs = buildObservation({
      question: 'show everything about all domains network dom console performance security please',
      state,
      maxTokens: 300,
    });
    const hasHint = obs.text.includes('inspect(') || obs.text.length < 2000;
    expect(hasHint).toBe(true);
  });
});

describe('AttentionRouter.isGenericQuestion', () => {
  const router = new AttentionRouter();

  it('returns true for "what is here?"', () => {
    expect(router.isGenericQuestion('what is here?')).toBe(true);
  });

  it('returns false for "why is network slow?"', () => {
    expect(router.isGenericQuestion('why is network slow?')).toBe(false);
  });

  it('returns true for "tell me about this"', () => {
    expect(router.isGenericQuestion('tell me about this')).toBe(true);
  });

  it('returns false for "are there security issues?"', () => {
    expect(router.isGenericQuestion('are there security issues?')).toBe(false);
  });
});

describe('queryAttention strategy', () => {
  it('shows relevant domains only', () => {
    const result = queryAttention('why is the api slow', makeState(), 8000);
    expect(result.domains).toContain('network');
    expect(result.domains).toContain('performance');
    expect(result.text).toContain('NETWORK');
  });

  it('returns empty domains for unrelated question', () => {
    const result = queryAttention('what color is the sky', makeState(), 8000);
    expect(result.domains).toEqual([]);
  });
});

describe('anomalyAttention strategy', () => {
  it('shows critical first', () => {
    const anomalies: Anomaly[] = [
      { domain: 'console', severity: 'warning', message: 'minor warning', timestamp: 0 },
      { domain: 'security', severity: 'critical', message: 'major cert error', timestamp: 0 },
    ];
    const result = anomalyAttention(anomalies);
    const critIdx = result.text.indexOf('major cert error');
    const warnIdx = result.text.indexOf('minor warning');
    expect(critIdx).toBeGreaterThan(0);
    expect(warnIdx).toBeGreaterThan(0);
    expect(critIdx).toBeLessThan(warnIdx);
  });

  it('returns empty for no anomalies', () => {
    const result = anomalyAttention([]);
    expect(result.text).toBe('');
    expect(result.count).toBe(0);
  });

  it('returns count of anomalies', () => {
    const anomalies: Anomaly[] = [
      { domain: 'console', severity: 'warning', message: 'a', timestamp: 0 },
      { domain: 'console', severity: 'warning', message: 'b', timestamp: 0 },
    ];
    const result = anomalyAttention(anomalies);
    expect(result.count).toBe(2);
  });
});

describe('diffAttention strategy', () => {
  it('shows changed fields', () => {
    const diff = makeDiff({
      fields: ['network.total', 'console.errors'],
      network: {
        requestsDelta: 5,
        completedDelta: 5,
        failedDelta: 0,
        newSlow: 0,
        newFailed: 0,
      },
      console: { errorsDelta: 2, warningsDelta: 0 },
    });
    const result = diffAttention(diff);
    expect(result.hasChanges).toBe(true);
    expect(result.text).toContain('Network requests: +5');
    expect(result.text).toContain('New errors: +2');
  });

  it('returns hasChanges=false when no fields changed', () => {
    const diff = makeDiff({ fields: [] });
    const result = diffAttention(diff);
    expect(result.hasChanges).toBe(false);
    expect(result.text).toBe('');
  });
});

describe('overviewAttention strategy', () => {
  it('shows all domains at high level', () => {
    const result = overviewAttention(makeState());
    expect(result).toContain('OVERVIEW');
    expect(result).toContain('Network:');
    expect(result).toContain('Console:');
    expect(result).toContain('Heap:');
    expect(result).toContain('Security:');
  });
});

describe('formatDomain (via buildObservation)', () => {
  it('network shows slow and failed requests', () => {
    const state = makeState({
      network: makeNetwork({
        slow: [
          makeTransaction({ durationMs: 5000, request: { url: 'https://a.com', method: 'GET', headers: {}, resourceType: 'Fetch', initiatorType: 'fetch', hasUserGesture: false } }),
        ],
        failedRequests: [
          makeTransaction({ state: 'failed', error: { errorText: 'connection refused', canceled: false } }),
        ],
      }),
    });
    const obs = buildObservation({ question: 'why is the api slow', state });
    expect(obs.text).toContain('NETWORK');
    expect(obs.text).toContain('Slow:');
    expect(obs.text).toContain('Failed:');
  });

  it('dom shows buttons and page type', () => {
    const state = makeState();
    const obs = buildObservation({ question: 'show dom structure', state });
    expect(obs.text).toContain('DOM');
    expect(obs.text).toContain('dashboard');
    expect(obs.text).toContain('Buttons:');
    expect(obs.text).toContain('Submit');
  });

  it('console shows errors with dedup count', () => {
    const state = makeState({
      console: makeConsole({
        errors: [
          { level: 'error', text: 'something broke badly in app', count: 3, timestamp: 0 },
        ],
        warnings: [],
        total: 1,
      }),
    });
    const obs = buildObservation({ question: 'show console errors', state });
    expect(obs.text).toContain('CONSOLE');
    expect(obs.text).toContain('Errors:');
    expect(obs.text).toContain('(x3)');
  });

  it('performance shows heap and metrics', () => {
    const state = makeState({
      performance: makePerf({
        jsHeapUsedMB: 75.5,
        jsHeapTotalMB: 200,
        domNodes: 1500,
      }),
    });
    const obs = buildObservation({ question: 'show performance', state });
    expect(obs.text).toContain('PERFORMANCE');
    expect(obs.text).toContain('Heap: 75.5MB');
    expect(obs.text).toContain('DOM nodes: 1500');
  });

  it('security shows state and threats', () => {
    const state = makeState({
      security: makeSecurity({
        state: 'insecure',
        totalThreats: 3,
        mixedContentRequests: 1,
        explanations: [
          { securityState: 'insecure', title: 'Insecure connection', summary: 'Page loaded over HTTP', description: '' },
        ],
      }),
    });
    const obs = buildObservation({ question: 'show security', state });
    expect(obs.text).toContain('SECURITY');
    expect(obs.text).toContain('State: insecure');
    expect(obs.text).toContain('Threats: 3');
    expect(obs.text).toContain('Insecure connection');
  });
});

describe('buildObservation composition', () => {
  it('composite kind when anomalies + domains', () => {
    const anomalies: Anomaly[] = [
      { domain: 'console', severity: 'warning', message: 'an error', timestamp: 0 },
    ];
    const obs = buildObservation({ question: 'show console errors', state: makeState(), anomalies });
    expect(obs.kind).toBe('composite');
  });

  it('domain_focused kind when only domains', () => {
    const obs = buildObservation({ question: 'show performance', state: makeState() });
    expect(obs.kind).toBe('domain_focused');
  });

  it('includes header with timestamp', () => {
    const obs = buildObservation({ question: 'hi', state: makeState({ timestamp: 1700000000000 }) });
    expect(obs.text).toContain('BROWSER STATE');
    expect(obs.text).toMatch(/2023|2024|2025/);
  });

  it('respects maxTokens cap on output size', () => {
    const obs = buildObservation({
      question: 'show me everything about the network and dom and console and performance and security',
      state: makeState(),
      maxTokens: 500,
    });
    expect(obs.text.length).toBeLessThan(5000);
  });
});
