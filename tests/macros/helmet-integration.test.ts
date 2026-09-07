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
    send = vi.fn(async (method: string) => method === 'Runtime.evaluate' ? { result: { value: JSON.stringify({
      url: 'https://example.com', readyState: 'complete',
      semantic: { title: 'Example', pageType: 'article', headings: [], mainContentPreview: '', language: 'en' },
      interactive: { buttons: [], links: [], inputs: [], total: 0 },
      structural: { totalElements: 1, depth: 1, iframes: 0, images: 0, scripts: 0, forms: 0, stylesheets: 0 },
    }) } } : {});
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

// P10: tools/call payloads are doctrine envelopes — unwrap the legacy result.
function unwrapToolResult(resp: any): any {
  const env = JSON.parse(resp.result.content[0].text);
  return env.result !== undefined ? env.result : env;
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
    const r = unwrapToolResult(resp);
    expect(Array.isArray(r.macros)).toBe(true);
  });

  it('macro_run on unknown returns lookup error', async () => {
    const resp = await send(stdin, out, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'macro_run', arguments: { name: 'ghost' } } });
    const r = unwrapToolResult(resp);
    expect(r.success).toBe(false);
    expect(r.stage).toBe('lookup');
  });

  it('macro_register with invalid name returns validation error', async () => {
    const resp = await send(stdin, out, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'macro_register', arguments: { name: 'Bad!', source: 'x' } } });
    const r = unwrapToolResult(resp);
    expect(r.success).toBe(false);
    expect(r.stage).toBe('validation');
  });
});

describe('buildCtx integration — real ctx methods called by macro', () => {
  // Note: This test uses the same spawn() helper and Helmet instance as above.
  // The mock extension-server's send() returns {}, which is fine — the macro just needs
  // to be invoked without TypeError. We register the macro inline via a macro_register call.

  it('invokes a macro that calls ctx.observe without TypeError', async () => {
    const { stdin, out } = spawn();
    try {
      const src = `export default { name: 'smoke', description: 'smoke', async run(_a, ctx) { const o = await ctx.observe('overview'); return { ok: true, o }; } };`;
      const regResp = await send(stdin, out, { jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'macro_register', arguments: { name: 'smoke', source: src } } });
      const regResult = unwrapToolResult(regResp);
      expect(regResult.success).toBe(true);

      const runResp = await send(stdin, out, { jsonrpc: '2.0', id: 101, method: 'tools/call', params: { name: 'macro_run', arguments: { name: 'smoke' } } });
      const runResult = unwrapToolResult(runResp);
      expect(runResult.success).toBe(true);
      expect(runResult.result.ok).toBe(true);
    } finally {
      teardown();
    }
  });
});
