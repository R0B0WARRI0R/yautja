/**
 * Kill switches por feature (patrón de `yjStripInterference`): flags en
 * chrome.storage.local de la extensión Yautja Bridge, leídos vía el comando
 * `storageGet` del service worker. Solo un false explícito desactiva la
 * feature; errores de lectura son fail-open (devuelven el default: un fallo
 * de storage no debe tumbar features defensivas ni bloquear al usuario).
 *
 * Caché en memoria (5s por defecto, por clave) para no martillear
 * storageGet en bucles (p.ej. acciones repetidas en la misma sesión).
 * Los fallos de lectura NO se cachean.
 *
 * Switches activos:
 *   yjStripInterference  default true  strip de iframes de extensiones
 *                                      ajenas antes de screenshots
 *                                      (src/arsenal/strip-interference.ts)
 *   yjBrowserBatch       default true  tool browser_batch (P9); si false,
 *                                      la tool devuelve YJ.POLICY.FEATURE_DISABLED
 *   yjSessionRecorder    default true  tool session_record (T12); si false,
 *                                      la tool devuelve YJ.POLICY.FEATURE_DISABLED
 *   yjMacroRecord        default true  tool macro_record (T13); si false,
 *                                      la tool devuelve YJ.POLICY.FEATURE_DISABLED
 *   yjSessionScheduler   default true  tool session_schedule (T14A) y la
 *                                      ejecución de jobs programados
 */

/** Mínimo interfaz para leer flags (ExtensionServer.storageGet). */
export interface StorageReader {
  storageGet(key: string): Promise<any>;
}

export const KILL_SWITCH_CACHE_TTL_MS = 5_000;

export const BROWSER_BATCH_KILL_SWITCH_KEY = 'yjBrowserBatch';

export const SESSION_RECORDER_KILL_SWITCH_KEY = 'yjSessionRecorder';

export const MACRO_RECORD_KILL_SWITCH_KEY = 'yjMacroRecord';

export const SESSION_SCHEDULER_KILL_SWITCH_KEY = 'yjSessionScheduler';

const cache = new Map<string, { value: boolean; at: number }>();

export interface FeatureFlagOptions {
  /** Valor cuando la clave no existe o no es booleana. Default true. */
  default?: boolean;
  /** TTL de la caché en ms (0 la desactiva). Default 5s. */
  ttlMs?: number;
  /** Reloj inyectable (tests). */
  now?: () => number;
}

/**
 * ¿Feature activada? Lee `key` de chrome.storage.local con caché corto.
 * Semántica: boolean explícito manda; ausente/no-boolean → default;
 * error de lectura → default (fail-open, sin cachear).
 */
export async function isFeatureEnabled(
  storage: StorageReader,
  key: string,
  opts: FeatureFlagOptions = {},
): Promise<boolean> {
  const def = opts.default ?? true;
  const ttl = opts.ttlMs ?? KILL_SWITCH_CACHE_TTL_MS;
  const now = opts.now ?? Date.now;

  const hit = cache.get(key);
  if (hit && ttl > 0 && now() - hit.at < ttl) return hit.value;

  let value: boolean;
  try {
    const raw = await storage.storageGet(key);
    value = typeof raw === 'boolean' ? raw : def;
  } catch {
    return def; // fail-open, no se cachea
  }
  cache.set(key, { value, at: now() });
  return value;
}

/** Vacía la caché de kill switches (tests; la caché es module-global). */
export function clearKillSwitchCache(): void {
  cache.clear();
}
