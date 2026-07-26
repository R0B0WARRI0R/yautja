import type { Severity, ErrorCategory, RetryStrategy, YautjaError } from './types.js';

export interface ErrorCodeDef {
  code: string;
  introduced_in: string;
  category: ErrorCategory;
  severity: Severity;
  retryable: boolean;
  default_retry_strategy: RetryStrategy;
  user_confirmation_required: boolean;
  default_message_en: string;
  default_agent_summary_en: string;
  default_recovery_allowed: RetryStrategy[];
  default_recovery_recommended: RetryStrategy;
}

const RECOVERY = {
  reobserve: ['REOBSERVE_THEN_RETRY', 'ROLLBACK_TO_CHECKPOINT', 'ABORT'] as RetryStrategy[],
  retrySame: ['RETRY_SAME', 'REOBSERVE_THEN_RETRY', 'ABORT'] as RetryStrategy[],
  abort: ['ABORT'] as RetryStrategy[],
  rollback: ['ROLLBACK_TO_CHECKPOINT', 'ABORT'] as RetryStrategy[],
  approval: ['REQUEST_APPROVAL', 'ABORT'] as RetryStrategy[],
};

export const MVP_CODES: readonly ErrorCodeDef[] = [
  {
    code: 'YJ.PROTOCOL.INVALID_ARGUMENT',
    introduced_in: '1.0', category: 'protocol', severity: 'correctable',
    retryable: false, default_retry_strategy: 'ABORT',
    user_confirmation_required: false,
    default_message_en: 'Invalid argument provided to tool.',
    default_agent_summary_en: 'Fix the arguments and retry. Do not repeat the same call.',
    default_recovery_allowed: RECOVERY.abort,
    default_recovery_recommended: 'ABORT',
  },
  {
    code: 'YJ.ACT.DOM_TARGET_NOT_FOUND',
    introduced_in: '1.0', category: 'action', severity: 'recoverable',
    retryable: true, default_retry_strategy: 'REOBSERVE_THEN_RETRY',
    user_confirmation_required: false,
    default_message_en: 'Selector did not match any element in the DOM.',
    default_agent_summary_en: 'Run yautja_observe with interactive profile to find the correct selector.',
    default_recovery_allowed: RECOVERY.reobserve,
    default_recovery_recommended: 'REOBSERVE_THEN_RETRY',
  },
  {
    code: 'YJ.ACT.DOM_TARGET_STALE',
    introduced_in: '1.0', category: 'action', severity: 'recoverable',
    retryable: true, default_retry_strategy: 'REOBSERVE_THEN_RETRY',
    user_confirmation_required: false,
    default_message_en: 'Target element changed after selector was resolved.',
    default_agent_summary_en: 'Re-observe with interactive_delta profile and resolve selector again.',
    default_recovery_allowed: RECOVERY.reobserve,
    default_recovery_recommended: 'REOBSERVE_THEN_RETRY',
  },
  {
    code: 'YJ.ACT.NAVIGATION_RACE',
    introduced_in: '1.0', category: 'action', severity: 'recoverable',
    retryable: true, default_retry_strategy: 'REOBSERVE_THEN_RETRY',
    user_confirmation_required: false,
    default_message_en: 'Page navigated unexpectedly during action.',
    default_agent_summary_en: 'Invalidate all selector handles and snapshots. Re-observe the new page state.',
    default_recovery_allowed: RECOVERY.reobserve,
    default_recovery_recommended: 'REOBSERVE_THEN_RETRY',
  },
  {
    code: 'YJ.ACT.ACTION_NOT_IDEMPOTENT',
    introduced_in: '1.0', category: 'action', severity: 'correctable',
    retryable: false, default_retry_strategy: 'ABORT',
    user_confirmation_required: false,
    default_message_en: 'Action has external side effects and no idempotency_key was provided.',
    default_agent_summary_en: 'Provide an idempotency_key before calling this action again.',
    default_recovery_allowed: RECOVERY.abort,
    default_recovery_recommended: 'ABORT',
  },
  {
    code: 'YJ.CAPTURE.CONTEXT_BUDGET_EXCEEDED',
    introduced_in: '1.0', category: 'capture', severity: 'recoverable',
    retryable: true, default_retry_strategy: 'REOBSERVE_THEN_RETRY',
    user_confirmation_required: false,
    default_message_en: 'Response would exceed the available context window.',
    default_agent_summary_en: 'Switch to interactive_delta or network_summary profile to reduce token cost.',
    default_recovery_allowed: RECOVERY.reobserve,
    default_recovery_recommended: 'REOBSERVE_THEN_RETRY',
  },
  {
    code: 'YJ.CAPTURE.WINDOW_EXPIRED',
    introduced_in: '1.0', category: 'capture', severity: 'transient',
    retryable: true, default_retry_strategy: 'RETRY_SAME',
    user_confirmation_required: false,
    default_message_en: 'Capture window expired before data was collected.',
    default_agent_summary_en: 'Re-open the capture window and retry.',
    default_recovery_allowed: RECOVERY.retrySame,
    default_recovery_recommended: 'RETRY_SAME',
  },
  {
    code: 'YJ.NET.REQUEST_TIMEOUT',
    introduced_in: '1.0', category: 'net', severity: 'transient',
    retryable: true, default_retry_strategy: 'RETRY_SAME',
    user_confirmation_required: false,
    default_message_en: 'Network request timed out.',
    default_agent_summary_en: 'Retry with exponential backoff.',
    default_recovery_allowed: RECOVERY.retrySame,
    default_recovery_recommended: 'RETRY_SAME',
  },
  {
    code: 'YJ.NET.SESSION_STATE_UNKNOWN',
    introduced_in: '1.0', category: 'net', severity: 'recoverable',
    retryable: true, default_retry_strategy: 'ROLLBACK_TO_CHECKPOINT',
    user_confirmation_required: false,
    default_message_en: 'Session state cannot be verified.',
    default_agent_summary_en: 'Restore the last known checkpoint to re-establish session integrity.',
    default_recovery_allowed: RECOVERY.rollback,
    default_recovery_recommended: 'ROLLBACK_TO_CHECKPOINT',
  },
  {
    code: 'YJ.POLICY.DOMAIN_PERMISSION_REQUIRED',
    introduced_in: '1.0', category: 'policy', severity: 'approval_required',
    retryable: false, default_retry_strategy: 'REQUEST_APPROVAL',
    user_confirmation_required: true,
    default_message_en: 'Domain requires explicit permission to interact.',
    default_agent_summary_en: 'Request user approval for this domain before retrying.',
    default_recovery_allowed: RECOVERY.approval,
    default_recovery_recommended: 'REQUEST_APPROVAL',
  },
  {
    code: 'YJ.POLICY.DRY_RUN_REQUIRED',
    introduced_in: '1.0', category: 'policy', severity: 'approval_required',
    retryable: false, default_retry_strategy: 'REQUEST_APPROVAL',
    user_confirmation_required: true,
    default_message_en: 'Action requires a dry-run preview before execution.',
    default_agent_summary_en: 'Run with dry_run=true first to preview impact, then request approval.',
    default_recovery_allowed: RECOVERY.approval,
    default_recovery_recommended: 'REQUEST_APPROVAL',
  },
  {
    code: 'YJ.OPSEC.ANOMALY_RISK_ELEVATED',
    introduced_in: '1.0', category: 'opsec', severity: 'terminal',
    retryable: false, default_retry_strategy: 'ABORT',
    user_confirmation_required: true,
    default_message_en: 'Anomaly risk elevated — operational posture may be compromised.',
    default_agent_summary_en: 'Abort immediately. Preserve all evidence. Escalate to human operator. Do not auto-recover.',
    default_recovery_allowed: RECOVERY.abort,
    default_recovery_recommended: 'ABORT',
  },
  // ─── P11: Input Atomicity ──────────────────────────────────
  {
    code: 'YJ.ACT.TYPE_PARTIAL',
    introduced_in: '1.1', category: 'action', severity: 'recoverable',
    retryable: true, default_retry_strategy: 'ROLLBACK_TO_CHECKPOINT',
    user_confirmation_required: false,
    default_message_en: 'Typed text was only partially written to the target input.',
    default_agent_summary_en: 'Call ensureEmpty on the resolved selector, then retry smartType once. Do not stack text on the residual.',
    default_recovery_allowed: RECOVERY.rollback,
    default_recovery_recommended: 'ROLLBACK_TO_CHECKPOINT',
  },
  {
    code: 'YJ.ACT.TYPE_REJECTED',
    introduced_in: '1.1', category: 'action', severity: 'correctable',
    retryable: false, default_retry_strategy: 'REOBSERVE_THEN_RETRY',
    user_confirmation_required: false,
    default_message_en: 'Target element refused the typed input.',
    default_agent_summary_en: 'Inspect the DOM (inspect dom) and retry with an alternate selector or query.',
    default_recovery_allowed: RECOVERY.reobserve,
    default_recovery_recommended: 'REOBSERVE_THEN_RETRY',
  },
  {
    code: 'YJ.ACT.TYPE_RETRY_BLOCKED',
    introduced_in: '1.1', category: 'action', severity: 'correctable',
    retryable: false, default_retry_strategy: 'ROLLBACK_TO_CHECKPOINT',
    user_confirmation_required: false,
    default_message_en: 'A recent TYPE_PARTIAL failure on this selector blocks blind retry.',
    default_agent_summary_en: 'Call ensureEmpty on the selector (or reload the tab) before typing again. Blind retry is blocked for 30s after a partial type.',
    default_recovery_allowed: RECOVERY.rollback,
    default_recovery_recommended: 'ROLLBACK_TO_CHECKPOINT',
  },
  {
    code: 'YJ.ACT.INPUT_NOT_CLEARABLE',
    introduced_in: '1.1', category: 'action', severity: 'recoverable',
    retryable: false, default_retry_strategy: 'ROLLBACK_TO_CHECKPOINT',
    user_confirmation_required: false,
    default_message_en: 'Input could not be emptied with any available strategy.',
    default_agent_summary_en: 'Reload the tab (act navigate) and retry. The element likely re-renders from framework state.',
    default_recovery_allowed: RECOVERY.rollback,
    default_recovery_recommended: 'ROLLBACK_TO_CHECKPOINT',
  },
  {
    code: 'YJ.ACT.SUBMIT_NO_EFFECT',
    introduced_in: '1.1', category: 'action', severity: 'recoverable',
    retryable: true, default_retry_strategy: 'REOBSERVE_THEN_RETRY',
    user_confirmation_required: false,
    default_message_en: 'Submit (Enter) had no observable effect on the target input.',
    default_agent_summary_en: 'Use findClick on the send button instead of Enter, or waitForUi (P12) for the response container.',
    default_recovery_allowed: RECOVERY.reobserve,
    default_recovery_recommended: 'REOBSERVE_THEN_RETRY',
  },
  // ─── P12: waitForUi ────────────────────────────────────────
  {
    code: 'YJ.ACT.WAIT_TIMEOUT',
    introduced_in: '1.2', category: 'action', severity: 'recoverable',
    retryable: true, default_retry_strategy: 'REOBSERVE_THEN_RETRY',
    user_confirmation_required: false,
    default_message_en: 'No wait predicate matched within the timeout.',
    default_agent_summary_en: 'Run inspect dom or observe to see the actual page state, adjust predicates, and retry waitFor with a longer timeoutMs.',
    default_recovery_allowed: RECOVERY.reobserve,
    default_recovery_recommended: 'REOBSERVE_THEN_RETRY',
  },
  // ─── P13: site profiles + quota ────────────────────────────
  {
    code: 'YJ.POLICY.QUOTA_EXHAUSTED',
    introduced_in: '1.3', category: 'policy', severity: 'recoverable',
    retryable: false, default_retry_strategy: 'REQUEST_APPROVAL',
    user_confirmation_required: true,
    default_message_en: 'Domain quota/budget for automated queries is exhausted for this session.',
    default_agent_summary_en: 'Stop automated queries on this domain. Do NOT retry in a loop. Ask the user whether to wait for quota reset or continue manually.',
    default_recovery_allowed: RECOVERY.approval,
    default_recovery_recommended: 'REQUEST_APPROVAL',
  },
  {
    code: 'YJ.OPSEC.CAPTCHA_DETECTED',
    introduced_in: '1.3', category: 'opsec', severity: 'terminal',
    retryable: false, default_retry_strategy: 'ABORT',
    user_confirmation_required: true,
    default_message_en: 'A CAPTCHA/anti-bot challenge is present on the page.',
    default_agent_summary_en: 'Stop immediately. Do NOT attempt to solve, retry, or route around the challenge. Hand over to the human operator.',
    default_recovery_allowed: RECOVERY.abort,
    default_recovery_recommended: 'ABORT',
  },
  {
    code: 'YJ.POLICY.GATE_DENIED',
    introduced_in: '1.3', category: 'policy', severity: 'correctable',
    retryable: false, default_retry_strategy: 'REQUEST_APPROVAL',
    user_confirmation_required: false,
    default_message_en: 'Action denied by the active site profile policy.',
    default_agent_summary_en: 'The site profile for this domain forbids this action (e.g. intercept: forbid, denied URL pattern). Respect it or ask the user to change the profile.',
    default_recovery_allowed: RECOVERY.approval,
    default_recovery_recommended: 'REQUEST_APPROVAL',
  },
  // ─── P13.5: tab identity ───────────────────────────────────
  {
    code: 'YJ.ACT.TAB_SWITCH_MISMATCH',
    introduced_in: '1.3.5', category: 'action', severity: 'recoverable',
    retryable: true, default_retry_strategy: 'REOBSERVE_THEN_RETRY',
    user_confirmation_required: false,
    default_message_en: 'After switching tabs, the attached page does not match the requested tab.',
    default_agent_summary_en: 'Call listTabs to re-enumerate, then switchTab again. The previous attach may have raced a tab close or redirect.',
    default_recovery_allowed: RECOVERY.reobserve,
    default_recovery_recommended: 'REOBSERVE_THEN_RETRY',
  },
  // ─── P16: trusted gestures ─────────────────────────────────
  {
    code: 'YJ.PROTOCOL.CAPABILITY_MISSING',
    introduced_in: '1.6', category: 'protocol', severity: 'correctable',
    retryable: false, default_retry_strategy: 'ABORT',
    user_confirmation_required: false,
    default_message_en: 'The current backend cannot perform this action (missing capability).',
    default_agent_summary_en: 'The action requires a capability this backend lacks (e.g. trusted file chooser). Delegate to an alternative backend (e.g. SuperAPI file_upload) or use a human hand-off. Do NOT report fake success.',
    default_recovery_allowed: RECOVERY.abort,
    default_recovery_recommended: 'ABORT',
  },
] as const;

const REGISTRY_MAP: ReadonlyMap<string, ErrorCodeDef> = new Map(
  MVP_CODES.map(def => [def.code, def]),
);

export const REGISTRY = REGISTRY_MAP;

export function lookupCode(code: string): ErrorCodeDef | undefined {
  return REGISTRY.get(code);
}

export function codesInFamily(category: ErrorCategory): ErrorCodeDef[] {
  return MVP_CODES.filter(def => def.category === category);
}

export function toYautjaError(
  code: string,
  overrides?: Partial<Pick<YautjaError, 'message' | 'agent_summary' | 'recovery'>>,
): YautjaError {
  const def = lookupCode(code);
  if (!def) {
    throw new Error(`Unknown error code: ${code}. Register it in registry.ts first.`);
  }
  return {
    code: def.code,
    introduced_in: def.introduced_in,
    category: def.category,
    severity: def.severity,
    retryable: def.retryable,
    retry_strategy: def.default_retry_strategy,
    user_confirmation_required: def.user_confirmation_required,
    message: overrides?.message ?? def.default_message_en,
    agent_summary: overrides?.agent_summary ?? def.default_agent_summary_en,
    recovery: overrides?.recovery ?? {
      allowed: def.default_recovery_allowed,
      recommended: def.default_recovery_recommended,
      next_tool_call: null,
    },
  };
}