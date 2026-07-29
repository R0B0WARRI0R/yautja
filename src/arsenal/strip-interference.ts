/**
 * Strip de iframes de extensiones ajenas (estilo cicStripExtensionInterference
 * de Claude in Chrome): antes de acciones trusted y screenshots se eliminan
 * del DOM los iframes inyectados por OTRAS extensiones, que pueden tapar
 * elementos (clicks erróneos) o salir en la captura.
 *
 * Kill switch: clave `yjStripInterference` en chrome.storage.local de la
 * extensión Yautja Bridge. Default true; si vale false, el strip es no-op.
 * Se lee vía el helper generalizado de kill switches (arsenal/kill-switch.ts).
 *
 * Errores del strip: NO fatales — el caller loguea y continúa (la acción
 * principal manda).
 */

import { isFeatureEnabled } from './kill-switch.js';

/** Re-export por compatibilidad (la interfaz vive en kill-switch.ts). */
export type { StorageReader } from './kill-switch.js';

import type { StorageReader } from './kill-switch.js';

export interface Transport {
  send(method: string, params?: Record<string, any>): Promise<any>;
}

export interface StripResult {
  removed: number;
  hosts: string[];
}

export const STRIP_KILL_SWITCH_KEY = 'yjStripInterference';

/**
 * Genera el script in-page: busca iframes chrome-extension:// cuyo id de
 * extensión ≠ selfExtId, los elimina y devuelve {removed, hosts}.
 * Función pura para tests.
 */
export function buildStripInterferenceScript(selfExtId: string): string {
  return `(() => {
  const SELF = ${JSON.stringify(selfExtId)};
  const removed = [];
  for (const f of document.querySelectorAll('iframe[src^="chrome-extension://"]')) {
    const m = /^chrome-extension:\\/\\/([^/]+)/.exec(f.src || '');
    const host = m ? m[1] : '';
    if (host && host !== SELF) {
      removed.push(host);
      f.remove();
    }
  }
  return { removed: removed.length, hosts: removed };
})()`;
}

/** Parsea el resultado del evaluate; tolerante con payloads raros. */
export function parseStripResult(raw: unknown): StripResult {
  if (!raw || typeof raw !== 'object') return { removed: 0, hosts: [] };
  const r = raw as Record<string, any>;
  return {
    removed: typeof r.removed === 'number' ? r.removed : 0,
    hosts: Array.isArray(r.hosts) ? r.hosts.filter((h) => typeof h === 'string') : [],
  };
}

/**
 * Kill switch: lee `yjStripInterference` de chrome.storage.local vía el
 * helper generalizado (default true, fail-open, caché corto de 5s).
 */
export async function isStripInterferenceEnabled(storage: StorageReader): Promise<boolean> {
  return isFeatureEnabled(storage, STRIP_KILL_SWITCH_KEY);
}

/**
 * Ejecuta el strip vía Runtime.evaluate. Nunca lanza: ante cualquier fallo
 * devuelve {removed: 0, hosts: []} (no fatal por diseño).
 */
export async function stripInterference(transport: Transport, selfExtId: string): Promise<StripResult> {
  try {
    const result = await transport.send('Runtime.evaluate', {
      expression: buildStripInterferenceScript(selfExtId),
      returnByValue: true,
    });
    if (result?.exceptionDetails) return { removed: 0, hosts: [] };
    return parseStripResult(result?.result?.value);
  } catch {
    return { removed: 0, hosts: [] };
  }
}
