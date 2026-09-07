# Corrección de reconexión tras reiniciar el puerto base

Fecha: 5 de septiembre de 2026.

## Causa observada

La extensión de Brave estaba conectada al proceso anterior del puerto 9878.
El MCP de esta conversación había arrancado en el puerto 9876 y se había
declarado broker, aunque no tenía la extensión. Las sondas autenticadas
`brokerInfo` confirmaron `hasExtension: true` en 9878 y `false` en 9876.

El arranque elegía el rol por el puerto ocupado. La reelección solo buscaba
puertos inferiores y dejaba de buscar tras promocionar un proceso a broker.
Además, un cliente registrado dejaba de buscar aunque su broker hubiera
perdido la extensión. Esto permitía mantener procesos vivos sin una ruta
operativa hacia el navegador después de un reinicio.

Chrome estaba cerrado durante la primera comprobación. Durante el diagnóstico
se abrió y su extensión 0.2.0 se conectó al puerto 9999; listar pestañas funcionó.
No se atribuye ese estado inicial al mismo fallo de Brave.

## Cambio

- Todos los procesos, incluido el del puerto base, mantienen la reconciliación.
- Buscan en los diez puertos de su instancia, con autenticación y sondas
  concurrentes acotadas. La elección exige una extensión conectada directamente.
- Una conexión operativa se conserva. Un registro vivo sin extensión vuelve
  a buscar; una ausencia temporal sin otro propietario conserva el registro.
- Un proceso que pasa a cliente no anuncia a sus propios clientes una conexión
  directa ni reenvía sus comandos a través de otro cliente. Cada sesión debe
  registrarse con el propietario directo, conservando su identidad y grupo.
- El apagado espera la búsqueda pendiente y descarta registros tardíos.
  Los eventos y avisos de un cliente sustituido no alteran el enlace nuevo.
- Cuando llega una extensión local, su generación tiene prioridad sobre la
  del enlace anterior durante la transición.

Archivos principales: `src/connection/broker-discovery.ts`,
`src/connection/broker-reelection.ts`, `src/connection/extension-server.ts`
y el arranque en `src/helmet.ts`.

## Validación

Las tres regresiones del fallo de reconexión fallaron antes del cambio y
pasaron después. Se añadieron también comprobaciones de ausencia de rutas
entre clientes y de apagado durante discovery.

- `npx vitest run`: **1.557 pruebas aprobadas en 92 archivos**.
- `npm run build`, `npm run lint` y `npm run check:extensions`: correctos.
- `node scripts/verify-browser-reliability.mjs`: correcto en Brave y Chrome,
  con perfiles temporales y puertos propios autenticados. Incluye las diez
  comprobaciones anteriores y dos nuevas: regreso del puerto base y
  conservación del broker superviviente.
- Tras recuperar el puerto base, se verifica conexión como cliente, misma
  generación que el propietario, apertura y evaluación de una página local,
  y cierre del grupo creado. Los perfiles de prueba se eliminan al terminar.

## Activación

Build generado de Helmet: `e261ecd2ee82f803`.

La corrección está en el backend. No requiere otra actualización de la
extensión. Los procesos MCP que ya estaban abiertos conservan el código que
cargaron al arrancar; deben reiniciarse desde su host para activar este build.
No se han terminado procesos personales ni creado commits.
