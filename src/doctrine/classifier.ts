import type { ArsenalError, ArsenalErrorType } from '../arsenal/errors.js';
import type { YautjaError } from './types.js';
import { toYautjaError } from './registry.js';

const LEGACY_MAP: Record<ArsenalErrorType, string> = {
  SELECTOR_NOT_FOUND: 'YJ.ACT.DOM_TARGET_NOT_FOUND',
  SELECTOR_NOT_VISIBLE: 'YJ.ACT.DOM_TARGET_NOT_FOUND',
  ELEMENT_NOT_INTERACTABLE: 'YJ.ACT.DOM_TARGET_STALE',
  NAVIGATION_TIMEOUT: 'YJ.NET.REQUEST_TIMEOUT',
  JS_EVALUATION_ERROR: 'YJ.PROTOCOL.INVALID_ARGUMENT',
  ACTION_PRECONDITION: 'YJ.PROTOCOL.INVALID_ARGUMENT',
  CDP_COMMAND_FAILED: 'YJ.NET.REQUEST_TIMEOUT',
  NOT_CONNECTED: 'YJ.NET.SESSION_STATE_UNKNOWN',
  TIMEOUT: 'YJ.NET.REQUEST_TIMEOUT',
  INVALID_ARGUMENT: 'YJ.PROTOCOL.INVALID_ARGUMENT',
  UNSUPPORTED_ACTION: 'YJ.PROTOCOL.INVALID_ARGUMENT',
  STORAGE_ERROR: 'YJ.NET.SESSION_STATE_UNKNOWN',
  PERMISSION_DENIED: 'YJ.POLICY.DOMAIN_PERMISSION_REQUIRED',
  UNKNOWN_ERROR: 'YJ.PROTOCOL.INVALID_ARGUMENT',
};

export function classifyLegacyError(legacy: ArsenalError): YautjaError {
  const targetCode = LEGACY_MAP[legacy.type] ?? 'YJ.PROTOCOL.INVALID_ARGUMENT';
  const isUnclassified = legacy.type === 'UNKNOWN_ERROR';

  return toYautjaError(targetCode, {
    message: legacy.message,
    agent_summary: isUnclassified
      ? `LEGACY_ERROR_UNCLASSIFIED: original type was UNKNOWN_ERROR. ${legacy.recoveryHint ?? 'Inspect the error message for clues.'}`
      : undefined,
  });
}