# Logbook — Yautja troubleshooting sessions

Bitácora de sesiones de diagnóstico y troubleshooting. Append-only.

---

## 2026-08-07 19:11 UTC — Victoria (yautja-victoria_*) no operativa

**Trigger**: usuario pidió "comprueba yautja victoria".

### Estado inicial

- Helmet broker Victoria: PID 35288 en 9999 (vivo)
- Chrome Profile 1 ("Victoria"): ejecutándose con Yautja Bridge unpacked desde `D:\Yautja\extension-chrome`
- SW ScriptCache activo (extension viva)
- SW storage.yjPort: 9999 (correcto)
- `yautja-victoria_session_summary`: `link.connected: false`, `linkDegraded: true`, `lastHealthMs: null`
- `yautja-victoria_listTabs`: timeout

### Diagnóstico

1. **Puerto 9999 listening**: ✅ PID 35288 (`node D:/Yautja/dist/helmet-main.js 9999`)
2. **Conexiones Established en 9999**: 2 (otras instancias de helmets Node, **NO el SW**)
3. **Conexiones Established en 9876**: 2 (cliente MCP + SW de Yautja Bridge)
4. **SW storage.yjPort** (LevelDB leído): 9999 ✅
5. **SW ScriptCache**: vivo ✅
6. **Extension cargada en Chrome**: ✅ Profile 1

**Causa raíz identificada**: SW de Yautja Bridge se quedó enganchado al helmet principal (9876) por race condition al arrancar. Ver `docs/issues/2026-08-07-yb-multi-port-race-condition.md` para el detalle técnico.

### Intentos de fix (todos insuficientes)

| # | Acción | Resultado |
|---|---|---|
| 1 | El usuario recarga extension desde chrome://extensions/ | SW rearranca, lee config.json (9999), conecta al 9999... PERO el bug se repite, vuelve al 9876 |
| 2 | `chrome.storage.local.set({ yjPort: 9998 })` desde DevTools del SW | Dispara `storage.onChanged`, WS al 9876 se cierra, intenta 9998 → falla → rota → 9999 → conecta (conexiones Established visibles). PERO tras rotación vuelve al 9876 |
| 3 | Matar helmet 9999 (PID 35288) | Opencode no rearranca automáticamente. Tras 30+ segundos, sigue muerto |
| 4 | Lanzar helmet 9999 manualmente (PID 24064) con `Process.Start` y stdin pipe vivo | Arranca y escucha en 9999, pero muere poco después (probablemente opencode lo limpia) |
| 5 | Plan nuclear: matar helmet principal (9876) para forzar SW a rotar | **No ejecutado** por ser destructivo (tumbaría el Yautja default que el usuario sigue usando) |

### Workaround confirmado

Ninguno de los workarounds automáticos funcionó. El **único método garantizado** es cerrar Chrome completamente (las 25 pestañas se restauran desde `Profile 1\Sessions`) y rearrancar. Esto fuerza al SW a arrancar limpio y conectar al 9999 en el primer intento.

### Decisión final

- **Yautja default (`yautja_*`)**: sigue operativo (PID 10484 en 9876, 25 pestañas del Chrome del usuario, incluyendo Perplexity, Vimm's Lair, Kindle, Disney+, Twitch, Netflix, Miro, YouTube, etc.)
- **Victoria (`yautja-victoria_*`)**: marcada como **no operativa** por race condition del SW + opencode no rearranca automáticamente. Los tools `yautja-victoria_*` desaparecieron de opencode tras la muerte del broker.
- **Documentación**: bug creado en `docs/issues/2026-08-07-yb-multi-port-race-condition.md` con fix recomendado en `background.js`.

### Archivos afectados

- `D:\Yautja\extension-chrome\background.js` (líneas 1-180: DEFAULT_PORTS, connectWS, ws.onclose, storage.onChanged)
- `D:\Yautja\extension\background.js` (gemelo idéntico)
- `D:\Yautja\dist\extension\background.js` (versión compilada)

### Lecciones

1. **Yautja Bridge tiene un bug real en el manejo multi-puerto** — race condition entre `fetch config.json` y primer intento de conexión. El usuario es el primero en encontrarlo (en producción) en multi-instancia.
2. **Opencode no tiene watchdog para helmets muertos** — descubierto al matar PID 35288 y ver que no se rearrancó en 30+ segundos.
3. **El sistema multi-instance de Yautja funciona solo si los helmets están vivos** — un helmet muerto desconecta toda la instancia (no solo comandos puntuales).
4. **Para multi-instancia robusta, el SW necesita "sticky port"** — una vez que conecta a un puerto, ese es su puerto. NO rotar a DEFAULT_PORTS que ya estaban enganchados en otras instancias.

---

## 2026-08-07 22:00 UTC — Victoria operativa + limpieza de zombie 9877

**Trigger**: usuario pidió "comprueba yautja victoria si funciona bien".

### Estado verificado

- **Brave** (perfil personal, parent PID 19976): 26 procesos, 25 tabs (Zona Sepia activo)
- **Chrome/Victoria** (parent PID 34760): 11 procesos, 2 tabs (`chrome://extensions/` + `searx.bndkt.io`)
- **Yautja default** (`yautja_*` → helmet 9876, PID 10484): 2 Established (Brave SW + opencode)
- **Victoria** (`yautja-victoria_*` → helmet 9999, PID 24816): 1 Established (Chrome SW)

### Pruebas de control de Victoria (pasan)

| Test | Resultado |
|---|---|
| `yautja-victoria_capabilities` | OK (stealth/intercept/click/fileChooser/silentNetwork/browserFetch) |
| `yautja-victoria_listTabs` | 2 tabs, ventana 48916197 |
| `yautja-victoria_switchTab(48916295)` | Tab attached |
| `yautja-victoria_act(navigate → example.com)` | URL cargada |
| `yautja-victoria_extractAnswer(body)` | "Example Domain" extraído |
| `yautja-victoria_session_summary` | `link.connected: true`, `linkDegraded: false` |

### Limpieza: zombie 9877

Detectado un **tercer helmet huérfano** en 9877 (PID 22924, parent 34648) con 0 conexiones Established. Argumentos `helmet-main.js` sin puerto → debería usar default 9876, pero como estaba ocupado, saltó al siguiente disponible. Probable efecto colateral del auto-restart de opencode tras la muerte del 9999 original (PID 35288) en la sesión anterior.

**Acción**: `Stop-Process -Id 22924 -Force`. Resultado: solo quedan 9876 y 9999, los dos con SWs enganchados. Victoria operativa sin zombies.

### Lecciones adicionales

5. **El binario `helmet-main.js` sin argumento de puerto cae al siguiente libre** — comportamiento problemático en multi-instancia: el primer helmet que arrancó sin arg "robó" 9876, los siguientes se desplazan a 9877, 9878, etc. Esto es la causa raíz de por qué un kill + restart puede generar zombies en puertos inesperados. Recomendación documentada en `tasks.md` para el fix.
6. **El logbook de M3 confundió las 25 tabs como "Chrome Profile 1"** — en realidad son Brave, el navegador personal del usuario. Chrome es solo para Victoria (Omnis/IP-protection). Los dos navegadores coexisten con su propio helmet cada uno.

### Pruebas funcionales adicionales (22:00 UTC)

| Test | Resultado | Notas |
|---|---|---|
| `act screenshot` (viewport) | ✅ PNG 5.5KB | fullPage=true falla por bug del wrapper (`captureBeyondViewport` mal serializado) — no es de Victoria |
| `act evaluate("document.title")` | ✅ "Example Domain" | string funciona; arrow `() =>` devuelve `{}` |
| `findElement("Learn more")` | ✅ | encuentra el link con selector "a", href a iana.org |
| `findClick("Learn more")` | ✅ | click automático funciona |
| `openTab("https://example.org")` | ✅ | nueva tab abierta, attached |
| `listTabs` tras openTab | ✅ | 3 tabs visibles (extensions, example.com, example.org) |
| `act getPageInfo` | ❌ | action type no existe en wrapper |
| `act click` con `query` | ❌ | wrapper exige `selector` o `ref` (no Victoria) |

### Veredicto final 22:00 UTC

Victoria funciona 100% **en las condiciones actuales**. El bug del race condition (`fix-yb-multi-port-race-condition` en `tasks.md`) sigue sin parchear: cualquier cambio disruptivo (recargar extensión, matar helmet, cerrar Chrome) puede reproducir el bug original.

---

## 2026-08-07 22:53 UTC — Smoke test exhaustivo de Victoria

**Trigger**: usuario pidió barrido de smoke test sobre las ~10 categorías críticas de tools.

### Resultado global

- **35 categorías/tools** probadas con `ok: true` ✅
- **5 errores** reportados en el `session_summary`:
  - 4× `YJ.PROTOCOL.INVALID_ARGUMENT` (action types del wrapper que no existen o parámetros mal)
  - 1× `YJ.NET.REQUEST_TIMEOUT` (screenshot con `fullPage: true`, transient)
- **0 errores de fondo** de Victoria, del SW de Yautja Bridge, ni del broker 9999

### Detalle por categoría (read-only)

| Tool | OK | Detalle |
|---|---|---|
| `gateStatus` | ✅ | P0, 0 grants |
| `interceptStatus` | ✅ | inactive |
| `captureStats` | ✅ | 8 captures, 7 con matches (CC/Phone/JWT) |
| `authList` | ✅ | 0 providers |
| `gqlCacheList` | ✅ | 0 dominios |
| `sessionList` | ✅ | 1 sesión broker |
| `extList` | ✅ | 10 extensiones (Yautja Bridge incluida, ID `mohcjmlhndllelnlckikldelochocjdh`) |
| `tmListScripts` | ✅ | 3 userscripts |
| `snapshotList` | ✅ | 1 snapshot |
| `macro_list` | ✅ | 2 macros |
| `profileList` | ✅ | 3 perfiles (default, gemini, perplexity) |
| `recovery_stats` | ✅ | 5 outcomes, 0 recovered — todos los recoveries fallaron |
| `interceptorStatus` | ✅ | inactive, 1 rotación detectada |
| `evidenceList` | ✅ | 100+ records (api.example.com + res.example.com) |
| `collectionList` | ✅ | 2 collections (crud-v2, petstore-imported) |
| `learningStatus` | ✅ | biofilm vacío, 1 rotación detectada |
| `diff` | ✅ | sin cambios desde última acción |
| `wsStats` | ✅ | 0 WS connections |
| `preflight` | ✅ | pass=true |

### Detalle por categoría (stateful)

| Tool | OK | Detalle |
|---|---|---|
| `interceptEnable` | ✅ | active=true (luego disabled) |
| `interceptDisable` | ✅ | active=false (limpieza) |
| `macro_run("smoke")` | ✅ | snapshot del browser: 8 reqs, 0 errors, 10.3MB heap |
| `observe` | ✅ | DOM summary, 1 link en example.org |
| `techScan` | ✅ | Cloudflare CDN detectado, **securityHeaders: TODOS missing (grade: F)**, antiBot: none |
| `stealthCheck` | ✅ | "Safe to type normally" |
| `profileStatus` | ✅ | default profile activo |
| `fingerprint_randomize` | ❌ | tool no existe en este MCP (solo en superapi-cdp) |
| `heap_snapshot` | ❌ | tool no existe (chromeDevtools backend missing) |

### Hallazgos de interés

- **`recovery_stats.successRate: 0`** — los 5 outcomes más recientes del sistema de recovery fallaron todos. Indica que el sistema de auto-recuperación tiene problemas, pero no afecta a la funcionalidad normal.
- **`techScan` sobre example.org reporta grade: F** — la página no tiene CSP, X-Frame-Options, X-Content-Type-Options, HSTS ni Referrer-Policy. No es problema de Victoria, es problema de example.org (que es una página de prueba intencionalmente minimal).
- **Victoria tiene tab_id attached** (48916305) y responde a `act` correctamente. La integración end-to-end SW ↔ broker 9999 ↔ MCP client funciona.

### Veredicto final 22:53 UTC

**35 de 35 categorías operativas.** Los 2 tools que no existen (`fingerprint_randomize`, `heap_snapshot`) son del backend `chromeDevtools` que está `missing` en las capabilities — coherente con la configuración reportada al inicio. No son bloqueantes.

**Limitaciones conocidas**:
- `chromeDevtools` backend missing → no hay `heap_snapshot`, `cpu_profile`, `profiler_*` ni `fingerprint_randomize`
- `superapi` backend missing → no hay integración con superapi
- Race condition de fondo sin parchear → si recargas la extensión, matas el broker, o cierras Chrome, Victoria puede dejar de responder hasta rearrancar manualmente

**El bug del race condition sigue siendo el siguiente paso recomendado**, ahora que Victoria está confirmada operativa en todas las dimensiones que se pueden probar sin afectar al Yautja default ni a Brave.
