import { AsyncLocalStorage } from 'node:async_hooks';
import { generateOperationId } from '../doctrine/ids.js';
import { assertMacroActive, currentMacroSignal } from '../macros/execution-scope.js';

export type OperationState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown';
export class OperationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'OperationError'; }
}
export interface OperationContext {
  id: string;
  tool: string;
  requestId?: string | number;
  startedAt: number;
  deadline: number;
  state: OperationState;
  phase: string;
  phaseStartedAt: number;
  phaseTimings: Record<string, number>;
  target?: { tabId: number; generation: string };
  controller: AbortController;
  pendingMutations: number;
  elapsedMs?: number;
  queueMs?: number;
}
const storage = new AsyncLocalStorage<OperationContext>();
export const currentOperation = () => storage.getStore();
export function assertOperationActive(): void {
  assertMacroActive();
  const op = currentOperation();
  if (!op) return;
  op.controller.signal.throwIfAborted();
  if (Date.now() >= op.deadline) throw new OperationError('OPERATION_TIMEOUT', 'Operation deadline exceeded');
}
export function remainingOperationMs(fallback: number): number {
  assertOperationActive();
  return Math.max(1, Math.min(fallback, (currentOperation()?.deadline ?? Infinity) - Date.now()));
}
export function pinOperationTarget(tabId: number, generation: string): void {
  assertOperationActive();
  const op = currentOperation();
  if (!op) return;
  if (op.target && op.target.tabId !== tabId) throw new OperationError('TARGET_MISMATCH', 'Operation target changed');
  if (op.target && op.target.generation !== generation) throw new OperationError('STALE_GENERATION', 'Connection generation changed');
  op.target = { tabId, generation };
}
/** Explicit navigation/selection inside a serialized macro establishes its next target. */
export function selectOperationTarget(tabId: number, generation: string): void {
  assertOperationActive();
  const op = currentOperation();
  if (op) op.target = { tabId, generation };
}
export function operationPhase(phase: string): void {
  assertOperationActive();
  const op = currentOperation();
  if (op) {
    op.phaseTimings[op.phase] = (op.phaseTimings[op.phase] ?? 0) + Date.now() - op.phaseStartedAt;
    op.phase = phase;
    op.phaseStartedAt = Date.now();
  }
}
export function operationSignal(): AbortSignal | undefined {
  const signals = [currentOperation()?.controller.signal, currentMacroSignal()].filter((signal): signal is AbortSignal => !!signal);
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}

/** One queue per Helmet. Cancel/status bypass it; no global browser lock. */
export class OperationManager {
  private tail: Promise<unknown> = Promise.resolve();
  private records = new Map<string, OperationContext>();
  private activeRequests = new Map<string | number, OperationContext>();

  async run<T>(tool: string, fn: () => Promise<T>, opts: {
    timeoutMs?: number; requestId?: string | number; concurrent?: boolean; id?: string;
  } = {}): Promise<T> {
    if (currentOperation()) { assertOperationActive(); return fn(); }
    const startedAt = Date.now();
    const op: OperationContext = {
      id: opts.id ?? generateOperationId(), tool, requestId: opts.requestId, startedAt,
      deadline: startedAt + (opts.timeoutMs ?? 60_000), state: 'pending', phase: 'queue',
      phaseStartedAt: startedAt, phaseTimings: {},
      controller: new AbortController(), pendingMutations: 0,
    };
    this.records.set(op.id, op);
    if (opts.requestId !== undefined) this.activeRequests.set(opts.requestId, op);
    for (const [id, record] of this.records) {
      if (this.records.size <= 200) break;
      if (record.elapsedMs !== undefined) this.records.delete(id);
    }
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(op.controller.signal.reason);
      op.controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const timer = setTimeout(() => op.controller.abort(new OperationError('OPERATION_TIMEOUT', 'Operation deadline exceeded')), Math.max(1, op.deadline - Date.now()));
    const run = () => storage.run(op, async () => {
      assertOperationActive();
      op.state = 'running'; operationPhase('execution'); op.queueMs = Date.now() - startedAt;
      return fn();
    });
    const predecessor = this.tail;
    const work = opts.concurrent ? run() : predecessor.then(run);
    const result = Promise.race([work, cancelled]);
    // A cancelled QUEUED request must not let its successor overtake the
    // operation that is still running ahead of it.
    if (!opts.concurrent) this.tail = Promise.all([predecessor, result.catch(() => {})]).then(() => {});
    try {
      const value = await result;
      op.state = op.pendingMutations > 0 ? 'outcome_unknown' : (value as any)?.ok === false ? 'failed' : 'succeeded';
      return value;
    } catch (err) {
      op.state = op.pendingMutations > 0 ? 'outcome_unknown'
        : op.controller.signal.aborted ? 'cancelled' : 'failed';
      throw err;
    } finally {
      clearTimeout(timer);
      op.elapsedMs = Date.now() - startedAt;
      op.phaseTimings[op.phase] = (op.phaseTimings[op.phase] ?? 0) + Date.now() - op.phaseStartedAt;
      if (opts.requestId !== undefined) this.activeRequests.delete(opts.requestId);
      op.controller.signal.removeEventListener('abort', onAbort);
      op.controller.abort(new OperationError('OPERATION_ENDED', 'Operation has ended'));
    }
  }

  cancel(requestId: string | number): boolean {
    const op = this.activeRequests.get(requestId) ?? this.records.get(String(requestId));
    if (!op || op.elapsedMs !== undefined) return false;
    op.controller.abort(new OperationError('OPERATION_CANCELLED', 'Operation cancelled'));
    return true;
  }
  cancelAll(exceptId?: string): void {
    for (const op of this.records.values()) if (op.id !== exceptId && op.elapsedMs === undefined) this.cancel(op.id);
  }
  list() {
    return [...this.records.values()].map(({ controller: _controller, ...op }) => ({ ...op, phaseTimings: { ...op.phaseTimings }, target: op.target && { ...op.target } }));
  }
}
