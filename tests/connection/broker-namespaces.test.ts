import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { BrokerClient } from '../../src/connection/broker-client.js';
import { ExtensionServer, TabOwnedByOtherSessionError } from '../../src/connection/extension-server.js';

/**
 * Tests de namespaces por sesión en el broker (Tanda B multi-instancia):
 * registro de grupos por sesión, enrutado de eventos solo al dueño, política
 * de tabs (TAB_OWNED_BY_OTHER_SESSION / user-tabs permitidas con audit) y
 * heartbeat de grupo (muerte de un cliente libera sus tabs).
 * Mismo patrón de fakes que broker-client.test.ts.
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

async function freePort(): Promise<number> {
  const { WebSocketServer } = await import('ws');
  const probe = new WebSocketServer({ port: 0 });
  await new Promise<void>((res) => probe.on('listening', res));
  const port = (probe.address() as any).port;
  await new Promise<void>((res) => probe.close(() => res()));
  return port;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Broker namespaces por sesión (Tanda B)', () => {
  let broker: ExtensionServer;
  let clientA: BrokerClient;
  let clientB: BrokerClient;
  let basePort: number;
  let ext: WebSocket;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let nextGroupId: number;

  beforeEach(async () => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    basePort = await freePort();
    broker = new ExtensionServer(basePort);
    broker.setBrokerSessionId('sess_broker');
    await broker.start();

    // Fake extension: sessionGroupCreate devuelve grupos correlativos
    // (100/tab 10, 200/tab 20, …); el resto de comandos responde {}.
    nextGroupId = 100;
    ext = connectExtension(basePort, (msg) => {
      if (msg.type === 'sessionGroupCreate') {
        const groupId = nextGroupId;
        nextGroupId += 100;
        return { groupId, tabId: groupId / 10 };
      }
      return {};
    });
    await waitForOpen(ext);
    await vi.waitFor(() => expect(broker.isExtensionConnected()).toBe(true), { timeout: 2000, interval: 20 });

    clientA = new BrokerClient(basePort, 'sess_a');
    clientB = new BrokerClient(basePort, 'sess_b');
    expect(await clientA.start()).toBe(true);
    expect(await clientB.start()).toBe(true);

    // Cada cliente crea su grupo: A → group 100 (tab 10), B → group 200 (tab 20).
    await clientA.sendToBroker({ type: 'sessionGroupCreate' });
    await clientB.sendToBroker({ type: 'sessionGroupCreate' });
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    try { ext.close(); } catch {}
    await clientA.stop();
    await clientB.stop();
    await broker.stop();
  });

  function collectEvents(client: BrokerClient): any[] {
    const events: any[] = [];
    client.onEvent((payload) => events.push(payload));
    return events;
  }

  it('routing: evento de tab del grupo A solo llega a A (no a B ni a clientes ajenos)', async () => {
    const eventsA = collectEvents(clientA);
    const eventsB = collectEvents(clientB);

    ext.send(JSON.stringify({ type: 'event', tabId: 10, method: 'Console.messageAdded', params: { text: 'de A' } }));
    await vi.waitFor(() => expect(eventsA.length).toBe(1), { timeout: 2000, interval: 20 });
    expect(eventsA[0]).toMatchObject({ tabId: 10, method: 'Console.messageAdded' });
    await sleep(150);
    expect(eventsB.length).toBe(0);

    // Evento del grupo de la broker-session: no se reenvía a ningún cliente.
    await broker.sessionGroupCreate(); // group 300, tab 30 → 'sess_broker'
    ext.send(JSON.stringify({ type: 'event', tabId: 30, method: 'Console.messageAdded', params: { text: 'broker' } }));
    // Evento sin tabId (target de service worker): tampoco se reenvía.
    ext.send(JSON.stringify({ type: 'event', targetId: 'sw-1', method: 'Log.entryAdded', params: {} }));
    await sleep(150);
    expect(eventsA.length).toBe(1);
    expect(eventsB.length).toBe(0);
  });

  it('política: comando de B sobre tab del grupo A → TAB_OWNED_BY_OTHER_SESSION tipado', async () => {
    const err = await clientB.sendToBroker({ type: 'attach', tabId: 10 }).then(
      () => { throw new Error('should have rejected'); },
      (e) => e,
    );
    expect(err).toBeInstanceOf(TabOwnedByOtherSessionError);
    expect(err.code).toBe('TAB_OWNED_BY_OTHER_SESSION');
    expect(err.message).toContain('pertenece a otra sesión');
    expect(err.message).toContain('usa tu propio grupo o pide handoff');

    // openTab con groupId ajeno → también denegado.
    const err2 = await clientB.sendToBroker({ type: 'openTab', url: 'https://x', groupId: 100 }).then(
      () => { throw new Error('should have rejected'); },
      (e) => e,
    );
    expect(err2.code).toBe('TAB_OWNED_BY_OTHER_SESSION');

    // Y un comando sobre la tab del grupo de la broker-session → denegado igual.
    await broker.sessionGroupCreate(); // group 300, tab 30 → 'sess_broker'
    const err3 = await clientA.sendToBroker({ type: 'closeTab', tabId: 30 }).then(
      () => { throw new Error('should have rejected'); },
      (e) => e,
    );
    expect(err3.code).toBe('TAB_OWNED_BY_OTHER_SESSION');
  });

  it('política: comando sobre tab sin grupo (usuario) → permitido + audit log', async () => {
    const res = await clientB.sendToBroker({ type: 'attach', tabId: 999 });
    expect(res).toEqual({});
    const logged = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(logged).toContain('[broker] session sess_b tocó tab de usuario 999');
  });

  it('heartbeat de grupo: muere A → sus tabs quedan libres y B puede operarlas', async () => {
    // B no puede tocar la tab 10 (grupo de A)…
    await expect(clientB.sendToBroker({ type: 'attach', tabId: 10 })).rejects.toMatchObject({
      code: 'TAB_OWNED_BY_OTHER_SESSION',
    });

    (clientA as any).ws.terminate();
    await vi.waitFor(() => expect((broker as any).clientSockets.size).toBe(1), { timeout: 2000, interval: 20 });
    // Solo queda registrado el grupo de B (200); el de A se olvidó.
    expect((broker as any).sessionGroups.size).toBe(1);
    expect((broker as any).sessionGroups.get(200)).toBe('sess_b');
    expect((broker as any).tabToGroup.has(10)).toBe(false);

    // …pero tras la muerte de A la tab vuelve a ser "de usuario": permitido.
    const res = await clientB.sendToBroker({ type: 'attach', tabId: 10 });
    expect(res).toEqual({});
  });

  it('listTabs del cliente resincroniza tabToGroup en el broker', async () => {
    // La extensión reporta la tab 10 movida al grupo 200 (de B) y la 20 cerrada.
    ext.removeAllListeners('message');
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (!msg.id) return;
      if (msg.type === 'listTabs') {
        ext.send(JSON.stringify({
          id: msg.id,
          type: 'result',
          result: { tabs: [
            { tabId: 10, url: 'https://a', groupId: 200 },
            { tabId: 999, url: 'https://user', groupId: -1 },
          ] },
        }));
        return;
      }
      ext.send(JSON.stringify({ id: msg.id, type: 'result', result: {} }));
    });

    await clientA.sendToBroker({ type: 'listTabs' });
    expect((broker as any).tabToGroup.get(10)).toBe(200);
    expect((broker as any).tabToGroup.has(20)).toBe(false);

    // La tab 10 ahora es del grupo de B: A ya no puede operarla.
    await expect(clientA.sendToBroker({ type: 'attach', tabId: 10 })).rejects.toMatchObject({
      code: 'TAB_OWNED_BY_OTHER_SESSION',
    });
    // Y B sí.
    await expect(clientB.sendToBroker({ type: 'attach', tabId: 10 })).resolves.toEqual({});
  });
});
