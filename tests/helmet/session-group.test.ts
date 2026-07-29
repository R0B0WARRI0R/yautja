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
    tabs: [
      { tabId: 1, url: 'https://example.com', title: 'Example', active: true, index: 0, windowId: 1, groupId: -1 },
    ] as any[],
  };
});

vi.mock('../../src/connection/extension-server.js', () => {
  class MockExtensionServer {
    public port: number;
    public isExtensionConnected = vi.fn(() => true);
    public start = vi.fn(async () => {});
    public stop = vi.fn(async () => {});
    public listTabs = vi.fn(async () => mockState.tabs);
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
    public storageGet = vi.fn(async (_key: string) => undefined);
    public sessionGroupCreate = vi.fn(async (_title: string, _color: string) => {
      const groupId = 42;
      const tabId = 99;
      mockState.tabs.push({ tabId, url: 'about:blank', title: '', active: false, index: 1, windowId: 1, groupId });
      return { groupId, tabId };
    });
    public openTab = vi.fn(async (url: string, groupId?: number) => {
      const tabId = 100 + mockState.tabs.length;
      mockState.tabs.push({ tabId, url, title: '', active: true, index: mockState.tabs.length, windowId: 1, groupId: groupId ?? -1 });
      return { tabId, url };
    });
    public closeTab = vi.fn(async (tabId: number) => {
      mockState.tabs = mockState.tabs.filter((t) => t.tabId !== tabId);
    });
    public send = vi.fn(async (method: string, params?: any) => {
      if (method === 'Runtime.evaluate') {
        if (params?.expression === 'location.href') {
          return { result: { value: 'https://example.com/' } };
        }
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

function server(): any {
  return mockState.servers[mockState.servers.length - 1];
}

describe('Helmet — session tab group (P8)', () => {
  let helmet: Helmet;
  let stdin: Readable;
  let stdoutLines: string[];
  let originalStdin: typeof process.stdin;
  let originalStdout: typeof process.stdout;
  let nextId = 1;

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
    mockState.tabs = [
      { tabId: 1, url: 'https://example.com', title: 'Example', active: true, index: 0, windowId: 1, groupId: -1 },
    ];
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

  async function callTool(name: string, args: object, timeoutMs = 8000): Promise<any> {
    const id = nextId++;
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

  it('sessionGroupCreate creates the group and is idempotent', async () => {
    const first = await callTool('sessionGroupCreate', {});
    expect(first.ok).toBe(true);
    expect(first.result.groupId).toBe(42);
    expect(first.result.tabId).toBe(99);
    expect(first.result.existed).toBe(false);

    const second = await callTool('sessionGroupCreate', {});
    expect(second.ok).toBe(true);
    expect(second.result.groupId).toBe(42);
    expect(second.result.existed).toBe(true);
    expect(server().sessionGroupCreate).toHaveBeenCalledTimes(1);
  });

  it('openTab creates the tab inside the session group by default', async () => {
    await callTool('sessionGroupCreate', {});
    const env = await callTool('openTab', { url: 'https://example.com/page' });
    expect(env.ok).toBe(true);
    expect(env.result.groupId).toBe(42);
    expect(server().openTab).toHaveBeenCalledWith('https://example.com/page', 42);
  });

  it('openTab with inGroup:false stays outside the group', async () => {
    await callTool('sessionGroupCreate', {});
    const env = await callTool('openTab', { url: 'https://example.com/outside', inGroup: false });
    expect(env.ok).toBe(true);
    expect(env.result.groupId).toBeUndefined();
    expect(server().openTab).toHaveBeenCalledWith('https://example.com/outside', undefined);
  });

  it('listTabs reports groupId / inSessionGroup per tab', async () => {
    await callTool('sessionGroupCreate', {});
    const env = await callTool('listTabs', {});
    expect(env.ok).toBe(true);
    expect(env.result.sessionGroupId).toBe(42);
    const userTab = env.result.tabs.find((t: any) => t.tabId === 1);
    const groupTab = env.result.tabs.find((t: any) => t.tabId === 99);
    expect(userTab.inSessionGroup).toBe(false);
    expect(groupTab.inSessionGroup).toBe(true);
    expect(groupTab.groupId).toBe(42);
  });

  it('closeTab rejects tabs outside the session group with TAB_OUTSIDE_GROUP', async () => {
    await callTool('sessionGroupCreate', {});
    const env = await callTool('closeTab', { tabId: 1 });
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('YJ.POLICY.GATE_DENIED');
    expect(server().closeTab).not.toHaveBeenCalled();
  });

  it('closeTab allows in-group tabs and force:true bypasses the guard', async () => {
    await callTool('sessionGroupCreate', {});
    const inside = await callTool('closeTab', { tabId: 99 });
    expect(inside.ok).toBe(true);
    expect(server().closeTab).toHaveBeenCalledWith(99);

    const forced = await callTool('closeTab', { tabId: 1, force: true });
    expect(forced.ok).toBe(true);
    expect(server().closeTab).toHaveBeenCalledWith(1);
  });
});
