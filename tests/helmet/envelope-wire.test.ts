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
  return { servers: [] as any[], domSummary };
});

vi.mock('../../src/connection/extension-server.js', () => {
  class MockExtensionServer {
    public port: number;
    public isExtensionConnected = vi.fn(() => true);
    public start = vi.fn(async () => {});
    public stop = vi.fn(async () => {});
    public listTabs = vi.fn(async () => [
      { tabId: 1, url: 'https://example.com', title: 'Example', active: true, index: 0, windowId: 1 },
    ]);
    public attachTab = vi.fn(async (_tabId: number) => {});
    public detachTab = vi.fn(async (_tabId: number) => {});
    public detachAll = vi.fn(async () => {});
    public openTab = vi.fn(async (url: string) => ({ tabId: 42, url }));
    public switchToTab = vi.fn(async (_tabId: number) => {});
    public enableDomains = vi.fn(async (_domains: string[]) => {});
    public disableDomains = vi.fn(async (_domains: string[]) => {});
    public onStatusChange = vi.fn(() => () => {});
    public getBufferedEvents = vi.fn(() => []);
    public getCurrentTabId = vi.fn(() => 1);
    public getEnabledDomains = vi.fn(() => []);
    public getPort = vi.fn(() => 9876);
    public send = vi.fn(async (method: string, params?: any) => {
      if (method === 'Runtime.evaluate') {
        const expr: string = params?.expression ?? '';
        // P14: browserFetch page-context fetch script
        if (expr.includes('AbortController')) {
          return {
            result: {
              value: JSON.stringify({
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: { 'content-type': 'application/json' },
                body: '{"hello":"world"}',
                timingMs: 5,
              }),
            },
          };
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

describe('P10 — doctrine envelope wire (shim 10a)', () => {
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

  async function callTool(id: number, name: string, args: object, timeoutMs = 3000): Promise<any> {
    const beforeCount = stdoutLines.length;
    stdin.push(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    for (let i = 0; i < timeoutMs / 10; i++) {
      if (stdoutLines.length > beforeCount) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    if (stdoutLines.length <= beforeCount) throw new Error(`No MCP response for ${name}`);
    const resp = JSON.parse(stdoutLines[beforeCount]!);
    return JSON.parse(resp.result.content[0].text);
  }

  function expectEnvelopeShape(env: any): void {
    expect(env.schema_version).toBe('1.0');
    expect(env.operation).toMatchObject({ attempt: 1, max_attempts: 1 });
    expect(typeof env.operation.operation_id).toBe('string');
    expect(typeof env.operation.trace_id).toBe('string');
    expect(env.state).toHaveProperty('session_id');
    expect(env.state).toHaveProperty('state_integrity');
    expect(env.evidence.redacted).toBe(true);
    expect(env.evidence.redaction_policy).toContain('secrets');
    expect(env.context).toHaveProperty('consumed_tokens_estimate');
    expect(env.context).toHaveProperty('available_window_tokens');
  }

  it('success path: observe returns native ok:true envelope with text result', async () => {
    const env = await callTool(1, 'observe', { question: 'what is on this page?' });
    expect(env.ok).toBe(true);
    expect(env.error).toBeUndefined();
    expect(typeof env.result.text).toBe('string');
    expect(env.result.text.length).toBeGreaterThan(0);
    expect(env.operation.tool).toBe('observe');
    // Native (10b): real state meta
    expect(env.state.state_integrity).toBe('known');
    expect(env.state.url_after).toBe('https://example.com');
    expectEnvelopeShape(env);
  });

  it('success path: JSON-returning tools keep their parsed payload as result', async () => {
    const env = await callTool(2, 'inspect', { domain: 'network' });
    expect(env.ok).toBe(true);
    expect(env.result).toHaveProperty('total');
    expectEnvelopeShape(env);
  });

  it('error path: act with unsupported action returns ok:false with classified YJ code', async () => {
    const env = await callTool(3, 'act', { action: { type: 'not_a_real_action' } });
    expect(env.ok).toBe(false);
    expect(env.error.code).toMatch(/^YJ\./);
    expect(env.error.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
    expect(typeof env.error.agent_summary).toBe('string');
    expect(env.error.recovery).toHaveProperty('recommended');
    // Native (10b): real state meta with before/after urls
    expect(env.state.state_integrity).toBe('known');
    expect(env.state.url_before).toBe('https://example.com');
    expect(env.state.url_after).toBe('https://example.com');
    expectEnvelopeShape(env);
  });

  it('success path: act returns value, changes and real state meta', async () => {
    const env = await callTool(30, 'act', { action: { type: 'evaluate', expression: '1+1' } });
    expect(env.ok).toBe(true);
    expect(env.result.success).toBe(true);
    expect(env.result).toHaveProperty('changes');
    expect(env.state.state_integrity).toBe('known');
    expect(env.state.url_before).toBe('https://example.com');
    expect(env.state.url_after).toBe('https://example.com');
    expect(env.operation.action_type).toBe('evaluate');
  });

  it('diff without previous state is ok:true with null diff (not an error)', async () => {
    const env = await callTool(31, 'diff', {});
    expect(env.ok).toBe(true);
    expect(env.result.diff).toBeNull();
    expect(env.result.message).toContain('No previous state');
  });

  it('listTabs and reattach return native envelopes', async () => {
    const tabs = await callTool(32, 'listTabs', {});
    expect(tabs.ok).toBe(true);
    expect(Array.isArray(tabs.result.tabs)).toBe(true);
    expect(tabs.result.currentTabId).toBe(1);

    const re = await callTool(33, 'reattach', {});
    expect(re.ok).toBe(true);
    expect(re.result.success).toBe(true);
    expect(re.state.state_integrity).toBe('restored');
  });

  it('error path: unknown tool returns ok:false envelope, not a raw string', async () => {
    const env = await callTool(4, 'definitely_not_a_tool', {});
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
    expect(env.error.message).toContain('Unknown tool');
    expectEnvelopeShape(env);
  });

  it('redaction: every envelope marks evidence as redacted with secrets policy', async () => {
    const ok = await callTool(5, 'diff', {});
    expect(ok.evidence.redacted).toBe(true);
    expect(ok.evidence.redaction_policy).toContain('secrets');
    const fail = await callTool(6, 'definitely_not_a_tool', {});
    expect(fail.evidence.redacted).toBe(true);
    expect(fail.evidence.redaction_policy).toContain('secrets');
  });

  it('recovery_stats is registered and returns telemetry after a failure', async () => {
    await callTool(7, 'act', { action: { type: 'not_a_real_action' } });
    const env = await callTool(8, 'recovery_stats', {});
    expect(env.ok).toBe(true);
    expect(env.result.stats.total).toBeGreaterThanOrEqual(1);
    expect(env.result.stats.failed).toBeGreaterThanOrEqual(1);
    expect(env.result).toHaveProperty('recent_outcomes');
  });

  it('recovery_stats filters by error code', async () => {
    await callTool(9, 'act', { action: { type: 'not_a_real_action' } });
    const env = await callTool(10, 'recovery_stats', { code: 'YJ.PROTOCOL.INVALID_ARGUMENT' });
    expect(env.ok).toBe(true);
    expect(env.result.stats.total).toBeGreaterThanOrEqual(1);
    const empty = await callTool(11, 'recovery_stats', { code: 'YJ.ACT.DOM_TARGET_STALE' });
    expect(empty.result.stats.total).toBe(0);
  });

  it('P11: smartType without query fails fast with INVALID_ARGUMENT', async () => {
    const env = await callTool(12, 'smartType', { text: 'hello' });
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
    expect(env.error.recovery.recommended).toBeTruthy();
  });

  it('P11: ensureEmpty without query or selector fails fast with INVALID_ARGUMENT', async () => {
    const env = await callTool(13, 'ensureEmpty', {});
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
  });

  it('P12: waitFor without predicates fails fast with INVALID_ARGUMENT', async () => {
    const env = await callTool(14, 'waitFor', {});
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
  });

  it('P12: waitFor fn predicate matches and reports which', async () => {
    const env = await callTool(15, 'waitFor', {
      anyOf: [{ type: 'fn', expression: '1 === 1' }],
      timeoutMs: 1000,
      pollMs: 50,
    });
    expect(env.ok).toBe(true);
    expect(env.result.matched).toBe('anyOf');
    expect(env.result.which).toBe(0);
    expect(typeof env.result.elapsedMs).toBe('number');
  });

  it('P12: waitFor timeout returns YJ.ACT.WAIT_TIMEOUT with recovery', async () => {
    const env = await callTool(16, 'waitFor', {
      anyOf: [{ type: 'urlMatch', pattern: 'zzz-no-such-host' }],
      timeoutMs: 300,
      pollMs: 50,
    });
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('YJ.ACT.WAIT_TIMEOUT');
    expect(env.error.recovery.recommended).toBe('REOBSERVE_THEN_RETRY');
  });

  it('P12: extractAnswer extracts text with chunk metadata', async () => {
    const env = await callTool(17, 'extractAnswer', { waitUntil: 'now' });
    expect(env.ok).toBe(true);
    expect(typeof env.result.text).toBe('string');
    expect(env.result.length).toBeGreaterThan(0);
    expect(env.result.truncated).toBe(false);
  });

  it('P13: profileList ships perplexity, gemini and default profiles', async () => {
    const env = await callTool(18, 'profileList', {});
    expect(env.ok).toBe(true);
    const ids = env.result.profiles.map((p: any) => p.id);
    expect(ids).toContain('perplexity');
    expect(ids).toContain('gemini');
    expect(ids).toContain('default');
  });

  it('P13: profileStatus on a default domain returns the default profile and budget view', async () => {
    const env = await callTool(19, 'profileStatus', {});
    expect(env.ok).toBe(true);
    expect(env.result.profile.id).toBe('default');
    expect(env.result.budget.domainProfile).toBe('default');
    expect(env.result.profile.rules.intercept).toBe('allow');
  });

  it('P13: preflight on a default domain passes', async () => {
    const env = await callTool(20, 'preflight', {});
    expect(env.ok).toBe(true);
    expect(env.result.pass).toBe(true);
    expect(env.result.profile).toBe('default');
  });

  it('P13: profileLoad with unknown id fails with INVALID_ARGUMENT', async () => {
    const env = await callTool(21, 'profileLoad', { id: 'does-not-exist' });
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
  });

  it('P13: interceptEnable works on a default domain (no profile forbid)', async () => {
    const env = await callTool(22, 'interceptEnable', {});
    expect(env.ok).toBe(true);
  });

  it('P13.5: openTab returns verified identity (tabId, attached, previousActiveTabId)', async () => {
    const env = await callTool(23, 'openTab', { url: 'https://example.com/new' }, 5000);
    expect(env.ok).toBe(true);
    expect(env.result.tabId).toBe(42);
    expect(env.result.attached).toBe(true);
    expect(env.result.previousActiveTabId).toBe(1);
    expect(typeof env.result.url).toBe('string');
  });

  it('P13.5: switchTab to an existing tab succeeds with verified url', async () => {
    const env = await callTool(24, 'switchTab', { tabId: 1 });
    expect(env.ok).toBe(true);
    expect(env.result.success).toBe(true);
    expect(env.result.tabId).toBe(1);
    expect(env.result.previousTabId).toBe(1);
  });

  it('P13.5: switchTab to a missing tab fails with INVALID_ARGUMENT', async () => {
    const env = await callTool(25, 'switchTab', { tabId: 999 });
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
    expect(env.error.message).toContain('Tab not found');
  });

  it('P14: gateStatus starts at default P0 with no grants', async () => {
    const env = await callTool(26, 'gateStatus', {});
    expect(env.ok).toBe(true);
    expect(env.result.defaultGate).toBe('P0');
    expect(env.result.activeGrants).toBe(0);
  });

  it('P14: browserFetch without grant is denied (hard rule P0)', async () => {
    const env = await callTool(27, 'browserFetch', { url: 'https://api.example.com/v1', method: 'POST' });
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('YJ.POLICY.GATE_DENIED');
  });

  it('P14: gateGrant requires the user phrase', async () => {
    const env = await callTool(28, 'gateGrant', { level: 'P1', hosts: ['api.example.com'] });
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
  });

  it('P14: grant P1 → GET ok with gateUsed; POST still denied; revoke clears', async () => {
    const grant = await callTool(29, 'gateGrant', {
      level: 'P1',
      hosts: ['api.example.com'],
      phrase: 'sí, haz el recon de la api de ejemplo',
    });
    expect(grant.ok).toBe(true);
    expect(grant.result.granted).toBe(true);

    // GET without cookies → allowed by P1, executes in page (mocked fetch)
    const get = await callTool(30, 'browserFetch', {
      url: 'https://api.example.com/v1',
      credentials: 'omit',
    });
    expect(get.ok).toBe(true);
    expect(get.result.status).toBe(200);
    expect(get.result.body).toBe('{"hello":"world"}');
    expect(get.result.gateUsed).toBe('P1');

    // POST needs P3 → still denied
    const post = await callTool(31, 'browserFetch', { url: 'https://api.example.com/v1', method: 'POST', credentials: 'omit' });
    expect(post.ok).toBe(false);
    expect(post.error.code).toBe('YJ.POLICY.GATE_DENIED');

    const revoke = await callTool(32, 'gateRevoke', { all: true });
    expect(revoke.ok).toBe(true);
    expect(revoke.result.revoked).toBeGreaterThanOrEqual(1);

    const status = await callTool(33, 'gateStatus', {});
    expect(status.result.activeGrants).toBe(0);
  });

  it('P15: apiSurface returns merged endpoint list (empty without captures)', async () => {
    const env = await callTool(34, 'apiSurface', {});
    expect(env.ok).toBe(true);
    expect(Array.isArray(env.result.endpoints)).toBe(true);
    expect(env.result.generatedAt).toBeTruthy();
  });

  it('P15: exportHar writes a HAR file and reports entries/bytes', async () => {
    const env = await callTool(35, 'exportHar', {});
    expect(env.ok).toBe(true);
    expect(env.result.path).toContain('.har');
    expect(typeof env.result.entries).toBe('number');
    expect(env.result.bytes).toBeGreaterThan(0);
  });

  it('P15: evidence put/get/list roundtrip, redacted by default', async () => {
    const put = await callTool(36, 'evidencePut', {
      host: 'api.example.com',
      url: 'https://api.example.com/me',
      method: 'GET',
      body: '{"token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c","user":1}',
    });
    expect(put.ok).toBe(true);
    const id = put.result.record.id;
    expect(id).toMatch(/^ev_/);
    expect(put.result.record.redacted).toBe(true);

    const get = await callTool(37, 'evidenceGet', { id });
    expect(get.ok).toBe(true);
    expect(get.result.body).toContain('REDACTED');
    expect(get.result.body).not.toContain('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c');

    const list = await callTool(38, 'evidenceList', { host: 'api.example.com' });
    expect(list.ok).toBe(true);
    expect(list.result.records.length).toBeGreaterThanOrEqual(1);
  });

  it('P15: evidenceGet includeRaw without analystMode is denied', async () => {
    const env = await callTool(39, 'evidenceGet', { id: 'ev_whatever', includeRaw: true });
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('YJ.POLICY.GATE_DENIED');
  });

  it('P15: responseDiff detects extra field (BOLA-style)', async () => {
    const env = await callTool(40, 'responseDiff', {
      a: { body: '{"id":1,"name":"alice"}' },
      b: { body: '{"id":1,"name":"alice","role":"admin"}' },
    });
    expect(env.ok).toBe(true);
    expect(env.result.format).toBe('json');
    expect(env.result.added).toEqual([{ path: 'role', b: 'admin' }]);
  });

  it('P15: responseDiff with invalid inputs fails fast', async () => {
    const env = await callTool(41, 'responseDiff', { a: null, b: { body: '{}' } });
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
  });

  it('P16: capabilities returns the session matrix', async () => {
    const env = await callTool(42, 'capabilities', {});
    expect(env.ok).toBe(true);
    expect(env.result.backends.yautja).toBe(true);
    expect(typeof env.result.trustedClick).toBe('boolean');
    expect(typeof env.result.trustedFileChooser).toBe('boolean');
    expect(typeof env.result.intercept).toBe('boolean');
  });

  it('P16: trustedClick without selector/query fails fast', async () => {
    const env = await callTool(43, 'trustedClick', {});
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
  });

  it('P16: trustedFileChooser with missing files on disk fails fast', async () => {
    const env = await callTool(44, 'trustedFileChooser', {
      triggerSelector: '#upload',
      files: ['D:/definitely/not/here.pdf'],
    });
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
    expect(env.error.message).toContain('Files not found');
  });

  it('P17: snapshot save/list roundtrip', async () => {
    const save = await callTool(45, 'snapshotSave', { name: 'test-snap' });
    expect(save.ok).toBe(true);
    expect(save.result.saved).toBe(true);

    const list = await callTool(46, 'snapshotList', {});
    expect(list.ok).toBe(true);
    const names = list.result.snapshots.map((s: any) => s.name);
    expect(names).toContain('test-snap');
  });

  it('P17: snapshotRestore unknown snapshot fails fast', async () => {
    const env = await callTool(47, 'snapshotRestore', { name: 'does-not-exist' });
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
    expect(env.error.message).toContain('Snapshot not found');
  });

  it('P17: resources/list + resources/read for stored evidence', async () => {
    const put = await callTool(48, 'evidencePut', { host: 'res.example.com', body: '{"r":1}' });
    const id = put.result.record.id;

    const beforeCount = stdoutLines.length;
    stdin.push(JSON.stringify({ jsonrpc: '2.0', id: 490, method: 'resources/list' }) + '\n');
    for (let i = 0; i < 300; i++) {
      if (stdoutLines.length > beforeCount) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const listResp = JSON.parse(stdoutLines[beforeCount]!);
    const uris = listResp.result.resources.map((r: any) => r.uri);
    expect(uris).toContain(`resource://yautja/evidence/${id}`);

    const before2 = stdoutLines.length;
    stdin.push(JSON.stringify({ jsonrpc: '2.0', id: 491, method: 'resources/read', params: { uri: `resource://yautja/evidence/${id}` } }) + '\n');
    for (let i = 0; i < 300; i++) {
      if (stdoutLines.length > before2) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const readResp = JSON.parse(stdoutLines[before2]!);
    expect(readResp.result.contents[0].text).toBe('{"r":1}');
  });

  it('P17: resources/read on unknown uri returns JSON-RPC error', async () => {
    const beforeCount = stdoutLines.length;
    stdin.push(JSON.stringify({ jsonrpc: '2.0', id: 492, method: 'resources/read', params: { uri: 'resource://yautja/evidence/ev_nope' } }) + '\n');
    for (let i = 0; i < 300; i++) {
      if (stdoutLines.length > beforeCount) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const resp = JSON.parse(stdoutLines[beforeCount]!);
    expect(resp.error).toBeDefined();
    expect(resp.error.code).toBe(-32602);
  });

  it('P18: delegate routes yautja-native capability; unconfigured backend → CAPABILITY_MISSING', async () => {
    const env = await callTool(50, 'delegate', { capability: 'observe' });
    expect(env.ok).toBe(true);
    expect(env.result.backend).toBe('yautja');
    expect(env.result.delegated).toBe(false);

    const missing = await callTool(51, 'delegate', { capability: 'heap_profile' });
    expect(missing.ok).toBe(false);
    expect(missing.error.code).toBe('YJ.PROTOCOL.CAPABILITY_MISSING');
  });

  it('P18: YAUTJA_LEGACY_SHIM=0 makes non-migrated tools fail typed', async () => {
    process.env.YAUTJA_LEGACY_SHIM = '0';
    try {
      // techScan is still shim-routed (10a) → typed failure with the flag on
      const env = await callTool(52, 'techScan', {});
      expect(env.ok).toBe(false);
      expect(env.error.code).toBe('YJ.PROTOCOL.CAPABILITY_MISSING');
      // native tools keep working with the flag on
      const native = await callTool(53, 'observe', { question: 'q' });
      expect(native.ok).toBe(true);
    } finally {
      delete process.env.YAUTJA_LEGACY_SHIM;
    }
  });

  it('hardening: stdin close (host death) triggers clean stop and exit — no zombie', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
    const stopSpy = vi.spyOn(helmet as any, 'stop');
    stdin.push(null); // EOF — the MCP host died
    await new Promise((r) => setTimeout(r, 150));
    expect(stopSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });
});
