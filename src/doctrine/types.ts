export const SCHEMA_VERSION = '1.0' as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

export type Severity =
  | 'correctable'
  | 'transient'
  | 'recoverable'
  | 'approval_required'
  | 'terminal';

export type StateIntegrity =
  | 'unknown'
  | 'known'
  | 'corrupted'
  | 'restored'
  | 'contaminated';

export type ErrorCategory =
  | 'protocol'
  | 'action'
  | 'capture'
  | 'net'
  | 'policy'
  | 'opsec';

export type RetryStrategy =
  | 'RETRY_SAME'
  | 'REOBSERVE_THEN_RETRY'
  | 'ROLLBACK_TO_CHECKPOINT'
  | 'REQUEST_APPROVAL'
  | 'ABORT';

export type RedactionCategory = 'secrets' | 'pii' | 'sensitive_dom' | 'none';

export type TokenConfidence = 'high' | 'medium' | 'low';

export interface RecoveryHint {
  allowed: RetryStrategy[];
  recommended: RetryStrategy;
  next_tool_call: {
    name: string;
    arguments: Record<string, unknown>;
  } | null;
}

export interface YautjaError {
  code: string;
  introduced_in: string;
  category: ErrorCategory;
  severity: Severity;
  retryable: boolean;
  retry_strategy: RetryStrategy;
  user_confirmation_required: boolean;
  message: string;
  agent_summary: string;
  recovery: RecoveryHint;
}

export interface OperationMeta {
  status?: string;
  phase?: string;
  elapsed_ms?: number;
  queue_ms?: number;
  tool: string;
  action_type: string;
  operation_id: string;
  trace_id: string;
  attempt: number;
  max_attempts: number;
  idempotency_key: string | null;
}

export interface StateMeta {
  session_id: string;
  tab_id: number;
  origin: string;
  url_before?: string;
  url_after?: string;
  checkpoint_id: string | null;
  state_integrity: StateIntegrity;
}

export interface EvidenceMeta {
  snapshot_before?: string;
  snapshot_after?: string;
  target_fingerprint_before?: string;
  target_fingerprint_after?: string;
  network_window?: string;
  redacted: boolean;
  redaction_policy: RedactionCategory[];
}

export interface ContextMeta {
  consumed_tokens_estimate: number;
  available_window_tokens: number;
  confidence: TokenConfidence;
}

export interface YautjaResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error?: YautjaError;
  operation: OperationMeta;
  state: StateMeta;
  evidence: EvidenceMeta;
  context: ContextMeta;
  schema_version: SchemaVersion;
}

export function success<T>(
  result: T,
  meta: {
    operation: OperationMeta;
    state: StateMeta;
    evidence?: Partial<EvidenceMeta>;
    context: ContextMeta;
  },
): YautjaResponse<T> {
  return {
    ok: true,
    result,
    operation: meta.operation,
    state: meta.state,
    evidence: {
      redacted: true,
      redaction_policy: ['secrets'],
      ...meta.evidence,
    },
    context: meta.context,
    schema_version: SCHEMA_VERSION,
  };
}

export function failure(
  error: YautjaError,
  meta: {
    operation: OperationMeta;
    state: StateMeta;
    evidence?: Partial<EvidenceMeta>;
    context: ContextMeta;
  },
): YautjaResponse<never> {
  return {
    ok: false,
    error,
    operation: meta.operation,
    state: meta.state,
    evidence: {
      redacted: true,
      redaction_policy: ['secrets'],
      ...meta.evidence,
    },
    context: meta.context,
    schema_version: SCHEMA_VERSION,
  };
}
