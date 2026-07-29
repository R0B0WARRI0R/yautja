import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests de extension/background.js en Node con chrome.* y WebSocket mockeados.
 * El service worker real vive en Chrome; aquí verificamos el contrato:
 * health instantáneo, contador de handlers en vuelo y timeout de handlers.
 */

const sent: any[] = [];

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  // ─── helpers de test ───
  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(msg: any) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const chromeMock = {
  runtime: {
    id: 'test-ext-id',
    onStartup: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
    lastError: null as any,
  },
  webRequest: {
    onBeforeRequest: { addListener: vi.fn() },
    onCompleted: { addListener: vi.fn() },
    onErrorOccurred: { addListener: vi.fn() },
  },
  debugger: {
    onEvent: { addListener: vi.fn() },
    onDetach: { addListener: vi.fn() },
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    sendCommand: vi.fn(async () => ({})),
    getTargets: vi.fn(async () => []),
  },
  tabs: {
    query: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: 7, url: 'about:blank' })),
    group: vi.fn(async () => 42),
    update: vi.fn(async () => ({})),
    get: vi.fn(async () => ({ id: 5, windowId: 1 })),
    remove: vi.fn(async () => {}),
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    sendMessage: vi.fn(async () => ({})),
  },
  tabGroups: { update: vi.fn(async () => {}) },
  windows: { update: vi.fn(async () => {}) },
  storage: { local: { get: vi.fn(async () => ({})) }, onChanged: { addListener: vi.fn() } },
  management: { getAll: vi.fn(async () => []), setEnabled: vi.fn(async () => {}) },
  proxy: {
    settings: {
      set: vi.fn((_v: any, _s: any, cb?: () => void) => cb?.()),
      clear: vi.fn((_s: any, cb?: () => void) => cb?.()),
    },
  },
  alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
};

function ws(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

function lastResponse(id: number): any {
  return sent.filter((m) => m.id === id).pop();
}

describe('extension/background.js — health y timeouts de handler', () => {
  beforeAll(async () => {
    (globalThis as any).chrome = chromeMock;
    (globalThis as any).WebSocket = FakeWebSocket;
    await import('../../extension/background.js');
  });

  beforeEach(() => {
    sent.length = 0;
    ws().open();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('health responde inmediatamente con runtimeId, uptimeMs, pendingHandlers y attachedTabs', async () => {
    ws().receive({ id: 1, type: 'health' });
    await Promise.resolve();
    const res = lastResponse(1);
    expect(res.type).toBe('result');
    expect(res.result.runtimeId).toBe('test-ext-id');
    expect(typeof res.result.uptimeMs).toBe('number');
    expect(typeof res.result.pendingHandlers).toBe('number');
    expect(res.result.attachedTabs).toEqual([]);
  });

  it('handler colgado en CDP → error "timed out" a los 20s y health delata el wedge', async () => {
    vi.useFakeTimers();

    // attach OK (chrome.debugger.attach resuelve)
    ws().receive({ id: 2, type: 'attach', tabId: 5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastResponse(2).type).toBe('result');

    // command que nunca resuelve (renderer saturado)
    chromeMock.debugger.sendCommand.mockReturnValueOnce(new Promise(() => {}) as any);
    ws().receive({ id: 3, type: 'command', tabId: 5, method: 'Runtime.evaluate', params: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastResponse(3)).toBeUndefined();

    // Mientras cuelga, health responde y reporta 2 handlers (el colgado + él mismo)
    ws().receive({ id: 4, type: 'health' });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastResponse(4).result.pendingHandlers).toBe(2);
    expect(lastResponse(4).result.attachedTabs).toEqual([5]);

    // A los 20s el handler expira y el helmet recibe un error (no un timeout propio)
    await vi.advanceTimersByTimeAsync(20_001);
    const err = lastResponse(3);
    expect(err.type).toBe('error');
    expect(err.error).toMatch(/CDP Runtime\.evaluate failed: .*timed out after 20000ms/);

    // El handler completó: health vuelve a reportar solo el suyo
    ws().receive({ id: 6, type: 'health' });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastResponse(6).result.pendingHandlers).toBe(1);
  });

  it('Page.navigate usa timeout mayor (45s) que un comando normal', async () => {
    vi.useFakeTimers();

    ws().receive({ id: 10, type: 'attach', tabId: 9 });
    await vi.advanceTimersByTimeAsync(0);

    chromeMock.debugger.sendCommand.mockReturnValueOnce(new Promise(() => {}) as any);
    ws().receive({ id: 11, type: 'command', tabId: 9, method: 'Page.navigate', params: { url: 'https://x' } });
    await vi.advanceTimersByTimeAsync(0);

    // A los 20s aún no ha expirado (es navigate)
    await vi.advanceTimersByTimeAsync(20_001);
    expect(lastResponse(11)).toBeUndefined();

    // A los 45s expira con error
    await vi.advanceTimersByTimeAsync(25_001);
    const err = lastResponse(11);
    expect(err.type).toBe('error');
    expect(err.error).toMatch(/timed out after 45000ms/);
  });
});
