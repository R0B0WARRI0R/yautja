import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable, Writable } from 'stream';
import { clearKillSwitchCache, BROWSER_BATCH_KILL_SWITCH_KEY } from '../../src/arsenal/kill-switch.js';

const mockState = vi.hoisted(() => {
  const domSummary = {
    url: 'https://example.com',
    semantic: {
      pageType: 'article',
      title: 'Example Domain',
      headings: ['Welcome'],
      mainContentPreview: 'Hello world',
      language: 'en',
    },
    interactive: { buttons: [], links: [], inputs: [], total: 0 },
    structural: {
      totalElements: 10,
      depth: 3,
      iframes: 0,
      images: 1,
      scripts: 2,
      forms: 0,
      stylesheets: 1,
    },
  };
  return {
    servers: [] as any[],
    domSummary,
    storageValues: {} as Record<string, any>,
  };
});

vi.mock('../../src/connection/extension-server.js', () => {
  class MockExtensionServer {
    public port: number;
    public isExtensionConnected = vi.fn(() => true);
    public start = vi.fn(async () => {});
    public stop = vi.fn(async () => {});
    public listTabs = vi.fn(async () => [
      { tabId: 1, url: 'https://example.com', title: 'Example', active: true, index: 0, windowId: 1, groupId: -1 },
    ]);
    public attachTab = vi.fn(async (_tabId: number) => {});
    public detachTab = vi.fn(async (_tabId: number) => {});
    public detachAll = vi.fn(async () => {});
    public switchToTab = vi.fn(async (_tabId: number) => {});
    public enableDomains = vi.fn(async (_domains: string[]) => {});
    public disableDomains = vi.fn(async (_domains: string[]) => {});
    public onStatusChange = vi.fn(() => () => {});
    public getBufferedEvents = vi.fn(() => []);
    public getCurrentTabId = vi.fn(() => 1);
    public getEnabledDomains = vi.fn(() => []);
    public getPort = vi.fn(() => 9876);
    public getExtensionId = vi.fn(() => 'yautjabridgeid123');
    public storageGet = vi.fn(async (key: string) => mockState.storageValues[key]);
    public send = vi.fn(async (method: string, _params?: any) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: JSON.stringify(mockState.domSummary) } };
      }
      if (method === 'Performance.getMetrics') {
        return { metrics: [] };
      }
      return {};
    });
    public on = vi.fn((_event: string, _handler: (params: any) => void) => () => {});
    public onEvent = vi.fn((_handler: any) => () => {});
    public setNetworkCaptureCallback = vi.fn((_cb: (msg: any) => void) => {});
    public listAllTargets = vi.fn(async () => []);
    public attachTarget = vi.fn(async (_targetId: string) => {});
    public detachTarget = vi.fn(async (_targetId: string) => {});
    public sendToTarget = vi.fn(async (_targetId: string, _method: string, _params?: Record<string, any>) => ({}));
    public managementGetAll = vi.fn(async () => []);
    public managementSetEnabled = vi.fn(async (_extId: string, _enabled: boolean) => {});
    public webRequestStart = vi.fn(async (_extId: string) => {});
    public webRequestStop = vi.fn(async (_extId: string) => {});
    public webRequestList = vi.fn(async (_extId: string) => ({ requests: [], count: 0, totalEventsSeen: 0 }));

    constructor(port: number = 9876) {
      this.port = port;
      mockState.servers.push(this);
    }
  }
  return { ExtensionServer: MockExtensionServer };
});

import { Helmet } from '../../src/helmet.js';

const PLAN_ARGS = {
  items: ['Reconocer la API', 'Mapear endpoints públicos', 'Resumir el modelo de auth'],
  domains: ['API.Example.com'],
  requestedLevel: 'P2',
};

describe('Helmet — plan_propose / plan_approve (P14.1)', () => {
  let helmet: Helmet;
  let stdin: Readable;
  let stdoutLines: string[];
  let originalStdin: typeof process.stdin;
  let originalStdout: typeof process.stdout;

  beforeEach(() => {
    originalStdin = process.stdin;
    originalStdout = process.stdout;
    stdin = new Readable({ read() {} });
    stdoutLines = [];
    const stdout = new Writable({
      write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
        stdoutLines.push(chunk.toString());
        cb();
      },
    });
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
    mockState.storageValues = {};
    clearKillSwitchCache();
    helmet = new Helmet({ postActionDelayMs: 0 });
    helmet.serveMCP();
  });

  afterEach(async () => {
    try {
      await helmet.stop();
    } catch {
      // ignore
    }
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: originalStdout, configurable: true });
  });

  async function callTool(id: number, name: string, args: object, timeoutMs = 5000): Promise<any> {
    const beforeCount = stdoutLines.length;
    stdin.push(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    const pollIntervalMs = 10;
    for (let i = 0; i < timeoutMs / pollIntervalMs; i++) {
      if (stdoutLines.length > beforeCount) break;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    if (stdoutLines.length <= beforeCount) {
      throw new Error(`No MCP response within ${timeoutMs}ms`);
    }
    return JSON.parse(JSON.parse(stdoutLines[beforeCount]!).result.content[0].text);
  }

  it('propose válido: guarda el plan, devuelve presentación y NO concede grants', async () => {
    const env = await callTool(1, 'plan_propose', PLAN_ARGS);
    expect(env.ok).toBe(true);
    expect(env.result.proposed).toBe(true);
    expect(env.result.plan.domains).toEqual(['api.example.com']);
    expect(env.result.plan.requestedLevel).toBe('P2');
    expect(env.result.presentation).toContain('api.example.com');
    expect(env.result.presentation).toContain('1. Reconocer la API');

    const status = await callTool(2, 'gateStatus', {});
    expect(status.result.activeGrants).toBe(0); // proponer no concede
    expect(status.result.pendingPlan).toMatchObject({ domains: ['api.example.com'], requestedLevel: 'P2' });
    expect(status.result.pendingPlan.items).toHaveLength(3);
  });

  it('propose inválido: items fuera de rango, dominio con scheme, nivel malo', async () => {
    const few = await callTool(3, 'plan_propose', { ...PLAN_ARGS, items: ['uno', 'dos'] });
    expect(few.ok).toBe(false);
    expect(few.error.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');

    const scheme = await callTool(4, 'plan_propose', { ...PLAN_ARGS, domains: ['https://api.example.com'] });
    expect(scheme.ok).toBe(false);
    expect(scheme.error.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');

    const level = await callTool(5, 'plan_propose', { ...PLAN_ARGS, requestedLevel: 'P9' });
    expect(level.ok).toBe(false);
    expect(level.error.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
  });

  it('approve sin plan pendiente → YJ.POLICY.PLAN_NOT_FOUND', async () => {
    const env = await callTool(6, 'plan_approve', { phrase: 'sí, adelante con el plan' });
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('YJ.POLICY.PLAN_NOT_FOUND');
    expect(env.error.agent_summary).toContain('plan_propose');
  });

  it('approve sin phrase → INVALID_ARGUMENT (mismo contrato que gateGrant)', async () => {
    await callTool(7, 'plan_propose', PLAN_ARGS);
    const env = await callTool(8, 'plan_approve', {});
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
  });

  it('approve crea UN grant con scope correcto, audit, y limpia el plan; gateRevoke por nivel lo retira', async () => {
    await callTool(9, 'plan_propose', PLAN_ARGS);
    const auditSpy = vi.spyOn((helmet as any).gates, 'audit');

    const env = await callTool(10, 'plan_approve', { phrase: 'apruebo el plan de recon' });
    expect(env.ok).toBe(true);
    expect(env.result.granted).toBe(true);
    expect(env.result.grant).toMatchObject({
      level: 'P2',
      grantedBy: 'user_phrase',
      phrase: 'apruebo el plan de recon',
      scope: { hosts: ['api.example.com'] },
    });

    // audit: gateGrant (de SessionGates.grant) + planApprove (del helmet)
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'gateGrant', level: 'P2' }));
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'planApprove', level: 'P2', domains: ['api.example.com'] }));

    // grant real: browserFetch GET con cookies ahora pasa el gate
    const status = await callTool(11, 'gateStatus', {});
    expect(status.result.activeGrants).toBe(1);
    expect(status.result.pendingPlan).toBeNull(); // consumido

    // item 4: no hace falta plan_revoke — gateRevoke por nivel cubre el grant
    const revoke = await callTool(12, 'gateRevoke', { level: 'P2' });
    expect(revoke.result.revoked).toBe(1);
    const after = await callTool(13, 'gateStatus', {});
    expect(after.result.activeGrants).toBe(0);
  });

  it('un nuevo propose sustituye al plan pendiente (idempotencia de propuesta)', async () => {
    await callTool(14, 'plan_propose', PLAN_ARGS);
    await callTool(15, 'plan_propose', {
      items: ['Paso A', 'Paso B', 'Paso C'],
      domains: ['other.example.org'],
      requestedLevel: 'P1',
    });
    const status = await callTool(16, 'gateStatus', {});
    expect(status.result.pendingPlan).toMatchObject({ domains: ['other.example.org'], requestedLevel: 'P1' });

    const env = await callTool(17, 'plan_approve', { phrase: 'ok, el segundo plan' });
    expect(env.result.grant.scope.hosts).toEqual(['other.example.org']);
    expect(env.result.grant.level).toBe('P1');
  });

  it('ambas tools están registradas en tools/list', async () => {
    const beforeCount = stdoutLines.length;
    stdin.push(JSON.stringify({ jsonrpc: '2.0', id: 90, method: 'tools/list' }) + '\n');
    for (let i = 0; i < 100; i++) {
      if (stdoutLines.length > beforeCount) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const response = JSON.parse(stdoutLines[beforeCount]!);
    const names = response.result.tools.map((t: any) => t.name);
    expect(names).toContain('plan_propose');
    expect(names).toContain('plan_approve');
    const propose = response.result.tools.find((t: any) => t.name === 'plan_propose');
    expect(propose.inputSchema.required).toEqual(['items', 'domains']);
  });
});

describe('Helmet — browser_batch kill switch (yjBrowserBatch)', () => {
  let helmet: Helmet;
  let stdin: Readable;
  let stdoutLines: string[];
  let originalStdin: typeof process.stdin;
  let originalStdout: typeof process.stdout;

  beforeEach(() => {
    originalStdin = process.stdin;
    originalStdout = process.stdout;
    stdin = new Readable({ read() {} });
    stdoutLines = [];
    const stdout = new Writable({
      write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
        stdoutLines.push(chunk.toString());
        cb();
      },
    });
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
    mockState.storageValues = { [BROWSER_BATCH_KILL_SWITCH_KEY]: false };
    clearKillSwitchCache();
    helmet = new Helmet({ postActionDelayMs: 0 });
    helmet.serveMCP();
  });

  afterEach(async () => {
    try {
      await helmet.stop();
    } catch {
      // ignore
    }
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: originalStdout, configurable: true });
  });

  it('devuelve YJ.POLICY.FEATURE_DISABLED con hint del kill switch cuando yjBrowserBatch=false', async () => {
    const beforeCount = stdoutLines.length;
    stdin.push(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'browser_batch', arguments: { actions: [{ type: 'evaluate', expression: '1+1' }] } },
    }) + '\n');
    for (let i = 0; i < 500; i++) {
      if (stdoutLines.length > beforeCount) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const env = JSON.parse(JSON.parse(stdoutLines[beforeCount]!).result.content[0].text);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('YJ.POLICY.FEATURE_DISABLED');
    expect(env.error.message).toContain(BROWSER_BATCH_KILL_SWITCH_KEY);
    expect(env.error.agent_summary).toContain('kill switch');
    // no se ejecutó ninguna sub-acción
    const server = mockState.servers[mockState.servers.length - 1];
    expect(server.send).not.toHaveBeenCalledWith('Runtime.evaluate', expect.anything());
  });
});
