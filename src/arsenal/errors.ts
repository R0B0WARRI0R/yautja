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
  | 'SCREENSHOT_TOO_LARGE'
  | 'REF_NOT_FOUND'
  | 'TAB_OUTSIDE_GROUP'
  | 'TAB_OWNED_BY_OTHER_SESSION'
  | 'FEATURE_DISABLED'
  | 'EXTENSION_LINK_DEGRADED'
  | 'UNKNOWN_ERROR';

export interface ArsenalError {
  type: ArsenalErrorType;
  message: string;
  recoverable: boolean;
  recoveryHint?: string;
  /**
   * Acción exacta de recuperación (estilo auto-guiado de Claude in Chrome,
   * p.ej. "element gone → call read_page without ref_id"). Aditivo: los
   * consumidores existentes de `recoveryHint` no se ven afectados; ambos
   * campos se pueblan con el mismo texto.
   */
  hint?: string;
}

/**
 * Hints por defecto por tipo de error. Un hint explícito en `makeError`
 * tiene prioridad sobre el default.
 */
const DEFAULT_HINTS: Partial<Record<ArsenalErrorType, string>> = {
  SELECTOR_NOT_FOUND:
    'Usa findElement con una descripción textual, o observe para ver el estado actual de la página',
  JS_EVALUATION_ERROR:
    'Revisa la sintaxis de la expresión; prueba con returnByValue y un snippet mínimo para aislar el fallo',
  CDP_COMMAND_FAILED:
    'Reintentar tras reattach; si persiste, observe para re-sincronizar estado',
  SCREENSHOT_TOO_LARGE:
    'Usa clip o screenshotZoom para recortar la región, o format jpeg con quality menor',
  REF_NOT_FOUND:
    'El elemento ya no existe o cambió; llama a observe para obtener refs frescas',
  TAB_OUTSIDE_GROUP:
    'Solo se pueden cerrar pestañas del grupo de sesión; usa switchTab para las del usuario o force: true si de verdad quieres cerrarla',
  TAB_OWNED_BY_OTHER_SESSION:
    'La tab pertenece al grupo de otra sesión; usa tu propio grupo (sessionGroupCreate) o pide handoff al broker — no reintentes sobre la misma tab',
  FEATURE_DISABLED:
    'La feature está desactivada por su kill switch en chrome.storage.local; pide al usuario que la reactive (clave a true) o usa una tool alternativa — no reintentar en bucle',
  EXTENSION_LINK_DEGRADED:
    'Enlace extensión degradado; recuperación automática en curso — reintenta en unos segundos. No apiles comandos mientras tanto',
};

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
    SCREENSHOT_TOO_LARGE: true,
    REF_NOT_FOUND: true,
    TAB_OUTSIDE_GROUP: false,
    TAB_OWNED_BY_OTHER_SESSION: false,
    FEATURE_DISABLED: false,
    EXTENSION_LINK_DEGRADED: true,
    UNKNOWN_ERROR: false,
  };
  const effectiveHint = hint ?? DEFAULT_HINTS[type];
  return {
    type,
    message,
    recoverable: recoverableMap[type],
    recoveryHint: effectiveHint,
    hint: effectiveHint,
  };
}

import { classifyLegacyError } from '../doctrine/classifier.js';
import type { YautjaError } from '../doctrine/types.js';

export function arsenalToDoctrine(err: ArsenalError): YautjaError {
  return classifyLegacyError(err);
}