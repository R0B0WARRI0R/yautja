import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Conversation, type ConversationContext } from '../../src/neural-link/conversation.js';
import { LLMClient } from '../../src/neural-link/client.js';
import { YAUTJA_TOOLS, SYSTEM_PROMPT } from '../../src/neural-link/types.js';
import type { LLMConfig, LLMMessage, LLMResponse } from '../../src/neural-link/types.js';
import { AttentionRouter } from '../../src/targeting/router.js';
import { WorkingMemory } from '../../src/memory/browser-state.js';
import type { BrowserState, StateDiff } from '../../src/memory/browser-state.js';
import type { NetworkSummary } from '../../src/vision/thermal.js';
import type { DOMSummary } from '../../src/vision/em.js';
import type { ConsoleSummary } from '../../src/vision/audio.js';
import type { PerformanceSummary } from '../../src/vision/motion.js';
import type { SecuritySummary } from '../../src/vision/threat.js';
import type { Transport, Anomaly } from '../../src/vision/base-sensor.js';

// ──────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────

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
      buttons: [{ tag: 'BUTTON', text: 'Submit', selector: '#submit', visible: true, disabled: false }],
      links: [],
      inputs: [],
      total: 1,
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
}

function makeConfig(overrides: Partial<LLMConfig> = {}): LLMConfig {
  return {
    apiUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test-123',
    model: 'MiniMax-M3',
    maxIterations: 10,
    temperature: 0.7,
    ...overrides,
  };
}

function makeResponse(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    message: { role: 'assistant', content: 'final answer' },
    finishReason: 'stop',
    ...overrides,
  };
}

function toolCallResponse(name: string, args: Record<string, any>, id = 'call_1'): LLMResponse {
  return {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id,
          type: 'function',
          function: {
            name,
            arguments: JSON.stringify(args),
          },
        },
      ],
    },
    finishReason: 'tool_calls',
  };
}

/**
 * Snapshot-based chat mock: records a copy of the messages array at every call
 * so tests can assert on the exact state when the LLM was invoked (before any
 * subsequent push to the live `this.messages`).
 */
function setupChatSequence(chatMock: ReturnType<typeof vi.spyOn>, responses: LLMResponse[]) {
  const snapshots: LLMMessage[][] = [];
  let callIdx = 0;
  chatMock.mockImplementation(async (messages: LLMMessage[]) => {
    snapshots.push([...messages]);
    const r = responses[callIdx++];
    if (!r) throw new Error(`setupChatSequence: no response queued for call ${callIdx}`);
    return r;
  });
  return snapshots;
}

// ──────────────────────────────────────────────────────────────
// Conversation
// ──────────────────────────────────────────────────────────────

describe('Conversation', () => {
  let config: LLMConfig;
  let chatMock: ReturnType<typeof vi.spyOn>;
  let transport: MockTransport;
  let router: AttentionRouter;
  let memory: WorkingMemory;
  let getPageState: ReturnType<typeof vi.fn>;
  let ctx: ConversationContext;

  beforeEach(() => {
    config = makeConfig();
    chatMock = vi.spyOn(LLMClient.prototype, 'chat');
    transport = new MockTransport();
    router = new AttentionRouter();
    memory = new WorkingMemory();
    getPageState = vi.fn(async () => ({ state: makeState(), anomalies: [] }));
    ctx = { router, memory, transport, getPageState };
  });

  afterEach(() => {
    chatMock.mockRestore();
  });

  // ── Initialization ─────────────────────────────────────────

  it('initializes with a single system message', () => {
    const conv = new Conversation(config, ctx);
    const history = conv.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.role).toBe('system');
    expect(history[0]?.content).toBe(SYSTEM_PROMPT);
  });

  // ── ask(): message sending ─────────────────────────────────

  it('sends system + user message to LLMClient on ask', async () => {
    const snapshots = setupChatSequence(chatMock, [
      makeResponse({ message: { role: 'assistant', content: 'hi back' } }),
    ]);
    const conv = new Conversation(config, ctx);
    await conv.ask('hello there');
    expect(chatMock).toHaveBeenCalledTimes(1);
    const sent = snapshots[0]!;
    expect(sent).toHaveLength(2);
    expect(sent[0]?.role).toBe('system');
    expect(sent[0]?.content).toBe(SYSTEM_PROMPT);
    expect(sent[1]?.role).toBe('user');
    expect(sent[1]?.content).toBe('hello there');
  });

  it('passes YAUTJA_TOOLS on every chat call', async () => {
    setupChatSequence(chatMock, [
      makeResponse({ message: { role: 'assistant', content: 'ok' } }),
    ]);
    const conv = new Conversation(config, ctx);
    await conv.ask('q');
    const sentTools = chatMock.mock.calls[0]?.[1];
    expect(sentTools).toBe(YAUTJA_TOOLS);
  });

  // ── ask(): stop branch ─────────────────────────────────────

  it('returns answer when LLM finishes with stop', async () => {
    chatMock.mockResolvedValueOnce(makeResponse({ message: { role: 'assistant', content: 'the answer is 42' } }));
    const conv = new Conversation(config, ctx);
    const result = await conv.ask('what is the answer?');
    expect(result.answer).toBe('the answer is 42');
    expect(result.iterations).toBe(1);
    expect(result.toolCalls).toBe(0);
  });

  it('returns "(no response)" when assistant content is empty', async () => {
    chatMock.mockResolvedValueOnce(makeResponse({ message: { role: 'assistant', content: '' } }));
    const conv = new Conversation(config, ctx);
    const result = await conv.ask('hi');
    expect(result.answer).toBe('(no response)');
  });

  it('returns answer when message has no tool_calls even without stop reason', async () => {
    chatMock.mockResolvedValueOnce({
      message: { role: 'assistant', content: 'done' },
      finishReason: 'length',
    });
    const conv = new Conversation(config, ctx);
    const result = await conv.ask('q');
    expect(result.answer).toBe('done');
    expect(result.toolCalls).toBe(0);
  });

  // ── ask(): observe tool ────────────────────────────────────

  it('executes observe tool and sends result back to LLM', async () => {
    chatMock
      .mockResolvedValueOnce(toolCallResponse('observe', { question: 'overview' }))
      .mockResolvedValueOnce(makeResponse({ message: { role: 'assistant', content: 'I see a dashboard' } }));

    const conv = new Conversation(config, ctx);
    const result = await conv.ask('what do you see?');

    expect(getPageState).toHaveBeenCalled();
    expect(result.answer).toBe('I see a dashboard');
    expect(result.toolCalls).toBe(1);
    expect(result.iterations).toBe(2);

    // Verify tool result message was sent back
    const secondCall = chatMock.mock.calls[1]?.[0] as LLMMessage[];
    const toolResult = secondCall.find((m) => m.role === 'tool');
    expect(toolResult).toBeDefined();
    expect(toolResult?.tool_call_id).toBe('call_1');
    const parsed = JSON.parse(toolResult?.content ?? '{}');
    expect(parsed).toHaveProperty('observation');
    expect(parsed).toHaveProperty('domains');
  });

  it('observe uses "overview" fallback when question missing', async () => {
    let observedQuestion = '';
    const spyRouter = new AttentionRouter();
    const originalObserve = spyRouter.observe.bind(spyRouter);
    spyRouter.observe = (q: string, ...rest: any[]) => {
      observedQuestion = q;
      return originalObserve(q, ...rest);
    };

    chatMock
      .mockResolvedValueOnce(toolCallResponse('observe', {}))
      .mockResolvedValueOnce(makeResponse({ message: { role: 'assistant', content: 'ok' } }));

    const localCtx: ConversationContext = { ...ctx, router: spyRouter };
    const conv = new Conversation(config, localCtx);
    await conv.ask('q');
    expect(observedQuestion).toBe('overview');
  });

  // ── ask(): act tool ────────────────────────────────────────

  it('executes act tool, updates memory, returns success', async () => {
    transport.setSendResponse('DOM.getDocument', { root: { nodeId: 1 } });
    transport.setSendResponse('Page.navigate', {});

    chatMock
      .mockResolvedValueOnce(toolCallResponse('act', { action: { type: 'navigate', url: 'https://example.com' } }))
      .mockResolvedValueOnce(makeResponse({ message: { role: 'assistant', content: 'navigated' } }));

    const conv = new Conversation(config, ctx);
    const result = await conv.ask('go to example.com');

    expect(result.answer).toBe('navigated');
    expect(result.toolCalls).toBe(1);
    expect(getPageState).toHaveBeenCalledTimes(1); // act branch calls once for memory update

    const toolMsg = (chatMock.mock.calls[1]?.[0] as LLMMessage[]).find((m) => m.role === 'tool');
    const parsed = JSON.parse(toolMsg?.content ?? '{}');
    expect(parsed.success).toBe(true);
  });

  it('returns error info when act fails', async () => {
    // No DOM.getDocument response → querySelector returns null → SELECTOR_NOT_FOUND
    chatMock
      .mockResolvedValueOnce(toolCallResponse('act', { action: { type: 'click', selector: '#missing' } }))
      .mockResolvedValueOnce(makeResponse({ message: { role: 'assistant', content: 'failed' } }));

    const conv = new Conversation(config, ctx);
    const result = await conv.ask('click missing');

    const toolMsg = (chatMock.mock.calls[1]?.[0] as LLMMessage[]).find((m) => m.role === 'tool');
    const parsed = JSON.parse(toolMsg?.content ?? '{}');
    expect(parsed.error).toContain('not found');
    expect(parsed.errorType).toBe('SELECTOR_NOT_FOUND');
    expect(parsed).toHaveProperty('recoveryHint');
    expect(result.answer).toBe('failed');
  });

  // ── ask(): inspect tool ────────────────────────────────────

  it.each([
    ['network', 'network'],
    ['dom', 'dom'],
    ['console', 'console'],
    ['performance', 'performance'],
    ['security', 'security'],
  ])('inspect(%s) returns the matching domain summary', async (domain) => {
    const state = makeState();
    getPageState.mockResolvedValue({ state, anomalies: [] });

    chatMock
      .mockResolvedValueOnce(toolCallResponse('inspect', { domain }))
      .mockResolvedValueOnce(makeResponse({ message: { role: 'assistant', content: 'here you go' } }));

    const conv = new Conversation(config, ctx);
    await conv.ask(`show ${domain}`);

    const toolMsg = (chatMock.mock.calls[1]?.[0] as LLMMessage[]).find((m) => m.role === 'tool');
    const parsed = JSON.parse(toolMsg?.content ?? '{}');
    expect(parsed).toEqual((state as any)[domain]);
  });

  it('inspect with unknown domain returns error to LLM', async () => {
    chatMock
      .mockResolvedValueOnce(toolCallResponse('inspect', { domain: 'mystery' }))
      .mockResolvedValueOnce(makeResponse({ message: { role: 'assistant', content: 'sorry' } }));

    const conv = new Conversation(config, ctx);
    await conv.ask('show mystery');

    const toolMsg = (chatMock.mock.calls[1]?.[0] as LLMMessage[]).find((m) => m.role === 'tool');
    const parsed = JSON.parse(toolMsg?.content ?? '{}');
    expect(parsed.error).toBe('unknown domain: mystery');
  });

  // ── ask(): diff tool ───────────────────────────────────────

  it('diff tool returns state diff when previous state exists', async () => {
    memory.update(makeState({ url: 'https://example.com/old' }));
    memory.update(makeState({ url: 'https://example.com/new' }));

    chatMock
      .mockResolvedValueOnce(toolCallResponse('diff', {}))
      .mockResolvedValueOnce(makeResponse({ message: { role: 'assistant', content: 'URL changed' } }));

    const conv = new Conversation(config, ctx);
    await conv.ask('what changed?');

    const toolMsg = (chatMock.mock.calls[1]?.[0] as LLMMessage[]).find((m) => m.role === 'tool');
    const parsed = JSON.parse(toolMsg?.content ?? '{}');
    expect(parsed).toHaveProperty('fields');
    expect(parsed).toHaveProperty('network');
    expect(parsed).toHaveProperty('console');
  });

  it('diff tool returns message when no previous state', async () => {
    // Empty memory — no current, no history → diff returns null
    chatMock
      .mockResolvedValueOnce(toolCallResponse('diff', {}))
      .mockResolvedValueOnce(makeResponse({ message: { role: 'assistant', content: 'nothing yet' } }));

    const conv = new Conversation(config, ctx);
    await conv.ask('what changed?');

    const toolMsg = (chatMock.mock.calls[1]?.[0] as LLMMessage[]).find((m) => m.role === 'tool');
    const parsed = JSON.parse(toolMsg?.content ?? '{}');
    expect(parsed.message).toBe('no previous state to diff');
  });

  // ── ask(): error paths ─────────────────────────────────────

  it('returns error to LLM when tool args are invalid JSON', async () => {
    chatMock
      .mockResolvedValueOnce({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'bad_1', type: 'function', function: { name: 'observe', arguments: 'not-json{' } },
          ],
        },
        finishReason: 'tool_calls',
      })
      .mockResolvedValueOnce(makeResponse({ message: { role: 'assistant', content: 'retrying' } }));

    const conv = new Conversation(config, ctx);
    const result = await conv.ask('q');
    expect(result.answer).toBe('retrying');

    const toolMsg = (chatMock.mock.calls[1]?.[0] as LLMMessage[]).find((m) => m.role === 'tool');
    const parsed = JSON.parse(toolMsg?.content ?? '{}');
    expect(parsed.error).toBe('invalid arguments');
    expect(toolMsg?.tool_call_id).toBe('bad_1');
  });

  it('returns error to LLM when tool name is unknown', async () => {
    chatMock
      .mockResolvedValueOnce(toolCallResponse('fly_to_moon', { payload: 1 }))
      .mockResolvedValueOnce(makeResponse({ message: { role: 'assistant', content: 'no moon' } }));

    const conv = new Conversation(config, ctx);
    await conv.ask('q');

    const toolMsg = (chatMock.mock.calls[1]?.[0] as LLMMessage[]).find((m) => m.role === 'tool');
    const parsed = JSON.parse(toolMsg?.content ?? '{}');
    expect(parsed.error).toBe('unknown tool: fly_to_moon');
  });

  // ── ask(): multi-tool loop ─────────────────────────────────

  it('loops observe → act → observe → stop', async () => {
    transport.setSendResponse('DOM.getDocument', { root: { nodeId: 1 } });
    transport.setSendResponse('Page.navigate', {});

    chatMock
      .mockResolvedValueOnce(toolCallResponse('observe', { question: 'overview' }, 'c1'))
      .mockResolvedValueOnce(toolCallResponse('act', { action: { type: 'navigate', url: 'https://x.com' } }, 'c2'))
      .mockResolvedValueOnce(toolCallResponse('observe', { question: 'after' }, 'c3'))
      .mockResolvedValueOnce(makeResponse({ message: { role: 'assistant', content: 'all done' } }));

    const conv = new Conversation(config, ctx);
    const result = await conv.ask('navigate and report');

    expect(result.answer).toBe('all done');
    expect(result.toolCalls).toBe(3);
    expect(result.iterations).toBe(4);
    expect(chatMock).toHaveBeenCalledTimes(4);
  });

  it('executes multiple tool_calls in one response sequentially', async () => {
    transport.setSendResponse('DOM.getDocument', { root: { nodeId: 1 } });

    chatMock.mockResolvedValueOnce({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'multi_1',
            type: 'function',
            function: { name: 'observe', arguments: JSON.stringify({ question: 'a' }) },
          },
          {
            id: 'multi_2',
            type: 'function',
            function: { name: 'observe', arguments: JSON.stringify({ question: 'b' }) },
          },
        ],
      },
      finishReason: 'tool_calls',
    }).mockResolvedValueOnce(makeResponse({ message: { role: 'assistant', content: 'paired' } }));

    const conv = new Conversation(config, ctx);
    const result = await conv.ask('q');

    expect(result.toolCalls).toBe(2);
    const secondCall = chatMock.mock.calls[1]?.[0] as LLMMessage[];
    const toolResults = secondCall.filter((m) => m.role === 'tool');
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]?.tool_call_id).toBe('multi_1');
    expect(toolResults[1]?.tool_call_id).toBe('multi_2');
  });

  // ── ask(): max iterations ──────────────────────────────────

  it('returns "(max iterations reached)" when loop never stops', async () => {
    // Always return a new tool_call each time — never stop
    chatMock.mockImplementation(async () => toolCallResponse('observe', { question: 'keep going' }, `c_${Math.random()}`));

    const conv = new Conversation(config, ctx);
    const result = await conv.ask('q');

    expect(result.answer).toBe('(max iterations reached)');
    expect(result.iterations).toBe(10);
    expect(result.toolCalls).toBe(10);
    expect(chatMock).toHaveBeenCalledTimes(10);
  });

  // ── toolCalls counter ──────────────────────────────────────

  it('toolCalls counter increments correctly across iterations', async () => {
    transport.setSendResponse('DOM.getDocument', { root: { nodeId: 1 } });

    chatMock
      .mockResolvedValueOnce(toolCallResponse('observe', {}, 't1'))
      .mockResolvedValueOnce(toolCallResponse('act', { action: { type: 'navigate', url: 'https://a' } }, 't2'))
      .mockResolvedValueOnce(toolCallResponse('diff', {}, 't3'))
      .mockResolvedValueOnce(makeResponse({ message: { role: 'assistant', content: 'three calls' } }));

    const conv = new Conversation(config, ctx);
    const result = await conv.ask('q');
    expect(result.toolCalls).toBe(3);
  });

  // ── clear() / getHistory() ─────────────────────────────────

  it('clear() resets messages to only the system prompt', async () => {
    chatMock.mockResolvedValueOnce(makeResponse({ message: { role: 'assistant', content: 'hi' } }));
    const conv = new Conversation(config, ctx);
    await conv.ask('hello');
    expect(conv.getHistory().length).toBeGreaterThan(1);

    conv.clear();
    const history = conv.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.role).toBe('system');
  });

  it('clear() resets toolCallCount to zero', async () => {
    chatMock.mockResolvedValueOnce(toolCallResponse('observe', {}, 'x1'))
      .mockResolvedValueOnce(toolCallResponse('observe', {}, 'x2'))
      .mockResolvedValueOnce(makeResponse({ message: { role: 'assistant', content: 'done' } }));

    const conv = new Conversation(config, ctx);
    const result = await conv.ask('q');
    expect(result.toolCalls).toBe(2);

    conv.clear();
    chatMock.mockResolvedValueOnce(makeResponse({ message: { role: 'assistant', content: 'fresh' } }));
    const result2 = await conv.ask('q2');
    expect(result2.toolCalls).toBe(0);
  });

  it('getHistory() returns a defensive copy (mutations do not affect internals)', async () => {
    const conv = new Conversation(config, ctx);
    const h1 = conv.getHistory();
    h1.push({ role: 'user', content: 'tampered' });
    const h2 = conv.getHistory();
    expect(h2).toHaveLength(1);
    expect(h2[0]?.role).toBe('system');
  });

  it('result.history is a defensive copy', async () => {
    chatMock.mockResolvedValueOnce(makeResponse({ message: { role: 'assistant', content: 'x' } }));
    const conv = new Conversation(config, ctx);
    const result = await conv.ask('q');
    result.history.push({ role: 'user', content: 'evil' });
    const again = conv.getHistory();
    expect(again.find((m) => m.content === 'evil')).toBeUndefined();
  });

  // ── Anomaly inclusion in observe ───────────────────────────

  it('observe tool passes anomalies through to the router', async () => {
    const anomalies: Anomaly[] = [
      { domain: 'security', severity: 'critical', message: 'broken SSL', timestamp: 0 },
    ];
    getPageState.mockResolvedValue({ state: makeState(), anomalies });

    chatMock
      .mockResolvedValueOnce(toolCallResponse('observe', { question: 'security' }))
      .mockResolvedValueOnce(makeResponse({ message: { role: 'assistant', content: 'seen' } }));

    const conv = new Conversation(config, ctx);
    await conv.ask('check security');

    const toolMsg = (chatMock.mock.calls[1]?.[0] as LLMMessage[]).find((m) => m.role === 'tool');
    const parsed = JSON.parse(toolMsg?.content ?? '{}');
    expect(parsed.observation).toContain('ANOMALIES');
    expect(parsed.observation).toContain('broken SSL');
  });
});

// ──────────────────────────────────────────────────────────────
// LLMClient
// ──────────────────────────────────────────────────────────────

describe('LLMClient', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;
  let client: LLMClient;
  let config: LLMConfig;

  function jsonResponse(data: any, init: { status?: number; ok?: boolean } = {}): Response {
    const status = init.status ?? 200;
    const ok = init.ok ?? (status >= 200 && status < 300);
    return {
      ok,
      status,
      statusText: String(status),
      text: async () => JSON.stringify(data),
      json: async () => data,
      headers: new Headers(),
    } as unknown as Response;
  }

  beforeEach(() => {
    config = makeConfig();
    client = new LLMClient(config);
    fetchMock = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('POSTs to <apiUrl>/chat/completions with correct headers', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    }));

    await client.chat([{ role: 'user', content: 'hello' }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBe('Bearer sk-test-123');
  });

  it('body includes model, messages and temperature', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }));

    await client.chat([{ role: 'user', content: 'q' }]);

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.model).toBe('MiniMax-M3');
    expect(body.messages).toEqual([{ role: 'user', content: 'q' }]);
    expect(body.temperature).toBe(0.7);
  });

  it('body omits tools when not provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }));

    await client.chat([{ role: 'user', content: 'q' }]);

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('body includes tools and tool_choice=auto when tools are provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }));

    await client.chat([{ role: 'user', content: 'q' }], YAUTJA_TOOLS);

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.tools).toEqual(YAUTJA_TOOLS);
    expect(body.tool_choice).toBe('auto');
  });

  it('body omits tools when empty array is provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }));

    await client.chat([{ role: 'user', content: 'q' }], []);

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('throws on non-OK response with status and truncated body', async () => {
    const longBody = 'x'.repeat(500);
    const errorResponse = {
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => longBody,
      json: async () => { throw new Error('not json'); },
    } as unknown as Response;
    fetchMock.mockResolvedValueOnce(errorResponse).mockResolvedValueOnce(errorResponse);

    await expect(client.chat([{ role: 'user', content: 'q' }])).rejects.toThrow(/LLMClient: API returned 500/);
    try {
      await client.chat([{ role: 'user', content: 'q' }]);
    } catch (e) {
      expect((e as Error).message.length).toBeLessThan(300);
      expect((e as Error).message).toContain('xxxx');
    }
  });

  it('throws when response has no choices', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [] }));

    await expect(client.chat([{ role: 'user', content: 'q' }])).rejects.toThrow(/no choices/);
  });

  it('throws when response has no choices field at all', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    await expect(client.chat([{ role: 'user', content: 'q' }])).rejects.toThrow(/no choices/);
  });

  it('maps prompt_tokens and completion_tokens to usage', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 42, completion_tokens: 7 },
    }));

    const r = await client.chat([{ role: 'user', content: 'q' }]);
    expect(r.usage).toEqual({ promptTokens: 42, completionTokens: 7 });
  });

  it('omits usage when not provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }));

    const r = await client.chat([{ role: 'user', content: 'q' }]);
    expect(r.usage).toBeUndefined();
  });

  it('usage defaults missing token counts to zero', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: {}, // empty usage
    }));

    const r = await client.chat([{ role: 'user', content: 'q' }]);
    expect(r.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it('returns message and finishReason from first choice', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      choices: [
        {
          message: { role: 'assistant', content: 'final', tool_calls: [] },
          finish_reason: 'stop',
        },
        { message: { role: 'assistant', content: 'ignored' }, finish_reason: 'stop' },
      ],
    }));

    const r = await client.chat([{ role: 'user', content: 'q' }]);
    expect(r.message.content).toBe('final');
    expect(r.finishReason).toBe('stop');
  });

  it('passes AbortSignal to fetch', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }));

    const ctrl = new AbortController();
    await client.chat([{ role: 'user', content: 'q' }], undefined, ctrl.signal);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBe(ctrl.signal);
  });
});

// ──────────────────────────────────────────────────────────────
// Tool definitions + system prompt sanity
// ──────────────────────────────────────────────────────────────

describe('YAUTJA_TOOLS and SYSTEM_PROMPT', () => {
  it('exposes exactly the four documented tools', () => {
    const names = YAUTJA_TOOLS.map((t) => t.function.name).sort();
    expect(names).toEqual(['act', 'diff', 'inspect', 'observe']);
  });

  it('every tool declares type=function', () => {
    for (const t of YAUTJA_TOOLS) expect(t.type).toBe('function');
  });

  it('observe tool requires question parameter', () => {
    const obs = YAUTJA_TOOLS.find((t) => t.function.name === 'observe');
    expect(obs?.function.parameters.required).toEqual(['question']);
  });

  it('act tool requires action parameter', () => {
    const act = YAUTJA_TOOLS.find((t) => t.function.name === 'act');
    expect(act?.function.parameters.required).toEqual(['action']);
  });

  it('inspect tool requires domain parameter with enum', () => {
    const ins = YAUTJA_TOOLS.find((t) => t.function.name === 'inspect');
    expect(ins?.function.parameters.required).toEqual(['domain']);
    expect(ins?.function.parameters.properties.domain.enum).toEqual([
      'network', 'dom', 'console', 'performance', 'security',
    ]);
  });

  it('SYSTEM_PROMPT mentions all four tools and the word Yautja', () => {
    expect(SYSTEM_PROMPT).toContain('Yautja');
    expect(SYSTEM_PROMPT).toContain('observe(');
    expect(SYSTEM_PROMPT).toContain('act(');
    expect(SYSTEM_PROMPT).toContain('inspect(');
    expect(SYSTEM_PROMPT).toContain('diff()');
  });
});