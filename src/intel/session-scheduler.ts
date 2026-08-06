/**
 * Scheduler local de tool calls/macros (T14A — RE de Claude in Chrome,
 * scheduled tasks). Vive en memoria del helmet y persiste los jobs en
 * <dir>/schedule.json (mismo directorio de sesión donde SessionGates
 * persiste gates.json).
 *
 * Tipos de schedule:
 *   once     { kind:'once', at }           dispara una vez y se AUTO-ELIMINA
 *   interval { kind:'interval', everyMs }  mínimo MIN_INTERVAL_MS (anti-spam)
 *   cron     { kind:'cron', expr }         5 campos (min hour dom mon dow) en
 *                                          UTC: `*`, `* /n`, listas `a,b`,
 *                                          rangos `a-b` (y `a-b/n`). Sin
 *                                          dependencias externas.
 *
 * Arranque: al cargar jobs persistidos NO hay ejecución en ráfaga. Los
 * `once` vencidos durante el apagado se marcan `missed:true` y quedan
 * deshabilitados; interval/cron se reprograman desde "ahora".
 *
 * Seguridad: SCHEDULER_EXCLUDED_TOOLS (gateGrant/gateRevoke/plan_approve)
 * nunca se pueden programar — los grants requieren frase humana en chat.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { toYautjaError } from '../doctrine/registry.js';

/** Mínimo intervalo permitido (guardarraíl anti-spam). */
export const MIN_INTERVAL_MS = 60_000;

/** Tools que un job NUNCA puede ejecutar (grants/planes: solo humano en chat). */
export const SCHEDULER_EXCLUDED_TOOLS = new Set(['gateGrant', 'gateRevoke', 'plan_approve']);

export type ScheduleSpec =
  | { kind: 'once'; at: number }
  | { kind: 'interval'; everyMs: number }
  | { kind: 'cron'; expr: string };

export type JobPayload =
  | { type: 'tool'; tool: string; args?: Record<string, unknown> }
  | { type: 'macro'; name: string; args?: unknown };

export interface ScheduledJob {
  id: string;
  name?: string;
  schedule: ScheduleSpec;
  payload: JobPayload;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt: number;
  runCount: number;
  enabled: boolean;
  /** once vencido mientras el helmet estaba apagado: no se ejecuta. */
  missed?: boolean;
  lastError?: string;
}

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  mon: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MINUTE_MS = 60_000;

/**
 * Parsea un campo cron: `*`, `* /n`, `a`, `a,b,c`, `a-b`, `a-b/n`, `a/n`.
 * Devuelve null si es inválido (rango invertido, fuera de [min,max], step<1).
 */
export function parseCronField(field: string, min: number, max: number): Set<number> | null {
  if (typeof field !== 'string' || field.length === 0) return null;
  const out = new Set<number>();
  for (const part of field.split(',')) {
    if (!part) return null;
    const pieces = part.split('/');
    if (pieces.length > 2) return null;
    const [range, stepStr] = pieces;
    const step = stepStr !== undefined ? Number(stepStr) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (/^\d+$/.test(range)) {
      lo = Number(range);
      hi = stepStr !== undefined ? max : lo;
    } else {
      const m = /^(\d+)-(\d+)$/.exec(range);
      if (!m) return null;
      lo = Number(m[1]);
      hi = Number(m[2]);
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

/**
 * Parsea una expresión cron de 5 campos (min hour dom mon dow). dow 0 y 7
 * son domingo. Devuelve null si la expresión no es válida.
 */
export function parseCron(expr: string): CronSpec | null {
  if (typeof expr !== 'string') return null;
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseCronField(fields[0], 0, 59);
  const hour = parseCronField(fields[1], 0, 23);
  const dom = parseCronField(fields[2], 1, 31);
  const mon = parseCronField(fields[3], 1, 12);
  const dowRaw = parseCronField(fields[4], 0, 7);
  if (!minute || !hour || !dom || !mon || !dowRaw) return null;
  const dow = new Set([...dowRaw].map((d) => (d === 7 ? 0 : d)));
  return {
    minute, hour, dom, mon, dow,
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  };
}

/** Siguiente las 00:00 UTC del día siguiente. */
function nextDayStart(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** Siguiente hora en punto UTC. */
function nextHourStart(t: number): number {
  return Math.floor(t / 3_600_000) * 3_600_000 + 3_600_000;
}

/** Las 00:00 UTC del día 1 del mes siguiente. */
function nextMonthStart(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * Próxima ocurrencia (epoch ms, minuto exacto UTC) estrictamente posterior a
 * `afterMs`. Semántica cron estándar para dom/dow: si ambos están
 * restringidos, basta que coincida uno (OR); si no, deben coincidir ambos.
 * null si no hay ocurrencia en 4 años (o la expresión no parsea).
 */
export function nextCronAfter(expr: string, afterMs: number): number | null {
  const spec = parseCron(expr);
  if (!spec) return null;
  let t = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const limit = afterMs + 4 * 366 * 24 * 60 * MINUTE_MS;
  while (t <= limit) {
    const d = new Date(t);
    if (!spec.mon.has(d.getUTCMonth() + 1)) { t = nextMonthStart(t); continue; }
    const domOk = spec.dom.has(d.getUTCDate());
    const dowOk = spec.dow.has(d.getUTCDay());
    const dayOk = spec.domRestricted && spec.dowRestricted ? domOk || dowOk : domOk && dowOk;
    if (!dayOk) { t = nextDayStart(t); continue; }
    if (!spec.hour.has(d.getUTCHours())) { t = nextHourStart(t); continue; }
    if (!spec.minute.has(d.getUTCMinutes())) { t += MINUTE_MS; continue; }
    return t;
  }
  return null;
}

export interface SchedulerExecutors {
  executeTool: (tool: string, args?: Record<string, unknown>) => Promise<unknown>;
  executeMacro: (name: string, args?: unknown) => Promise<unknown>;
  /** Validación opcional en `add` (p.ej. MacroRunner.get). */
  macroExists?: (name: string) => boolean;
}

export interface SessionSchedulerOptions extends SchedulerExecutors {
  /** Directorio de sesión (donde vive gates.json). */
  dir: string;
  now?: () => number;
  /** Periodo del timer interno (default 1000ms). */
  tickMs?: number;
}

export class SessionScheduler {
  private readonly dir: string;
  private readonly executors: SchedulerExecutors;
  private readonly nowFn: () => number;
  private readonly tickMs: number;
  private jobs = new Map<string, ScheduledJob>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(opts: SessionSchedulerOptions) {
    this.dir = opts.dir;
    this.executors = opts;
    this.nowFn = opts.now ?? Date.now;
    this.tickMs = opts.tickMs ?? 1_000;
    this.load();
  }

  /** Carga schedule.json y reconcilia (sin ráfagas: ver cabecera del módulo). */
  private load(): void {
    let changed = false;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, 'schedule.json');
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(data.jobs)) {
          for (const j of data.jobs) {
            if (j && typeof j.id === 'string' && j.schedule && j.payload) {
              this.jobs.set(j.id, j as ScheduledJob);
            }
          }
        }
      }
    } catch {
      // estado corrupto/ausente → empezar limpio; nunca tumbar el helmet
    }
    const now = this.nowFn();
    for (const job of this.jobs.values()) {
      if (job.schedule.kind === 'once') {
        if (job.nextRunAt <= now) {
          // Venció con el helmet apagado: se marca missed y NO se ejecuta.
          job.missed = true;
          job.enabled = false;
          changed = true;
        }
      } else if (job.schedule.kind === 'interval') {
        if (!job.enabled) continue;
        job.nextRunAt = now + job.schedule.everyMs;
        changed = true;
      } else {
        if (!job.enabled) continue;
        const next = nextCronAfter(job.schedule.expr, now);
        if (next === null) {
          job.enabled = false;
          job.missed = true;
        } else {
          job.nextRunAt = next;
        }
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private persist(): void {
    try {
      fs.writeFileSync(
        path.join(this.dir, 'schedule.json'),
        JSON.stringify({ version: 1, jobs: [...this.jobs.values()] }, null, 2),
      );
    } catch {}
  }

  private validatePayload(payload: any): JobPayload {
    const invalid = (msg: string) => toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', { message: msg });
    if (!payload || typeof payload !== 'object') {
      throw invalid('payload must be {type:"tool",tool,args?} or {type:"macro",name,args?}');
    }
    if (payload.type === 'tool') {
      if (typeof payload.tool !== 'string' || payload.tool.length === 0) {
        throw invalid('payload.tool must be a non-empty tool name');
      }
      if (SCHEDULER_EXCLUDED_TOOLS.has(payload.tool)) {
        throw invalid(
          `tool "${payload.tool}" cannot be scheduled: gate/plan grants require the user's phrase in chat and are never automated`,
        );
      }
      const out: JobPayload = { type: 'tool', tool: payload.tool };
      if (payload.args !== undefined) {
        if (typeof payload.args !== 'object' || payload.args === null || Array.isArray(payload.args)) {
          throw invalid('payload.args must be an object');
        }
        out.args = payload.args;
      }
      return out;
    }
    if (payload.type === 'macro') {
      if (typeof payload.name !== 'string' || payload.name.length === 0) {
        throw invalid('payload.name must be a non-empty macro name');
      }
      if (this.executors.macroExists && !this.executors.macroExists(payload.name)) {
        throw invalid(`unknown macro: ${payload.name}`);
      }
      const out: JobPayload = { type: 'macro', name: payload.name };
      if (payload.args !== undefined) out.args = payload.args;
      return out;
    }
    throw invalid(`payload.type must be "tool" or "macro" (got ${JSON.stringify(payload.type)})`);
  }

  private validateSchedule(schedule: any, now: number): { spec: ScheduleSpec; nextRunAt: number } {
    const invalid = (msg: string) => toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', { message: msg });
    if (!schedule || typeof schedule !== 'object') {
      throw invalid('schedule must be {kind:"once",at} | {kind:"interval",everyMs} | {kind:"cron",expr}');
    }
    switch (schedule.kind) {
      case 'once': {
        if (typeof schedule.at !== 'number' || !Number.isFinite(schedule.at)) {
          throw invalid('schedule.at must be a finite epoch-ms timestamp');
        }
        if (schedule.at <= now) throw invalid('schedule.at is in the past');
        return { spec: { kind: 'once', at: schedule.at }, nextRunAt: schedule.at };
      }
      case 'interval': {
        if (typeof schedule.everyMs !== 'number' || !Number.isFinite(schedule.everyMs)) {
          throw invalid('schedule.everyMs must be a finite number');
        }
        if (schedule.everyMs < MIN_INTERVAL_MS) {
          throw invalid(`schedule.everyMs must be >= ${MIN_INTERVAL_MS}ms (anti-spam guard)`);
        }
        return { spec: { kind: 'interval', everyMs: schedule.everyMs }, nextRunAt: now + schedule.everyMs };
      }
      case 'cron': {
        if (typeof schedule.expr !== 'string' || !parseCron(schedule.expr)) {
          throw invalid(`schedule.expr is not a valid 5-field cron expression: ${JSON.stringify(schedule.expr)}`);
        }
        const next = nextCronAfter(schedule.expr, now);
        if (next === null) throw invalid('cron expression has no occurrence within 4 years');
        return { spec: { kind: 'cron', expr: schedule.expr }, nextRunAt: next };
      }
      default:
        throw invalid(`schedule.kind must be once|interval|cron (got ${JSON.stringify(schedule.kind)})`);
    }
  }

  /** Crea un job. Lanza Error con mensaje claro si la validación falla. */
  addJob(input: { name?: string; schedule: unknown; payload: unknown }): ScheduledJob {
    const now = this.nowFn();
    const payload = this.validatePayload(input.payload);
    const { spec, nextRunAt } = this.validateSchedule(input.schedule, now);
    const job: ScheduledJob = {
      id: `job_${crypto.randomBytes(6).toString('hex')}`,
      schedule: spec,
      payload,
      createdAt: now,
      nextRunAt,
      runCount: 0,
      enabled: true,
    };
    if (input.name) job.name = String(input.name);
    this.jobs.set(job.id, job);
    this.persist();
    return { ...job };
  }

  list(): ScheduledJob[] {
    return [...this.jobs.values()].map((j) => ({ ...j }));
  }

  get(id: string): ScheduledJob | undefined {
    const j = this.jobs.get(id);
    return j ? { ...j } : undefined;
  }

  remove(id: string): boolean {
    const removed = this.jobs.delete(id);
    if (removed) this.persist();
    return removed;
  }

  setEnabled(id: string, enabled: boolean): ScheduledJob {
    const job = this.jobs.get(id);
    if (!job) throw toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', { message: `unknown job id: ${id}` });
    job.enabled = enabled;
    if (enabled) job.missed = undefined;
    if (enabled && job.schedule.kind !== 'once') {
      // Reprogramar desde ahora al re-habilitar (sin ráfaga acumulada).
      const now = this.nowFn();
      job.nextRunAt = job.schedule.kind === 'interval'
        ? now + job.schedule.everyMs
        : nextCronAfter(job.schedule.expr, now) ?? job.nextRunAt;
    }
    this.persist();
    return { ...job };
  }

  /** Ejecuta el payload de un job (actualiza lastRunAt/runCount/lastError). */
  private async execute(job: ScheduledJob, now: number): Promise<unknown> {
    try {
      const result = job.payload.type === 'tool'
        ? await this.executors.executeTool(job.payload.tool, job.payload.args)
        : await this.executors.executeMacro(job.payload.name, job.payload.args);
      job.lastRunAt = now;
      job.runCount++;
      job.lastError = undefined;
      return result;
    } catch (err) {
      job.lastRunAt = now;
      job.runCount++;
      job.lastError = err instanceof Error ? err.message : String(err);
      return { error: job.lastError };
    }
  }

  /**
   * Ejecuta un job inmediatamente (aunque esté deshabilitado). No altera la
   * programación (nextRunAt) ni elimina los `once`.
   */
  async runNow(id: string): Promise<unknown> {
    const job = this.jobs.get(id);
    if (!job) throw toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', { message: `unknown job id: ${id}` });
    const result = await this.execute(job, this.nowFn());
    this.persist();
    return result;
  }

  /**
   * Procesa los jobs vencidos (llamado por el timer interno; público para
   * tests con reloj fake). Secuencial y no reentrante.
   */
  async tick(now: number = this.nowFn()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due = [...this.jobs.values()]
        .filter((j) => j.enabled && j.nextRunAt <= now)
        .sort((a, b) => a.nextRunAt - b.nextRunAt);
      for (const job of due) {
        await this.execute(job, now);
        if (job.schedule.kind === 'once') {
          // Los once se auto-eliminan tras disparar (aunque fallen).
          this.jobs.delete(job.id);
        } else if (job.schedule.kind === 'interval') {
          const next = job.nextRunAt + job.schedule.everyMs;
          job.nextRunAt = next > now ? next : now + job.schedule.everyMs;
        } else {
          job.nextRunAt = nextCronAfter(job.schedule.expr, now) ?? job.nextRunAt;
        }
      }
      if (due.length > 0) this.persist();
    } finally {
      this.ticking = false;
    }
  }

  /** Arranca el timer interno (unref: no mantiene vivo el proceso). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
