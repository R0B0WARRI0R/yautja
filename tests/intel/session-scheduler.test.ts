import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  SessionScheduler,
  parseCron,
  parseCronField,
  nextCronAfter,
  MIN_INTERVAL_MS,
  SCHEDULER_EXCLUDED_TOOLS,
} from '../../src/intel/session-scheduler.js';

// Jueves 15 ene 2026, 10:00:00 UTC
const T0 = Date.UTC(2026, 0, 15, 10, 0, 0);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yj-sched-'));
}

function makeScheduler(dir: string, now: () => number, extra: Record<string, any> = {}) {
  const calls: Array<{ kind: string; target: string; args: unknown }> = [];
  const scheduler = new SessionScheduler({
    dir,
    now,
    executeTool: async (tool, args) => { calls.push({ kind: 'tool', target: tool, args }); return { ok: tool }; },
    executeMacro: async (name, args) => { calls.push({ kind: 'macro', target: name, args }); return { ok: name }; },
    ...extra,
  });
  return { scheduler, calls };
}

describe('parseCronField', () => {
  it('parses * as the full range', () => {
    const s = parseCronField('*', 0, 5)!;
    expect([...s].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('parses */n steps', () => {
    expect([...parseCronField('*/15', 0, 59)!].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  it('parses comma lists', () => {
    expect([...parseCronField('1,2,30', 0, 59)!].sort((a, b) => a - b)).toEqual([1, 2, 30]);
  });

  it('parses ranges and stepped ranges', () => {
    expect([...parseCronField('10-14', 0, 59)!].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14]);
    expect([...parseCronField('0-10/5', 0, 59)!].sort((a, b) => a - b)).toEqual([0, 5, 10]);
  });

  it('parses a/n as a..max stepping', () => {
    expect([...parseCronField('5/20', 0, 59)!].sort((a, b) => a - b)).toEqual([5, 25, 45]);
  });

  it('rejects invalid forms', () => {
    for (const bad of ['', 'abc', '5-1', '70', '*/0', '*/-1', '1-2-3', '1,,2', '1/', '1/2/3', '-5']) {
      expect(parseCronField(bad, 0, 59), bad).toBeNull();
    }
  });
});

describe('parseCron / nextCronAfter', () => {
  it('requires exactly 5 fields', () => {
    expect(parseCron('* * * *')).toBeNull();
    expect(parseCron('* * * * * *')).toBeNull();
    expect(parseCron('*/15 * * * *')).not.toBeNull();
  });

  it('maps dow 7 to Sunday (0)', () => {
    const spec = parseCron('0 0 * * 7')!;
    expect(spec.dow.has(0)).toBe(true);
    expect(spec.dow.has(7)).toBe(false);
  });

  it('computes the next */15 occurrence', () => {
    expect(nextCronAfter('*/15 * * * *', T0)).toBe(Date.UTC(2026, 0, 15, 10, 15));
    expect(nextCronAfter('*/15 * * * *', Date.UTC(2026, 0, 15, 10, 14, 30))).toBe(Date.UTC(2026, 0, 15, 10, 15));
  });

  it('computes a daily occurrence (next day when already past)', () => {
    expect(nextCronAfter('0 9 * * *', T0)).toBe(Date.UTC(2026, 0, 16, 9, 0));
    expect(nextCronAfter('0 11 * * *', T0)).toBe(Date.UTC(2026, 0, 15, 11, 0));
  });

  it('handles month boundaries and leap years', () => {
    // Feb 29 desde 2026 → 2028 (bisiesto), dentro de la ventana de 4 años
    expect(nextCronAfter('0 0 29 2 *', T0)).toBe(Date.UTC(2028, 1, 29, 0, 0));
    // Fuera de la ventana de 4 años → null (31 de febrero no existe)
    expect(nextCronAfter('0 0 31 2 *', T0)).toBeNull();
  });

  it('applies standard cron dom/dow OR semantics when both are restricted', () => {
    // dom=13 OR dow=viernes: desde el jueves 1 ene 2026 el próximo match es
    // el viernes 2 ene (no el 13)
    const from = Date.UTC(2026, 0, 1, 12, 0);
    expect(nextCronAfter('0 0 13 * 5', from)).toBe(Date.UTC(2026, 0, 2, 0, 0));
    // Solo dow restringido → AND (el 13 que además cae en cualquier dow: aquí dom=*)
    expect(nextCronAfter('0 0 13 * *', from)).toBe(Date.UTC(2026, 0, 13, 0, 0));
  });

  it('returns null for unparseable expressions', () => {
    expect(nextCronAfter('not a cron', T0)).toBeNull();
  });
});

describe('SessionScheduler engine (fake clock)', () => {
  let dir: string;
  let now: number;

  beforeEach(() => {
    dir = tmpDir();
    now = T0;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fires an interval job on tick and reschedules', async () => {
    const { scheduler, calls } = makeScheduler(dir, () => now);
    const job = scheduler.addJob({
      schedule: { kind: 'interval', everyMs: MIN_INTERVAL_MS },
      payload: { type: 'tool', tool: 'observe', args: { question: 'q' } },
    });
    expect(job.nextRunAt).toBe(T0 + MIN_INTERVAL_MS);

    now = T0 + MIN_INTERVAL_MS;
    await scheduler.tick();
    expect(calls).toEqual([{ kind: 'tool', target: 'observe', args: { question: 'q' } }]);
    const after = scheduler.get(job.id)!;
    expect(after.runCount).toBe(1);
    expect(after.lastRunAt).toBe(now);
    expect(after.nextRunAt).toBe(T0 + 2 * MIN_INTERVAL_MS);

    // Mismo tick → no re-dispara
    await scheduler.tick();
    expect(calls).toHaveLength(1);
  });

  it('auto-deletes once jobs after firing (even on failure)', async () => {
    const { scheduler } = makeScheduler(dir, () => now, {
      executeTool: async () => { throw new Error('boom'); },
    });
    const job = scheduler.addJob({
      schedule: { kind: 'once', at: T0 + 1_000 },
      payload: { type: 'tool', tool: 'observe' },
    });
    now = T0 + 1_000;
    await scheduler.tick();
    expect(scheduler.get(job.id)).toBeUndefined();
    expect(scheduler.list()).toHaveLength(0);
  });

  it('disabled jobs do not fire but persist', async () => {
    const { scheduler, calls } = makeScheduler(dir, () => now);
    const job = scheduler.addJob({
      schedule: { kind: 'interval', everyMs: MIN_INTERVAL_MS },
      payload: { type: 'tool', tool: 'observe' },
    });
    scheduler.setEnabled(job.id, false);
    now = T0 + 10 * MIN_INTERVAL_MS;
    await scheduler.tick();
    expect(calls).toHaveLength(0);
    expect(scheduler.get(job.id)!.enabled).toBe(false);

    // Re-habilitar reprograma desde ahora (sin ráfaga acumulada)
    const re = scheduler.setEnabled(job.id, true);
    expect(re.nextRunAt).toBe(now + MIN_INTERVAL_MS);
  });

  it('runs macro payloads through executeMacro', async () => {
    const { scheduler, calls } = makeScheduler(dir, () => now);
    scheduler.addJob({
      schedule: { kind: 'interval', everyMs: MIN_INTERVAL_MS },
      payload: { type: 'macro', name: 'my-macro', args: { a: 1 } },
    });
    now = T0 + MIN_INTERVAL_MS;
    await scheduler.tick();
    expect(calls).toEqual([{ kind: 'macro', target: 'my-macro', args: { a: 1 } }]);
  });

  it('run-now executes immediately, returns the result and keeps the job', async () => {
    const { scheduler, calls } = makeScheduler(dir, () => now);
    const job = scheduler.addJob({
      schedule: { kind: 'once', at: T0 + 60_000 },
      payload: { type: 'tool', tool: 'macro_list' },
    });
    const result = await scheduler.runNow(job.id);
    expect(result).toEqual({ ok: 'macro_list' });
    expect(calls).toHaveLength(1);
    const after = scheduler.get(job.id)!;
    expect(after.runCount).toBe(1);
    expect(after.nextRunAt).toBe(T0 + 60_000); // programación intacta
    await expect(scheduler.runNow('job_nope')).rejects.toThrow(/unknown job id/);
  });

  it('records lastError when the executor throws', async () => {
    const { scheduler } = makeScheduler(dir, () => now, {
      executeTool: async () => { throw new Error('executor failed'); },
    });
    const job = scheduler.addJob({
      schedule: { kind: 'interval', everyMs: MIN_INTERVAL_MS },
      payload: { type: 'tool', tool: 'observe' },
    });
    now = T0 + MIN_INTERVAL_MS;
    await scheduler.tick();
    expect(scheduler.get(job.id)!.lastError).toBe('executor failed');
  });
});

describe('SessionScheduler persistence', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('round-trips jobs through schedule.json', () => {
    const now = T0;
    const { scheduler } = makeScheduler(dir, () => now);
    const job = scheduler.addJob({
      name: 'daily',
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      payload: { type: 'tool', tool: 'observe' },
    });
    expect(fs.existsSync(path.join(dir, 'schedule.json'))).toBe(true);

    const { scheduler: reloaded } = makeScheduler(dir, () => now);
    const jobs = reloaded.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: job.id, name: 'daily', enabled: true, runCount: 0 });
  });

  it('marks once jobs expired during downtime as missed and does NOT run them', async () => {
    const t0 = T0;
    const { scheduler: s1 } = makeScheduler(dir, () => t0);
    const job = s1.addJob({
      schedule: { kind: 'once', at: t0 + 1_000 },
      payload: { type: 'tool', tool: 'observe' },
    });

    // "Reinicio" del helmet 5s después: el once venció apagado
    const t1 = t0 + 5_000;
    const { scheduler: s2, calls } = makeScheduler(dir, () => t1);
    const loaded = s2.get(job.id)!;
    expect(loaded.missed).toBe(true);
    expect(loaded.enabled).toBe(false);
    await s2.tick();
    expect(calls).toHaveLength(0);
  });

  it('reschedules interval/cron jobs from now on load (no catch-up burst)', async () => {
    const t0 = T0;
    const { scheduler: s1 } = makeScheduler(dir, () => t0);
    s1.addJob({ schedule: { kind: 'interval', everyMs: MIN_INTERVAL_MS }, payload: { type: 'tool', tool: 'observe' } });
    s1.addJob({ schedule: { kind: 'cron', expr: '*/15 * * * *' }, payload: { type: 'tool', tool: 'observe' } });

    const t1 = t0 + 10 * MIN_INTERVAL_MS + 30_000;
    const { scheduler: s2, calls } = makeScheduler(dir, () => t1);
    for (const j of s2.list()) expect(j.nextRunAt).toBeGreaterThan(t1);
    await s2.tick();
    expect(calls).toHaveLength(0);
  });

  it('survives a corrupt schedule.json', () => {
    fs.writeFileSync(path.join(dir, 'schedule.json'), '{not json');
    const { scheduler } = makeScheduler(dir, () => T0);
    expect(scheduler.list()).toEqual([]);
  });
});

describe('SessionScheduler validations and exclusions', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('rejects scheduling gate/plan tools (grants are never automated)', () => {
    const { scheduler } = makeScheduler(dir, () => T0);
    for (const tool of SCHEDULER_EXCLUDED_TOOLS) {
      expect(() => scheduler.addJob({
        schedule: { kind: 'interval', everyMs: MIN_INTERVAL_MS },
        payload: { type: 'tool', tool, args: {} },
      }), tool).toThrow(/cannot be scheduled/);
    }
    expect(SCHEDULER_EXCLUDED_TOOLS).toEqual(new Set(['gateGrant', 'gateRevoke', 'plan_approve']));
  });

  it('rejects intervals below the anti-spam minimum', () => {
    const { scheduler } = makeScheduler(dir, () => T0);
    expect(() => scheduler.addJob({
      schedule: { kind: 'interval', everyMs: 5_000 },
      payload: { type: 'tool', tool: 'observe' },
    })).toThrow(new RegExp(`>= ${MIN_INTERVAL_MS}ms`));
  });

  it('rejects malformed schedules and payloads', () => {
    const { scheduler } = makeScheduler(dir, () => T0);
    const tool = { type: 'tool', tool: 'observe' } as const;
    expect(() => scheduler.addJob({ schedule: { kind: 'cron', expr: 'bad' }, payload: tool })).toThrow(/cron/);
    expect(() => scheduler.addJob({ schedule: { kind: 'once', at: T0 - 1 }, payload: tool })).toThrow(/past/);
    expect(() => scheduler.addJob({ schedule: { kind: 'once', at: 'x' }, payload: tool })).toThrow(/timestamp/);
    expect(() => scheduler.addJob({ schedule: { kind: 'nope' }, payload: tool })).toThrow(/once\|interval\|cron/);
    expect(() => scheduler.addJob({ schedule: { kind: 'interval', everyMs: MIN_INTERVAL_MS }, payload: null })).toThrow(/payload/);
    expect(() => scheduler.addJob({ schedule: { kind: 'interval', everyMs: MIN_INTERVAL_MS }, payload: { type: 'tool' } })).toThrow(/tool name/);
    expect(() => scheduler.addJob({ schedule: { kind: 'interval', everyMs: MIN_INTERVAL_MS }, payload: { type: 'macro', name: '' } })).toThrow(/macro name/);
  });

  it('validates macro existence when macroExists is provided', () => {
    const { scheduler } = makeScheduler(dir, () => T0, { macroExists: (n: string) => n === 'real' });
    expect(() => scheduler.addJob({
      schedule: { kind: 'interval', everyMs: MIN_INTERVAL_MS },
      payload: { type: 'macro', name: 'ghost' },
    })).toThrow(/unknown macro/);
    expect(() => scheduler.addJob({
      schedule: { kind: 'interval', everyMs: MIN_INTERVAL_MS },
      payload: { type: 'macro', name: 'real' },
    })).not.toThrow();
  });

  it('cron jobs fire on tick and recompute nextRunAt', async () => {
    let now = T0;
    const { scheduler, calls } = makeScheduler(dir, () => now);
    const job = scheduler.addJob({
      schedule: { kind: 'cron', expr: '*/15 * * * *' },
      payload: { type: 'tool', tool: 'observe' },
    });
    expect(job.nextRunAt).toBe(Date.UTC(2026, 0, 15, 10, 15));
    now = Date.UTC(2026, 0, 15, 10, 15);
    await scheduler.tick();
    expect(calls).toHaveLength(1);
    expect(scheduler.get(job.id)!.nextRunAt).toBe(Date.UTC(2026, 0, 15, 10, 30));
  });
});
