import { AsyncLocalStorage } from 'node:async_hooks';

export class MacroTimeoutError extends Error {
  constructor(ms: number) {
    super(`timeout after ${ms}ms`);
    this.name = 'MacroTimeoutError';
  }
}

interface MacroScope {
  signal: AbortSignal;
  deadline: number;
  timeoutMs: number;
}

const scopes = new AsyncLocalStorage<MacroScope>();

/** Also checked at the transport boundary, including after tool-internal awaits. */
export function assertMacroActive(): void {
  const scope = scopes.getStore();
  if (!scope) return;
  scope.signal.throwIfAborted();
  if (Date.now() >= scope.deadline) throw new MacroTimeoutError(scope.timeoutMs);
}

export function currentMacroSignal(): AbortSignal | undefined {
  return scopes.getStore()?.signal;
}

/** Nested macros inherit their parent's cancellation and cannot outlive it. */
export async function withMacroDeadline<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  assertMacroActive();
  const parent = scopes.getStore();
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent!.signal.reason);
  parent?.signal.addEventListener('abort', onParentAbort, { once: true });
  const scope = { signal: controller.signal, deadline: Math.min(Date.now() + ms, parent?.deadline ?? Infinity), timeoutMs: ms };
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new MacroTimeoutError(ms)), ms);
  try {
    return await Promise.race([scopes.run(scope, fn), cancelled]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    parent?.signal.removeEventListener('abort', onParentAbort);
    // Revoke leaked contexts and fire-and-forget descendants even on success.
    controller.abort(new Error('Macro execution has ended'));
  }
}

/** Capture this run's scope so a retained ctx cannot escape cancellation. */
export function bindMacroScope<T extends unknown[], R>(fn: (...args: T) => R): (...args: T) => R {
  const scope = scopes.getStore();
  return (...args: T) => {
    const invoke = () => { assertMacroActive(); return fn(...args); };
    return scope ? scopes.run(scope, invoke) : invoke();
  };
}
