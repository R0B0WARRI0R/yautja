import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable, Writable } from 'stream';
import { clearKillSwitchCache, SESSION_SCHEDULER_KILL_SWITCH_KEY } from '../../src/arsenal/kill-switch.js';

const mockState = vi.hoisted(() => ({
  storageValues: {} as Record<string, any>,
}));

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
    public send = vi.fn(async (_method: string, _params?: any) => ({}));
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
    }
  }
  return { ExtensionServer: MockExtensionServer };
});

import { Helmet } from '../../src/helmet.js';

const INTERVAL_JOB = {
  schedule: { kind: 'interval', everyMs: 60_000 },
  payload: { type: 'tool', tool: 'macro_list' },
};

describe('Helmet — session_schedule / session_summary (T14)', () => {
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

  let nextId = 1;
  async function callTool(name: string, args: object, timeoutMs = 5000): Promise<any> {
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

  it('tools/list includes session_schedule and session_summary', async () => {
    const id = nextId++;
    stdin.push(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }) + '\n');
    for (let i = 0; i < 500; i++) {
      if (stdoutLines.length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const resp = JSON.parse(stdoutLines[0]!);
    const names = resp.result.tools.map((t: any) => t.name);
    expect(names).toContain('session_schedule');
    expect(names).toContain('session_summary');
  });

  it('add → list → run-now → remove lifecycle', async () => {
    const add = await callTool('session_schedule', { action: 'add', name: 'poll', ...INTERVAL_JOB });
    expect(add.ok).toBe(true);
    expect(add.result.job.id).toMatch(/^job_/);
    expect(add.result.job.enabled).toBe(true);
    expect(add.result.job.nextRunAt).toBeGreaterThan(Date.now());
    const jobId = add.result.job.id;

    const list = await callTool('session_schedule', { action: 'list' });
    expect(list.result.jobs).toHaveLength(1);
    expect(list.result.jobs[0].name).toBe('poll');

    const run = await callTool('session_schedule', { action: 'run-now', id: jobId });
    expect(run.ok).toBe(true);
    expect(run.result.result.ok).toBe(true); // envelope de macro_list parseado
    const afterRun = await callTool('session_schedule', { action: 'list' });
    expect(afterRun.result.jobs[0].runCount).toBe(1);

    const remove = await callTool('session_schedule', { action: 'remove', id: jobId });
    expect(remove.ok).toBe(true);
    const empty = await callTool('session_schedule', { action: 'list' });
    expect(empty.result.jobs).toHaveLength(0);

    const removeAgain = await callTool('session_schedule', { action: 'remove', id: jobId });
    expect(removeAgain.ok).toBe(false);
    expect(removeAgain.error.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
  });

  it('enable/disable toggles the job', async () => {
    const add = await callTool('session_schedule', { action: 'add', ...INTERVAL_JOB });
    const jobId = add.result.job.id;
    const disable = await callTool('session_schedule', { action: 'disable', id: jobId });
    expect(disable.result.job.enabled).toBe(false);
    const enable = await callTool('session_schedule', { action: 'enable', id: jobId });
    expect(enable.result.job.enabled).toBe(true);
  });

  it('rejects scheduling gate/plan tools with a clear error', async () => {
    for (const tool of ['gateGrant', 'gateRevoke', 'plan_approve']) {
      const env = await callTool('session_schedule', {
        action: 'add',
        schedule: { kind: 'interval', everyMs: 60_000 },
        payload: { type: 'tool', tool, args: {} },
      });
      expect(env.ok, tool).toBe(false);
      expect(env.error.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
      expect(env.error.message).toContain('cannot be scheduled');
    }
  });

  it('rejects sub-minute intervals and malformed schedules', async () => {
    const fast = await callTool('session_schedule', {
      action: 'add',
      schedule: { kind: 'interval', everyMs: 1_000 },
      payload: { type: 'tool', tool: 'observe' },
    });
    expect(fast.ok).toBe(false);
    expect(fast.error.message).toContain('>= 60000ms');

    const cron = await callTool('session_schedule', {
      action: 'add',
      schedule: { kind: 'cron', expr: 'not cron' },
      payload: { type: 'tool', tool: 'observe' },
    });
    expect(cron.ok).toBe(false);
    expect(cron.error.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');

    const action = await callTool('session_schedule', { action: 'explode' });
    expect(action.ok).toBe(false);
    expect(action.error.message).toContain('unknown session_schedule action');
  });

  it('returns YJ.POLICY.FEATURE_DISABLED when the kill switch is off', async () => {
    mockState.storageValues[SESSION_SCHEDULER_KILL_SWITCH_KEY] = false;
    clearKillSwitchCache();
    const env = await callTool('session_schedule', { action: 'add', ...INTERVAL_JOB });
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('YJ.POLICY.FEATURE_DISABLED');
    expect(env.error.message).toContain(SESSION_SCHEDULER_KILL_SWITCH_KEY);
  });

  it('session_summary composes gates, recorder, scheduler, macros and activity', async () => {
    await callTool('session_schedule', { action: 'add', name: 'poll', ...INTERVAL_JOB });
    const env = await callTool('session_summary', {});
    expect(env.ok).toBe(true);
    const s = env.result;
    expect(s.truncated).toBe(false);
    expect(s.sessionId).toMatch(/^sess_/);
    expect(s.sections.gates.defaultGate).toBe('P0');
    expect(s.sections.recorder.active).toBe(false);
    expect(s.sections.scheduler.jobs).toHaveLength(1);
    expect(s.sections.scheduler.jobs[0].payload).toBe('tool:macro_list');
    expect(Array.isArray(s.sections.macros)).toBe(true);
    // actividad: las propias llamadas a tools quedan contadas por nombre
    expect(s.sections.activity.toolCalls.session_schedule).toBeGreaterThanOrEqual(1);
  });

  it('session_summary truncates with tiny maxChars and reports omittedSections', async () => {
    await callTool('session_schedule', { action: 'add', name: 'poll', ...INTERVAL_JOB });
    const env = await callTool('session_summary', { maxChars: 250 });
    expect(env.ok).toBe(true);
    expect(env.result.truncated).toBe(true);
    expect(env.result.omittedSections.length).toBeGreaterThan(0);
    expect(JSON.stringify(env.result).length).toBeLessThanOrEqual(250);
  });
});
