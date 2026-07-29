/**
 * Grabación de sesión anotada (T12 — RE de Claude in Chrome, gif_creator).
 *
 * Un recorder por sesión que almacena un log de eventos JSON (timestamp,
 * tipo de evento, metadatos compactos) — NO imágenes: es barato y sirve
 * como replay log. Si la acción es un screenshot, el helmet enlaza la
 * evidencia (evidenceId) en vez del base64 (ver recordToolCall en helmet).
 *
 * Los valores se sanitizan antes de grabar: redacción de campos sensibles
 * (misma semántica que src/vision/redaction.ts) y truncado de strings
 * largos a RECORDED_STRING_MAX_CHARS.
 */

import { REDACTED_VALUE, isSensitiveElement } from '../vision/redaction.js';
import type { EvidenceStore, EvidenceRecord } from './evidence-store.js';

/** Máximo de caracteres de un string grabado (resumen compacto). */
export const RECORDED_STRING_MAX_CHARS = 200;

/** Tools de gestión de la propia grabación: nunca se graban (autorreferencia). */
export const RECORDER_EXCLUDED_TOOLS = new Set(['session_record', 'macro_record']);

/** Claves cuyo valor nunca se serializa en un evento grabado. */
const SENSITIVE_KEY_PATTERN =
  /^(password|passwd|pass|secret|token|api[-_]?key|otp|cvv|csc|cc[-_]?number|cc[-_]?csc|cc[-_]?exp|authorization|new-password|current-password|one-time-code)$/i;

export interface SessionEvent {
  /** Epoch ms del evento. */
  ts: number;
  /** Tipo de evento: click, type, navigate, screenshot... (action.type o el tool). */
  event: string;
  /** Tool MCP que originó el evento. */
  tool: string;
  ok: boolean;
  url?: string;
  selector?: string;
  coords?: { x: number; y: number };
  /** Enlace a evidencia (screenshots) en vez del base64. */
  evidenceId?: string;
  /** Metadatos compactos y sanitizados de la llamada. */
  data?: Record<string, unknown>;
}

export interface SessionRecording {
  startedAt: number;
  stoppedAt?: number;
  events: SessionEvent[];
}

export interface SessionRecordingSummary {
  events: number;
  durationMs: number;
  byType: Record<string, number>;
}

export interface SessionRecorderStatus {
  active: boolean;
  events: number;
  startedAt: string | null;
  elapsedMs: number | null;
}

/**
 * Sanitización recursiva para logs de grabación: redacta valores de claves
 * sensibles (y de elementos sensibles vía isSensitiveElement), redacta el
 * texto tecleado sobre selectores *password* y trunca strings largos.
 * No muta el original.
 */
export function sanitizeRecordedValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > RECORDED_STRING_MAX_CHARS
      ? `${value.slice(0, RECORDED_STRING_MAX_CHARS)}…[+${value.length - RECORDED_STRING_MAX_CHARS} chars]`
      : value;
  }
  if (typeof value !== 'object') return value;
  if (depth >= 4) return '[max depth]';
  if (Array.isArray(value)) return value.map((v) => sanitizeRecordedValue(v, depth + 1));
  const obj = value as Record<string, unknown>;
  const redactElementValue = isSensitiveElement(obj) && typeof obj.value === 'string';
  // Heurística extra: texto tecleado sobre un selector *password* se redacta.
  const passwordSelector = typeof obj.selector === 'string' && /password|passwd/i.test(obj.selector);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERN.test(k)
      || (k === 'value' && redactElementValue)
      || ((k === 'text' || k === 'value') && passwordSelector && typeof v === 'string')) {
      out[k] = REDACTED_VALUE;
    } else {
      out[k] = sanitizeRecordedValue(v, depth + 1);
    }
  }
  return out;
}

/**
 * Construye un evento compacto a partir de una tool call MCP. Para `act`
 * el tipo de evento es el action.type (click, navigate, screenshot...);
 * para el resto de tools (trustedClick, smartType, openTab...) es el
 * nombre de la tool.
 */
export function summarizeToolEvent(tool: string, args: any, ok: boolean): SessionEvent {
  const ev: SessionEvent = { ts: Date.now(), event: tool, tool, ok };
  const action = tool === 'act' && args?.action && typeof args.action === 'object'
    ? args.action
    : undefined;
  const source = action ?? (args && typeof args === 'object' ? args : {});
  if (action && typeof action.type === 'string') ev.event = action.type;
  if (typeof source.url === 'string') ev.url = source.url;
  if (typeof source.selector === 'string') ev.selector = source.selector;
  const coords = source.coords;
  if (coords && typeof coords.x === 'number' && typeof coords.y === 'number') {
    ev.coords = { x: coords.x, y: coords.y };
  }
  ev.data = sanitizeRecordedValue(source) as Record<string, unknown>;
  return ev;
}

/** Resumen agregado de una grabación (nº eventos, duración, acciones por tipo). */
export function summarizeRecording(rec: SessionRecording, now = Date.now()): SessionRecordingSummary {
  const byType: Record<string, number> = {};
  for (const ev of rec.events) byType[ev.event] = (byType[ev.event] ?? 0) + 1;
  const end = rec.stoppedAt ?? (rec.events.length ? rec.events[rec.events.length - 1].ts : now);
  return {
    events: rec.events.length,
    durationMs: Math.max(0, end - rec.startedAt),
    byType,
  };
}

export class SessionRecorder {
  private activeFlag = false;
  private events: SessionEvent[] = [];
  private startedAt = 0;
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  get active(): boolean {
    return this.activeFlag;
  }

  /** Empieza una grabación nueva (descarta los eventos anteriores). */
  start(): void {
    this.activeFlag = true;
    this.events = [];
    this.startedAt = this.now();
  }

  /**
   * Graba un evento. No-op si el recorder no está activo. `data` aporta
   * tool/ok/url/selector/coords/evidenceId/data (ver summarizeToolEvent).
   */
  capture(event: string, data?: Omit<Partial<SessionEvent>, 'ts' | 'event'>): SessionEvent | null {
    if (!this.activeFlag) return null;
    const ev: SessionEvent = {
      ts: this.now(),
      event,
      tool: data?.tool ?? event,
      ok: data?.ok ?? true,
    };
    if (data?.url !== undefined) ev.url = data.url;
    if (data?.selector !== undefined) ev.selector = data.selector;
    if (data?.coords !== undefined) ev.coords = data.coords;
    if (data?.evidenceId !== undefined) ev.evidenceId = data.evidenceId;
    if (data?.data !== undefined) ev.data = data.data;
    this.events.push(ev);
    return ev;
  }

  /** Detiene la grabación y devuelve lo grabado (null si no había nada). */
  stop(): SessionRecording | null {
    if (!this.activeFlag && this.events.length === 0) return null;
    this.activeFlag = false;
    return { startedAt: this.startedAt, stoppedAt: this.now(), events: [...this.events] };
  }

  /** Vacía el log (no cambia el estado activo/inactivo). */
  clear(): void {
    this.events = [];
    this.startedAt = this.activeFlag ? this.now() : 0;
  }

  /** Últimos N eventos grabados (copia; el más reciente al final). */
  tail(limit: number): SessionEvent[] {
    return this.events.slice(-Math.max(0, limit));
  }

  status(): SessionRecorderStatus {
    return {
      active: this.activeFlag,
      events: this.events.length,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      elapsedMs: this.startedAt ? this.now() - this.startedAt : null,
    };
  }

  /**
   * Vuelca el log JSON al evidence store (kind 'session-recording') y
   * devuelve el record + resumen. null si no hay eventos grabados.
   */
  exportToEvidence(
    store: EvidenceStore,
    opts: { runId?: string; host?: string } = {},
  ): { record: EvidenceRecord; summary: SessionRecordingSummary } | null {
    if (this.events.length === 0) return null;
    const recording: SessionRecording = { startedAt: this.startedAt, events: [...this.events] };
    const summary = summarizeRecording(recording, this.now());
    const doc = {
      version: 1,
      kind: 'session-recording',
      startedAt: new Date(this.startedAt).toISOString(),
      active: this.activeFlag,
      summary,
      events: recording.events,
    };
    const record = store.put({
      host: opts.host ?? 'session-recorder',
      kind: 'session-recording',
      runId: opts.runId,
      body: JSON.stringify(doc, null, 2),
    });
    return { record, summary };
  }
}
