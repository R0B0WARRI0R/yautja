# Plan de fiabilidad: destinos, datos, conexión, cancelación y grupos

Fecha: 5 de septiembre de 2026.

Estado: implementación local y validación realizadas el 5 de septiembre de
2026. Los bloques descritos debajo conservan el razonamiento del diseño;
el estado de entrega y sus límites se detallan en la sección siguiente.
Los procesos MCP personales que ya estaban abiertos no se han reiniciado.

Complementa `docs/2026-09-05-revision-y-mejoras-avanzadas.md`. Conserva los
cambios locales existentes y no requiere cambios en Mecamorph.

## Entrega y comprobación

| Bloque | Implementación |
| --- | --- |
| Destino | Selección separada del foco, cola por sesión, correlación de respuesta por pestaña, generación de conexión y comprobación de instancia de navegador. Se elimina también el salto automático a YouTube al cerrar la pestaña seleccionada. |
| Datos | Red y consola particionadas por generación, pestaña y época del documento; capturas de cuerpos pendientes conservan el registro de origen. Se invalidan cachés de DOM, rendimiento, memoria y WebSocket al cambiar de contexto. |
| Diagnóstico | `connection_status` local con PID, hash del módulo cargado y estado del enlace. `capabilities` separa soporte, disponibilidad y autorización. MCP publica `outputSchema`, `structuredContent` e `isError`. |
| Operaciones | Plazo total configurable (60 s por defecto, incluida cola), cancelación MCP y `operation_cancel`, historial acotado con fase y tiempos. Las continuaciones vencidas no pueden despachar nuevas llamadas de Chrome; una acción enviada sin confirmación produce `outcome_unknown` sin reintento automático. |
| Grupos | `sessionGroupAddTab`, `sessionGroupRename` y `session_finish`. Procedencia de pestañas, restauración de las prestadas, comprobación de grupo antes de cerrar, informe parcial y repetición idempotente. El silencio MCP no libera grupos vivos. |
| Variantes | `extension/background.js` es la fuente común y `sync:extensions` genera la copia de Chrome, conservando la configuración de cada instancia. Ambas extensiones anuncian versión 0.2.0. |

La prueba reproducible `npm run test:browser-reliability` compila y ejecuta
el recorrido contra Brave y Google Chrome instalados, con perfiles temporales,
servidor HTTP local y puertos de bridge autenticados propios. Comprueba A y B
del mismo origen, foco en A con acciones sobre B, aislamiento de clics y red,
dos sesiones, serialización, cancelación, destino cerrado y cierre de grupos
con restauración de pestañas prestadas. Cierra los grupos y los navegadores
de prueba y elimina sus perfiles temporales.

En Chrome, el fixture carga la extensión mediante
[`Extensions.loadUnpacked`](https://chromedevtools.github.io/devtools-protocol/tot/Extensions/#method-loadUnpacked)
en el proceso de prueba, a través del pipe de Playwright. No modifica el
perfil personal. `YAUTJA_TEST_BROWSER` permite cambiar el ejecutable y
`YAUTJA_TEST_VARIANT` seleccionar `extension` o `extension-chrome`.

Se han ampliado las regresiones de transporte, buffers, cancelación,
procedencia y contrato MCP. La skill local de Yautja incorpora el uso
obligatorio de grupos y `session_finish` antes de terminar una tarea.

Validación final del 5 de septiembre de 2026:

- `npx vitest run`: **1.552 pruebas aprobadas en 92 archivos**.
- `npm run build` y `npm run lint`: correctos.
- `npm run check:extensions` y `git diff --check`: correctos.
- Fixture real: **correcto en Brave y Google Chrome**, con dos sesiones
  en cada navegador y las diez comprobaciones del script satisfechas.
- Grupos de prueba cerrados, pestañas prestadas restauradas y perfiles
  temporales eliminados. Cambios locales conservados; no se crean commits.

### Activación y límites

- El build queda en `dist`. El hash de `connection_status.build` identifica
  el módulo Helmet cargado al iniciar el proceso; no es una firma de todas
  las dependencias ni demuestra que una sesión antigua haya recargado código.
- La activación en los perfiles personales requiere recargar cada extensión
  y reiniciar sus conexiones MCP desde el host. No hay una herramienta de
  recarga del host disponible en esta sesión. Arrancar otro `helmet-main`
  manualmente no sustituye al proceso stdio que mantiene Codex.
- La cancelación no revierte efectos que Chrome ya aceptó. Una creación cuyo
  resultado se pierda antes de registrar el identificador exige reconciliar
  el inventario; no se cierran pestañas de procedencia incierta.
- El cierre al terminar el proceso es de mejor esfuerzo y tiene el margen
  de salida del host. El flujo normal debe llamar explícitamente a
  `session_finish`. No se ha añadido un evento de fin de tarea a Codex.
- La captura es acotada y declara `captureComplete: false`; no promete el
  historial anterior a la conexión. La época de documento se observa mediante
  eventos CDP y no constituye una identidad persistente de todos los frames.
- Estas correcciones no establecen la causa del fallo original de Instagram.

## Evidencia y límites

- Al principio, ambas instancias MCP respondían, pero `listTabs` fallaba con
  `broker: extension not connected`. Más tarde Brave volvió a responder.
- `openTab` creó Instagram en segundo plano, dentro de un grupo, y devolvió
  `attached: true`. La siguiente evaluación devolvió la URL y contenido de
  YouTube. Una selección explícita posterior de Instagram recuperó el destino.
- `read_network_requests`, con el `tabId` de Instagram, devolvió peticiones de
  YouTube. No son pruebas del estado de red de Instagram.
- Una evaluación tardó mucho más que los 20 segundos indicados por su error
  final. No hay una traza temporal completa que permita atribuir toda la demora
  a una sola capa.
- Fue posible crear el grupo «Chopper», abrir una pestaña dentro y cerrar las
  dos pestañas creadas. No hay herramientas MCP explícitas para incorporar
  pestañas existentes, renombrar o finalizar el grupo de sesión.
- El error de IG Helper se observó en Instagram. No se ha demostrado que sea
  la causa de la ausencia de publicaciones; queda fuera de estas correcciones.

Las observaciones prueban comportamientos externos. Las rutas de código
descritas debajo explican riesgos compatibles con ellos, pero la atribución
exacta requiere reproducirlos con la versión efectivamente cargada.

## Orden de ejecución

0. Identificar las versiones en ejecución y preparar reproducciones locales.
1. Garantizar el destino de cada operación, incluida su recuperación.
2. Aislar eventos, sensores y resultados por pestaña y sesión.
3. Exponer disponibilidad real y errores de conexión precisos.
4. Limitar y cancelar la operación completa.
5. Completar el ciclo de vida de los grupos y aplicar las preferencias.
6. Validar el conjunto en ambas variantes y cargar las versiones verificadas.

Cada bloque debe tener su reproducción, corrección y prueba de regresión antes
de avanzar. El estado de conexión se implementa antes del plazo global para
que las interrupciones tengan causas identificables. La identidad y la
generación de conexión deben quedar disponibles desde el primer bloque.

## 0. Versiones y reproducciones

El `dist` actual no acredita qué módulos tienen cargados el broker, los clientes
ni la extensión. Registrar build, versión del protocolo, proceso, rol, instancia
de navegador, versión de extensión y generación de conexión en el diagnóstico.
Evitar divulgar tokens, argumentos privados o URLs completas innecesarias.

Preparar dos páginas locales A y B con identificadores diferentes, contadores
de clics y eventos de red/consola distinguibles. Añadir dos páginas del mismo
origen: comparar hostnames no basta para demostrar identidad.

La reproducción debe mantener A activa y abrir B en segundo plano. Registrar
destino pedido, comando enviado, respuesta y destino observado. Repetir con
reconexión, cierre de B y dos llamadas simultáneas. Una simulación de la
extensión debe permitir retrasar respuestas y emitir eventos antiguos.

## 1. Destino estable por operación — prioridad crítica

### Hallazgos del código

- `Helmet.ensureAttached()` puede recurrir a `attachToActiveTab()` cuando pierde
  la referencia actual. Esa función selecciona la pestaña activa o la primera
  utilizable.
- `actCore()` ignora errores de `ensureAttached()` y continúa.
- `TabRegistry.locationHref()` convierte los errores en una cadena vacía.
  `switchVerified()` puede devolver éxito usando la URL del inventario, incluso
  si no pudo verificarla. La comparación existente solo distingue hostnames.
- `TabRegistry.openVerified()` informa de la URL evaluada sin demostrar que
  procede de la pestaña creada.
- `ExtensionServer.send()` consulta el destino mutable al enviar cada comando.
  `serveMCP()` permite solapamiento entre solicitudes asíncronas.
- Abrir o cambiar pestaña invoca `detachAll()`, que puede interferir con las
  pestañas adjuntas de otras sesiones.

### Solución

Separar el destino elegido por el agente del foco visual del usuario. Capturar
al inicio una referencia con sesión, instancia de navegador, generación de
conexión y `tabId`. Para acciones sobre elementos, incluir identidad del
documento y comprobar que las referencias siguen vigentes.

El transporte de la operación debe usar esa referencia explícita en todos sus
comandos. Una selección concurrente no puede cambiarla. Empezar serializando
las operaciones que comparten estado mutable de una misma sesión; las lecturas
de estado y cancelaciones deben poder responder mientras otra operación espera.
No usar una cola global que bloquee otras sesiones.

Revalidar propiedad y generación inmediatamente antes de ejecutar en el extremo
que controla el navegador. Tras desconectarse, intentar recuperar únicamente
la pestaña seleccionada. Si desapareció o no puede verificarse, fallar con un
error tipado; la recuperación no debe seleccionar otra pestaña.

La identidad no se demuestra con la URL. Correlacionar el destino CDP y la
respuesta; tratar las redirecciones como navegación del mismo destino.
Representar por separado pestaña creada, adjunta y verificada. No anunciar
`state_integrity: known` si la comprobación falló.

Sustituir el desacoplamiento global por gestión de adjuntos por sesión y
pestaña, con referencias cuando varias sesiones autorizadas comparten un
destino. No retirar el debugger que otra sesión sigue utilizando.

### Pruebas de aceptación

- A activa, B abierta en segundo plano: evaluar y clicar solo afecta a B.
- Dos páginas con el mismo origen no se confunden.
- B cerrada o desconectada: ninguna acción termina en A.
- Cambio de pestaña concurrente, respuesta tardía o mensaje de una generación
  anterior: no redirigen la operación.
- Cambiar el destino de una sesión no desconecta el de otra.
- Verificación fallida produce un resultado explícito, sin falso éxito.

Archivos: `src/helmet.ts`, `src/connection/tab-registry.ts`,
`src/connection/extension-server.ts`, `src/connection/broker-client.ts` y ambas
variantes de `background.js`.

## 2. Eventos y sensores aislados — prioridad crítica

### Hallazgos del código

`ExtensionEvent` contiene `tabId`, pero el adaptador `on(method, handler)`
entrega únicamente `params`. Los sensores Audio y Thermal mantienen buffers
globales. Comprobar que el argumento `tabId` coincide con la selección actual
no demuestra el origen de lo almacenado. El broker entrega eventos a sus
consumidores locales antes de enrutarlos al cliente propietario.

### Solución

Conservar la identidad de origen durante todo el recorrido: extensión, broker,
suscripción, sensor y resultado. Aplicar autorización antes de entregar eventos
a consumidores locales o remotos. Suscribirse explícitamente a las pestañas de
usuario autorizadas, evitando el broadcast a otras sesiones.

Separar buffers por instancia, generación y pestaña; distinguir documentos o
épocas de navegación. Correlacionar peticiones con esa clave y `requestId`.
Mantener un límite global de memoria además del límite por pestaña.

`read_network_requests(tabId)` y `read_console_messages(tabId)` deben leer el
buffer autorizado de ese destino, sin cambiar de pestaña. Devolver origen,
intervalo temporal, época y si la captura es completa. Si no se capturó nada,
devolver un estado explícito; nunca rellenar con datos de otra pestaña.

Aplicar el mismo criterio a working memory, diffs, WebSockets y capturas de
cuerpos. La carga asíncrona de un cuerpo debe usar el destino original aunque
la selección haya cambiado. Mantener la sanitización ya implementada.

### Pruebas de aceptación

Eventos intercalados de A y B, IDs repetidos entre destinos, cambio de pestaña,
limpieza de un buffer, reconexión y navegación: cada lectura y cada cuerpo solo
contienen datos de su destino autorizado. El broker no incorpora eventos del
cliente a sus sensores locales por defecto.

Archivos: transporte de eventos, `src/vision/base-sensor.ts`,
`src/vision/thermal.ts`, `src/vision/audio.ts`, suscripciones de `src/helmet.ts`,
working memory y consumidores de eventos afectados.

## 3. Conexión y capacidades operativas — prioridad alta

### Hallazgos del código

`detectCapabilities()` anuncia varias funciones como verdaderas sin comprobar
el enlace. `getLinkState()` existe, pero no explica todo el recorrido de un
cliente hasta la extensión. La comprobación de capacidades consulta la URL
mediante CDP, por lo que también puede quedar esperando al enlace averiado.

### Solución

Crear un diagnóstico rápido basado en estado local, sin `Runtime.evaluate`:
servidor MCP, registro con broker, enlace con extensión, estado de degradación,
generación, pestaña seleccionada, adjunto verificado y última comprobación.
Separar los datos conocidos de los que necesitan una sonda. Ofrecer la sonda
como operación acotada, no como requisito para leer el estado.

Por capacidad, devolver `supported`, `ready`, `authorized` y `reason`.
`authorized` puede ser desconocido o depender del destino/acción: no convertir
la existencia de un gate en una autorización general. Conservar temporalmente
los booleanos anteriores como información de soporte documentada.

Añadir errores tipados para extensión desconectada, broker desconectado,
destino ausente, enlace degradado y generación obsoleta. Para herramientas MCP,
añadir `structuredContent`, `outputSchema` e `isError` conservando el texto
compatible. Las consultas locales de diagnóstico siguen disponibles al fallar
el navegador.

### Pruebas de aceptación

MCP vivo con extensión caída, cliente registrado con broker sin extensión,
WebSocket vivo pero CDP colgado y reconexión sin pestaña verificada se distinguen
sin evaluar una página. Un cliente MCP detecta errores y valida resultados
sin interpretar una cadena JSON.

Archivos: `src/doctrine/capabilities.ts`, estado de broker/extensión,
`src/helmet.ts`, contratos y pruebas de envelope.

## 4. Plazo global y cancelación — prioridad alta

### Hallazgos del código

`actCore()` ejecuta `gatherState()` antes y después de la acción. La recogida
incluye varios sensores y anomalías. El timeout de un comando CDP no limita
todo ese recorrido. Existe cancelación para macros, pero `serveMCP()` no
gestiona `notifications/cancelled`.

### Solución

Crear un contexto de operación con ID, destino fijo, instante de inicio,
deadline, fase y AbortSignal. Propagarlo por cola, observación, acción, broker,
extensión y verificaciones. Cada espera consume el presupuesto restante; no
reinicia el plazo. En equipos distintos, intercambiar presupuestos restantes
evita depender de relojes de pared perfectamente sincronizados.

Generalizar la cancelación de macros para que hereden el plazo de su solicitud
MCP. Registrar operaciones activas por ID MCP. Atender `notifications/cancelled`
sin esperar a la cola de acciones; liberar recursos y descartar respuestas
tardías conforme al protocolo. No basta con un `Promise.race`: el trabajo que
continúe debe tener revocado el envío de nuevos comandos.

Mantener estados `pending`, `running`, `succeeded`, `failed`, `cancelled` y
`outcome_unknown`. Si una mutación ya se envió y se perdió su respuesta,
registrar resultado desconocido y exigir verificación antes de repetir.
Cancelar no deshace lo que el navegador ya ejecutó.

Reducir la observación obligatoria: comprobación mínima de destino y política
antes de actuar, y verificación específica después. Recogida completa bajo
demanda. Un fallo de telemetría posterior no debe convertir una mutación ya
confirmada en candidata a repetición. Medir `queue_ms`, `preflight_ms`,
`action_ms`, `verification_ms` y `elapsed_ms`.

### Pruebas de aceptación

Cancelar mientras está en cola, durante una espera y después de enviar una
acción. Ningún comando nuevo tras cancelación; ninguna repetición automática
de resultado desconocido. Un sensor colgado no multiplica el plazo global.
Comprobar carreras entre finalización y cancelación, macros anidadas y
respuestas antiguas tras reconectar.

Referencia: [cancelación MCP](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation).

## 5. Grupos y fin de tarea — prioridad alta de usabilidad

### Preferencias expresadas por el usuario

- Trabajar siempre dentro de grupos.
- Cerrar los grupos de trabajo al terminar.

### Solución

Ampliar las herramientas de sesión con crear/consultar grupo, incorporar
pestaña existente, renombrar y finalizar. Crear la primera pestaña útil y
agruparla sin dejar una auxiliar `about:blank`. Una creación de pestaña con
fallo de agrupación debe informar del resultado parcial y limpiar únicamente
lo que haya creado esa operación cuando sea posible.

Registrar procedencia de las pestañas: creadas por la tarea o preexistentes
incorporadas temporalmente. Al finalizar, cancelar primero las operaciones de
la tarea, impedir nuevas acciones en ese grupo y cerrar sus pestañas creadas.
Devolver las preexistentes a su grupo/posición anterior cuando sea viable;
no interpretar la preferencia de limpieza como permiso para borrar pestañas
personales. Si el usuario pide explícitamente cerrarlas, se aplica esa orden.

Un `session_finish` idempotente debe devolver pestañas cerradas, restauradas,
fallidas y si el grupo desapareció. Consultar y verificar propiedad justo antes
del cierre; no cerrar un grupo basándose solo en un ID antiguo. Guardar errores
parciales para que repetir la limpieza no afecte a nuevas pestañas ajenas.

El agente debe llamar a `session_finish` antes de terminar la tarea. El servidor
no sabe que una respuesta final del asistente significa fin de tarea salvo que
el host se lo comunique. Añadir ese contrato a la skill de Yautja y al host
cuando exista un evento apropiado. El cierre del proceso es un respaldo, no
una señal fiable de finalización normal.

Eliminar la liberación de grupos por cinco minutos sin herramientas. Mantener
la propiedad con señales de vida independientes; razonar sin llamar herramientas
no equivale a haber muerto. Tras una caída, reconciliar recursos y no cerrar
automáticamente pestañas cuya propiedad no se pueda demostrar.

Aplicar los mismos handlers y pruebas a Brave y Chrome. Mantener diferencias de
instancia en configuración, con una fuente común para estas operaciones.

### Pruebas de aceptación

Crear, abrir, incorporar, renombrar y finalizar. Probar pestañas personales,
dos sesiones, movimiento manual de pestañas, fallo parcial de cierre, segundo
`session_finish`, desconexión durante limpieza y periodo largo de razonamiento.
Al terminar una tarea normal no queda el grupo ni una pestaña auxiliar creada
por ella, y las pestañas preexistentes se conservan.

Referencias: [chrome.tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs)
y [chrome.tabGroups](https://developer.chrome.com/docs/extensions/reference/api/tabGroups).

## 6. Verificación y carga del resultado

Por bloque: regresión que falle antes del cambio y pase después, seguida de las
pruebas del área. Al terminar: `npm run lint`, `npx vitest run`, `npm run build`
y `git diff --check`.

Validar con las páginas locales de prueba en ambas variantes de extensión,
manteniendo una pestaña personal activa y trabajando en un grupo temporal.
Probar desconexiones y concurrencia antes de volver a diagnosticar Instagram.
Cerrar los grupos temporales al finalizar.

La carga del resultado debe coordinar la extensión, el broker y los clientes
MCP. No matar procesos compartidos ni lanzar un servidor stdio suelto como
sustituto. Confirmar versiones y capacidades efectivas tras reiniciar o
reconectar mediante el host correspondiente.

No declarar resuelto un fallo de navegador solo porque pasa un mock, ni confundir
un build escrito en disco con el código que está ejecutando una sesión viva.
