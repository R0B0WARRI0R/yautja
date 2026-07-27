import type { YautjaResponse, OperationMeta, StateMeta, ContextMeta } from './types.js';
import { failure, success } from './types.js';
import { toYautjaError, lookupCode } from './registry.js';
import { RetryEngine, type RetryPolicy } from './retry-engine.js';
import type { StateIntegrityTracker } from './state-integrity.js';
import type { IdempotencyRegistry } from './idempotency.js';
import { generateOperationId } from './ids.js';

type ExecResult<T> =
  | { value: T }
  | { error: { code: string; message?: string } };

export interface ExecuteOptions<T> {
  tool: string;
  action_type: string;
  policy_key: string;
  trace_id: string;
  idempotency_key?: string | null;
  fn: () => Promise<ExecResult<T>>;
  verify?: (result: T) => Promise<boolean>;
  session_id?: string;
  tab_id?: number;
  origin?: string;
}

export interface RecoveryMachineConfig {
  tracker: StateIntegrityTracker;
  idempotency: IdempotencyRegistry;
  policies: Record<string, RetryPolicy>;
  agent_context_window?: number;
  /** Optional sink for recovery outcomes (helmet wires telemetry here). */
  onOutcome?: (outcome: {
    trace_id: string;
    operation_id: string;
    original_error_code: string;
    recovery_strategy: string;
    attempts: number;
    outcome: 'recovered' | 'recovered_with_degradation' | 'failed' | 'deviated';
    time_to_recover_ms: number;
    context_cost_delta_tokens: number;
    deviated_from_recommendation: boolean;
  }) => void;
}

export class RecoveryMachine {
  private config: RecoveryMachineConfig;

  constructor(config: RecoveryMachineConfig) {
    this.config = config;
  }

  async execute<T>(opts: ExecuteOptions<T>): Promise<YautjaResponse<T>> {
    const policy = this.config.policies[opts.policy_key] ?? this.config.policies['default'];
    const engine = new RetryEngine(policy);

    // PREFLIGHT: check contaminated state
    if (this.config.tracker.current() === 'contaminated') {
      return this.makeError('YJ.OPSEC.ANOMALY_RISK_ELEVATED', opts, 1, policy.max_attempts);
    }

    // PREFLIGHT: check idempotency cache
    if (opts.idempotency_key) {
      const cached = this.config.idempotency.get<T>(opts.idempotency_key);
      if (cached) return cached;
    }

    // EXECUTE with retries
    const operation_id = generateOperationId();
    let lastErrorCode: string | null = null;
    const started = Date.now();

    for (let attempt = 1; attempt <= policy.max_attempts; attempt++) {
      this.config.tracker.beginOperation();

      const execResult = await opts.fn();

      if ('value' in execResult) {
        // VERIFY
        if (opts.verify && !(await opts.verify(execResult.value))) {
          lastErrorCode = 'YJ.ACT.DOM_TARGET_STALE';
          if (engine.shouldRetry(lastErrorCode, attempt)) {
            await this.delay(engine.getDelay(attempt));
            continue;
          }
          return this.makeError(lastErrorCode, opts, attempt, policy.max_attempts, operation_id);
        }

        // COMMIT
        const response = success(execResult.value, {
          operation: this.makeOperation(opts, attempt, policy.max_attempts, operation_id),
          state: this.makeState(opts),
          context: this.makeContext(0),
        });

        if (opts.idempotency_key) {
          this.config.idempotency.set(opts.idempotency_key, response);
        }

        // Telemetry: a success after a prior failed attempt IS a recovery
        if (attempt > 1 && lastErrorCode) {
          this.config.onOutcome?.({
            trace_id: opts.trace_id,
            operation_id,
            original_error_code: lastErrorCode,
            recovery_strategy: engine.nextEscalation(attempt - 1),
            attempts: attempt,
            outcome: 'recovered',
            time_to_recover_ms: Date.now() - started,
            context_cost_delta_tokens: 0,
            deviated_from_recommendation: false,
          });
        }

        return response;
      }

      // Error case
      lastErrorCode = execResult.error.code;
      const def = lookupCode(lastErrorCode);

      if (!def || !engine.shouldRetry(lastErrorCode, attempt)) {
        const yjError = toYautjaError(lastErrorCode, {
          message: execResult.error.message,
        });
        return failure(yjError, {
          operation: this.makeOperation(opts, attempt, policy.max_attempts, operation_id),
          state: this.makeState(opts),
          context: this.makeContext(0),
        });
      }

      // Retry with backoff
      await this.delay(engine.getDelay(attempt));
    }

    // Exhausted retries
    return this.makeError(lastErrorCode ?? 'YJ.NET.REQUEST_TIMEOUT', opts, policy.max_attempts, policy.max_attempts, operation_id);
  }

  private makeOperation<T>(opts: ExecuteOptions<T>, attempt: number, maxAttempts: number, opId: string): OperationMeta {
    return {
      tool: opts.tool,
      action_type: opts.action_type,
      operation_id: opId,
      trace_id: opts.trace_id,
      attempt,
      max_attempts: maxAttempts,
      idempotency_key: opts.idempotency_key ?? null,
    };
  }

  private makeState<T>(opts: ExecuteOptions<T>): StateMeta {
    return {
      session_id: opts.session_id ?? this.config.tracker.session_id(),
      tab_id: opts.tab_id ?? 0,
      origin: opts.origin ?? '',
      checkpoint_id: this.config.tracker.checkpoint(),
      state_integrity: this.config.tracker.current(),
    };
  }

  private makeContext(consumedTokens: number): ContextMeta {
    const window = this.config.agent_context_window ?? 128000;
    return {
      consumed_tokens_estimate: consumedTokens,
      available_window_tokens: Math.max(0, window - consumedTokens),
      confidence: 'low',
    };
  }

  private makeError<T>(
    code: string,
    opts: ExecuteOptions<T>,
    attempt: number,
    maxAttempts: number,
    operation_id?: string,
  ): YautjaResponse<never> {
    const yjError = toYautjaError(code);
    return failure(yjError, {
      operation: this.makeOperation(opts, attempt, maxAttempts, operation_id ?? generateOperationId()),
      state: this.makeState(opts),
      context: this.makeContext(0),
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
