/**
 * `form_input` (estilo Claude in Chrome — RE ítem 7): establece el valor de un
 * campo de formulario ramificando por tipo de elemento (select, checkbox,
 * radio, date/week/month/time, range, texto/contenteditable) en un único
 * script inyectado atómico. Dispara focus() + input + change (bubbles) y
 * devuelve `{ previous, new }` — redactados si el campo es sensible.
 *
 * El script no puede importar módulos en el contexto de la página, así que el
 * detector de campos sensibles está duplicado inline — keep in sync con
 * src/vision/redaction.ts. La resolución por `ref` usa el element map de
 * src/vision/element-map.ts.
 */

import { REDACTED_VALUE } from '../vision/redaction.js';

export interface FormInputTarget {
  selector?: string;
  ref?: string;
  value: string | boolean | number;
}

export type FormInputFailure =
  | { ok: false; error: 'REF_NOT_FOUND' }
  | { ok: false; error: 'NOT_FOUND' }
  | { ok: false; error: 'NOT_INPUT' }
  | { ok: false; error: 'BAD_VALUE'; expected: string; inputType: string }
  | { ok: false; error: 'NO_OPTION'; options: string[] };

export interface FormInputValue {
  previous: string | boolean;
  new: string | boolean;
  sensitive: boolean;
  tag: string;
  inputType: string;
  /** name del grupo (solo radios). */
  group?: string;
}

export type FormInputOutcome = FormInputFailure | { ok: true; value: FormInputValue };

export function buildFormInputScript(target: FormInputTarget): string {
  const valueJson = JSON.stringify(target.value);
  const resolveBlock = target.ref
    ? `var map = window.__yjElementMap || {};
  var wr = map[${JSON.stringify(target.ref)}];
  var el = wr && wr.deref ? wr.deref() : null;
  if (!el || !document.contains(el)) {
    if (map[${JSON.stringify(target.ref)}]) delete map[${JSON.stringify(target.ref)}];
    return JSON.stringify({ error: 'REF_NOT_FOUND' });
  }`
    : `var el = document.querySelector(${JSON.stringify(target.selector ?? '')});
  if (!el) return JSON.stringify({ error: 'NOT_FOUND' });`;

  return `(function() {
  ${resolveBlock}
  // Sensitive-field detector — keep in sync with src/vision/redaction.ts.
  var sensitive = (function() {
    var t = (el.type || (el.getAttribute ? el.getAttribute('type') : '') || '').toString().toLowerCase();
    if (t === 'password' || t === 'hidden') return true;
    var ac = ((el.getAttribute ? el.getAttribute('autocomplete') : '') || '').toLowerCase();
    if (!ac) return false;
    var tokens = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year'];
    return tokens.some(function(tok) { return ac.indexOf(tok) !== -1; });
  })();
  var REDACTED = ${JSON.stringify(REDACTED_VALUE)};
  var tag = el.tagName ? el.tagName.toUpperCase() : '';
  var itype = (el.type || (el.getAttribute ? el.getAttribute('type') : '') || tag.toLowerCase()).toString().toLowerCase();
  var value = ${valueJson};
  function badValue(expected) {
    return JSON.stringify({ error: 'BAD_VALUE', expected: expected, inputType: itype });
  }
  var previous; var next; var group;
  if (tag === 'SELECT') {
    if (typeof value !== 'string') return badValue('string');
    previous = el.value;
    var found = null; var avail = [];
    for (var i = 0; i < el.options.length; i++) {
      avail.push(el.options[i].value);
      if (!found && (el.options[i].value === value || el.options[i].text === value)) found = el.options[i];
    }
    if (!found) return JSON.stringify({ error: 'NO_OPTION', options: avail.slice(0, 20) });
    el.value = found.value;
    next = el.value;
  } else if (tag === 'INPUT' && itype === 'checkbox') {
    if (typeof value !== 'boolean') return badValue('boolean');
    previous = el.checked;
    el.checked = value;
    next = el.checked;
  } else if (tag === 'INPUT' && itype === 'radio') {
    previous = el.checked;
    el.checked = true;
    next = el.checked;
    group = el.name || '';
  } else if (tag === 'INPUT' && (itype === 'date' || itype === 'week' || itype === 'month' || itype === 'time')) {
    if (typeof value !== 'string') return badValue('string');
    previous = el.value;
    el.value = value;
    next = el.value;
  } else if (tag === 'INPUT' && itype === 'range') {
    if (typeof value !== 'number' || isNaN(value)) return badValue('number');
    previous = el.value;
    el.value = String(value);
    next = el.value;
  } else {
    if (typeof value !== 'string') return badValue('string');
    var isCE = el.isContentEditable || (el.getAttribute && el.getAttribute('contenteditable') === 'true');
    if (isCE) {
      previous = el.innerText || el.textContent || '';
      el.textContent = value;
      next = el.textContent;
    } else if (el.value !== undefined) {
      previous = String(el.value);
      el.value = value;
      next = el.value;
    } else {
      return JSON.stringify({ error: 'NOT_INPUT' });
    }
  }
  try { el.focus(); } catch (e) {}
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({
    ok: true,
    previous: sensitive ? REDACTED : previous,
    new: sensitive ? REDACTED : next,
    sensitive: sensitive,
    tag: tag,
    inputType: itype,
    group: group,
  });
})()`;
}

/**
 * Parsea la salida JSON del script. Defensa en profundidad: si el campo es
 * sensible, los valores se fuerzan a REDACTED_VALUE también en Node (igual
 * que hace ensure-empty con el residual).
 */
export function parseFormInputResult(raw: unknown): FormInputOutcome {
  if (typeof raw !== 'string' || raw === '') return { ok: false, error: 'NOT_FOUND' };
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'NOT_FOUND' };
  }
  if (parsed?.ok === true) {
    const sensitive = parsed.sensitive === true;
    return {
      ok: true,
      value: {
        previous: sensitive ? REDACTED_VALUE : parsed.previous,
        new: sensitive ? REDACTED_VALUE : parsed.new,
        sensitive,
        tag: String(parsed.tag ?? ''),
        inputType: String(parsed.inputType ?? ''),
        group: typeof parsed.group === 'string' ? parsed.group : undefined,
      },
    };
  }
  switch (parsed?.error) {
    case 'REF_NOT_FOUND':
      return { ok: false, error: 'REF_NOT_FOUND' };
    case 'NO_OPTION':
      return { ok: false, error: 'NO_OPTION', options: Array.isArray(parsed.options) ? parsed.options.slice(0, 20).map(String) : [] };
    case 'BAD_VALUE':
      return { ok: false, error: 'BAD_VALUE', expected: String(parsed.expected ?? ''), inputType: String(parsed.inputType ?? '') };
    case 'NOT_INPUT':
      return { ok: false, error: 'NOT_INPUT' };
    default:
      return { ok: false, error: 'NOT_FOUND' };
  }
}
