import type { Severity, ErrorCategory, RetryStrategy, YautjaError, RecoveryHint } from './types.js';

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
  default_recovery_allowed: readonly RetryStrategy[];
  default_recovery_recommended: RetryStrategy;
}

/**
 * Sentinel code returned by `toYautjaError` when the caller requests a code
 * that the registry does not know. Registered as the 27th code so the failure
 * path itself is a typed `YautjaError` rather than a bare `Error`.
 *
 * @internal Exposed as a constant for tests; production callers should hit
 *           `toYautjaError` which recurses on this code.
 */
export const UNKNOWN_ERROR_CODE = 'YJ.PROTOCOL.UNKNOWN_ERROR_CODE';

/**
 * Closed set of recovery strategies per "shape" of failure. Frozen at module
 * load so accidental mutation cannot corrupt the 26+ entries that share them
 * by reference.
 */
const RECOVERY = Object.freeze({
  reobserve: Object.freeze(['REOBSERVE_THEN_RETRY', 'ROLLBACK_TO_CHECKPOINT', 'ABORT'] as RetryStrategy[]),
  retrySame: Object.freeze(['RETRY_SAME', 'REOBSERVE_THEN_RETRY', 'ABORT'] as RetryStrategy[]),
  abort: Object.freeze(['ABORT'] as RetryStrategy[]),
  rollback: Object.freeze(['ROLLBACK_TO_CHECKPOINT', 'ABORT'] as RetryStrategy[]),
  approval: Object.freeze(['REQUEST_APPROVAL', 'ABORT'] as RetryStrategy[]),
});

const MVP_CODES_RAW: ErrorCodeDef[] = [
  {
    code: 'YJ.PROTOCOL.INVALID_ARGUMENT',
    introduced_in: '1.0', category: 'protocol', severity: 'correctable',
    retryable: false, default_retry_strategy: 'ABORT',
    user_confirmation_required: false,
    default_message_en: 'Invalid argument provided to tool.',
    default_agent_summary_en: 'Fix the arguments and retry. Do not repeat the same call.',
    default_recovery_allowed: [...RECOVERY.abort],
    default_recovery_recommended: 'ABORT',
  },
  {
    code: 'YJ.ACT.DOM_TARGET_NOT_FOUND',
    introduced_in: '1.0', category: 'action', severity: 'recoverable',
    retryable: true, default_retry_strategy: 'REOBSERVE_THEN_RETRY',
    user_confirmation_required: false,
    default_message_en: 'Selector did not match any element in the DOM.',
    default_agent_summary_en: 'Run yautja_observe with interactive profile to find the correct selector.',
    default_recovery_allowed: [...RECOVERY.reobserve],
    default_recovery_recommended: 'REOBSERVE_THEN_RETRY',
  },
  {
    code: 'YJ.ACT.DOM_TARGET_STALE',
    introduced_in: '1.0', category: 'action', severity: 'recoverable',
    retryable: true, default_retry_strategy: 'REOBSERVE_THEN_RETRY',
    user_confirmation_required: false,
    default_message_en: 'Target element changed after selector was resolved.',
    default_agent_summary_en: 'Re-observe with interactive_delta profile and resolve selector again.',
    default_recovery_allowed: [...RECOVERY.reobserve],
    default_recovery_recommended: 'REOBSERVE_THEN_RETRY',
  },
  {
    code: 'YJ.ACT.NAVIGATION_RACE',
    introduced_in: '1.0', category: 'action', severity: 'recoverable',
    retryable: true, default_retry_strategy: 'REOBSERVE_THEN_RETRY',
    user_confirmation_required: false,
    default_message_en: 'Page navigated unexpectedly during action.',
    default_agent_summary_en: 'Invalidate all selector handles and snapshots. Re-observe the new page state.',
    default_recovery_allowed: [...RECOVERY.reobserve],
    default_recovery_recommended: 'REOBSERVE_THEN_RETRY',
  },
  {
    code: 'YJ.ACT.ACTION_NOT_IDEMPOTENT',
    introduced_in: '1.0', category: 'action', severity: 'correctable',
    retryable: false, default_retry_strategy: 'ABORT',
    user_confirmation_required: false,
    default_message_en: 'Action has external side effects and no idempotency_key was provided.',
    default_agent_summary_en: 'Provide an idempotency_key before calling this action again.',
    default_recovery_allowed: [...RECOVERY.abort],
    default_recovery_recommended: 'ABORT',
  },
  {
    code: 'YJ.CAPTURE.CONTEXT_BUDGET_EXCEEDED',
    introduced_in: '1.0', category: 'capture', severity: 'recoverable',
    retryable: true, default_retry_strategy: 'REOBSERVE_THEN_RETRY',
    user_confirmation_required: false,
    default_message_en: 'Response would exceed the available context window.',
    default_agent_summary_en: 'Switch to interactive_delta or network_summary profile to reduce token cost.',
    default_recovery_allowed: [...RECOVERY.reobserve],
    default_recovery_recommended: 'REOBSERVE_THEN_RETRY',
  },
  {
    code: 'YJ.CAPTURE.WINDOW_EXPIRED',
    introduced_in: '1.0', category: 'capture', severity: 'transient',
    retryable: true, default_retry_strategy: 'RETRY_SAME',
    user_confirmation_required: false,
    default_message_en: 'Capture window expired before data was collected.',
    default_agent_summary_en: 'Re-open the capture window and retry.',
    default_recovery_allowed: [...RECOVERY.retrySame],
    default_recovery_recommended: 'RETRY_SAME',
  },
  {
    code: 'YJ.NET.REQUEST_TIMEOUT',
    introduced_in: '1.0', category: 'net', severity: 'transient',
    retryable: true, default_retry_strategy: 'RETRY_SAME',
    user_confirmation_required: false,
    default_message_en: 'Network request timed out.',
    default_agent_summary_en: 'Retry with exponential backoff.',
    default_recovery_allowed: [...RECOVERY.retrySame],
    default_recovery_recommended: 'RETRY_SAME',
  },
  {
    code: 'YJ.NET.SESSION_STATE_UNKNOWN',
    introduced_in: '1.0', category: 'net', severity: 'recoverable',
    retryable: true, default_retry_strategy: 'ROLLBACK_TO_CHECKPOINT',
    user_confirmation_required: false,
    default_message_en: 'Session state cannot be verified.',
    default_agent_summary_en: 'Restore the last known checkpoint to re-establish session integrity.',
    default_recovery_allowed: [...RECOVERY.rollback],
    default_recovery_recommended: 'ROLLBACK_TO_CHECKPOINT',
  },
  {
    code: 'YJ.POLICY.DOMAIN_PERMISSION_REQUIRED',
    introduced_in: '1.0', category: 'policy', severity: 'approval_required',
    retryable: false, default_retry_strategy: 'REQUEST_APPROVAL',
    user_confirmation_required: true,
    default_message_en: 'Domain requires explicit permission to interact.',
    default_agent_summary_en: 'Request user approval for this domain before retrying.',
    default_recovery_allowed: [...RECOVERY.approval],
    default_recovery_recommended: 'REQUEST_APPROVAL',
  },
  {
    code: 'YJ.POLICY.DRY_RUN_REQUIRED',
    introduced_in: '1.0', category: 'policy', severity: 'approval_required',
    retryable: false, default_retry_strategy: 'REQUEST_APPROVAL',
    user_confirmation_required: true,
    default_message_en: 'Action requires a dry-run preview before execution.',
    default_agent_summary_en: 'Run with dry_run=true first to preview impact, then request approval.',
    default_recovery_allowed: [...RECOVERY.approval],
    default_recovery_recommended: 'REQUEST_APPROVAL',
  },
  {
    code: 'YJ.OPSEC.ANOMALY_RISK_ELEVATED',
    introduced_in: '1.0', category: 'opsec', severity: 'terminal',
    retryable: false, default_retry_strategy: 'ABORT',
    user_confirmation_required: true,
    default_message_en: 'Anomaly risk elevated — operational posture may be compromised.',
    default_agent_summary_en: 'Abort immediately. Preserve all evidence. Escalate to human operator. Do not auto-recover.',
    default_recovery_allowed: [...RECOVERY.abort],
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
    default_recovery_allowed: [...RECOVERY.rollback],
    default_recovery_recommended: 'ROLLBACK_TO_CHECKPOINT',
  },
  {
    code: 'YJ.ACT.TYPE_REJECTED',
    introduced_in: '1.1', category: 'action', severity: 'correctable',
    retryable: false, default_retry_strategy: 'REOBSERVE_THEN_RETRY',
    user_confirmation_required: false,
    default_message_en: 'Target element refused the typed input.',
    default_agent_summary_en: 'Inspect the DOM (inspect dom) and retry with an alternate selector or query.',
    default_recovery_allowed: [...RECOVERY.reobserve],
    default_recovery_recommended: 'REOBSERVE_THEN_RETRY',
  },
  {
    code: 'YJ.ACT.TYPE_RETRY_BLOCKED',
    introduced_in: '1.1', category: 'action', severity: 'correctable',
    retryable: false, default_retry_strategy: 'ROLLBACK_TO_CHECKPOINT',
    user_confirmation_required: false,
    default_message_en: 'A recent TYPE_PARTIAL failure on this selector blocks blind retry.',
    default_agent_summary_en: 'Call ensureEmpty on the selector (or reload the tab) before typing again. Blind retry is blocked for 30s after a partial type.',
    default_recovery_allowed: [...RECOVERY.rollback],
    default_recovery_recommended: 'ROLLBACK_TO_CHECKPOINT',
  },
  {
    code: 'YJ.ACT.INPUT_NOT_CLEARABLE',
    introduced_in: '1.1', category: 'action', severity: 'recoverable',
    retryable: false, default_retry_strategy: 'ROLLBACK_TO_CHECKPOINT',
    user_confirmation_required: false,
    default_message_en: 'Input could not be emptied with any available strategy.',
    default_agent_summary_en: 'Reload the tab (act navigate) and retry. The element likely re-renders from framework state.',
    default_recovery_allowed: [...RECOVERY.rollback],
    default_recovery_recommended: 'ROLLBACK_TO_CHECKPOINT',
  },
  {
    code: 'YJ.ACT.SUBMIT_NO_EFFECT',
    introduced_in: '1.1', category: 'action', severity: 'recoverable',
    retryable: true, default_retry_strategy: 'REOBSERVE_THEN_RETRY',
    user_confirmation_required: false,
    default_message_en: 'Submit (Enter) had no observable effect on the target input.',
    default_agent_summary_en: 'Use findClick on the send button instead of Enter, or waitForUi (P12) for the response container.',
    default_recovery_allowed: [...RECOVERY.reobserve],
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
    default_recovery_allowed: [...RECOVERY.reobserve],
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
    default_recovery_allowed: [...RECOVERY.approval],
    default_recovery_recommended: 'REQUEST_APPROVAL',
  },
  {
    code: 'YJ.OPSEC.CAPTCHA_DETECTED',
    introduced_in: '1.3', category: 'opsec', severity: 'terminal',
    retryable: false, default_retry_strategy: 'ABORT',
    user_confirmation_required: true,
    default_message_en: 'A CAPTCHA/anti-bot challenge is present on the page.',
    default_agent_summary_en: 'Stop immediately. Do NOT attempt to solve, retry, or route around the challenge. Hand over to the human operator.',
    default_recovery_allowed: [...RECOVERY.abort],
    default_recovery_recommended: 'ABORT',
  },
  {
    code: 'YJ.POLICY.GATE_DENIED',
    introduced_in: '1.3', category: 'policy', severity: 'correctable',
    retryable: false, default_retry_strategy: 'REQUEST_APPROVAL',
    user_confirmation_required: false,
    default_message_en: 'Action denied by the active site profile policy.',
    default_agent_summary_en: 'The site profile for this domain forbids this action (e.g. intercept: forbid, denied URL pattern). Respect it or ask the user to change the profile.',
    default_recovery_allowed: [...RECOVERY.approval],
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
    default_recovery_allowed: [...RECOVERY.reobserve],
    default_recovery_recommended: 'REOBSERVE_THEN_RETRY',
  },
  // ─── P14.1: session plans + kill switches ──────────────────
  {
    code: 'YJ.POLICY.PLAN_NOT_FOUND',
    introduced_in: '1.7', category: 'policy', severity: 'correctable',
    retryable: false, default_retry_strategy: 'ABORT',
    user_confirmation_required: false,
    default_message_en: 'No pending plan to approve.',
    default_agent_summary_en: 'Propose a plan first with plan_propose (items + domains + requestedLevel), present it to the user, and only call plan_approve after their explicit approval.',
    default_recovery_allowed: [...RECOVERY.abort],
    default_recovery_recommended: 'ABORT',
  },
  {
    code: 'YJ.POLICY.FEATURE_DISABLED',
    introduced_in: '1.7', category: 'policy', severity: 'correctable',
    retryable: false, default_retry_strategy: 'ABORT',
    user_confirmation_required: false,
    default_message_en: 'Feature disabled by a kill switch in chrome.storage.local.',
    default_agent_summary_en: 'The feature is disabled via its kill switch key in chrome.storage.local. Do NOT retry in a loop: ask the user to re-enable it (set the key to true) or use an alternative tool.',
    default_recovery_allowed: [...RECOVERY.abort],
    default_recovery_recommended: 'ABORT',
  },
  // ─── P16: trusted gestures ─────────────────────────────────
  {
    code: 'YJ.PROTOCOL.CAPABILITY_MISSING',
    introduced_in: '1.6', category: 'protocol', severity: 'correctable',
    retryable: false, default_retry_strategy: 'ABORT',
    user_confirmation_required: false,
    default_message_en: 'The current backend cannot perform this action (missing capability).',
    default_agent_summary_en: 'The action requires a capability this backend lacks (e.g. trusted file chooser). Delegate to an alternative backend (e.g. SuperAPI file_upload) or use a human hand-off. Do NOT report fake success.',
    default_recovery_allowed: [...RECOVERY.abort],
    default_recovery_recommended: 'ABORT',
  },
  // ─── Extension link watchdog ───────────────────────────────
  {
    code: 'YJ.NET.EXTENSION_LINK_DEGRADED',
    introduced_in: '1.8', category: 'net', severity: 'recoverable',
    retryable: true, default_retry_strategy: 'RETRY_SAME',
    user_confirmation_required: false,
    default_message_en: 'Extension link degraded: consecutive command timeouts (extension handlers stuck, likely against a busy renderer).',
    default_agent_summary_en: 'Automatic recovery is in progress (socket closed, extension reconnects, health probe). Retry in a few seconds; do NOT stack commands meanwhile.',
    default_recovery_allowed: [...RECOVERY.retrySame],
    default_recovery_recommended: 'RETRY_SAME',
  },
  // ─── Sentinel: registry miss ────────────────────────────────
  {
    code: UNKNOWN_ERROR_CODE,
    introduced_in: '1.9', category: 'protocol', severity: 'terminal',
    retryable: false, default_retry_strategy: 'ABORT',
    user_confirmation_required: true,
    default_message_en: 'Unknown error code passed to the registry.',
    default_agent_summary_en: 'A tool or layer raised an error code that is not registered. This is a bug — report it. Do not retry.',
    default_recovery_allowed: [...RECOVERY.abort],
    default_recovery_recommended: 'ABORT',
  },
];

const CODE_PATTERN = /^YJ\.[A-Z]+\.[A-Z_]+$/;
const VERSION_PATTERN = /^\d+(\.\d+)*$/;

/**
 * Validates the registry at module load. Throws a descriptive `Error` (with
 * `cause`) if any entry violates a contract that the type system cannot
 * enforce (e.g. recommended ∈ allowed, non-empty messages, unique codes).
 *
 * Invariants covered:
 *  1. code matches `YJ.FAMILY.NAME`
 *  2. introduced_in is a dot-separated numeric version
 *  3. terminal ⇒ retryable=false
 *  4. correctable ⇒ retryable=false
 *  5. approval_required ⇒ user_confirmation_required=true
 *  6. transient ⇒ retryable=true
 *  7. default_recovery_recommended ∈ default_recovery_allowed
 *  8. default_retry_strategy ∈ default_recovery_allowed
 *  9. default_message_en and default_agent_summary_en are non-empty
 * 10. codes are unique
 */
function assertInvariants(codes: readonly ErrorCodeDef[]): void {
  const seen = new Set<string>();
  for (const def of codes) {
    if (!CODE_PATTERN.test(def.code)) {
      throw new Error(`registry invariant: code ${def.code} does not match YJ.FAMILY.NAME`);
    }
    if (!VERSION_PATTERN.test(def.introduced_in)) {
      throw new Error(`registry invariant: ${def.code} introduced_in="${def.introduced_in}" is not a valid version`);
    }
    if (seen.has(def.code)) {
      throw new Error(`registry invariant: duplicate code ${def.code}`);
    }
    seen.add(def.code);
    if (def.severity === 'terminal' && def.retryable) {
      throw new Error(`registry invariant: ${def.code} is terminal but retryable=true`);
    }
    if (def.severity === 'correctable' && def.retryable) {
      throw new Error(`registry invariant: ${def.code} is correctable but retryable=true`);
    }
    if (def.severity === 'approval_required' && !def.user_confirmation_required) {
      throw new Error(`registry invariant: ${def.code} is approval_required but user_confirmation_required=false`);
    }
    if (def.severity === 'transient' && !def.retryable) {
      throw new Error(`registry invariant: ${def.code} is transient but retryable=false`);
    }
    if (!def.default_recovery_allowed.includes(def.default_recovery_recommended)) {
      throw new Error(`registry invariant: ${def.code} recommended=${def.default_recovery_recommended} not in allowed=[${def.default_recovery_allowed.join(',')}]`);
    }
    if (!def.default_recovery_allowed.includes(def.default_retry_strategy)) {
      throw new Error(`registry invariant: ${def.code} retry_strategy=${def.default_retry_strategy} not in allowed=[${def.default_recovery_allowed.join(',')}]`);
    }
    if (def.default_message_en.trim() === '' || def.default_agent_summary_en.trim() === '') {
      throw new Error(`registry invariant: ${def.code} has empty default_message_en or default_agent_summary_en`);
    }
  }
}

// Module-load invariants (throws on malformed registry; survives frozensharing).
for (const [code, message] of Object.entries({
  EXTENSION_DISCONNECTED: 'Browser extension is disconnected.',
  BROKER_DISCONNECTED: 'Browser broker is disconnected.',
  EXTENSION_LINK_DEGRADED: 'Browser link is degraded.',
  TAB_OWNED_BY_OTHER_SESSION: 'Target belongs to another session.',
  TARGET_MISSING: 'Selected target is missing.',
  TARGET_MISMATCH: 'Operation target changed.',
  TARGET_UNVERIFIED: 'Target could not be verified.',
  STALE_GENERATION: 'Connection generation changed.',
  OPERATION_TIMEOUT: 'Operation deadline exceeded.',
  OPERATION_CANCELLED: 'Operation cancelled.',
  OPERATION_ENDED: 'Operation has ended.',
  OUTCOME_UNKNOWN: 'A dispatched mutation has an unknown outcome; verify before repeating.',
})) {
  MVP_CODES_RAW.push({
    code: `YJ.RUNTIME.${code}`, introduced_in: '2.0', category: 'action', severity: 'recoverable',
    retryable: false, default_retry_strategy: 'ABORT', user_confirmation_required: false,
    default_message_en: message, default_agent_summary_en: message,
    default_recovery_allowed: [...RECOVERY.abort], default_recovery_recommended: 'ABORT',
  });
}
assertInvariants(MVP_CODES_RAW);

/**
 * Deeply immutable registry of every registered YJ code. Each entry is frozen
 * so the type lie (`as const` only freezes the type, not the runtime value)
 * cannot let a stray `MVP_CODES[i].retryable = true` corrupt the catalog.
 */
export const MVP_CODES: readonly ErrorCodeDef[] = Object.freeze(
  MVP_CODES_RAW.map(def => Object.freeze({
    ...def,
    default_recovery_allowed: Object.freeze([...def.default_recovery_allowed]),
  })),
);

/**
 * Read-only lookup table for registered codes. Built once at module load and
 * frozen so callers cannot mutate it.
 */
export const REGISTRY: ReadonlyMap<string, ErrorCodeDef> = Object.freeze(
  new Map(MVP_CODES.map(def => [def.code, def])),
);

/**
 * Returns the registered definition for a code, or `undefined` if the code is
 * unknown. The input is canonicalized: trimmed and uppercased so callers do
 * not silently miss on `YJ.act.dom_target_stale` style typos.
 */
export function lookupCode(code: string): ErrorCodeDef | undefined {
  if (typeof code !== 'string' || code.length === 0) return undefined;
  return REGISTRY.get(code.trim().toUpperCase());
}

/**
 * Returns all codes in a given category. The return type is `readonly` so
 * callers cannot accidentally mutate the registry through the returned array.
 * Unknown categories yield `[]`.
 */
export function codesInFamily(category: ErrorCategory): readonly ErrorCodeDef[] {
  return Object.freeze(MVP_CODES.filter(def => def.category === category));
}

/**
 * Validates the shape of a caller-supplied `overrides.recovery` block.
 * Must contain a non-empty `allowed` list and a `recommended` strategy that
 * is in `allowed`. Throws `TypeError` on violation. Exposed for reuse by
 * tooling that wants to validate before calling `toYautjaError`.
 */
export function validateRecoveryOverride(recovery: RecoveryHint): void {
  if (!Array.isArray(recovery.allowed) || recovery.allowed.length === 0) {
    throw new TypeError('override.recovery.allowed must be a non-empty array');
  }
  if (!recovery.allowed.includes(recovery.recommended)) {
    throw new TypeError(
      `override.recovery.recommended=${recovery.recommended} must be in allowed=[${recovery.allowed.join(',')}]`,
    );
  }
}

/**
 * Builds a fully-populated `YautjaError` from a registered code. If the
 * code is unknown, recurses on the typed `UNKNOWN_ERROR_CODE` sentinel so
 * callers always receive a typed `YautjaError` and never a bare `Error`.
 *
 * @param code       YJ.<FAMILY>.<NAME> code.
 * @param overrides  Optional per-call overrides for `message`, `agent_summary`,
 *                   or `recovery`. Overrides are validated at the boundary.
 * @throws TypeError if `overrides.recovery` is malformed.
 */
export function toYautjaError(
  code: string,
  overrides?: Partial<Pick<YautjaError, 'message' | 'agent_summary' | 'recovery'>>,
): YautjaError {
  const def = lookupCode(code);
  if (!def) {
    if (code === UNKNOWN_ERROR_CODE) {
      // Recursion safety: if UNKNOWN_ERROR_CODE itself is missing, the registry is broken.
      throw new Error('registry invariant: UNKNOWN_ERROR_CODE is not registered');
    }
    return toYautjaError(UNKNOWN_ERROR_CODE, {
      message: `Unknown error code: ${code}.`,
      agent_summary: `The code "${code}" is not in the registry. Report it as a bug.`,
    });
  }
  if (overrides?.recovery) {
    validateRecoveryOverride(overrides.recovery);
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
      allowed: [...def.default_recovery_allowed],
      recommended: def.default_recovery_recommended,
      next_tool_call: null,
    },
  };
}
