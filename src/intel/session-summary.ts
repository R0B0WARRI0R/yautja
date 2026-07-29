/**
 * Resumen compacto de sesión para el LLM cliente (T14B — RE de Claude in
 * Chrome, meta-resúmenes). Yautja no tiene LLM propio: el cliente MCP es el
 * LLM, así que `session_summary` produce un estado de sesión estructurado y
 * acotado pensado para consumirse en una sola lectura.
 *
 * Secciones (de mayor a menor prioridad): gates, plan, tabs, recorder,
 * scheduler, macros, activity, lastActions. Si el JSON excede maxChars se
 * eliminan secciones enteras empezando por la de MENOR prioridad y se marca
 * `truncated: true` con `omittedSections`. Nunca devuelve un blob gigante.
 */

import type { GateGrant } from '../doctrine/gates.js';
import type { PendingPlan } from '../doctrine/plan.js';
import type { SessionEvent } from './session-recorder.js';
import type { MacroSummary } from '../macros/types.js';
import type { ScheduledJob } from './session-scheduler.js';

export const DEFAULT_SUMMARY_MAX_CHARS = 4_000;

/** Orden de recorte: la primera es la primera en eliminarse. */
const TRIM_ORDER = ['lastActions', 'activity', 'macros', 'scheduler', 'recorder', 'tabs', 'plan', 'link', 'gates'] as const;

/** Topes por sección antes de entrar en recorte de secciones completas. */
const MAX_GRANTS = 10;
const MAX_JOBS = 20;
const MAX_MACROS = 50;

export interface SessionSummaryInput {
  sessionId: string;
  /** SessionGates.status() */
  gates?: { defaultGate: string; activeGrants: number; grants: GateGrant[] };
  pendingPlan?: PendingPlan | null;
  /** null/undefined → la sesión no tiene grupo de tabs (sección omitida). */
  sessionGroupId?: number | null;
  /** Tabs del grupo de sesión (null si no se pudieron enumerar). */
  tabs?: Array<{ tabId: number; url: string; title: string; active: boolean }> | null;
  /** SessionRecorder.status() + eventos recientes (tail). */
  recorder?: {
    active: boolean;
    events: number;
    startedAt: string | null;
    elapsedMs: number | null;
    lastEvents?: SessionEvent[];
  };
  macros?: MacroSummary[];
  /** SessionScheduler.list() */
  jobs?: ScheduledJob[];
  activity?: {
    toolCalls: Record<string, number>;
    errorsByCode: Record<string, number>;
  };
  /** Estado del enlace extensión↔helmet (ExtensionServer.getLinkState()). */
  link?: {
    connected: boolean;
    consecutiveTimeouts: number;
    linkDegraded: boolean;
    lastHealthMs: number | null;
  };
}

export interface SessionSummary {
  generatedAt: string;
  sessionId: string;
  truncated: boolean;
  omittedSections?: string[];
  sections: Record<string, unknown>;
}

function compactGrant(g: GateGrant): Record<string, unknown> {
  const out: Record<string, unknown> = {
    level: g.level,
    hosts: g.scope.hosts,
    grantedAt: g.grantedAt,
    usedRequests: g.usedRequests,
  };
  if (g.scope.pathPrefix) out.pathPrefix = g.scope.pathPrefix;
  if (g.scope.methods) out.methods = g.scope.methods;
  if (g.expiresAt) out.expiresAt = g.expiresAt;
  if (g.maxRequests !== undefined) out.maxRequests = g.maxRequests;
  return out;
}

function compactJob(j: ScheduledJob): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: j.id,
    kind: j.schedule.kind,
    payload: j.payload.type === 'tool' ? `tool:${j.payload.tool}` : `macro:${j.payload.name}`,
    enabled: j.enabled,
    nextRunAt: new Date(j.nextRunAt).toISOString(),
    runCount: j.runCount,
  };
  if (j.name) out.name = j.name;
  if (j.missed) out.missed = true;
  if (j.lastError) out.lastError = j.lastError;
  return out;
}

function compactEvent(ev: SessionEvent): Record<string, unknown> {
  const out: Record<string, unknown> = { ts: ev.ts, event: ev.event, tool: ev.tool, ok: ev.ok };
  if (ev.url) out.url = ev.url;
  if (ev.selector) out.selector = ev.selector;
  if (ev.evidenceId) out.evidenceId = ev.evidenceId;
  return out;
}

/**
 * Construye el resumen. Función pura: los inputs los recoge el helmet y
 * aquí solo se componen y recortan. maxChars <= 0 usa el default.
 */
export function buildSessionSummary(input: SessionSummaryInput, maxChars?: number): SessionSummary {
  const limit = typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars > 0
    ? Math.floor(maxChars)
    : DEFAULT_SUMMARY_MAX_CHARS;

  const sections: Record<string, unknown> = {};

  if (input.gates) {
    const grants = input.gates.grants;
    sections.gates = {
      defaultGate: input.gates.defaultGate,
      activeGrants: input.gates.activeGrants,
      grants: grants.slice(0, MAX_GRANTS).map(compactGrant),
      ...(grants.length > MAX_GRANTS ? { grantsTrimmed: grants.length - MAX_GRANTS } : {}),
    };
  }

  if (input.pendingPlan) {
    sections.plan = input.pendingPlan;
  }

  if (input.sessionGroupId != null) {
    sections.tabs = {
      groupId: input.sessionGroupId,
      tabs: input.tabs ?? 'unavailable (browser not reachable)',
    };
  }

  if (input.recorder) {
    const { lastEvents, ...status } = input.recorder;
    sections.recorder = status;
    if (status.active && lastEvents && lastEvents.length > 0) {
      sections.lastActions = lastEvents.map(compactEvent);
    }
  }

  if (input.jobs) {
    sections.scheduler = {
      jobs: input.jobs.slice(0, MAX_JOBS).map(compactJob),
      ...(input.jobs.length > MAX_JOBS ? { jobsTrimmed: input.jobs.length - MAX_JOBS } : {}),
    };
  }

  if (input.macros) {
    sections.macros = input.macros.slice(0, MAX_MACROS).map((m) => ({
      name: m.name,
      source: m.source,
      hasArgs: m.hasArgs,
    }));
  }

  if (input.activity) {
    sections.activity = input.activity;
  }

  if (input.link) {
    sections.link = input.link;
  }

  const out: SessionSummary = {
    generatedAt: new Date().toISOString(),
    sessionId: input.sessionId,
    truncated: false,
    sections,
  };

  const omitted: string[] = [];
  const trimQueue = [...TRIM_ORDER];
  // El chequeo incluye truncated/omittedSections: lo que se añade al recortar
  // también cuenta contra el presupuesto.
  const serializedLength = () => JSON.stringify(
    omitted.length > 0 ? { ...out, truncated: true, omittedSections: omitted } : out,
  ).length;
  while (serializedLength() > limit && trimQueue.length > 0) {
    const key = trimQueue.shift()!;
    if (key in sections) {
      delete sections[key];
      omitted.push(key);
    }
  }
  if (omitted.length > 0) {
    out.truncated = true;
    out.omittedSections = omitted;
  }
  return out;
}
