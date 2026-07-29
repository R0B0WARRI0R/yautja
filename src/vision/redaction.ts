/**
 * Redacción de campos sensibles en la percepción DOM (quick win — RE de
 * Claude in Chrome): antes de que el `value` de un input llegue a la salida
 * hacia el LLM, los campos sensibles se sustituyen por `[value redacted]`.
 *
 * El predicado `isSensitiveElement` es puro y testeable. El script inyectado
 * de `em.ts` (EXTRACTION_SCRIPT) duplica la misma lógica inline porque no
 * puede importar módulos en el contexto de la página — mantener ambos en
 * sync (SENSITIVE_TYPES / SENSITIVE_AUTOCOMPLETE_TOKENS).
 */

export const REDACTED_VALUE = '[value redacted]';

const SENSITIVE_TYPES = new Set(['password', 'hidden']);

const SENSITIVE_AUTOCOMPLETE_TOKENS = [
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
];

export interface SensitiveElementAttrs {
  type?: string | null;
  autocomplete?: string | null;
}

/**
 * true si el elemento es un campo cuyo valor no debe serializarse:
 * `type` password/hidden, o un `autocomplete` (lowercase) que contenga
 * alguno de los tokens sensibles (passwords, OTPs, tarjetas).
 */
export function isSensitiveElement(attrs: SensitiveElementAttrs): boolean {
  const type = (attrs.type ?? '').toLowerCase();
  if (SENSITIVE_TYPES.has(type)) return true;
  const autocomplete = (attrs.autocomplete ?? '').toLowerCase();
  if (!autocomplete) return false;
  return SENSITIVE_AUTOCOMPLETE_TOKENS.some((token) => autocomplete.includes(token));
}

/** Devuelve REDACTED_VALUE si el elemento es sensible; el valor original en caso contrario. */
export function redactValue(attrs: SensitiveElementAttrs, value: string): string {
  return isSensitiveElement(attrs) ? REDACTED_VALUE : value;
}
