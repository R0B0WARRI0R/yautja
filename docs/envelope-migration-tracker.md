# Envelope Migration Tracker — P10–P18

**Spec:** YJ-ERR-1.0 (`proyectos-pendientes/yautja-error-contract-1.0.md`) · Roadmap P10–P18 (`docs/roadmap-phase-10-18.md`)
**Estado:** **ROADMAP P10–P18 COMPLETO (v0.2.0)** — 2026-07-26 · 1073 tests verdes · `docs/CHANGELOG.md`

## Qué está hecho

### P10 — envelope

- Toda respuesta `tools/call` va envuelta en `YautjaResponse` (`schema_version: "1.0"`) vía `Helmet.envelopeToolCall` (`src/helmet.ts`).
- **10b — core tools nativos:** `observe`, `act`, `inspect`, `diff`, `listTabs`, `reattach` con `StateMeta` real, errores `YJ.*` directos vía `arsenalToDoctrine`. Lógica compartida en `observeCore`/`actCore`.
- Envelope pass-through + telemetría de fallos unificada en `envelopeToolCall` (shim y nativos).
- `schema_version: "1.0"` en `initialize`; `recovery_stats` registrada; `TelemetryCollector` wired.

### P11 — input atomicity

- **5 códigos nuevos**: `TYPE_PARTIAL`, `TYPE_REJECTED`, `TYPE_RETRY_BLOCKED`, `INPUT_NOT_CLEARABLE`, `SUBMIT_NO_EFFECT` (`1.1`).
- `src/arsenal/ensure-empty.ts`, `src/arsenal/type-transaction.ts`, `src/memory/input-session.ts`.
- **smartType** nativo transaccional vía RecoveryMachine; **tool `ensureEmpty`**; híbrido r2 stealth≤80/insertText; anti blind-retry 30s.
- Skills Perplexity/Gemini: Paso 0b delega en `ensureEmpty`.

### P12 — waitForUi + stream extract

- **Código nuevo**: `YJ.ACT.WAIT_TIMEOUT` (`1.2`).
- `src/arsenal/wait-for-ui.ts` (motor de predicados: selector, urlMatch, ariaBusy, noPulse, networkIdle real vía `ThermalSensor.getPendingCount`, textSettled, fn, timeout).
- `src/arsenal/extract-answer.ts` (settled + scrub + chunking, sin cortes silenciosos).
- Tools nativas `waitFor`/`extractAnswer`; `smartType({waitReady})`; `translator.waitFor` sobre el motor; `act` sleep condicional (`postActionDelayMs`).
- Skill Perplexity: "wait 8-12s" → `waitFor` + `extractAnswer`.

### P13 — site profiles + preflight/quota

- **3 códigos nuevos** (21 total): `YJ.POLICY.QUOTA_EXHAUSTED`, `YJ.OPSEC.CAPTCHA_DETECTED`, `YJ.POLICY.GATE_DENIED` (`1.3`).
- **Perfiles JSON** (desviación de spec: YAML → JSON; el proyecto no tiene parser YAML y no se justifica la dependencia): `profiles/{perplexity,gemini,default}.json` shipped + override en `~/.yautja/profiles/*.json`. Precedencia user > shipped > hardcode.
- `src/doctrine/site-profile.ts`: schema Zod, `SiteProfileStore` (load/match/register), match por host + `pathPrefix` opcional (multi-cuenta r2), helpers `isInterceptAllowed`/`isUrlAllowed`.
- `src/doctrine/preflight.ts`: checks `cookieJson` (decode uriComponent/base64) + `abortIf` (path punteado, ops numéricos) con mapeo de códigos cortos a `YJ.*`.
- `src/vision/economic-sensor.ts` + `src/doctrine/quota-readers/{perplexity,gemini}.ts`: vista budget/quota pasiva (cookie `pplx.metadata.qcd`; Gemini unknown — sin auto-navegación a /usage).
- **Enforcement en helmet:**
  - `interceptEnable` en dominio con `intercept: forbid` → `YJ.POLICY.GATE_DENIED`.
  - `act navigate` a URL que matchea `urlDenyRegex` del perfil destino → `YJ.POLICY.GATE_DENIED` (CF Access /restricted).
  - `smartType` en dominio con perfil: CAPTCHA `stop_hard` → `YJ.OPSEC.CAPTCHA_DETECTED` (sin retry); preflight → abort con código mapeado (`QUOTA_EXHAUSTED`); `maxAgentQueriesPerSession` con contador de burn por dominio; `stealth: required` → auto-enable (strict → GATE_DENIED).
- **Tools nativas:** `profileList`, `profileLoad` (id|path, valida Zod y registra), `profileStatus` (perfil + budget + queryBurn + lastPreflight), `preflight` (action type/navigate/intercept).
- Skills Perplexity/Gemini referencian sus profile IDs.
- Tests: `tests/doctrine/site-profile.test.ts` (11), `tests/doctrine/preflight.test.ts` (8), `tests/vision/economic-sensor.test.ts` (8), envelope-wire +6.

### P13.5 — tab identity + silent listen

- **Código nuevo** (22 total): `YJ.ACT.TAB_SWITCH_MISMATCH` (`1.3.5`).
- `src/connection/tab-registry.ts`: identidad canónica de pestañas.
  - `openVerified`: captura `previousActiveTabId` ANTES de abrir, adjunta con retry, y reporta la URL **verificada** (`location.href` post-attach) — arregla el bug de `openTab` reportando la URL de la pestaña activa anterior.
  - `switchVerified`: verifica `location.href` tras attach; si ambas URLs parsean y los hosts difieren → mismatch. Sin falsos positivos con `about:blank`.
- **`openTab`/`switchTab` nativos** con envelope: `previousActiveTabId`/`previousTabId`, `attached`, URL verificada; tab inexistente → INVALID_ARGUMENT; mismatch → `YJ.ACT.TAB_SWITCH_MISMATCH`.
- **Capture modes documentados:** `listen` = Network domain + buffer (`capture*`, default seguro, sin gating) vs `intercept` = Fetch domain (`intercept*`, profile-gated P13). Duplicidad `intercept*` (reglas Fetch) vs `interceptor*` (pipeline intel GQL): se mantiene; candidata a deprecación en P18.
- Tests: `tests/connection/tab-registry.test.ts` (7), envelope-wire +3, registry 22 códigos.

### P14 — browserFetch + session gates

- `src/doctrine/gates.ts`: grants P0–P4 persistidos en `~/.yautja/sessions/<session>/gates.json`, `audit.jsonl` append-only, `RateLimiter` por host, evidencia content-addressed (`ev_<sha256>`). Mapeo: P1=GET sin cookies, P2=GET con cookies, P3=mutations, P4=exóticos. **Hard rule: default P0.**
- `src/intel/browser-fetch.ts`: fetch en page context (cookie jar de la pestaña, CORS real) con `AbortController` timeout; headers sensibles eliminados (`set-cookie`, `x-api-key`…); cuerpo con secretos enmascarados por defecto (`redactResponse`); cap `maxBodyChars` con flag `truncated`.
- **Tools nativas:** `gateStatus`, `gateGrant` (phrase del usuario OBLIGATORIA — mitigación r2 del auto-bypass; queda en audit como `grantedBy: user_phrase`), `gateRevoke`, `browserFetch` (check → rate limit → execute → consume → audit; `captureAsEvidence` → `evidenceId`).
- **Gate de `evaluate(fetch)` (r2):** `act evaluate/evaluateAsync` con `fetch(|XMLHttpRequest` → perfil `allowEvaluateFetch: none` → `YJ.POLICY.GATE_DENIED`; `limited`/`full` → permitido con audit.
- Grants con `maxRequests` (consume tras cada request), `expiresAt`, scope host/pathPrefix/methods.
- Tests: `tests/doctrine/gates.test.ts` (14, incl. acceptance "sin grant POST deny", "grant P1: GET ok POST deny", rate limit spacing), `tests/intel/browser-fetch.test.ts` (11, script real contra fake fetch, redacción), envelope-wire +5.

### P15 — apiSurface + HAR + evidence store

- **Layout canónico** (r2): `%APPDATA%/.yautja/{sessions,evidence,har,profiles}` — evidence y HAR nuevos van al layout; `NetworkCapture` mantiene su dir legacy `.yautja-network-captures` (alias documentado; migración diferida para no romper tooling existente).
- `src/intel/api-surface.ts`: endpoints desde red capturada (normalización `/users/123` → `/users/{id}`, authHint cookie/bearer/none) + paths `/api/*` en bundles JS cargados (script in-page, denylist de assets). `mergeEndpoints` fusiona con matching difuso por método `*` (bundle) — bug corregido en desarrollo: los endpoints de bundle nunca fusionaban con los de red.
- `src/intel/har-export.ts`: HAR 1.2 válido; headers sensibles eliminados y secretos enmascarados por defecto; bodies >64KB → stub `sha256:` (sin truncado silencioso).
- `src/intel/evidence-store.ts`: content-addressed (`ev_<sha256>`), scrubbed en disco por defecto, `index.jsonl`, filtros host/runId, export JSONL.
- `src/intel/response-diff.ts`: diff JSON profundo `{added, removed, changed}` con dotted paths + ignorePaths; fallback line-diff para texto.
- **Tools nativas:** `apiSurface`, `exportHar`, `evidencePut` (manual o `fromLastFetch`), `evidenceGet` (`includeRaw` solo con `YAUTJA_ANALYST_MODE=1`, si no → GATE_DENIED), `evidenceList`, `responseDiff`.
- Tests: api-surface (7, fixture SPA 3 calls + bundle `/api/auth/me`), har-export (7, schema mínimo + stubs), evidence-store (6, sin secretos en disco), response-diff (6, BOLA field extra), envelope-wire +6.

### P16 — trusted gestures + file upload

- **Código nuevo** (23 total): `YJ.PROTOCOL.CAPABILITY_MISSING` (`1.6`) — regla dura: sin capacidad → error tipado, nunca éxito falso.
- `src/arsenal/trusted-input.ts`: click con `isTrusted:true` vía `Input.dispatchMouseEvent` (compute click point → pressed/released con button/clickCount).
- `src/arsenal/file-chooser.ts`: **path A** — input[type=file] directo con `DOM.setFileInputFiles`; **path B** — trigger button: `Page.setInterceptFileChooserDialog` + trustedClick + `fileChooserOpened` + setFileInputFiles con backendNodeId. Sin soporte (sin event channel, intercept no soportado, timeout de chooser) → `CAPABILITY_MISSING` con hint de delegación (SuperAPI file_upload), enfoque híbrido C del roadmap.
- `src/doctrine/capabilities.ts`: matriz de sesión (stealth, intercept profile-aware, trustedClick, trustedFileChooser, silentNetwork, browserFetch, backends).
- **Tools nativas:** `trustedClick` (selector|query, button, clickCount), `trustedFileChooser` (valida que los ficheros existen en disco), `capabilities`.
- Skill Gemini: sección upload apunta a `trustedFileChooser`/`trustedClick` con fallback SuperAPI.
- Tests: trusted-input (6, secuencia CDP + click point fake DOM), file-chooser (7, paths A/B, timeouts, CAPABILITY_MISSING), capabilities (3), envelope-wire +3.

### P17 — snapshots + capture unification + MCP resources

- `src/memory/session-snapshot.ts`: captura/restaura cookies + localStorage + url. Cookies de dominio ajeno al origin actual se omiten (contadas en `skippedForeign`); restaurar cookies en host no-lab → `opsecWarning` explícito.
- **Tools nativas:** `snapshotSave`, `snapshotList`, `snapshotRestore` (include: cookies/localStorage/url).
- **MCP resources:** `resources/list` (traces + evidence, con GC TTL 7 días antes de listar) y `resources/read` (`resource://yautja/traces/...` y `resource://yautja/evidence/<id>`); initialize ahora anuncia `capabilities.resources`. El campo `evidence.*` del envelope ya no es una URL muerta.
- `TraceStore.findExpired` implementado (era stub) + `purgeExpired` + `listTraces`; `EvidenceStore.gc(7)`.
- HAR edge cases: respuestas cached/SSE/SW sin body → `comment: "no body captured"` en vez de cuerpo vacío.
- `docs/capture-modes.md`: doc única — cuándo usar listen / intercept / interceptor GQL / browserFetch. Sin deprecaciones aún; rename `interceptor*` → `gqlCapture*` propuesto para P18.
- Tests: session-snapshot (8, round-trip, foreign cookies, OPSEC warning lab vs prod), trace-store purgeExpired, envelope-wire +5 (snapshots, resources list/read, unknown uri).

### P18 — backend router + hardening + ship

- `src/doctrine/backends.ts` + tool `delegate`: routing observe/act/network_listen → yautja, heap/cpu → chrome-devtools, file_upload → superapi. Config `~/.yautja/backends.json` + env (`SUPERAPI_URL`, `YAUTJA_CDP_REMOTE`). Dry-run (la invocación cross-proceso queda en el stack del operador); sin backend configurado → `YJ.PROTOCOL.CAPABILITY_MISSING`. `capabilities` ahora lee la misma config.
- **Shim kill-switch:** `YAUTJA_LEGACY_SHIM=0` → tools no migradas fallan tipado (`CAPABILITY_MISSING`) en vez de usar el shim legacy. Útil para CI anti-regresión.
- **siteMemory v2** (`src/memory/site-memory.ts`): entradas con `strategies[]` (aria/css/text/role + score), `hits`/`lastHit`, `ttlDays` por entrada, `buildVersion` opcional. v1 entries siguen funcionando; `getInput` filtra expiradas; smartType usa `getInput` + `recordHit`.
- **Macros precondition:** `macro_run` consulta perfil (`onCaptcha: stop_hard` + señales captcha) → `YJ.OPSEC.CAPTCHA_DETECTED` antes de ejecutar.
- **Docs de cierre:** `docs/CHANGELOG.md` (P10–P18), addendum arquitectura en `docs/SPEC.md`, SKILL.md (tools P11–P18 + flujos), roadmap header → COMPLETE, `test-e2e.mjs` ampliado (envelope, ensureEmpty, waitFor, profiles, gates).
- **Version bump:** 0.1.0 → 0.2.0 (package.json, serverInfo, HAR creator).
- Tests: backends (9), site-memory v2 (7), envelope-wire +2 (delegate, shim flag).

## Estado por grupo de tools

| Grupo | Tools | Estado |
|-------|-------|--------|
| Core | observe, act, inspect, diff, listTabs, reattach | ✅ nativo 10b |
| Smart input | smartType, ensureEmpty | ✅ nativo P11 |
| Waits/extract | waitFor, extractAnswer | ✅ nativo P12 |
| Profiles | profileList, profileLoad, profileStatus, preflight | ✅ nativo P13 |
| Tabs | openTab, switchTab | ✅ nativo P13.5 (verificados) |
| Gates/fetch | gateStatus, gateGrant, gateRevoke, browserFetch | ✅ nativo P14 |
| Recon | apiSurface, exportHar, evidencePut, evidenceGet, evidenceList, responseDiff | ✅ nativo P15 |
| Trusted | trustedClick, trustedFileChooser, capabilities | ✅ nativo P16 |
| Snapshots | snapshotSave, snapshotList, snapshotRestore | ✅ nativo P17 |
| Backends | delegate | ✅ nativo P18 (dry-run) |
| MCP resources | resources/list, resources/read | ✅ P17 |
| Doctrine | recovery_stats | ✅ nativa |
| **Todo lo demás** | closeTab, find*/siteMemory, intercept*, capture*, gql*, techScan, stealth*, osint/netIntel, ws*, macro_*, ext*, tm*, learningStatus | ✅ nativo **10c** |

## Pendiente (post-roadmap)

- [x] **10c COMPLETA (2026-07-27):** 100% de tools nativas vía codemod (100 returns) + helper `native()` (clasifica shapes legacy de error, preserva payload). **Shim eliminado** (`detectLegacyError` y el path de strings borrados; `handleToolCall` solo devuelve `YautjaResponse`).
- [x] Telemetría `recovered`: `RecoveryMachine.onOutcome` registra outcomes `recovered` cuando un retry tiene éxito tras un fallo (helmet lo cablea a `TelemetryCollector`).
- [x] Biofilm: estado visible en `learningStatus` (`biofilm.getState()`), opt-in sin auto-init (no spawnea tabs).
- [x] Multi-sesión: puertos configurables (`YAUTJA_PORT`, `YAUTJA_PROXY_PORT`, `YAUTJA_CDP_REMOTE_PORT`) + `docs/multi-session.md` con la receta y las limitaciones honestas.
- [ ] Rename propuesto `interceptor*` → `gqlCapture*` (ver `docs/capture-modes.md`).
- [ ] `ContextMeta.available_window_tokens` configurable por perfil de modelo.
- [ ] Economic sensor: campo `budget` en `observe` (hoy solo vía `profileStatus`).
- [ ] **Riesgo residual r2 (documentado):** `gateGrant` es MCP tool — el agente PUEDE llamarla con una phrase inventada. Mitigación actual: phrase obligatoria + audit + hard rule P0. Mitigación fuerte pendiente: grants solo vía fichero/CLI `yautja-gate`, o `confirmationToken` del host MCP.
- [ ] Delegate: invocación real cross-proceso (hoy dry-run).
- [ ] MITM proxy: HTTPS solo dominio (CONNECT), sin desencriptar contenido — limitación documentada; activar MITM real requiere CA instalada (`extNetwork installCert`).

## Notas de diseño

- `act()` (API directa) devuelve JSON puro (`{success, value, changes[]}`) y comparte lógica con el path nativo vía `actCore`. Lo mismo para `observe()`/`observeCore`.
- El envelope se aplica solo en la frontera MCP (`serveMCP`). La API directa (`helmet.observe/act/inspect/diff`) sigue devolviendo strings legacy para macros y consumidores internos.
- `EvidenceMeta` se emite con `redacted: true, redaction_policy: ['secrets']` por defecto (la redacción real de headers la hace `NetworkCapture`).
- El state tracker no se marca `contaminated` en rollback: en doctrine `contaminated` es terminal (brickearía la sesión). La contaminación del input se señala vía `TYPE_PARTIAL` + rollback ejecutado.
- `textSettled` exige texto no vacío para disparar: un stream que aún no empieza no "settlea".
- Los perfiles inválidos en disco se ignoran silenciosamente: un JSON roto del usuario nunca debe impedir el arranque del casco.
- `TabRegistry.openVerified` prefiere `location.href` verificado pero cae al URL reportado por la extensión si la verificación viene vacía (página aún sin cargar).
