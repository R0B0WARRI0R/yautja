import { z } from 'zod';

export const severitySchema = z.enum([
  'correctable', 'transient', 'recoverable', 'approval_required', 'terminal',
]);

export const stateIntegritySchema = z.enum([
  'unknown', 'known', 'corrupted', 'restored', 'contaminated',
]);

export const errorCategorySchema = z.enum([
  'protocol', 'action', 'capture', 'net', 'policy', 'opsec',
]);

export const retryStrategySchema = z.enum([
  'RETRY_SAME', 'REOBSERVE_THEN_RETRY', 'ROLLBACK_TO_CHECKPOINT',
  'REQUEST_APPROVAL', 'ABORT',
]);

export const yautjaErrorSchema = z.object({
  code: z.string().regex(/^YJ\.[A-Z]+(\.[A-Z_]+)+$/),
  introduced_in: z.string().regex(/^\d+(\.\d+)*$/),
  category: errorCategorySchema,
  severity: severitySchema,
  retryable: z.boolean(),
  retry_strategy: retryStrategySchema,
  user_confirmation_required: z.boolean(),
  message: z.string(),
  agent_summary: z.string(),
  recovery: z.object({
    allowed: z.array(retryStrategySchema),
    recommended: retryStrategySchema,
    next_tool_call: z.object({
      name: z.string(),
      arguments: z.record(z.string(), z.unknown()),
    }).nullable(),
  }),
});

export const operationMetaSchema = z.object({
  tool: z.string(),
  action_type: z.string(),
  operation_id: z.string(),
  trace_id: z.string(),
  attempt: z.number().int().positive(),
  max_attempts: z.number().int().positive(),
  idempotency_key: z.string().nullable(),
});

export const stateMetaSchema = z.object({
  session_id: z.string(),
  tab_id: z.number().int(),
  origin: z.string(),
  url_before: z.string().optional(),
  url_after: z.string().optional(),
  checkpoint_id: z.string().nullable(),
  state_integrity: stateIntegritySchema,
});

export const evidenceMetaSchema = z.object({
  snapshot_before: z.string().optional(),
  snapshot_after: z.string().optional(),
  target_fingerprint_before: z.string().optional(),
  target_fingerprint_after: z.string().optional(),
  network_window: z.string().optional(),
  redacted: z.boolean(),
  redaction_policy: z.array(z.enum(['secrets', 'pii', 'sensitive_dom', 'none'])),
});

export const contextMetaSchema = z.object({
  consumed_tokens_estimate: z.number().int().nonnegative(),
  available_window_tokens: z.number().int().nonnegative(),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const yautjaResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: yautjaErrorSchema.optional(),
  operation: operationMetaSchema,
  state: stateMetaSchema,
  evidence: evidenceMetaSchema,
  context: contextMetaSchema,
  schema_version: z.literal('1.0'),
});
