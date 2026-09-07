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
    getURL: vi.fn((path: string) => `chrome-extension://test-ext-id/${path}`),
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
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    onChanged: { addListener: vi.fn() },
  },
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

describe.each(['extension', 'extension-chrome'])('%s/background.js — transport and lifecycle', (variant) => {
  beforeAll(async () => {
    (globalThis as any).chrome = chromeMock;
    (globalThis as any).WebSocket = FakeWebSocket;
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false }));
    chromeMock.storage.local.get.mockResolvedValue({});
    FakeWebSocket.instances.length = 0;
    if (variant === 'extension') await import('../../extension/background.js');
    else await import('../../extension-chrome/background.js');
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  });

  beforeEach(() => {
    sent.length = 0;
    chromeMock.tabs.create.mockClear();
    chromeMock.tabs.update.mockClear();
    chromeMock.tabs.get.mockClear();
    chromeMock.windows.update.mockClear();
    chromeMock.tabs.remove.mockClear();
    chromeMock.tabs.group.mockClear();
    ws().open();
  });

  it('usa el endpoint loopback del helmet por defecto', () => {
    expect(ws().url).toBe('ws://127.0.0.1:9876');
  });

  it('openTab abre en segundo plano por defecto y solo roba foco con focus:true', async () => {
    ws().receive({ id: 20, type: 'openTab', url: 'https://example.com/background' });
    await vi.waitFor(() => expect(lastResponse(20)?.type).toBe('result'));
    expect(chromeMock.tabs.create).toHaveBeenLastCalledWith({
      url: 'https://example.com/background',
      active: false,
    });
    expect(lastResponse(20).result.focused).toBe(false);

    ws().receive({ id: 21, type: 'openTab', url: 'https://example.com/focused', focus: true });
    await vi.waitFor(() => expect(lastResponse(21)?.type).toBe('result'));
    expect(chromeMock.tabs.create).toHaveBeenLastCalledWith({
      url: 'https://example.com/focused',
      active: true,
    });
    expect(lastResponse(21).result.focused).toBe(true);
  });

  it('switchToTab no activa la pestaña ni la ventana salvo focus:true', async () => {
    ws().receive({ id: 22, type: 'switchToTab', tabId: 5 });
    await vi.waitFor(() => expect(lastResponse(22)?.type).toBe('result'));
    expect(chromeMock.tabs.get).toHaveBeenCalledWith(5);
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.windows.update).not.toHaveBeenCalled();
    expect(lastResponse(22).result.focused).toBe(false);

    ws().receive({ id: 23, type: 'switchToTab', tabId: 5, focus: true });
    await vi.waitFor(() => expect(lastResponse(23)?.type).toBe('result'));
    expect(chromeMock.tabs.update).toHaveBeenLastCalledWith(5, { active: true });
    expect(chromeMock.windows.update).toHaveBeenLastCalledWith(1, { focused: true });
    expect(lastResponse(23).result.focused).toBe(true);
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

  it('rejects a command from an old connection generation before touching Chrome', async () => {
    ws().receive({ type: 'helloAck', generation: 'current' });
    ws().receive({ id: 30, type: 'openTab', generation: 'old', url: 'https://example.com' });
    await vi.waitFor(() => expect(lastResponse(30)?.type).toBe('error'));
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it('cancellation stops group mutation after a pending create resolves', async () => {
    let resolveCreate!: (tab: any) => void;
    chromeMock.tabs.create.mockReturnValueOnce(new Promise(resolve => { resolveCreate = resolve; }));
    ws().receive({ type: 'helloAck', generation: 'cancel-test' });
    ws().receive({ id: 31, type: 'openTab', generation: 'cancel-test', groupId: 42, url: 'https://example.com' });
    ws().receive({ type: 'cancelCommand', commandId: 31, generation: 'cancel-test' });
    resolveCreate({ id: 7, url: 'https://example.com' });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(chromeMock.tabs.group).not.toHaveBeenCalled();
    expect(lastResponse(31)).toBeUndefined();
  });

  it('failed grouping returns an error and cleans the newly created tab', async () => {
    chromeMock.tabs.group.mockRejectedValueOnce(new Error('group disappeared'));
    ws().receive({ id: 32, type: 'openTab', groupId: 42, url: 'https://example.com' });
    await vi.waitFor(() => expect(lastResponse(32)?.type).toBe('error'));
    expect(lastResponse(32).error).toContain('cleaned=true');
    expect(chromeMock.tabs.remove).toHaveBeenCalledWith(7);
  });

  it('finish cannot close a tab moved out of the group at the last moment', async () => {
    chromeMock.tabs.get.mockResolvedValueOnce({ id: 5, windowId: 1, groupId: 99 } as any);
    ws().receive({ id: 33, type: 'closeTab', tabId: 5, expectedGroupId: 42 });
    await vi.waitFor(() => expect(lastResponse(33)?.type).toBe('error'));
    expect(chromeMock.tabs.remove).not.toHaveBeenCalled();
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

  it('un puerto de paquete o legado rota por la ventana; source=user queda fijado', async () => {
    vi.useFakeTimers();

    // Estado legado: yjPort existe pero las versiones antiguas no guardaban
    // yjPortSource. Debe tratarse como puerto base y probar base+1 al fallar.
    chromeMock.storage.local.get.mockResolvedValue({ yjPort: 9990 });
    ws().close();
    await vi.advanceTimersByTimeAsync(2_001);
    expect(ws().url).toBe('ws://127.0.0.1:9990');

    ws().close();
    await vi.advanceTimersByTimeAsync(2_001);
    expect(ws().url).toBe('ws://127.0.0.1:9991');

    // Un override manual explícito nunca salta a otro puerto.
    chromeMock.storage.local.get.mockResolvedValue({ yjPort: 9990, yjPortSource: 'user' });
    ws().close();
    await vi.advanceTimersByTimeAsync(2_001);
    expect(ws().url).toBe('ws://127.0.0.1:9990');

    ws().close();
    await vi.advanceTimersByTimeAsync(2_001);
    expect(ws().url).toBe('ws://127.0.0.1:9990');
  });
});
