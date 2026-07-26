# Capture modes — cuándo usar cada uno (P17, doc única)

Yautja tiene cuatro caminos para ver o generar tráfico HTTP. No son intercambiables.

| Modo | Tools | Mecanismo | Ve bodies | Perfil-gated | Cuándo usarlo |
|------|-------|-----------|-----------|--------------|----------------|
| **listen** (default seguro) | `captureSetActive`, `captureList`, `captureStats`, `captureBody`, `captureRequest`, `captureResponse`, `captureClear` | CDP Network domain (pasivo) | Sí (vía `Network.getResponseBody`) | No | Observar tráfico de la página sin tocarla. Siempre disponible, incluso en dominios con `intercept: forbid` (Perplexity). |
| **intercept** | `interceptEnable`, `interceptAddRule`, `interceptLog`, … | CDP Fetch domain (activo: modify/block/mock/redirect) | Sí, y los puede alterar | **Sí** (P13: `intercept: forbid` → `YJ.POLICY.GATE_DENIED`) | Bloquear ads/trackers, mockear respuestas, modificar headers al vuelo. Alto riesgo de detección anti-bot. |
| **interceptor** (pipeline GQL) | `interceptorStart`, `interceptorPull`, `interceptorStatus`, `capturedGql`, … | Script inyectado (`Page.addScriptToEvaluateOnNewDocument`) que wrappea fetch/XHR | Solo GQL (op + hash + body truncado) | No | Aprender persisted query hashes (Twitch/GQL), detectar rotaciones. |
| **browserFetch** | `browserFetch` (+ `gateGrant`/`gateStatus`/`gateRevoke`) | `fetch()` en page context con el cookie jar de la pestaña | Sí (redactado por defecto) | **Sí** (P14: session gates P0–P4) | API recon autorizado: llamar a la API de la web desde su propio cliente, con gates, rate limit y audit. |

## Reglas rápidas

1. **Default: `listen`.** Si solo necesitas ver, no actives nada más.
2. **`intercept` es el modo más detectable.** En dominios con Cloudflare BM / Datadog RUM, el Fetch domain deja huella. Los perfiles P13 lo prohíben donde corresponde.
3. **`browserFetch` no es un bypass de `intercept: forbid`**: tiene sus propios gates (P0 por defecto). Para Perplexity, la lectura de API es pasiva (`listen` + cookie quota preflight).
4. **`interceptor*` (GQL) no duplica `intercept*`**: el primero es un script de página para hashes GQL; el segundo es Fetch domain genérico. Su renombrado/deprecación se evalúa en P18.
5. **HAR export** (`exportHar`) usa `listen`: SW/cache/streams sin body aparecen como `comment: "no body captured"`, no como cuerpo vacío.

## Estado de deprecación

Ninguna tool está deprecada a día de hoy. En P18 se evaluará:
- Renombrar `interceptor*` → `gqlCapture*` para eliminar la confusión con `intercept*`.
- Unificar `captureBody` (hint textual) con las reglas `log` de `interceptAddRule`.
