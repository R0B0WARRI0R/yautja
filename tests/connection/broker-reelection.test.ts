import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { BrokerClient } from '../../src/connection/broker-client.js';
import { queryBrokerInfo, scanForBroker } from '../../src/connection/broker-discovery.js';
import { BrokerReelection } from '../../src/connection/broker-reelection.js';
import { BrokerDisconnectedError, ExtensionServer } from '../../src/connection/extension-server.js';

/**
 * Tests de reelección y re-registro automático (Tanda C multi-instancia).
 * Mismo patrón que broker-client.test.ts: fake extension = WebSocket cliente
 * que imita a extension/background.js; los helmets son ExtensionServer reales
 * en puertos efímeros (la ventana de escaneo se parametriza con el puerto
 * base libre de cada test — nunca 9876).
 */

/** Sonda/escaneo rápidos para tests (los defaults son 500ms/5s). */
const SCAN_TIMEOUT = 150;
const REELECTION_INTERVAL = 40;

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
}

/** Fake extension: responde result a todo comando con id. */
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
  const probe = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((res) => probe.on('listening', res));
  const port = (probe.address() as any).port;
  await new Promise<void>((res) => probe.close(() => res()));
  return port;
}

describe('Reelección de broker (Tanda C)', () => {
  let servers: ExtensionServer[];
  let clients: BrokerClient[];
  let reelections: BrokerReelection[];
  let extensions: WebSocket[];
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    servers = [];
    clients = [];
    reelections = [];
    extensions = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    for (const ws of extensions) {
      try { ws.close(); } catch {}
    }
    for (const r of reelections) await r.stop();
    for (const c of clients) await c.stop();
    for (const s of servers) await s.stop();
  });

  /** Helmet real en el siguiente puerto libre de la ventana (base, base+1…). */
  async function makeServer(basePort: number, sessionId: string): Promise<ExtensionServer> {
    const server = new ExtensionServer(basePort);
    server.setBrokerSessionId(sessionId);
    await server.start();
    servers.push(server);
    return server;
  }

  async function makeClient(port: number, sessionId: string, groupId?: number): Promise<BrokerClient> {
    const client = new BrokerClient(port, sessionId);
    if (groupId !== undefined) client.setGroupId(groupId);
    clients.push(client);
    return client;
  }

  function makeReelection(server: ExtensionServer, sessionId: string, windowBasePort: number, groupId?: number): BrokerReelection {
    const reelection = new BrokerReelection({
      server,
      sessionId,
      windowBasePort,
      getGroupId: () => groupId ?? null,
      intervalMs: REELECTION_INTERVAL,
      scanTimeoutMs: SCAN_TIMEOUT,
    });
    reelections.push(reelection);
    return reelection;
  }

  function connectFakeExtension(port: number, respondTo: (msg: any) => any | null): Promise<WebSocket> {
    const ws = connectExtension(port, respondTo);
    extensions.push(ws);
    return waitForOpen(ws).then(() => ws);
  }

  it('discovery: brokerInfo responde con sessionId y hasExtension', async () => {
    const base = await freePort();
    const server = await makeServer(base, 'sess_a');

    expect(await queryBrokerInfo(base, SCAN_TIMEOUT)).toEqual({ sessionId: 'sess_a', hasExtension: false });

    await connectFakeExtension(base, () => ({}));
    await vi.waitFor(() => expect(server.isExtensionConnected()).toBe(true), { timeout: 2000, interval: 20 });
    expect(await queryBrokerInfo(base, SCAN_TIMEOUT)).toEqual({ sessionId: 'sess_a', hasExtension: true });

    // Puerto muerto → null (sin excepción).
    const dead = await freePort();
    expect(await queryBrokerInfo(dead, SCAN_TIMEOUT)).toBeNull();
  });

  it('discovery: scanForBroker devuelve el helmet vivo de menor puerto', async () => {
    const base = await freePort();
    const a = await makeServer(base, 'sess_a');
    const b = await makeServer(base, 'sess_b');
    const c = await makeServer(base, 'sess_c');
    expect(a.getPort()).toBe(base);
    expect(b.getPort()).toBeGreaterThan(a.getPort());
    expect(c.getPort()).toBeGreaterThan(b.getPort());

    const brokerPorts = [a.getPort(), b.getPort(), c.getPort()];
    const found = await scanForBroker(brokerPorts, SCAN_TIMEOUT);
    expect(found?.port).toBe(base);
    expect(found?.info.sessionId).toBe('sess_a');

    // Puertos muertos se saltan en orden.
    const dead = await freePort();
    const found2 = await scanForBroker([dead, c.getPort()], SCAN_TIMEOUT);
    expect(found2?.port).toBe(c.getPort());
  });

  it('muerte del broker: el de menor puerto promueve, el otro se re-registra y el forwarding vuelve', async () => {
    const base = await freePort();
    const brokerA = await makeServer(base, 'sess_a');
    const serverB = await makeServer(base, 'sess_b');
    const serverC = await makeServer(base, 'sess_c');

    await connectFakeExtension(base, (msg) => (msg.type === 'listTabs' ? { tabs: [] } : {}));
    await vi.waitFor(() => expect(brokerA.isExtensionConnected()).toBe(true), { timeout: 2000, interval: 20 });

    const clientB = await makeClient(base, 'sess_b');
    serverB.setBrokerClient(clientB);
    expect(await clientB.start()).toBe(true);
    const reelectionB = makeReelection(serverB, 'sess_b', base);
    reelectionB.adopt(clientB);

    const clientC = await makeClient(base, 'sess_c');
    serverC.setBrokerClient(clientC);
    expect(await clientC.start()).toBe(true);
    const reelectionC = makeReelection(serverC, 'sess_c', base);
    reelectionC.adopt(clientC);

    // Muere el broker A (y con él la extensión conectada a su puerto).
    await brokerA.stop();
    await vi.waitFor(() => expect(clientC.isRegistered()).toBe(false), { timeout: 2000, interval: 20 });

    // Modo degradado: falla rápido con el error tipado.
    await expect(serverC.sendRaw({ type: 'listTabs' })).rejects.toBeInstanceOf(BrokerDisconnectedError);

    // B (menor puerto vivo) no encuentra helmet menor → se autopromueve.
    await vi.waitFor(() => expect(reelectionB.isPromoted()).toBe(true), { timeout: 3000, interval: 20 });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining(`promoted to broker on port ${base + 1}`));

    // La extensión rota hasta el puerto del promovido: slot libre → aceptada.
    await connectFakeExtension(base + 1, (msg) => (msg.type === 'listTabs' ? { tabs: [{ tabId: 9, url: 'https://y' }] } : {}));
    await vi.waitFor(() => expect(serverB.isExtensionConnected()).toBe(true), { timeout: 2000, interval: 20 });

    // C encuentra a B en su escaneo y se re-registra: sale del degradado.
    await vi.waitFor(() => expect(reelectionC.getClient()?.isRegistered()).toBe(true), { timeout: 3000, interval: 20 });
    expect(reelectionC.getClient()?.getBrokerSessionId()).toBe('sess_b');

    // El forwarding vuelve a funcionar a través del nuevo broker.
    const res = await serverC.sendRaw({ type: 'listTabs' });
    expect(res).toEqual({ tabs: [{ tabId: 9, url: 'https://y' }] });
  });

  it('autopromoción: el promovido acepta la fake extension y registros de otro cliente', async () => {
    const base = await freePort();
    const brokerA = await makeServer(base, 'sess_a');
    const serverB = await makeServer(base, 'sess_b');

    const clientB = await makeClient(base, 'sess_b');
    serverB.setBrokerClient(clientB);
    expect(await clientB.start()).toBe(true);
    const reelectionB = makeReelection(serverB, 'sess_b', base);
    reelectionB.adopt(clientB);

    await brokerA.stop();
    await vi.waitFor(() => expect(reelectionB.isPromoted()).toBe(true), { timeout: 3000, interval: 20 });

    // La extensión rota al puerto del promovido (slot libre) y es aceptada.
    await connectFakeExtension(base + 1, (msg) => (msg.type === 'listTabs' ? { tabs: [{ tabId: 3, url: 'https://z' }] } : {}));
    await vi.waitFor(() => expect(serverB.isExtensionConnected()).toBe(true), { timeout: 2000, interval: 20 });

    // Comando local del promovido contra su extensión.
    const local = await serverB.sendRaw({ type: 'listTabs' });
    expect(local).toEqual({ tabs: [{ tabId: 3, url: 'https://z' }] });

    // Otro helmet se registra en el promovido y su comando llega a la extensión.
    const clientD = await makeClient(base + 1, 'sess_d');
    expect(await clientD.start()).toBe(true);
    expect(clientD.getBrokerSessionId()).toBe('sess_b');
    const res = await clientD.sendToBroker({ type: 'listTabs' });
    expect(res).toEqual({ tabs: [{ tabId: 3, url: 'https://z' }] });
  });

  it('registro inicial fallido: sin helmet menor que acepte, el bucle promueve (standalone → broker)', async () => {
    const base = await freePort();
    // Un proceso ajeno a Yautja ocupa el puerto base (no responde brokerInfo).
    const { WebSocketServer } = await import('ws');
    const squatter = new WebSocketServer({ port: base, host: '127.0.0.1' });
    await new Promise<void>((res) => squatter.on('listening', res));
    try {
      const serverB = await makeServer(base, 'sess_b');
      expect(serverB.getPort()).toBe(base + 1);
      const reelectionB = makeReelection(serverB, 'sess_b', base);
      reelectionB.start();
      await vi.waitFor(() => expect(reelectionB.isPromoted()).toBe(true), { timeout: 3000, interval: 20 });
    } finally {
      await new Promise<void>((res) => squatter.close(() => res()));
    }
  });

  it('re-registro con groupId repuebla sessionGroups del nuevo broker', async () => {
    const base = await freePort();
    const broker = await makeServer(base, 'sess_broker');
    const client = await makeClient(base, 'sess_g', 555);
    expect(await client.start()).toBe(true);
    expect((broker as any).sessionGroups.get(555).sessionId).toBe('sess_g');
  });

  it('el puerto base reaparece y comparte la extensión del broker de puerto superior', async () => {
    const base = await freePort();
    const original = await makeServer(base, 'sess_original');
    const survivor = await makeServer(base, 'sess_survivor');
    await original.stop();
    await connectFakeExtension(survivor.getPort(), msg => msg.type === 'listTabs' ? { tabs: [{ tabId: 42 }] } : {});
    await vi.waitFor(() => expect(survivor.isExtensionConnected()).toBe(true));
    const ownerElection = makeReelection(survivor, 'sess_survivor', base);
    ownerElection.start();

    const restarted = await makeServer(base, 'sess_restarted');
    expect(restarted.getPort()).toBe(base);
    const election = makeReelection(restarted, 'sess_restarted', base, 555);
    election.start();
    await vi.waitFor(() => expect(election.getClient()?.getBrokerSessionId()).toBe('sess_survivor'), { timeout: 3000 });
    expect(await restarted.sendRaw({ type: 'listTabs' })).toEqual({ tabs: [{ tabId: 42 }] });
    expect((survivor as any).sessionGroups.get(555).sessionId).toBe('sess_restarted');
    expect(ownerElection.getClient()).toBeNull();
    expect((await queryBrokerInfo(base, SCAN_TIMEOUT))?.hasExtension).toBe(false);
  });

  it('un broker sin extensión sigue buscando después de promocionarse', async () => {
    const base = await freePort();
    const server = await makeServer(base, 'sess_base');
    const election = makeReelection(server, 'sess_base', base);
    election.start();
    await vi.waitFor(() => expect(election.isPromoted()).toBe(true));
    const later = await makeServer(base, 'sess_later');
    await connectFakeExtension(later.getPort(), msg => msg.type === 'listTabs' ? { tabs: [{ tabId: 43 }] } : {});
    await vi.waitFor(() => expect(election.getClient()?.getBrokerSessionId()).toBe('sess_later'), { timeout: 3000 });
    expect(await server.sendRaw({ type: 'listTabs' })).toEqual({ tabs: [{ tabId: 43 }] });
    expect(election.isPromoted()).toBe(false);
  });

  it('un cliente registrado se recupera si la extensión cambia de broker sin morir el anterior', async () => {
    const base = await freePort();
    const oldBroker = await makeServer(base, 'sess_old');
    const server = await makeServer(base, 'sess_client');
    const newBroker = await makeServer(base, 'sess_new');
    const extension = await connectFakeExtension(base, () => ({}));
    await vi.waitFor(() => expect(oldBroker.isExtensionConnected()).toBe(true));
    const client = await makeClient(base, 'sess_client');
    server.setBrokerClient(client);
    expect(await client.start()).toBe(true);
    const election = makeReelection(server, 'sess_client', base);
    election.adopt(client);
    extension.close();
    await vi.waitFor(() => expect(server.isExtensionConnected()).toBe(false));
    expect(client.isRegistered()).toBe(true);
    await connectFakeExtension(newBroker.getPort(), msg => msg.type === 'listTabs' ? { tabs: [{ tabId: 44 }] } : {});
    await vi.waitFor(() => expect(election.getClient()?.getBrokerSessionId()).toBe('sess_new'), { timeout: 3000 });
    expect(await server.sendRaw({ type: 'listTabs' })).toEqual({ tabs: [{ tabId: 44 }] });
    expect(client.isRegistered()).toBe(false);
  });

  it('los clientes de un broker que pasa a cliente buscan al propietario directo', async () => {
    const base = await freePort();
    const oldBroker = await makeServer(base, 'sess_old');
    const server = await makeServer(base, 'sess_client');
    const newBroker = await makeServer(base, 'sess_new');
    const client = await makeClient(base, 'sess_client');
    server.setBrokerClient(client);
    expect(await client.start()).toBe(true);
    const owner = makeReelection(oldBroker, 'sess_old', base);
    owner.start();
    await connectFakeExtension(newBroker.getPort(), msg => msg.type === 'listTabs' ? { tabs: [{ tabId: 45 }] } : {});
    await vi.waitFor(() => expect(oldBroker.isExtensionConnected()).toBe(true));
    // Local connectivity of the intermediate peer must not advertise a route
    // to its clients: that route would lose the original session namespace.
    expect(client.getBridgeState()?.connected).toBe(false);
    await expect(client.sendToBroker({ type: 'listTabs' })).rejects.toThrow('extension not connected');
    const election = makeReelection(server, 'sess_client', base);
    election.adopt(client);
    await vi.waitFor(() => expect(election.getClient()?.getBrokerSessionId()).toBe('sess_new'));
    expect(await server.sendRaw({ type: 'listTabs' })).toEqual({ tabs: [{ tabId: 45 }] });
  });

  it('stop durante discovery descarta el resultado tardío y no registra un cliente', async () => {
    const base = await freePort();
    const server = await makeServer(base, 'sess_stopping');
    const broker = await makeServer(base, 'sess_owner');
    await connectFakeExtension(broker.getPort(), () => ({}));
    await vi.waitFor(() => expect(broker.isExtensionConnected()).toBe(true));
    const election = makeReelection(server, 'sess_stopping', base);
    election.start();
    await election.stop();
    expect(election.getClient()).toBeNull();
    expect((broker as any).clientSockets.size).toBe(0);
    expect(server.isExtensionConnected()).toBe(false);
  });

  it('resiliencia MV3: la reconexión de la extensión al broker no rompe a los clientes', async () => {
    const base = await freePort();
    const broker = await makeServer(base, 'sess_broker');

    const ext1 = await connectFakeExtension(base, (msg) => (msg.type === 'listTabs' ? { tabs: [{ tabId: 1 }] } : {}));
    await vi.waitFor(() => expect(broker.isExtensionConnected()).toBe(true), { timeout: 2000, interval: 20 });

    const client = await makeClient(base, 'sess_c');
    expect(await client.start()).toBe(true);
    expect(await client.sendToBroker({ type: 'listTabs' })).toEqual({ tabs: [{ tabId: 1 }] });

    // La extensión cae (MV3 mata el SW) y reconecta al mismo puerto.
    ext1.close();
    await vi.waitFor(() => expect(broker.isExtensionConnected()).toBe(false), { timeout: 2000, interval: 20 });
    await connectFakeExtension(base, (msg) => (msg.type === 'listTabs' ? { tabs: [{ tabId: 2 }] } : {}));
    await vi.waitFor(() => expect(broker.isExtensionConnected()).toBe(true), { timeout: 2000, interval: 20 });

    // El canal del cliente sigue intacto: registrado, mismo slot, comandos OK.
    expect(client.isRegistered()).toBe(true);
    expect((broker as any).clientSockets.size).toBe(1);
    expect(await client.sendToBroker({ type: 'listTabs' })).toEqual({ tabs: [{ tabId: 2 }] });
  });
});
