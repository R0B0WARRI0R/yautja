import { describe, it, expectTypeOf } from 'vitest';
import type {
  YautjaResponse,
  YautjaError,
  OperationMeta,
  StateMeta,
  EvidenceMeta,
  ContextMeta,
  Severity,
  StateIntegrity,
} from '../../src/doctrine/types.js';

describe('YautjaResponse types', () => {
  it('success response has ok:true and result', () => {
    type S = YautjaResponse<string>;
    const ok: S = {
      ok: true,
      result: 'hello',
      operation: {
        tool: 'yautja_act',
        action_type: 'click',
        operation_id: 'op_01J',
        trace_id: 'tr_01J',
        attempt: 1,
        max_attempts: 3,
        idempotency_key: null,
      },
      state: {
        session_id: 'ses_1',
        tab_id: 1,
        origin: 'https://example.com',
        checkpoint_id: null,
        state_integrity: 'known',
      },
      evidence: {
        snapshot_after: 'resource://yautja/traces/tr_01J/dom/1',
        redacted: true,
        redaction_policy: ['secrets'],
      },
      context: {
        consumed_tokens_estimate: 100,
        available_window_tokens: 8000,
        confidence: 'medium',
      },
      schema_version: '1.0',
    };
    expectTypeOf(ok.ok).toEqualTypeOf<true>();
    expectTypeOf(ok.result).toEqualTypeOf<string>();
  });

  it('error response has ok:false and error with code', () => {
    type E = YautjaResponse<never>;
    const err: E = {
      ok: false,
      error: {
        code: 'YJ.ACT.DOM_TARGET_STALE',
        introduced_in: '1.0',
        category: 'action',
        severity: 'recoverable',
        retryable: true,
        retry_strategy: 'REOBSERVE_THEN_RETRY',
        user_confirmation_required: false,
        message: 'Target changed',
        agent_summary: 'Re-observe and resolve selector again',
        recovery: {
          allowed: ['REOBSERVE_THEN_RETRY', 'ROLLBACK_TO_CHECKPOINT', 'ABORT'],
          recommended: 'REOBSERVE_THEN_RETRY',
          next_tool_call: null,
        },
      },
      operation: {
        tool: 'yautja_act',
        action_type: 'click',
        operation_id: 'op_01J',
        trace_id: 'tr_01J',
        attempt: 2,
        max_attempts: 3,
        idempotency_key: null,
      },
      state: {
        session_id: 'ses_1',
        tab_id: 1,
        origin: 'https://example.com',
        checkpoint_id: null,
        state_integrity: 'corrupted',
      },
      evidence: {
        snapshot_before: 'resource://yautja/traces/tr_01J/dom/1',
        snapshot_after: 'resource://yautja/traces/tr_01J/dom/2',
        redacted: true,
        redaction_policy: ['secrets'],
      },
      context: {
        consumed_tokens_estimate: 200,
        available_window_tokens: 7800,
        confidence: 'medium',
      },
      schema_version: '1.0',
    };
    expectTypeOf(err.ok).toEqualTypeOf<false>();
    expectTypeOf(err.error.code).toEqualTypeOf<string>();
  });

  it('Severity has exactly 5 values', () => {
    const severities: Severity[] = [
      'correctable',
      'transient',
      'recoverable',
      'approval_required',
      'terminal',
    ];
    expectTypeOf(severities).toEqualTypeOf<Severity[]>();
  });

  it('StateIntegrity has exactly 5 values', () => {
    const states: StateIntegrity[] = [
      'unknown',
      'known',
      'corrupted',
      'restored',
      'contaminated',
    ];
    expectTypeOf(states).toEqualTypeOf<StateIntegrity[]>();
  });
});
