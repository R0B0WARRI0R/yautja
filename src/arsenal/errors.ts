export type ArsenalErrorType =
  | 'SELECTOR_NOT_FOUND'
  | 'SELECTOR_NOT_VISIBLE'
  | 'ELEMENT_NOT_INTERACTABLE'
  | 'NAVIGATION_TIMEOUT'
  | 'JS_EVALUATION_ERROR'
  | 'ACTION_PRECONDITION'
  | 'CDP_COMMAND_FAILED'
  | 'NOT_CONNECTED'
  | 'TIMEOUT'
  | 'INVALID_ARGUMENT'
  | 'UNSUPPORTED_ACTION'
  | 'STORAGE_ERROR'
  | 'PERMISSION_DENIED'
  | 'UNKNOWN_ERROR';

export interface ArsenalError {
  type: ArsenalErrorType;
  message: string;
  recoverable: boolean;
  recoveryHint?: string;
}

export function makeError(type: ArsenalErrorType, message: string, hint?: string): ArsenalError {
  const recoverableMap: Record<ArsenalErrorType, boolean> = {
    SELECTOR_NOT_FOUND: false,
    SELECTOR_NOT_VISIBLE: false,
    ELEMENT_NOT_INTERACTABLE: true,
    NAVIGATION_TIMEOUT: true,
    JS_EVALUATION_ERROR: false,
    ACTION_PRECONDITION: false,
    CDP_COMMAND_FAILED: true,
    NOT_CONNECTED: false,
    TIMEOUT: true,
    INVALID_ARGUMENT: false,
    UNSUPPORTED_ACTION: false,
    STORAGE_ERROR: false,
    PERMISSION_DENIED: false,
    UNKNOWN_ERROR: false,
  };
  return {
    type,
    message,
    recoverable: recoverableMap[type],
    recoveryHint: hint,
  };
}