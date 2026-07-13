import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable, Writable } from 'stream';

vi.mock('../../src/connection/extension-server.js', () => {
  class MES {
    isExtensionConnected = vi.fn(() => true);
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
    listTabs = vi.fn(async () => [{ tabId: 1, url: 'https://example.com', title: 'Example', active: true, index: 0, windowId: 1 }]);
    attachTab = vi.fn(async () => {});
    detachAll = vi.fn(async () => {});
    detachTab = vi.fn(async () => {});
    switchToTab = vi.fn(async () => {});
    enableDomains = vi.fn(async () => {});
    disableDomains = vi.fn(async () => {});
    onStatusChange = vi.fn(() => () => {});
    getCurrentTabId = vi.fn(() => 1);
    setNetworkCaptureCallback = vi.fn();
    on = vi.fn(() => () => {});
    send = vi.fn(async () => ({}));
  }
  return { ExtensionServer: MES };
});

import { Helmet } from '../../src/helmet.js';

let origStdin: typeof process.stdin;
let origStdout: typeof process.stdout;

function spawn() {
  const stdin = new Readable({ read() {} });
  const out: string[] = [];
  const capturedStream = new Writable({
    write(chunk, encoding, callback) {
      out.push(chunk.toString());
      callback();
    },
  });
  origStdin = process.stdin;
  origStdout = process.stdout;
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  Object.defineProperty(process, 'stdout', { value: capturedStream, configurable: true });
  const h = new Helmet({ port: 9999 });
  h.serveMCP();
  return { h, stdin, out };
}

function teardown() {
  Object.defineProperty(process, 'stdout', { value: origStdout, configurable: true });
  Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true });
}

async function send(stdin: Readable, out: string[], o: unknown): Promise<any> {
  const beforeCount = out.length;
  stdin.push(JSON.stringify(o) + '\n');
  for (let i = 0; i < 100; i++) {
    if (out.length > beforeCount) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  if (out.length <= beforeCount) throw new Error('No MCP response within 1s');
  return JSON.parse(out[out.length - 1]!.trim());
}

describe('Helmet macro tools (tools/list + tool routing)', () => {
  let h: Helmet;
  let stdin: Readable;
  let out: string[];

  beforeEach(() => {
    ({ h, stdin, out } = spawn());
  });

  afterEach(() => {
    teardown();
  });

  it('tools/list includes macro_list, macro_run, macro_register, macro_delete', async () => {
    const resp = await send(stdin, out, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = resp.result.tools.map((t: any) => t.name);
    expect(names).toContain('macro_list');
    expect(names).toContain('macro_run');
    expect(names).toContain('macro_register');
    expect(names).toContain('macro_delete');
  });

  it('macro_list returns array (possibly empty since start() not called)', async () => {
    const resp = await send(stdin, out, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'macro_list', arguments: {} } });
    const r = JSON.parse(resp.result.content[0].text);
    expect(Array.isArray(r.macros)).toBe(true);
  });

  it('macro_run on unknown returns lookup error', async () => {
    const resp = await send(stdin, out, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'macro_run', arguments: { name: 'ghost' } } });
    const r = JSON.parse(resp.result.content[0].text);
    expect(r.success).toBe(false);
    expect(r.stage).toBe('lookup');
  });

  it('macro_register with invalid name returns validation error', async () => {
    const resp = await send(stdin, out, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'macro_register', arguments: { name: 'Bad!', source: 'x' } } });
    const r = JSON.parse(resp.result.content[0].text);
    expect(r.success).toBe(false);
    expect(r.stage).toBe('validation');
  });
});
