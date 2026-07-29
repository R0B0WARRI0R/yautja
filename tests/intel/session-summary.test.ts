import { describe, it, expect } from 'vitest';
import { buildSessionSummary, DEFAULT_SUMMARY_MAX_CHARS } from '../../src/intel/session-summary.js';
import type { SessionSummaryInput } from '../../src/intel/session-summary.js';
import type { GateGrant } from '../../src/doctrine/gates.js';
import type { ScheduledJob } from '../../src/intel/session-scheduler.js';

const GRANT: GateGrant = {
  level: 'P2',
  scope: { hosts: ['api.example.com'], pathPrefix: '/v1', methods: ['GET'] },
  grantedAt: '2026-01-15T10:00:00.000Z',
  grantedBy: 'user_phrase',
  phrase: 'sí, autoriza las GET a api.example.com',
  usedRequests: 3,
  maxRequests: 50,
};

const JOB: ScheduledJob = {
  id: 'job_abc123',
  name: 'poll',
  schedule: { kind: 'interval', everyMs: 60_000 },
  payload: { type: 'tool', tool: 'observe', args: { question: 'q' } },
  createdAt: 1_768_000_000_000,
  nextRunAt: 1_768_000_060_000,
  runCount: 2,
  enabled: true,
};

function fullInput(): SessionSummaryInput {
  return {
    sessionId: 'sess_test',
    gates: { defaultGate: 'P0', activeGrants: 1, grants: [GRANT] },
    pendingPlan: {
      items: ['a', 'b', 'c'],
      domains: ['api.example.com'],
      requestedLevel: 'P2',
      proposedAt: '2026-01-15T10:00:00.000Z',
    },
    sessionGroupId: 7,
    tabs: [{ tabId: 1, url: 'https://example.com', title: 'Example', active: true }],
    recorder: {
      active: true,
      events: 2,
      startedAt: '2026-01-15T10:00:00.000Z',
      elapsedMs: 5_000,
      lastEvents: [
        { ts: 1, event: 'navigate', tool: 'act', ok: true, url: 'https://example.com', data: { url: 'https://example.com' } },
        { ts: 2, event: 'click', tool: 'act', ok: false, selector: '#btn', data: { selector: '#btn' } },
      ],
    },
    macros: [{ name: 'm1', description: 'a very long description that we do not ship', source: 'user', hasArgs: false }],
    jobs: [JOB],
    activity: { toolCalls: { observe: 4, act: 2 }, errorsByCode: { 'YJ.ACT.DOM_TARGET_NOT_FOUND': 1 } },
  };
}

describe('buildSessionSummary — composition', () => {
  it('includes all sections when everything is present', () => {
    const s = buildSessionSummary(fullInput());
    expect(s.truncated).toBe(false);
    expect(s.omittedSections).toBeUndefined();
    expect(s.sessionId).toBe('sess_test');
    for (const key of ['gates', 'plan', 'tabs', 'recorder', 'scheduler', 'macros', 'activity', 'lastActions']) {
      expect(s.sections, key).toHaveProperty(key);
    }
  });

  it('compacts grants to level + scope (no phrase leakage into the blob)', () => {
    const s = buildSessionSummary(fullInput());
    const grants = (s.sections.gates as any).grants;
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      level: 'P2',
      hosts: ['api.example.com'],
      pathPrefix: '/v1',
      methods: ['GET'],
      usedRequests: 3,
      maxRequests: 50,
    });
    expect(grants[0].phrase).toBeUndefined();
  });

  it('includes the extension link state when provided', () => {
    const s = buildSessionSummary({
      ...fullInput(),
      link: { connected: true, consecutiveTimeouts: 2, linkDegraded: false, lastHealthMs: 1_768_000_000_000 },
    });
    expect(s.sections.link).toEqual({
      connected: true,
      consecutiveTimeouts: 2,
      linkDegraded: false,
      lastHealthMs: 1_768_000_000_000,
    });
  });

  it('omits the link section when not provided', () => {
    const s = buildSessionSummary(fullInput());
    expect(s.sections.link).toBeUndefined();
  });

  it('compacts scheduler jobs and drops macro descriptions', () => {
    const s = buildSessionSummary(fullInput());
    const jobs = (s.sections.scheduler as any).jobs;
    expect(jobs[0]).toMatchObject({ id: 'job_abc123', kind: 'interval', payload: 'tool:observe', enabled: true, runCount: 2 });
    expect(typeof jobs[0].nextRunAt).toBe('string');
    const macros = s.sections.macros as any[];
    expect(macros[0]).toEqual({ name: 'm1', source: 'user', hasArgs: false });
  });

  it('compacts last actions (drops event data payloads)', () => {
    const s = buildSessionSummary(fullInput());
    const actions = s.sections.lastActions as any[];
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ event: 'navigate', tool: 'act', ok: true, url: 'https://example.com' });
    expect(actions[0].data).toBeUndefined();
  });

  it('omits lastActions when the recorder is not active', () => {
    const input = fullInput();
    input.recorder = { ...input.recorder!, active: false };
    const s = buildSessionSummary(input);
    expect(s.sections.lastActions).toBeUndefined();
    expect(s.sections.recorder).toMatchObject({ active: false, events: 2 });
  });

  it('omits the tabs section when there is no session group', () => {
    const input = fullInput();
    input.sessionGroupId = null;
    input.tabs = null;
    const s = buildSessionSummary(input);
    expect(s.sections.tabs).toBeUndefined();
  });

  it('marks tabs unavailable when enumeration failed but a group exists', () => {
    const input = fullInput();
    input.tabs = null;
    const s = buildSessionSummary(input);
    expect((s.sections.tabs as any).tabs).toMatch(/unavailable/);
  });

  it('works with a minimal input (gates only)', () => {
    const s = buildSessionSummary({ sessionId: 'sess_x', gates: { defaultGate: 'P0', activeGrants: 0, grants: [] } });
    expect(s.truncated).toBe(false);
    expect(s.sections.gates).toMatchObject({ defaultGate: 'P0', activeGrants: 0, grants: [] });
  });
});

describe('buildSessionSummary — trimming', () => {
  it('trims lowest-priority sections first and sets truncated + omittedSections', () => {
    const s = buildSessionSummary(fullInput(), 200);
    expect(s.truncated).toBe(true);
    expect(s.omittedSections!.length).toBeGreaterThan(0);
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(200);
    // La primera en caer es lastActions, la última gates
    expect(s.omittedSections![0]).toBe('lastActions');
    for (const key of s.omittedSections!) {
      expect(s.sections).not.toHaveProperty(key);
    }
  });

  it('keeps gates when the budget allows only one section', () => {
    const input = fullInput();
    // Presupuesto: solo cabe gates + overhead de truncated/omittedSections
    const onlyGates = buildSessionSummary({ sessionId: 'sess_test', gates: input.gates });
    const omittedOthers = ['lastActions', 'activity', 'macros', 'scheduler', 'recorder', 'tabs', 'plan'];
    const budget = JSON.stringify({ ...onlyGates, truncated: true, omittedSections: omittedOthers }).length + 2;
    const s = buildSessionSummary(input, budget);
    expect(s.truncated).toBe(true);
    expect(s.sections.gates).toBeDefined();
    expect(s.omittedSections).toEqual(omittedOthers);
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(budget);
  });

  it('respects the default maxChars when maxChars is invalid', () => {
    const s = buildSessionSummary(fullInput(), -5);
    expect(s.truncated).toBe(false);
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(DEFAULT_SUMMARY_MAX_CHARS);
  });

  it('caps long grant/job lists with a trimmed counter', () => {
    const input = fullInput();
    input.gates = { defaultGate: 'P0', activeGrants: 15, grants: Array.from({ length: 15 }, () => GRANT) };
    input.jobs = Array.from({ length: 25 }, (_, i) => ({ ...JOB, id: `job_${i}` }));
    const s = buildSessionSummary(input, 100_000);
    expect((s.sections.gates as any).grants).toHaveLength(10);
    expect((s.sections.gates as any).grantsTrimmed).toBe(5);
    expect((s.sections.scheduler as any).jobs).toHaveLength(20);
    expect((s.sections.scheduler as any).jobsTrimmed).toBe(5);
  });
});
