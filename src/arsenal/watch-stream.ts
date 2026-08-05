/**
 * watch-stream (P17, fase A) — stream-complete detector con observer de 2 fases.
 *
 * En vez de hacer snapshots del texto en cada poll (como textSettled), se
 * inyecta UNA vez en la página un MutationObserver de 2 fases:
 *   - fase 1 (armed): aparece texto en el contenedor de la respuesta
 *   - fase 2 (done): silence_timeout sin mutaciones tras el armado
 * El observer escribe su estado en `window.__yautjaStream` y el motor solo
 * LEE ese flag en cada poll (coste barato y constante, cero snapshots).
 *
 * La lógica de transición vive en `computeStreamTick`, una función pura que
 * se embebe en el script inyectado vía `.toString()` — misma fuente para el
 * test en Node y para el navegador.
 */

export interface StreamWatchOptions {
  selector: string;
  silenceMs: number;
  minLength?: number;
}

export interface StreamWatchState {
  armed: boolean;
  done: boolean;
  textLength: number;
  lastChangeAt: number;
}

/**
 * Flag tal como viaja por el wire (Runtime.evaluate over IPC): `lastChangeAt`
 * es estado interno del reducer y nunca se envía. El parser devuelve este
 * tipo; el reducer en página lo conserva en `state` pero no lo expone.
 */
export type WireStreamWatchState = Omit<StreamWatchState, 'lastChangeAt'>;

/** Estado inicial del observador. */
export const STREAM_WATCH_INITIAL: StreamWatchState = {
  armed: false,
  done: false,
  textLength: 0,
  lastChangeAt: 0,
};

/** Key global donde el script inyectado publica su estado. */
export const STREAM_WATCH_KEY = '__yautjaStream';

/** Key global donde el script inyectado firma la config usada. */
export const STREAM_WATCH_CFG_KEY = '__yautjaStreamCfg';

/**
 * Decide si el observador instalado debe ser sustituido por uno nuevo
 * al inyectar el script. Función pura y serializable (sin closures) para
 * que sea embebible en el script in-page vía `.toString()` igual que
 * `computeStreamTick`. Clave de orden de keys estable (JSON.stringify) — la
 * CFG que se pasa es siempre nueva por construcción, así que la igualdad
 * estructural es fiable.
 */
export function shouldReinstall(
  prevCfg: unknown,
  newCfg: { selector: string; silenceMs: number; minLength: number },
): boolean {
  if (!prevCfg) return true;
  if (typeof prevCfg !== 'object') return true;
  const p = prevCfg as Record<string, unknown>;
  return (
    p.selector !== newCfg.selector ||
    p.silenceMs !== newCfg.silenceMs ||
    p.minLength !== newCfg.minLength
  );
}

/**
 * Transición de estado ante una mutación (función pura, sin closures — por
 * eso es serializable por .toString() y embebible en el script inyectado).
 */
export function computeStreamTick(
  prev: StreamWatchState,
  textLength: number,
  now: number,
  silenceMs: number,
  minLength: number,
): StreamWatchState {
  const armed = prev.armed || textLength >= minLength;
  const changed = textLength !== prev.textLength;
  const lastChangeAt = changed ? now : prev.lastChangeAt;
  const done = armed && textLength >= minLength && !changed && now - lastChangeAt >= silenceMs;
  return { armed, done, textLength, lastChangeAt };
}

/**
 * Script inyectable (Runtime.evaluate): instala el observer de 2 fases y
 * devuelve el snapshot actual.
 *   - Si ya hay observer con la misma CFG, reusa el observer y devuelve el
 *     estado publicado sin reinstalar (true idempotency).
 *   - Si ya hay observer con CFG distinta (selector / silenceMs / minLength),
 *     desconecta el viejo y crea uno nuevo: la última CFG gana. Evita el
 *     footgun de devolver "done" de un stream anterior con config rota.
 */
export function buildStreamWatchScript(opts: StreamWatchOptions): string {
  const cfg = {
    selector: opts.selector,
    silenceMs: opts.silenceMs,
    minLength: opts.minLength ?? 1,
  };
  const tickSrc = computeStreamTick.toString();
  const reinstallSrc = shouldReinstall.toString();
  return `(() => {
  const KEY = ${JSON.stringify(STREAM_WATCH_KEY)};
  const CFG_KEY = ${JSON.stringify(STREAM_WATCH_CFG_KEY)};
  const CFG = ${JSON.stringify(cfg)};
  const reinstall = ${reinstallSrc};
  const prevObs = window.__yautjaStreamObs;
  const prevCfg = window[CFG_KEY];
  if (prevObs && !reinstall(prevCfg, CFG)) return window[KEY] || null;
  if (prevObs) { try { prevObs.disconnect(); } catch (e) {} }
  const tick = ${tickSrc};
  const state = { armed: false, done: false, textLength: 0, lastChangeAt: 0 };
  let timer = null;
  const readLen = () => {
    const el = document.querySelector(CFG.selector);
    if (!el) return 0;
    return (el.innerText || el.textContent || '').length;
  };
  const snapshot = () => { window[KEY] = { armed: state.armed, done: state.done, textLength: state.textLength }; };
  const onMutation = () => {
    if (timer) clearTimeout(timer);
    const next = tick(state, readLen(), Date.now(), CFG.silenceMs, CFG.minLength);
    Object.assign(state, next);
    snapshot();
    timer = setTimeout(() => {
      const settled = tick(state, readLen(), Date.now(), CFG.silenceMs, CFG.minLength);
      Object.assign(state, settled);
      snapshot();
    }, CFG.silenceMs + 50);
  };
  const obs = new MutationObserver(onMutation);
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.__yautjaStreamObs = obs;
  window[CFG_KEY] = CFG;
  onMutation();
  snapshot();
  return window[KEY];
})()`;
}

/** Expresión de lectura del flag (barata, no snapshot). */
export const STREAM_WATCH_READ_EXPR = `(() => { const s = window.${STREAM_WATCH_KEY}; if (!s) return null; return { armed: !!s.armed, done: !!s.done, textLength: typeof s.textLength === 'number' ? s.textLength : 0 }; })()`;

/** Parser tolerante del flag (mismo estilo que parseStripResult).
 *  Devuelve `WireStreamWatchState` — el timestamp interno no viaja. */
export function parseStreamWatchState(raw: unknown): WireStreamWatchState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  return {
    armed: r.armed === true,
    done: r.done === true,
    textLength: typeof r.textLength === 'number' ? r.textLength : 0,
  };
}
