import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { ExtensionLinkDegradedError, ExtensionServer } from '../../src/connection/extension-server.js';

/**
 * Fake extension: un WebSocket cliente que imita a extension/background.js.
 * `respondTo(msg)` devuelve el result a contestar, o null para colgar el
 * comando (simula handlers colgados contra un renderer saturado).
 */
function connectExtension(port: number, respondTo: (msg: any) => any | null): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello', id: 'fake-ext', version: 'test' }));
  });
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const result = respondTo(msg);
    if (result !== null && msg.id) {
      ws.send(JSON.stringify({ id: msg.id, type: 'result', result }));
    }
  });
  return ws;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.on('close', () => resolve());
  });
}

describe('ExtensionServer — watchdog de enlace', () => {
  let server: ExtensionServer;
  let port: number;
  let clients: WebSocket[];
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    clients = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    server = new ExtensionServer(0);
    await server.start();
    port = (server as any).wss.address().port;
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    for (const ws of clients) {
      try { ws.close(); } catch {}
    }
    await server.stop();
  });

  function connect(respondTo: (msg: any) => any | null): Promise<WebSocket> {
    const ws = connectExtension(port, respondTo);
    clients.push(ws);
    return waitForOpen(ws).then(() => ws);
  }

  it('comando colgado → timeout con log a stderr y contador', async () => {
    await connect(() => null);
    await expect(server.sendRaw({ type: 'listTabs' }, 80)).rejects.toThrow(/timed out after 80ms/);
    expect(server.getLinkState().consecutiveTimeouts).toBe(1);
    expect(server.getLinkState().linkDegraded).toBe(false);
    const logs = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(logs).toContain('listTabs');
    expect(logs).toContain('consecutiveTimeouts=1');
  });

  it('una respuesta OK resetea el contador de timeouts', async () => {
    let hang = true;
    await connect(() => (hang ? null : { tabs: [] }));
    await expect(server.sendRaw({ type: 'listTabs' }, 60)).rejects.toThrow(/timed out/);
    await expect(server.sendRaw({ type: 'listTabs' }, 60)).rejects.toThrow(/timed out/);
    expect(server.getLinkState().consecutiveTimeouts).toBe(2);
    hang = false;
    const res = await server.sendRaw({ type: 'listTabs' }, 500);
    expect(res).toEqual({ tabs: [] });
    expect(server.getLinkState().consecutiveTimeouts).toBe(0);
    expect(server.getLinkState().linkDegraded).toBe(false);
  });

  it('3 timeouts consecutivos → socket cerrado y fallo rápido EXTENSION_LINK_DEGRADED', async () => {
    const ws = await connect(() => null);
    for (let i = 0; i < 3; i++) {
      await expect(server.sendRaw({ type: 'listTabs' }, 60)).rejects.toThrow(/timed out/);
    }
    // El watchdog cierra el socket para forzar la reconexión de la extensión.
    await waitForClose(ws);
    const link = server.getLinkState();
    expect(link.linkDegraded).toBe(true);
    expect(link.connected).toBe(false);

    // Los comandos fallan RÁPIDO con el error tipado (sin esperar su timeout).
    const t0 = Date.now();
    const err = await server.sendRaw({ type: 'listTabs' }, 5000).then(
      () => { throw new Error('should have rejected'); },
      (e) => e,
    );
    expect(Date.now() - t0).toBeLessThan(100);
    expect(err).toBeInstanceOf(ExtensionLinkDegradedError);
    expect(err.code).toBe('EXTENSION_LINK_DEGRADED');
    expect(err.message).toContain('recuperación automática en curso');
  });

  it('reconexión + health OK → recuperación y comandos vuelven a funcionar', async () => {
    const ws1 = await connect(() => null);
    for (let i = 0; i < 3; i++) {
      await expect(server.sendRaw({ type: 'listTabs' }, 60)).rejects.toThrow(/timed out/);
    }
    await waitForClose(ws1);
    expect(server.getLinkState().linkDegraded).toBe(true);

    // La extensión reconecta (su scheduleReconnect) y esta vez responde.
    await connect((msg) => (msg.type === 'health'
      ? { runtimeId: 'fake-ext', uptimeMs: 1234, pendingHandlers: 0, attachedTabs: [] }
      : { tabs: [] }));

    // Tras el hello, el helmet sondea health automáticamente y levanta la degradación.
    await vi.waitFor(() => {
      expect(server.getLinkState().linkDegraded).toBe(false);
    }, { timeout: 2000, interval: 20 });

    const link = server.getLinkState();
    expect(link.connected).toBe(true);
    expect(link.consecutiveTimeouts).toBe(0);
    expect(link.lastHealthMs).not.toBeNull();

    const res = await server.sendRaw({ type: 'listTabs' }, 500);
    expect(res).toEqual({ tabs: [] });
    const logs = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(logs).toContain('extension link recovered');
  });

  it('reconexión con health colgado → sigue degradado', async () => {
    const ws1 = await connect(() => null);
    for (let i = 0; i < 3; i++) {
      await expect(server.sendRaw({ type: 'listTabs' }, 60)).rejects.toThrow(/timed out/);
    }
    await waitForClose(ws1);

    // Reconecta pero el SW sigue colgado: health (5s de timeout) no responde.
    await connect(() => null);
    await new Promise((r) => setTimeout(r, 150));
    expect(server.getLinkState().linkDegraded).toBe(true);
    // Los comandos de navegador siguen fallando rápido.
    const err = await server.sendRaw({ type: 'listTabs' }, 5000).catch((e) => e);
    expect(err.code).toBe('EXTENSION_LINK_DEGRADED');
  });

  it('timeout heavy para Page.navigate y evaluateAsync; default para el resto', async () => {
    await connect(() => null);
    const t0 = Date.now();
    // Default (30s) es inalcanzable en test; comprobamos la tabla vía timeoutFor.
    const timeoutFor = (server as any).timeoutFor.bind(server);
    expect(timeoutFor({ type: 'health' })).toBe(5000);
    expect(timeoutFor({ type: 'command', method: 'Page.navigate', params: {} })).toBe(60000);
    expect(timeoutFor({ type: 'command', method: 'Runtime.evaluate', params: { awaitPromise: true } })).toBe(60000);
    expect(timeoutFor({ type: 'command', method: 'Runtime.evaluate', params: {} })).toBe(30000);
    expect(timeoutFor({ type: 'listTabs' })).toBe(30000);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('ExtensionServer — asignación dinámica de puerto', () => {
  it('puerto base ocupado → auto-incrementa al siguiente libre', async () => {
    const { WebSocketServer } = await import('ws');
    // Ocupante: bindea un puerto efímero y se queda con él.
    const occupier = new WebSocketServer({ port: 0 });
    await new Promise<void>((res) => occupier.on('listening', res));
    const busyPort = (occupier.address() as any).port;

    const server = new ExtensionServer(busyPort);
    await server.start();
    try {
      expect(server.getPort()).toBe(busyPort + 1);
    } finally {
      await server.stop();
      occupier.close();
    }
  });

  it('puerto base libre → lo usa sin incrementar', async () => {
    const { WebSocketServer } = await import('ws');
    const probe = new WebSocketServer({ port: 0 });
    await new Promise<void>((res) => probe.on('listening', res));
    const freePort = (probe.address() as any).port;
    await new Promise<void>((res) => probe.close(() => res()));

    const server = new ExtensionServer(freePort);
    await server.start();
    try {
      expect(server.getPort()).toBe(freePort);
    } finally {
      await server.stop();
    }
  });
});
