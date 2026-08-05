# Follow-up: streamSettled review (post-implementation)

**Fecha:** 2026-08-05
**Origen:** review crítica del trabajo de la sesión
(commits `67943fc`, `825c090`, `37a66c3`, `f9aa9d7`, `2381a19`).
**Estado:** Issue abierta. No priorizada por ahora.

## Contexto

Después de implementar la Fase A del spec `stream-complete`
(commit `f9aa9d7`) y de hacer una review crítica del trabajo, se
identificaron los siguientes puntos. Algunos se arreglaron (C1, C3)
y se commitean en `2381a19`. El resto quedan aquí como deuda
técnica viva.

## Críticos pendientes

### C2 — Guard de idempotencia con configs distintas

**Archivo:** `src/arsenal/watch-stream.ts:72`

```js
if (window.__yautjaStreamObs) return window[KEY] || null;
```

Si el script se ha inyectado antes con otra `selector`/`silenceMs`,
el guard devuelve el estado del observer anterior e ignora la
configuración nueva. En SPAs con navegación interna esto puede
producir falsos `done` con la config antigua.

**Sugerencia:** invalidar el guard cuando la `CFG` no coincida con
una marca de versión (e.g., `window.__yautjaStreamCfg`), o al menos
loggear un WARN. Añadir test que cubra: "segunda inyección con
distinta config no devuelve estado viejo".

## Importantes

### I1 — Inconsistencia de idioma en `watch-stream.ts`

`wait-for-ui.ts:1-19` y el resto del arsenal están en inglés.
`watch-stream.ts:1-14` mezcla español. Decidir convención del
repo y traducir todo el módulo al idioma consistente.

### I2 — Mensaje genérico tras fallo permanente de install

`wait-for-ui.ts` case `streamSettled`: cuando el script de install
nunca puede inyectarse, el motor termina en `WAIT_TIMEOUT` con el
mensaje existente `'waitFor predicates not met after submit'` desde
`helmet.ts:1324`. No diferencia "selector nunca apareció" de "el
stream no empezó". Considerar un mensaje dedicado a predicados
`streamSettled` o un campo `lastReason` en `WaitForUiResult`.

### I3 — `parseStreamWatchState` siempre `lastChangeAt: 0`

La interfaz `StreamWatchState` declara `lastChangeAt`, pero por el
wire no viaja (es estado interno). Quien consuma el parser puede
confundirse si espera un timestamp real. Sugerencia:

```ts
export type WireStreamState = Omit<StreamWatchState, 'lastChangeAt'>;
```

O documentar la asimetría en el JSDoc.

### I4 — No hay test de "install devuelve estado inicial"

El test "streamSettled installs the observer once" cubre el camino
de éxito, pero no prueba explícitamente que cuando la install
devuelve `{ armed:false, done:false }` (estado inicial real), el
motor fija `installed = true` y luego entra al loop de lecturas del
flag. Test sencillo: simular `MutationObserver` devuelve el
snapshot inicial, asegurar match.

## Menores

### M1 — `STREAM_WATCH_INITIAL` exportado solo para tests

Considerar mover a un test-helper o mantener como constante
interna y exponer `currentStream()` de test puro.

### M2 — Tests del motor usan substring literales

Los tests de `streamSettled` dependen de substrings
`'MutationObserver'` y `'const s = window.__yautjaStream'`. Si
alguien reformatea el script, fallan silenciosos. Considerar
exportar marcadores (`STREAM_WATCH_INSTALL_MARKER`,
`STREAM_WATCH_READ_MARKER`) desde `watch-stream.ts` y reusarlos
en tests.

## Veredicto

El núcleo funciona y los tests son razonables. La deuda viva es
principalmente observabilidad (I2), consistencia (I1) y seguridad
contra el footgun del guard (C2).
