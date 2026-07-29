/**
 * Element map con refs (estilo Claude in Chrome — RE ítem 6): cada elemento
 * interactivo de la percepción recibe un `ref` estable (`e1`, `e2`, …) que las
 * acciones pueden usar en lugar de un selector CSS. En la página viven tres
 * estructuras sesión-scoped:
 *
 *   window.__yjElementMap         ref → WeakRef(element)
 *   window.__yjElementReverseMap  WeakMap(element → ref)
 *   window.__yjRefCounter         contador monótono
 *
 * En cada extracción (`em.ts` EXTRACTION_SCRIPT) se purgan los refs cuyo
 * WeakRef murió o cuyo elemento salió del documento. La lógica del mapa está
 * duplicada inline en ese script porque no puede importar módulos en el
 * contexto de la página — keep in sync con `createRefMap`.
 *
 * `createRefMap` es la versión pura y testeable en Node del mismo algoritmo;
 * `buildResolveRefScript` genera el script de resolución que usan las acciones
 * (click/type/focus) para dereferenciar un ref, validar que el elemento sigue
 * en el documento, hacer scrollIntoView y devolver el centro del rect.
 */

export interface RefMap {
  /** Devuelve el ref estable del elemento (asigna uno nuevo si no lo tenía). */
  assign(el: object): string;
  /** Resuelve un ref a su elemento (null si el WeakRef murió o no existe). */
  resolve(ref: string): object | null;
  /** Purga refs muertos o desconectados. Devuelve cuántos se eliminaron. */
  purge(): number;
  /** Elimina un ref concreto (usado al detectar un stale en resolución). */
  evict(ref: string): void;
  readonly size: number;
}

export function createRefMap(opts: { isConnected: (el: object) => boolean }): RefMap {
  const map = new Map<string, WeakRef<object>>();
  const reverse = new WeakMap<object, string>();
  let counter = 0;
  return {
    assign(el) {
      const existing = reverse.get(el);
      if (existing && map.has(existing)) return existing;
      counter += 1;
      const ref = `e${counter}`;
      map.set(ref, new WeakRef(el));
      reverse.set(el, ref);
      return ref;
    },
    resolve(ref) {
      const el = map.get(ref)?.deref();
      return el ?? null;
    },
    purge() {
      let removed = 0;
      for (const [ref, wr] of map) {
        const el = wr.deref();
        if (!el || !opts.isConnected(el)) {
          map.delete(ref);
          removed += 1;
        }
      }
      return removed;
    },
    evict(ref) {
      map.delete(ref);
    },
    get size() {
      return map.size;
    },
  };
}

export interface ResolveRefOptions {
  /** Llamar el.focus() tras validar (type/focus). */
  focus?: boolean;
  /** Vaciar el valor + input event antes de resolver (type con clearFirst). */
  clear?: boolean;
}

/**
 * Script inyectado que resuelve un ref a coordenadas. Devuelve JSON:
 * `{ ok: true, x, y }` o `{ ok: false }` (ref desconocido, WeakRef muerto o
 * elemento fuera del documento; en ese caso el ref se purga in-page).
 */
export function buildResolveRefScript(ref: string, options: ResolveRefOptions = {}): string {
  const refJson = JSON.stringify(ref);
  return `(function() {
  var map = window.__yjElementMap || {};
  var wr = map[${refJson}];
  var el = wr && wr.deref ? wr.deref() : null;
  if (!el || !document.contains(el)) {
    if (map[${refJson}]) delete map[${refJson}];
    return JSON.stringify({ ok: false });
  }
  ${options.clear ? `try {
    if (el.value !== undefined) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
  } catch (e) {}` : ''}
  ${options.focus ? `try { el.focus(); } catch (e) {}` : ''}
  try { el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }); } catch (e) {}
  var r = el.getBoundingClientRect();
  return JSON.stringify({ ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 });
})()`;
}
