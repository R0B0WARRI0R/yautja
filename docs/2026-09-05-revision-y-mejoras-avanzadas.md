# Yautja: revisión y mejoras avanzadas

Fecha: 5 de septiembre de 2026.

Este documento conserva las recomendaciones de la revisión solicitada por el
usuario y el resultado de la corrección posterior de los cuatro fallos
reproducidos. Las mejoras restantes son propuestas, no trabajo implementado
ni autorizado para su ejecución automática.

## Alcance y conclusión

Se revisaron el árbol de trabajo de `D:/Yautja`, las dos extensiones, los
contratos MCP y la integración documentada de Mecamorph. Se preservaron los
cambios locales previos y no se crearon commits.

La prioridad recomendada es reforzar la ejecución verificable: destino
correcto, aislamiento entre sesiones, cancelación, deduplicación y evidencia
del resultado. Yautja ya dispone de sensores, recuperación, evidencias,
macros, perfiles y una integración de compilación semántica.

Durante la revisión, la instancia MCP de esta conversación respondía a
consultas locales, pero su enlace con la extensión estaba desconectado.
Las reproducciones adicionales se hicieron de forma aislada; no constituyen
una validación de extremo a extremo sobre un navegador real.

## Cuatro fallos corregidos

| ID | Problema reproducido | Corrección realizada |
| --- | --- | --- |
| F1 | Una macro devolvía timeout y después ejecutaba otra acción. | Ámbito de ejecución con plazo y cancelación; esperas cancelables, revocación del contexto y comprobación antes de enviar nuevos comandos. Propagación a macros anidadas. |
| F2 | Un cliente B podía declarar el `sessionId` de A en un mensaje y superar el control sobre una pestaña de A. | La identidad de comandos y heartbeats procede del socket registrado. Se rechazan registros que reclamen identidades activas o grupos de otra sesión. |
| F3 | El filtro de capturas conservaba secretos sintéticos en URLs y campos JSON, aunque ocultaba Authorization. | Sanitización estructural de URL, JSON, formularios y cabeceras sensibles, compartida por la salida y la persistencia. Cobertura adicional de JSON truncado y multipart. |
| F4 | Dos llamadas simultáneas con la misma clave de idempotencia ejecutaban dos veces la función. | Reserva de operaciones pendientes y reutilización de su resultado. Claves separadas por sesión, huella de operación/destino/argumentos y rechazo de usos incompatibles. Copias de resultados para evitar mutaciones compartidas. |

Archivos principales:

- F1: `src/macros/execution-scope.ts`, `src/macros/runner.ts` y
  `src/connection/extension-server.ts`.
- F2: `src/connection/extension-server.ts`.
- F3: `src/intel/network-capture.ts`.
- F4: `src/doctrine/idempotency.ts`, `src/doctrine/recovery-machine.ts` y
  la llamada de `smartType` en `src/helmet.ts`.

Validación realizada al terminar los arreglos:

- `npm run lint`: correcto.
- `npx vitest run`: **1.511 tests en 89 archivos, todos verdes**.
- Se añadieron **17 pruebas de regresión** respecto a los 1.494 tests iniciales.
- `npm run build`: correcto; build actualizado.
- `git diff --check`: correcto.

Límites: cancelar no deshace una orden ya enviada al navegador. Las macros
JavaScript no se han convertido en un entorno aislado de ejecución de código
arbitrario. Los procesos MCP existentes deben reiniciarse para cargar el
build nuevo; actualizar los archivos no reemplaza sus módulos en memoria.

## Mejoras avanzadas pendientes

### M1. Operaciones con estado explícito y verificación posterior

**Prioridad: alta.** Extender la corrección de cancelación hacia un registro
de operaciones con estados `pending`, `running`, `succeeded`, `failed`,
`cancelled` y `outcome_unknown`, asociado a plazo, destino y evidencia.

Si se pierde la conexión después de pulsar Enviar, comprobar el resultado
antes de repetir. Propagar `notifications/cancelled` de MCP hasta la operación.
La deduplicación en memoria implementada en F4 no equivale a un registro
duradero que sobreviva a reinicios.

**Aceptación:** ninguna acción nueva después de cancelar y ninguna repetición
automática de una mutación cuyo resultado siga siendo desconocido.

Referencia: [cancelación MCP](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation).

### M2. Identidad de navegador y recuperación por generaciones

**Prioridad: alta.** Identificar instancia, sesión, pestaña y generación de
conexión en los comandos. Rechazar comandos de generaciones anteriores tras
una reconexión y reconciliar pestañas, grupos y operaciones pendientes.

Sustituir la liberación de grupos por cinco minutos sin herramientas por
comprobaciones de vida independientes. El silencio de un agente que está
razonando no demuestra que su proceso haya muerto.

No tomar el eventual reinicio automático del service worker como garantía de
recuperación: Chrome documenta que las sesiones activas de debugger pueden
mantenerlo vivo.

**Aceptación:** pruebas de desconexión, reinicio del worker y reconexión con
mensajes antiguos, sin ejecución sobre otra sesión ni pérdida de propiedad
por inactividad legítima.

Referencia: [ciclo de vida del service worker](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).

### M3. Percepción de frames, Shadow DOM y accesibilidad

**Prioridad: media, después de estabilizar la ejecución.** El buscador revisado
parte de `document.querySelectorAll` y utiliza una comprobación geométrica
limitada de visibilidad.

Evolucionar hacia referencias que incluyan target, frame, identidad de
documento y nodo. Combinar rol y nombre accesible con DOM y comprobar
obstáculos antes de clicar. Mantener estos accesos dentro del control de
sesiones y permisos de Yautja.

**Aceptación:** formularios dentro de iframes, componentes con Shadow DOM,
botones cubiertos por overlays y referencias invalidadas por navegación.

Referencias: `src/targeting/element-finder.ts`, `src/vision/element-map.ts` y
[dominio Target de CDP](https://chromedevtools.github.io/devtools-protocol/tot/Target/).

### M4. Capacidades operativas y contratos MCP precisos

**Prioridad: alta.** Separar `supported`, `ready`, `authorized` y `reason` en
el anuncio de capacidades. Durante la revisión se anunciaban capacidades de
navegador aunque el enlace de la instancia estaba desconectado.

Exponer resultados mediante `structuredContent`, añadir `outputSchema` y
marcar errores de ejecución con `isError`, conservando la compatibilidad
necesaria. El servidor revisado devuelve el envelope como texto JSON.

**Aceptación:** un cliente distingue soporte de disponibilidad real y puede
validar resultados y detectar errores sin interpretar cadenas de texto.

Referencias: `src/doctrine/capabilities.ts`, `src/helmet.ts` y
[contrato de herramientas MCP](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).

### M5. Fuente única para herramientas, documentación y extensiones

**Prioridad: alta; abordar de forma incremental.** Generar esquemas y
documentación desde un registro tipado de herramientas. Generar las dos
extensiones desde el mismo código con configuración por instancia.

Divergencias observadas durante la revisión:

- La skill describe `httpRequest`, `collectionRun` y `authStore`, ausentes
  del código revisado y de las 113 herramientas expuestas por la instancia.
- `extension/background.js` y `extension-chrome/background.js` difieren en
  selección de puertos y gestión del foco. La copia de Chrome activa pestañas
  donde la principal respeta `focus`.

**Aceptación:** comprobación automática entre catálogo, handlers y
documentación; mismas pruebas de comportamiento para ambas variantes y
diferencias de instancia declaradas en configuración.

### M6. Evaluar Mecamorph frente al flujo convencional

**Prioridad: experimental, tras estabilizar los fundamentos.** La compilación
semántica ya existe; el descubrimiento revisado se centra en
`ecommerce.product.search`. No presentarlo como una API universal ya resuelta.

Comparar búsqueda, filtrado, apertura de elementos y paginación en tres
fixtures distintos, con cambios deliberados de interfaz. Usar como baseline
el flujo habitual `observe → find → act`.

Medir éxito verificado, falsos positivos, llamadas, tokens y latencia. Decidir
con los resultados cuándo reutilizar una capacidad y cuándo redescubrirla.
Mantener separados definición, binding, verificador y workflow; Yautja
conserva la propiedad del navegador y de las autorizaciones.

**Aceptación:** comparación reproducible que permita evaluar coste y errores
de ambos enfoques, sin confundir una ejecución plausible con éxito verificado.

Antes de implementar, leer `D:/Mecamorph/AGENTS.md`, `docs/HANDOFF.md` y las
instrucciones allí enlazadas. Referencia de descubrimiento revisada:
`D:/Mecamorph/packages/discovery/src/index.ts`.

## Secuencia recomendada

1. **Completado:** F1–F4 y regresiones.
2. **Pendiente:** M1, M2, M4 y consolidación incremental de M5.
3. **Pendiente:** M3 y evaluación experimental M6.

Ampliar las pruebas de integración con desconexión durante acciones,
concurrencia, reinicio del worker y cambios de interfaz. Los tests actuales
verifican los escenarios implementados; no garantizan por sí solos el
comportamiento en todos los navegadores y sitios reales.
