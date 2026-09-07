import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { BrokerClient } from '../../src/connection/broker-client.js';
import { BrokerDisconnectedError, ExtensionServer } from '../../src/connection/extension-server.js';

const BRIDGE_TOKEN = 'b'.repeat(32);

/**
 * Tests del protocolo broker↔cliente (Tanda A multi-instancia). Mismo patrón
 * que extension-server.test.ts: la fake extension es un WebSocket cliente que
 * imita a extension/background.js conectada al BROKER; el CLIENT es un
 * ExtensionServer propio (sin extensión local) con un BrokerClient registrado.
 */

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
}

/** Fake extension conectada al broker: responde result a todo comando con id. */
function connectExtension(port: number, respondTo: (msg: any) => any | null): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello', id: 'fake-ext', version: 'test', bridgeToken: BRIDGE_TOKEN }));
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

describe('Broker↔Client — protocolo multi-instancia (Tanda A)', () => {
  let broker: ExtensionServer;
  let clientServer: ExtensionServer;
  let client: BrokerClient;
  let basePort: number;
  let extensions: WebSocket[];
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    extensions = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // BROKER: bindea el puerto base ("winner takes <base>").
    broker = new ExtensionServer(0, 500, { bridgeToken: BRIDGE_TOKEN });
    broker.setBrokerSessionId('sess_broker');
    await broker.start();
    basePort = broker.getPort();
    expect(broker.getPort()).toBe(basePort);
    // CLIENT: mismo puerto base → auto-incrementa al siguiente libre.
    clientServer = new ExtensionServer(basePort, 500, { bridgeToken: BRIDGE_TOKEN });
    await clientServer.start();
    expect(clientServer.getPort()).toBeGreaterThan(basePort);
    client = new BrokerClient(basePort, 'sess_client', undefined, BRIDGE_TOKEN);
    clientServer.setBrokerClient(client);
    client.onEvent((payload) => clientServer.dispatchBrokerEvent(payload));
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    for (const ws of extensions) {
      try { ws.close(); } catch {}
    }
    await client?.stop();
    await clientServer.stop();
    await broker.stop();
  });

  function connectFakeExtension(respondTo: (msg: any) => any | null): Promise<WebSocket> {
    const ws = connectExtension(basePort, respondTo);
    extensions.push(ws);
    return waitForOpen(ws).then(() => ws);
  }

  it('arranque: el primero bindea el base (broker) y el segundo se registra como client', async () => {
    const ok = await client.start();
    expect(ok).toBe(true);
    expect(client.isRegistered()).toBe(true);
    expect(client.getBrokerSessionId()).toBe('sess_broker');
    expect((broker as any).clientSockets.size).toBe(1);
    // Registro del cliente y disponibilidad del navegador son estados distintos.
    expect(clientServer.isExtensionConnected()).toBe(false);
  });

  it('broker protegido rechaza el registro de un cliente sin token', async () => {
    const intruder = new BrokerClient(basePort, 'sess_intruder', 300);
    try {
      expect(await intruder.start()).toBe(false);
      expect((broker as any).clientSockets.size).toBe(0);
    } finally {
      await intruder.stop();
    }
  });

  it('sin broker vivo en el puerto base → start() false (modo standalone)', async () => {
    // Reserve the port: another parallel suite must not become its broker.
    const unavailable = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>(resolve => unavailable.on('listening', resolve));
    unavailable.on('connection', socket => socket.close(4001, 'No broker available'));
    const orphanPort = (unavailable.address() as { port: number }).port;
    const orphan = new BrokerClient(orphanPort, 'sess_orphan', 300, BRIDGE_TOKEN);
    try {
      expect(await orphan.start()).toBe(false);
      expect(orphan.isRegistered()).toBe(false);
    } finally {
      await orphan.stop();
      for (const socket of unavailable.clients) socket.terminate();
      await new Promise<void>(resolve => unavailable.close(() => resolve()));
    }
  });

  it('forwarding: comando del cliente lo ejecuta el broker contra la extensión', async () => {
    await connectFakeExtension((msg) => (msg.type === 'listTabs' ? { tabs: [{ tabId: 1, url: 'https://x' }] } : {}));
    await vi.waitFor(() => expect(broker.isExtensionConnected()).toBe(true), { timeout: 2000, interval: 20 });
    await client.start();

    const res = await clientServer.sendRaw({ type: 'listTabs' });
    expect(res).toEqual({ tabs: [{ tabId: 1, url: 'https://x' }] });
  });

  it('forwarding: error de la extensión vuelve al cliente como rechazo', async () => {
    const ext = await connectFakeExtension(() => ({}));
    await vi.waitFor(() => expect(broker.isExtensionConnected()).toBe(true), { timeout: 2000, interval: 20 });
    await client.start();
    // La fake extension responde type:'error' en vez de 'result'.
    ext.removeAllListeners('message');
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id) ext.send(JSON.stringify({ id: msg.id, type: 'error', error: 'boom from extension' }));
    });

    await expect(clientServer.sendRaw({ type: 'listTabs' })).rejects.toThrow('boom from extension');
  });

  it('broker sin extensión → el cliente recibe "broker: extension not connected"', async () => {
    await client.start();
    await expect(clientServer.sendRaw({ type: 'listTabs' })).rejects.toThrow('broker: extension not connected');
  });

  it('routing (Tanda B): un evento llega al cliente solo si la tab es de su grupo', async () => {
    const ext = await connectFakeExtension((msg) =>
      msg.type === 'sessionGroupCreate' ? { groupId: 100, tabId: 7 } : {});
    await vi.waitFor(() => expect(broker.isExtensionConnected()).toBe(true), { timeout: 2000, interval: 20 });
    await client.start();
    // El cliente crea su grupo → el broker registra group 100 → 'sess_client'.
    await client.sendToBroker({ type: 'sessionGroupCreate' });

    const events: any[] = [];
    clientServer.onEvent((e) => events.push(e));
    // Tab del grupo del cliente → el evento se enruta y entra al pipeline local.
    ext.send(JSON.stringify({ type: 'event', tabId: 7, method: 'Console.messageAdded', params: { text: 'hi' } }));
    await vi.waitFor(() => expect(events.length).toBe(1), { timeout: 2000, interval: 20 });
    expect(events[0]).toMatchObject({ tabId: 7, method: 'Console.messageAdded', params: { text: 'hi' } });
    expect(clientServer.getBufferedEvents().some((e) => e.method === 'Console.messageAdded')).toBe(true);
    // Tab sin grupo (del usuario) → NO se reenvía: queda en la broker-session.
    ext.send(JSON.stringify({ type: 'event', tabId: 42, method: 'Console.messageAdded', params: { text: 'other' } }));
    await new Promise((r) => setTimeout(r, 150));
    expect(events.length).toBe(1);
  });

  it('heartbeat: el broker responde pong al ping del cliente', async () => {
    await client.start();
    const pong = new Promise<any>((resolve) => {
      (client as any).ws.on('message', (data: any) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'pong') resolve(msg);
      });
    });
    (client as any).ws.send(JSON.stringify({ type: 'ping' }));
    await expect(pong).resolves.toEqual({ type: 'pong' });
  });

  it('el broker olvida al cliente cuando muere su socket', async () => {
    await client.start();
    expect((broker as any).clientSockets.size).toBe(1);
    (client as any).ws.terminate();
    await vi.waitFor(() => expect((broker as any).clientSockets.size).toBe(0), { timeout: 2000, interval: 20 });
  });

  it('pérdida del broker → modo degradado con BrokerDisconnectedError tipado', async () => {
    await client.start();
    expect(client.isRegistered()).toBe(true);
    expect(clientServer.isExtensionConnected()).toBe(false);

    await broker.stop();
    await vi.waitFor(() => expect(client.isRegistered()).toBe(false), { timeout: 2000, interval: 20 });
    expect(clientServer.isExtensionConnected()).toBe(false);

    const t0 = Date.now();
    const err = await clientServer.sendRaw({ type: 'listTabs' }).then(
      () => { throw new Error('should have rejected'); },
      (e) => e,
    );
    expect(Date.now() - t0).toBeLessThan(100);
    expect(err).toBeInstanceOf(BrokerDisconnectedError);
    expect(err.code).toBe('BROKER_DISCONNECTED');
    expect(err.message).toContain('broker disconnected');
  });

  it('la extensión no ocupa el slot de los clientes (y viceversa)', async () => {
    await client.start();
    // Un segundo cliente con otro sessionId también cabe.
    const client2 = new BrokerClient(basePort, 'sess_client_2', undefined, BRIDGE_TOKEN);
    try {
      expect(await client2.start()).toBe(true);
      expect((broker as any).clientSockets.size).toBe(2);
      // La extensión sigue pudiendo conectar en su propio slot.
      await connectFakeExtension(() => ({}));
      await vi.waitFor(() => expect(broker.isExtensionConnected()).toBe(true), { timeout: 2000, interval: 20 });
      expect((broker as any).clientSockets.size).toBe(2);
    } finally {
      await client2.stop();
    }
  });
});
