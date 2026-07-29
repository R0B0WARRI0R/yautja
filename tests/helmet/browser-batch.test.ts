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
    evaluated: [] as string[],
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
    public storageGet = vi.fn(async (_key: string) => undefined);
    public send = vi.fn(async (method: string, params?: any) => {
      if (method === 'Runtime.evaluate') {
        const expr = params?.expression;
        // Marker expressions from batch sub-actions: echo them as the value.
        if (typeof expr === 'string' && expr.startsWith('__marker_')) {
          mockState.evaluated.push(expr);
          return { result: { value: expr } };
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

describe('Helmet — browser_batch', () => {
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
    mockState.evaluated.length = 0;
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

  it('executes actions sequentially and returns per-index results', async () => {
    const env = await callTool(1, 'browser_batch', {
      actions: [
        { type: 'evaluate', expression: '__marker_a' },
        { type: 'evaluate', expression: '__marker_b' },
      ],
    });
    expect(env.ok).toBe(true);
    expect(env.result.total).toBe(2);
    expect(env.result.executed).toBe(2);
    expect(env.result.succeeded).toBe(2);
    expect(env.result.failed).toBe(0);
    expect(env.result.stoppedAt).toBeUndefined();
    expect(env.result.results).toHaveLength(2);
    expect(env.result.results[0]).toMatchObject({ index: 0, ok: true, value: '__marker_a' });
    expect(env.result.results[1]).toMatchObject({ index: 1, ok: true, value: '__marker_b' });
    expect(mockState.evaluated).toEqual(['__marker_a', '__marker_b']);
  });

  it('stops at the first failure with stopOnError default and reports stoppedAt', async () => {
    const env = await callTool(2, 'browser_batch', {
      actions: [
        { type: 'evaluate', expression: '__marker_ok' },
        { type: 'click' }, // INVALID_ARGUMENT: no selector nor ref
        { type: 'evaluate', expression: '__marker_never' },
      ],
    });
    expect(env.ok).toBe(true);
    expect(env.result.executed).toBe(2);
    expect(env.result.succeeded).toBe(1);
    expect(env.result.failed).toBe(1);
    expect(env.result.stoppedAt).toBe(1);
    expect(env.result.results[1].ok).toBe(false);
    expect(env.result.results[1].error).toBeDefined();
    expect(mockState.evaluated).toEqual(['__marker_ok']);
  });

  it('continues past failures with stopOnError:false', async () => {
    const env = await callTool(3, 'browser_batch', {
      stopOnError: false,
      actions: [
        { type: 'click' }, // fails
        { type: 'evaluate', expression: '__marker_after' },
      ],
    });
    expect(env.ok).toBe(true);
    expect(env.result.executed).toBe(2);
    expect(env.result.failed).toBe(1);
    expect(env.result.succeeded).toBe(1);
    expect(env.result.stoppedAt).toBeUndefined();
    expect(mockState.evaluated).toEqual(['__marker_after']);
  });

  it('rejects nested batch actions with INVALID_ARGUMENT', async () => {
    const env = await callTool(4, 'browser_batch', {
      actions: [
        { type: 'evaluate', expression: '__marker_a' },
        { type: 'browser_batch', actions: [] },
      ],
    });
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
    expect(env.error.message).toContain('not nestable');
    expect(mockState.evaluated).toEqual([]);
  });

  it('rejects an empty or missing actions array', async () => {
    const env = await callTool(5, 'browser_batch', { actions: [] });
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
  });

  it('is registered in tools/list with required schema', async () => {
    const beforeCount = stdoutLines.length;
    stdin.push(JSON.stringify({ jsonrpc: '2.0', id: 90, method: 'tools/list' }) + '\n');
    for (let i = 0; i < 100; i++) {
      if (stdoutLines.length > beforeCount) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const response = JSON.parse(stdoutLines[beforeCount]!);
    const tool = response.result.tools.find((t: any) => t.name === 'browser_batch');
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(['actions']);
  });
});
