# Follow-up: streamSettled review (post-implementation)

**Fecha:** 2026-08-05
**Origen:** review crítica del trabajo de la sesión
(commits `67943fc`, `825c090`, `37a66c3`, `f9aa9d7`, `2381a19`, …).
**Estado:** Issue abierta. C2, I3 e I4 cerrados (commits posteriores). I1 re-bajada a nice-to-have no funcional. I2 queda como deuda viva.

## Contexto

Después de implementar la Fase A del spec `stream-complete`
(commit `f9aa9d7`) y de hacer una review crítica del trabajo, se
identificaron los siguientes puntos. Algunos se arreglaron (C1, C3)
y se commitean en `2381a19`. El resto quedan aquí como deuda
técnica viva.

## Críticos

### C2 — Guard de idempotencia con configs distintas ✅ (commit `76829c5`)

Antes:

```js
if (window.__yautjaStreamObs) return window[KEY] || null;
```

Si el script se había inyectado antes con otra `selector`/`silenceMs`,
el guard devolvía el estado del observer anterior e ignoraba la
configuración nueva. En SPAs con navegación interna podía producir
falsos `done` con la config rota.

Ahora `buildStreamWatchScript` firma la CFG en
`window.__yautjaStreamCfg` y desconecta el observer viejo
(`try/catch`) cuando la nueva CFG difiere. Helper puro
`shouldReinstall` exportado, embebido vía `.toString()` en el
script in-page y testeable en Node. Tres tests unitarios del
helper y dos tests de integración del motor.

## Importantes

### I1 — Inconsistencia de idioma en `watch-stream.ts` ⏬ nice-to-have

Re-bajado. Inspección del repo (`grep -E '//|/\*'` en `src/arsenal/`)
muestra que el español coexiste con inglés en muchos archivos
(strip-interference.ts, kill-switch.ts, translator.ts). El nuevo
módulo en español encaja con al menos uno de los pares más
cercanos (`strip-interference.ts`). No es funcional; queda como
decisión estilística pendiente.

### I2 — Mensaje genérico tras fallo permanente de install ✅ parcial (Opción A, commit `9516a7d`)

Antes: `wait-for-ui.ts` case `streamSettled` terminaba en
`WAIT_TIMEOUT` con la misma shape que cualquier timeout. No
diferenciaba "selector nunca apareció" de "el stream no empezó".

Ahora: `WaitForUiResult.failureReason?: { kind, selector, lastFlag,
lastInstallFailed }` se rellena en cada poll del `streamSettled`.
Cuando el `waitForUi` termina en `matched: 'timeout'`, el `result`
incluye el `failureReason` con:

- `kind: 'streamSettled'` (reservado para discriminadores futuros).
- `selector`: el pedido (e.g., `#answer`).
- `lastFlag`: la última publicación del reducer en página, con
  `{ armed, done, textLength }`. `null` si la página nunca aceptó el
  script.
- `lastInstallFailed`: `true` si el `Runtime.evaluate` del install
  devolvió algo no-objeto en algún poll (página bloquea CSP /
  sandbox / navegación).

Cobertura de tests (`tests/arsenal/wait-for-ui.test.ts`):

- `'streamSettled timeout carries failureReason with last flag observed'`
- `'streamSettled timeout reports lastInstallFailed when the page never accepts the script'`

**Estado**:Opción A cerrada. Queda pendiente para una iteración futura,
**solo si el usuario lo pide y una vez commiteado su WIP**, el
mensaje dedicado en `helmet.ts:1324` (actualmente
`'waitReady predicates not met after submit'`). Para ese día, el
`failureReason` ya está disponible vía `response.result.wait` (que
helmet devuelve en `smartType`). La integración es puramente
presentational: leer `failureReason` y emitir un mensaje mejor.

### I3 — `parseStreamWatchState` siempre `lastChangeAt: 0` ✅

Cerrado: nuevo tipo `WireStreamWatchState = Omit<StreamWatchState, 'lastChangeAt'>`
publicado y devuelto por el parser. El reducer interno sigue usando
`StreamWatchState` con `lastChangeAt`; el wire solo ve el subtipo
limpio.

### I4 — No hay test de "install devuelve estado inicial" ✅

Test nuevo en `wait-for-ui.test.ts` (`'streamSettled waits across
the initial-state arm after install'`): simula la install con
snapshot inicial `{ armed:false, done:false }` y tres lecturas que
transicionan hasta `done:true`. Assert `installs === 1` y
`matched: 'anyOf'`.

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

## Veredicto actualizado

Cerrado: **C2, I3, I4, I2 (Opción A)** — todos con commits
propios:

| ID | Commit |
|---|---|
| C1 | `2381a19` (rewording honesto) |
| C2 | `76829c5` (reinstall on config change) |
| C3 | `2381a19` (spec actualizado) |
| I3 | `97b1c48` (WireStreamWatchState) |
| I4 | `97b1c48` (test install-state initial) |
| I2A | `9516a7d` (failureReason) |

Abierto: I1 (nice-to-have no funcional), I2B (mensaje dedicado en
helmet, requiere WIP), M1, M2.

El núcleo funciona; los tests cubren idle/transitions/initial-arm/
reinstall/diagnostic-on-timeout.
