import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable, Writable } from 'stream';

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
  };
});

vi.mock('../src/connection/extension-server.js', () => {
  class MockExtensionServer {
    public port: number;
    public isExtensionConnected = vi.fn(() => true);
    public hasLocalExtension = vi.fn(() => true);
    public start = vi.fn(async () => {});
    public stop = vi.fn(async () => {});
    public listTabs = vi.fn(async () => [
      { tabId: 1, url: 'https://example.com', title: 'Example', active: true, index: 0, windowId: 1 },
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
    public send = vi.fn(async (method: string) => {
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
    // New extension-intel methods (added with ext* tools)
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
    // Multi-instancia (Tanda A)
    public setBrokerSessionId = vi.fn((_sessionId: string) => {});
    public setBrokerClient = vi.fn((_client: any) => {});
    public dispatchBrokerEvent = vi.fn((_payload: any) => {});

    constructor(port: number = 9876) {
      this.port = port;
      mockState.servers.push(this);
    }
  }
  return { ExtensionServer: MockExtensionServer };
});

vi.mock('../src/connection/broker-client.js', () => {
  // Sin broker vivo en tests: start() false → el helmet queda en standalone.
  class MockBrokerClient {
    public start = vi.fn(async () => false);
    public stop = vi.fn(async () => {});
    public isRegistered = vi.fn(() => false);
    public onEvent = vi.fn((_handler: any) => () => {});
    public onStatusChange = vi.fn((_handler: any) => () => {});
    public getBrokerSessionId = vi.fn(() => null);
    public sendToBroker = vi.fn(async () => ({}));
  }
  return { BrokerClient: MockBrokerClient };
});

import { Helmet } from '../src/helmet.js';

describe('Helmet — MCP protocol', () => {
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
    helmet = new Helmet();
  });

  afterEach(async () => {
    try {
      await helmet.stop();
    } catch {
      // ignore — stop may fail if start was never called
    }
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: originalStdout, configurable: true });
  });

  async function sendMCP(line: object, timeoutMs = 1000): Promise<any> {
    const beforeCount = stdoutLines.length;
    stdin.push(JSON.stringify(line) + '\n');
    const pollIntervalMs = 10;
    for (let i = 0; i < timeoutMs / pollIntervalMs; i++) {
      if (stdoutLines.length > beforeCount) break;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    if (stdoutLines.length <= beforeCount) {
      throw new Error(`No MCP response within ${timeoutMs}ms`);
    }
    return JSON.parse(stdoutLines[beforeCount]!);
  }

  it('initialize returns correct serverInfo and protocolVersion', async () => {
    helmet.serveMCP();
    const response = await sendMCP({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
    });
    expect(response.id).toBe(1);
    expect(response.jsonrpc).toBe('2.0');
    expect(response.result.serverInfo).toEqual({ name: 'yautja', version: '0.2.0' });
    expect(response.result.protocolVersion).toBe('2024-11-05');
    expect(response.result.capabilities).toEqual({ tools: {}, resources: {} });
    expect(response.result.schema_version).toBe('1.0');
  });

  it('tools/list returns core tools with correct names and schemas', async () => {
    helmet.serveMCP();
    const response = await sendMCP({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(response.id).toBe(2);
    const names = response.result.tools.map((t: any) => t.name);
    // Core tools must always be present (many more tools exist now)
    for (const core of [
      'observe', 'act', 'inspect', 'diff',
      'morph_compile', 'morph_list', 'morph_run', 'morph_explain',
    ]) {
      expect(names).toContain(core);
    }
    for (const tool of response.result.tools) {
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('inputSchema');
      expect(tool.inputSchema.type).toBe('object');
    }
    const observe = response.result.tools.find((t: any) => t.name === 'observe');
    expect(observe.inputSchema.required).toEqual(['question']);
    const act = response.result.tools.find((t: any) => t.name === 'act');
    expect(act.inputSchema.required).toEqual(['action']);
    const inspect = response.result.tools.find((t: any) => t.name === 'inspect');
    expect(inspect.inputSchema.properties.domain.enum).toEqual([
      'network', 'dom', 'console', 'performance', 'security',
    ]);
  });

  it('tools/call observe returns non-empty observation text', async () => {
    helmet.serveMCP();
    const response = await sendMCP({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'observe', arguments: { question: 'what is on this page?' } },
    });
    expect(response.id).toBe(3);
    expect(response.result.content).toHaveLength(1);
    expect(response.result.content[0].type).toBe('text');
    expect(typeof response.result.content[0].text).toBe('string');
    expect(response.result.content[0].text.length).toBeGreaterThan(0);
  });

  it('tools/call act returns action result inside a doctrine envelope', async () => {
    helmet.serveMCP();
    const response = await sendMCP({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'act', arguments: { action: { type: 'evaluate', expression: '1+1' } } },
    }, 3000);
    expect(response.id).toBe(4);
    const parsed = JSON.parse(response.result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.schema_version).toBe('1.0');
    expect(parsed.result.success).toBe(true);
  });

  it('tools/call inspect returns domain summary as JSON', async () => {
    helmet.serveMCP();
    const response = await sendMCP({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'inspect', arguments: { domain: 'network' } },
    });
    const parsed = JSON.parse(response.result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.result).toHaveProperty('total');
    expect(parsed.result).toHaveProperty('completed');
    expect(parsed.result).toHaveProperty('failed');
  });

  it('tools/call diff returns no-previous-state message when memory is empty', async () => {
    helmet.serveMCP();
    const response = await sendMCP({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'diff', arguments: {} },
    });
    expect(response.result.content[0].text).toContain('No previous state');
  });

  it('unknown method returns JSON-RPC error -32601', async () => {
    helmet.serveMCP();
    const response = await sendMCP({ jsonrpc: '2.0', id: 99, method: 'nonsense/method' });
    expect(response.id).toBe(99);
    expect(response.error).toBeDefined();
    expect(response.error.code).toBe(-32601);
    expect(response.error.message).toContain('Unknown method');
  });

  it('unknown tool returns error text in content', async () => {
    helmet.serveMCP();
    const response = await sendMCP({
      jsonrpc: '2.0',
      id: 100,
      method: 'tools/call',
      params: { name: 'unknown_tool', arguments: {} },
    });
    expect(response.result.content[0].type).toBe('text');
    expect(response.result.content[0].text).toContain('Unknown tool');
  });

  it('ping returns empty result object', async () => {
    helmet.serveMCP();
    const response = await sendMCP({ jsonrpc: '2.0', id: 7, method: 'ping' });
    expect(response.id).toBe(7);
    expect(response.result).toEqual({});
    expect(response.error).toBeUndefined();
  });
});

describe('Helmet — lifecycle', () => {
  let helmet: Helmet;

  beforeEach(() => {
    helmet = new Helmet();
  });

  afterEach(async () => {
    try {
      await helmet.stop();
    } catch {
      // ignore
    }
  });

  it('isReady is false before start', () => {
    expect(helmet.isReady()).toBe(false);
  });

  it('start connects to extension, attaches to a tab, and subscribes sensors', async () => {
    expect(helmet.isReady()).toBe(false);
    await helmet.start();
    expect(helmet.isReady()).toBe(true);
    const server = mockState.servers[mockState.servers.length - 1]!;
    expect(server.start).toHaveBeenCalled();
    expect(server.listTabs).toHaveBeenCalled();
    expect(server.attachTab).toHaveBeenCalled();
    expect(server.enableDomains).toHaveBeenCalled();
  });

  it('stop stops the extension server', async () => {
    await helmet.start();
    const server = mockState.servers[mockState.servers.length - 1]!;
    await helmet.stop();
    expect(server.stop).toHaveBeenCalled();
  });

  it('honors a custom port and disables autoAttach', async () => {
    const custom = new Helmet({ port: 9999, autoAttach: false });
    try {
      await custom.start();
      const server = mockState.servers[mockState.servers.length - 1]!;
      expect(server.port).toBe(9999);
      expect(server.listTabs).not.toHaveBeenCalled();
      expect(server.attachTab).not.toHaveBeenCalled();
      expect(custom.isReady()).toBe(false);
    } finally {
      await custom.stop();
    }
  });
});

describe('Helmet — tool surface (direct API)', () => {
  let helmet: Helmet;

  beforeEach(async () => {
    helmet = new Helmet();
    await helmet.start();
  });

  afterEach(async () => {
    await helmet.stop();
  });

  it('inspect accepts all 5 valid domains', async () => {
    for (const domain of ['network', 'dom', 'console', 'performance', 'security']) {
      const result = await helmet.inspect(domain);
      expect(() => JSON.parse(result)).not.toThrow();
    }
  });

  it('inspect returns an error message for unknown domain', async () => {
    const result = await helmet.inspect('not_a_domain');
    expect(result).toContain('unknown domain');
  });

  it('diff returns the no-previous-state message until an action is performed', async () => {
    const result = await helmet.diff();
    expect(result).toContain('No previous state');
  });
});
