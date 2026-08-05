# Design: Evento `stream-complete` para detección push de fin de stream (P17)

**Fecha:** 2026-08-05
**Estado:** Propuesta (no aprobado) — follow-up de `submitState` predicate (2026-08-05-submitstate-predicate-design.md)
**Repo:** Yautja (D:\Yautja)

## Problema

La validación en vivo de `submitState` (Perplexity, 2026-08-05) expuso la
limitación de la detección por polling:

| Limitación | Detalle observado |
|---|---|
| **Fase streaming transitoria** | El botón con `aria-label="Pausar"` duró < 10s (Kimi K3 responde muy rápido). `waitFor` con timeout 10s no llegó a muestrear la señal en el primer poll — el stream ya terminó. |
| **Coste de polling** | Cada poll de `Runtime.evaluate` consume cuota de presupuesto de agente (`agentbudget`, `maxAgentQueriesPerSession: 1`). Tras una validación, `queryBurn: 1` sin queries restantes. |
| **Sleeps ciegos** | Los `waitFor` que no aciertan a la primera gastan tiempo real de sesión y latencia. |
| **Sin generabilidad** | El predicado `submitState` es específico de DOM; no conocer el fin real del stream a nivel de red (SSE/WS). |

Diagnóstico: la detección **imperfecta por polling** escala mal con sitios que
usan streaming rápido y con un presupuesto de queries compartido.

## Objetivo

Detección **event-driven (push), dentro del navegador**, de fin de stream de IA
con **coste cero de cuota de agente**: evento proxy `stream-complete` que el
extensión Yautja emite cuando detecta que la IA terminó (2 fases, infraestructura
de red como assertion), y que el motor `waitFor` consume sin muestrear.

## Arquitectura

### 1. Inyección de detección dentro del navegador (dos fases reales)

`MutationObserver` de dos fases: inyectado via CDP `Page.addScriptToEvaluateOnNewDocument`
(o en el extension `background.js`):

- **Fase 1 (arranque)**: observer padre detecta la aparición del nodo de respuesta
  (contenedor del plan de respuesta). Inyecta observer hijo.
- **Fase 2 (fin)**: observer hijo esperan que la clase `streaming` / el botón
  volver al estado idle; cuando deja emitir mutaciones durante `silence_timeout`
  ms sin clases activas → emite `stream-complete`.

### 2. Aserción de close a nivel de red (assert network)

El MITM proxy / WebSocket tapped (ya existente: `websocket-inspector.ts`,
`src/intel/`) observa el close del canal SSE/WebSocket del assistant. Al ver
`[DONE]`/close frame → marca el flujo como cerrado. Se fusiona con el event
DOM → aserción dual (DOM + red).

### 3. Topic de eventos en el nucleus (bridge extension ↔ motor)

- El extension emite `stream-complete` con el id del tab + runId.
- El motor `waitFor` escucha el topic directamente (suscribe) y resuelve sin
  muestrear — 0 unidades del agente.
- Bono: el botón/indicador `status` intra-MCP no consume cota.

### 4. Gateway de presupuesto fuera del bucle del agente

`agentbudget` (budget host) fuera del control del agente:
- Rúbrica por session group; el detector no llama al gateway — es *observación por
  observer*, cero coste.

### 5. Perfil Perplexity — `agentbudget` / wait events
- Perfil nuevo tunable: `waitDefaults.ready` pasa a "suscribir `stream-complete`"
  en lugar de poll del botón. `submitState` queda como fallback para sites sin
  detector concreto.

## Flujo de datos

```
CDP inject MutationObserver (2 fases)
  → detecta nodo respuesta + quit class streaming / parada de mutaciones
  → emite stream-complete (tab, run id)        ══►  observation, 0 cuota
MITM proxy: [DONE]/WS close                      ══►  assert close (red)
        │
waitFor actual: suscribe stream-complete topic
  → resolución armada / fallback submitState si expira
```

## Manejo de errores

| Caso | Comportamiento |
|---|---|
| Observer no inyectado (navegador sin CDP) | Fallback a predicados actuales (`submitState`, `textSettled`, dummy timeout duro) |
| `silence_timeout` demasiado corto (gap real de tokens) | Fallback: aserción push de red (close stream) lo corrige → `stream-complete` igualmente |
| Evento sin catch (run id viejo) | Ignora silencioso; timeout existente `YJ.ACT.WAIT_TIMEOUT` |
| Sesión presupuesto agotado | Detector no se dispara → error de presupuesto controlado (indicador) |
| `agentbudget` sin gateway | No afecta: observación es de coste 0 independientemente |

## Testing (Vitest)

- **Unit detector**: MutationObserver botón idle→streaming→idle con jsdom/mock
  (fire mutaciones con timers reales).
- **Unit red assert**: parse de frame SSE con `[DONE]` y WS close → evento.
- **Integración**: evento push mock del extension → `waitFor` resuelve sin un
  solo poll (contador de `Runtime.evaluate` = 0).
- **Perfil**: `agentbudget` resta intacto tras flujo (coste 0 verificado).

## Fuera de alcance (YAGNI)

- Detección de **inicio** de streaming (el arranque sigue con `submitState`
  transitorio de polling; el valor está en el cierre)
- Otros sites: solo se configura cuando aparezca sitio con detector propio
- Tool MCP nueva: `streamCompleteWait` — no, basta motor con topic
- Migrar `smartType waitReady` a sólo eventos (se conserva fallback)

## Archivos

| Archivo | Cambio |
|---|---|
| `src/arsenal/watch-stream.ts` | Detector 2 fases + silence (nuevo) |
| `src/arsenal/wait-for-ui.ts` | Suscripción a topic `stream-complete` (sin case nuevo) |
| `src/intel/*` (websocket-inspector, MITM) | Aserción de close + `[DONE]` |
| `extension/background.js` | Bridge del topic → motor |
| `profiles/perplexity.json` | wait/ready con detector por evento (opcional) |
| `tests/` | Tests nuevos + unit/integration |

## Decisión pendiente (polling vs push)

Este spec separa qué es rápido de implementar (bridge del extension → motor)
de lo costoso (assert de red). Kickstart: fase A = observer DOM (nuevo
`watch-stream`) ya incluye 2 fases y silence_timeout; fase B = red. Patrón que
resuelve el race real (botón `Pausar` efímero).