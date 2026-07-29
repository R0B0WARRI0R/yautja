# Multi-puerto REAL: cada instancia de Kimi con Yautja autónomo

> ✅ IMPLEMENTADO (2026-07-28, Tandas A+B+C — 1360/1360 tests).
> Broker "winner takes base port" con registro de clientes, forwarding, namespaces por sesión (tab groups, política TAB_OWNED_BY_OTHER_SESSION) y reelección automática con re-registro. Módulos: `src/connection/broker-client.ts`, `broker-discovery.ts`, `broker-reelection.ts`, y lógica broker en `extension-server.ts`.

## Requisito

Que cada instancia de Kimi pueda trabajar con Yautja **de forma autónoma y simultánea**, sin pelearse por el navegador. Hoy la extensión es monogámica: solo UN helmet la controla a la vez (el resto de instancias se queda con tools locales únicamente). El multi-puerto implementado (auto-incremento + rotación) evita el EADDRINUSE pero NO da autonomía real: sigue habiendo un único dueño del navegador.

## Estado actual (lo ya hecho)

- Helmet auto-incrementa puerto (9876–9885) si está ocupado. Varios helmets conviven.
- Extensión rota por la ventana hasta encontrar helmet; `yjPort` en storage como override manual.
- Pero: la extensión mantiene UNA conexión WS → un solo helmet tiene navegador. Cambiar de dueño = `yjPort` manual (el resto pierde el control).

## El problema de fondo

1. **Un WS = un dueño**: la extensión solo acepta/mantiene una conexión activa.
2. **CDP es exclusivo por pestaña**: `chrome.debugger.attach` solo permite una sesión de depuración por pestaña (por extensión). Dos helmets no pueden adjuntar la misma tab a la vez.
3. **Estado compartido sin namespace**: cookies, storage, historial de red/consola, tab groups — todo es del navegador, sin aislamiento por instancia.

## Arquitecturas candidatas

### A) Extensión multi-conexión (N websockets)
- La extensión mantiene N conexiones WS (una por helmet vivo) y enruta comandos por conexión.
- Arbitraje de recursos: un helmet es "owner" de cada tab (el primero que la adjunta); otros reciben `TAB_BUSY` con opción `force` (handoff).
- Ventaja: sin procesos nuevos. Desventaja: toda la lógica de arbitraje dentro del service worker (complejo de depurar, MV3 lo mata a menudo y hay que reconstruir N conexiones).

### B) Broker local (RECOMENDADA)
- Un proceso broker (puede ser el propio helmet "primario" o un daemon mínimo `yautja-broker`) es el ÚNICO que habla con la extensión (puerto 9876).
- Los helmets de cada instancia se registran en el broker como clientes (WS local, puerto dinámico) con su `sessionId`.
- El broker multiplexa: cada sesión recibe su **namespace aislado** = su tab group de sesión (ya existe `sessionGroupCreate`), sus buffers de red/consola, sus adjuntos.
- Reglas: cada sesión solo ve/toca tabs de su grupo (ya implementado a nivel helmet; el broker lo haría estructural). Las tabs "del usuario" (fuera de grupos) son read-only o requieren handoff explícito.
- Ventaja: un solo punto de verdad para CDP (sin conflictos de attach), aislamiento real por sesión, extensión sin cambios estructurales (sigue con un WS). Desventaja: otro proceso que mantener vivo (puede vivir dentro del primer helmet que bindee 9876: "winner becomes broker").

### Decisión provisional
**B con "winner becomes broker"**: el helmet que bindea 9876 actúa de broker; los demás helmets (9877+) se registran como clientes. Si el broker muere, el siguiente helmet por orden de puerto asume el rol (elección determinista por puerto más bajo vivo, descubrimiento por escaneo de la ventana 9876–9885).

## Tareas de implementación (estimación de tanda)

1. Protocolo broker↔cliente: registro `{sessionId}`, routing de comandos, heartbeats.
2. Helmet: modo `broker` (sirve a clientes) y modo `client` (delega en el broker). Detección del rol al arrancar (¿9876 libre? → broker).
3. Namespace por sesión en el broker: tab group por sesión (mapear sessionId → groupId), filtrado de eventos CDP por grupo, aislamiento de buffers.
4. Política de tabs del usuario: lectura permitida, escritura con handoff.
5. Reelección de broker al morir el primario (los clientes re-escanean la ventana).
6. Extensión: sin cambios estructurales (sigue un WS); opcionalmente exponer `brokerInfo` en `hello`.
7. Tests: dos helmets (broker+cliente) con fake extension; aislamiento de grupos; reelección.

## Riesgos / notas

- MV3 mata el service worker con frecuencia: el broker debe tolerar reconexiones y reconstruir estado desde los clientes (los helmets son la fuente de verdad de sus sesiones).
- Rendimiento: un solo canal WS hacia la extensión serializa; los comandos ya son concurrentes en la extensión, así que el cuello de botella es aceptable.
- Seguridad: el broker escucha en localhost; aceptar solo clientes con `sessionId` válido y origen `ws://localhost`.
