# Yautja — Roadmap Phases 10–18

**Spec ID:** YJ-RM-10.18  
**Fecha:** 2026-07-16  
**Revisión:** r2 (auditoría código + skills + pendientes)  
**Estado:** **COMPLETE (2026-07-26)** — P10–P18 implementadas y verdes (1073 tests, v0.2.0). Ver `docs/envelope-migration-tracker.md` y `docs/CHANGELOG.md`  
**Autor:** Diseño asistido + contexto operador (api-recon, Perplexity OPSEC, Gemini UI)  
**Dependencias:** Phases 1–9 DONE · doctrine library parcial · [yautja-error-contract-1.0.md](../proyectos-pendientes/yautja-error-contract-1.0.md) · [2026-07-15-yautja-error-contract-plan.md](../proyectos-pendientes/2026-07-15-yautja-error-contract-plan.md)  
**Principio rector:** *percepción barata · acción atómica · evidencia redactada · política de dominio embebida*

> **r2 TL;DR:** El roadmap de dirección es **correcto**. Fallos de auditoría: (1) P10 ya tiene `src/doctrine/*` + tests — falta **wire a helmet**; (2) códigos deben ser `YJ.*` no nombres sueltos; (3) reutilizar wait/capture/RecoveryMachine existentes; (4) tab identity + silent listen antes de lo previsto; (5) no inflar MCP con 20 tools si se puede extender `act`/`inspect`; (6) gates bypasseables vía `evaluate`. Ver §0.5 y Appendix D.

---

## 0. North star

### 0.1 Qué es “perfecto” para este operador

| Eje | Criterio de éxito |
|-----|-------------------|
| **OPSEC en UIs de IA** | Perplexity/Gemini: preflight de cuota, zero residual en input, stop duro en CAPTCHA, intercept off por defecto en dominios de alto BM |
| **API recon autorizado** | Superficie API + HAR + evidence store + `browserFetch` con gates P0–P4 en sesión, sin bash/curl ad-hoc |
| **Fiabilidad SPA** | Angular/React contenteditable: type/submit atómico, waits declarativos, errores tipados con recovery |
| **Gestos reales** | Upload/drop/click `isTrusted` cuando la app lo exige; si no hay capacidad, error `CAPABILITY_MISSING` (no fallo silencioso) |
| **Agente** | Envelope `YautjaResponse` en todas las tools; menos tools sueltas, más workflows y perfiles |

### 0.2 Qué no entra en este roadmap

- Bypass garantizado de Cloudflare Bot Management / captchas
- Scanner de payloads / explotación (Hexstrike u otras skills)
- Multi-browser (Firefox/WebKit) como target
- Loop autónomo de hunting dentro del casco (eso es orquestador/skill)
- Duplicar SuperAPI fingerprint suite completa

### 0.3 Vista de fases (r2 — orden ajustado)

```
P10 Wire doctrine → helmet (envelope)  ── library YA existe; cablear + codes
P11 Input Atomicity + RecoveryMachine  ── ensureEmpty / smartType TX
P12 waitForUi (extender act.wait)      ── + extractAnswer; matar sleep ciego
P13 Site Profiles + Preflight/Quota    ── OPSEC por dominio
P13.5 Tab identity + silent listen     ── SPLIT desde P17 (antes era tarde)
P14 browserFetch + Session Gates P0-4  ── api-recon en sesión
P15 apiSurface + HAR + Evidence        ── unificar capture/trace-store
P16 Trusted Gestures + File Upload     ── Gems / Conocimientos
P17 (rest) Snapshots + capture unify   ── lo que quede de P17 original
P18 Backend Router + Hardening         ── Yautja / DevTools / SuperAPI
P19? Excel Web (OUT of this roadmap)   ── ver proyectos-pendientes/
```

**Orden estricto:** P10 → P11 → P12.  
**Promovido (r2):** Tab identity + silent network **antes o junto a P13** (bloquean Perplexity OPSEC y multi-tab Gemini).  
**Paralelo posible:** P13 ∥ P13.5; P14 tras P12; P15 depende de P14 + capture; P16 ∥ P15; P18 al final.

### 0.5 Auditoría r2 — estado real del repo (2026-07-16)

| Componente | Estado real | Implicación en roadmap |
|------------|-------------|------------------------|
| `src/doctrine/*` (types, registry, recovery-machine, trace-store, telemetry, idempotency, classifier…) | **Implementado + tests en `tests/doctrine/`** | P10 ≠ greenfield → **wire + migrate helmet** |
| `src/tools/recovery-stats.ts` | Existe | **No registrado** en `helmet.ts` tools list |
| `helmet.observe/act/inspect` | Devuelve `string` / JSON ad-hoc | Envelope no llega al agente MCP |
| Códigos error arsenal | `SELECTOR_NOT_FOUND`, `TIMEOUT`, … | Registry doctrina usa **`YJ.ACT.*` / `YJ.POLICY.*`** |
| `act` → `wait` | Existe; `networkIdle`/`navigation` son **stubs** (sleep) | P12 = **endurecer**, no inventar tool paralela obligatoria |
| `NetworkCapture` + `capture*` tools | Listen-ish vía Network domain + redaction patterns | P17 silent = **unificar/modos**, no segundo pipeline |
| `intercept*` vs `interceptor*` | **Dos stacks** de intercept | P18 o P17: consolidar o documentar roles |
| `hash-learner` / `learning-loop` / `biofilm` | Código intel avanzado | Roadmap casi no los usa → siteMemory v2 debería engancharlos |
| `sleep(1500)` post-`act` en helmet | Siempre | Taxa fija; P12 debe hacerlo condicional/`waitReady` |
| Excel Web | `proyectos-pendientes/yautja-excel-web-*.md` pausado | **Fuera** de P10–18; no olvidar en backlog global |
| Plan error contract tasks | `2026-07-15-yautja-error-contract-plan.md` Task 1–10 | Alinear P10 con ese DAG, no reescribir módulos |

### 0.6 Política de superficie MCP (r2 — anti-tool-bloat)

Preferencia de diseño al implementar:

| Preferir | Evitar |
|----------|--------|
| Extender `act` (`ensureEmpty`, `wait` predicates ricos, `trustedClick`) | Nueva tool MCP por cada micro-acción |
| Extender `inspect` (`budget`, `apiSurface` como domain) | 8 tools sueltas de recon |
| Subcomandos `profile` / `gate` / `evidence` con `action:` | 12 tools planas sin namespacing |
| Envelope + fewer verbs | Llegar a 80+ tools sin taxonomía |

Objetivo blando: **net +15 tools máximo** al cerrar P18 (hoy ~60); el resto como `act.type` o `inspect.domain`.

### 0.4 Estimación global

| Fase | Esfuerzo orientativo | Tests nuevos (min) | Breaking? |
|------|---------------------:|-------------------:|-----------|
| 10 | 4–6 días | 40 | No (shim) → sí al quitar shim |
| 11 | 3–5 días | 35 | No |
| 12 | 3–4 días | 30 | No |
| 13 | 4–5 días | 25 | No |
| 14 | 4–6 días | 40 | No |
| 15 | 5–7 días | 45 | No |
| 16 | 5–8 días | 30 | No |
| 17 | 4–6 días | 35 | Parcial (openTab contract) |
| 18 | 3–5 días | 20 | No |
| **Total** | **~6–10 semanas** (1 dev part-time) | **~300** | — |

---

## Phase 10 — Error Contract + Response Envelope

### 10.1 Objetivo

Toda tool MCP devuelve `YautjaResponse` (success/error simétrico). El agente decide reintentar / reattach / abortar / pedir permiso sin parsear strings.

### 10.1b Estado r2 (no greenfield)

| Ya existe | Falta |
|-----------|--------|
| `src/doctrine/types.ts` → `YautjaResponse`, `success()`, `failure()` | Helmet devuelve strings; no usa `success/failure` |
| `registry.ts` MVP codes `YJ.*` | Códigos P11+ (`TYPE_PARTIAL`, gates, quota) **no registrados** aún |
| `recovery-machine.ts` PREFLIGHT→EXECUTE→VERIFY→COMMIT | No envuelve `smartType` / `act` |
| `trace-store.ts`, `telemetry.ts`, `idempotency.ts` | No expuestos como MCP resources; telemetry no wired |
| `classifier.ts` ArsenalError → YJ.* | act path aún serializa `ArsenalError` legacy |
| `tools/recovery-stats.ts` | **No** en `TOOLS` de helmet |
| tests/doctrine/* (unit + integration scenarios) | tests e2e helmet envelope |

**P10 redefinido:** *wire + migrate + register missing codes*, no reimplementar doctrine.

### 10.2 Referencia normativa

- Spec: [yautja-error-contract-1.0.md](../proyectos-pendientes/yautja-error-contract-1.0.md) (YJ-ERR-1.0)  
- Plan de tareas: [2026-07-15-yautja-error-contract-plan.md](../proyectos-pendientes/2026-07-15-yautja-error-contract-plan.md) — **continuar Task 9–10** (wire arsenal + recovery-stats + integration), no Task 1–8 desde cero.

### 10.3 Módulos

| Archivo | Responsabilidad | r2 |
|---------|-----------------|-----|
| `src/doctrine/*` | Envelope, registry, recovery, traces | **REUSE** — no recrear |
| `src/doctrine/registry.ts` | Añadir codes de P11–P14 cuando toque | EXTEND |
| `src/helmet.ts` | Middleware: toda tool → `YautjaResponse` JSON | **MAIN WORK** |
| `src/arsenal/errors.ts` | Ya tiene shim classifier | completar paths |
| `src/arsenal/action-types.ts` | `ActionResult` → alinear con envelope | MODIFY (plan Task 9) |
| `src/tools/recovery-stats.ts` | Registrar en MCP tools list | WIRE |
| `tests/helmet/envelope-wire.test.ts` | observe/act/inspect envelope | NEW |

### 10.4 Envelope mínimo (recordatorio)

```typescript
type YautjaResponse<T> =
  | {
      ok: true;
      result: T;
      operation: OperationMeta;
      state: StateMeta;
      evidence: EvidenceMeta;
      context: ContextMeta;
      schema_version: "1.0";
    }
  | {
      ok: false;
      error: {
        code: string;
        category: "TRANSIENT" | "PERMANENT" | "POLICY" | "OPSEC" | "CAPABILITY" | "USER";
        message: string;
        agent_summary: string; // siempre EN
        state_integrity: "unknown" | "known" | "corrupted" | "restored" | "contaminated";
        recover: RecoveryHint[];
        next_tool_call?: { tool: string; args?: Record<string, unknown> };
      };
      operation: OperationMeta;
      state: StateMeta;
      evidence: EvidenceMeta;
      context: ContextMeta;
      schema_version: "1.0";
    };
```

### 10.5 Códigos prioritarios

**Usar siempre el namespace del registry** (`YJ.<FAMILY>.<NAME>`). Los nombres cortos de r1 son alias mentales, no strings de wire.

| Alias r1 (NO usar en wire) | Code real / a registrar | Cuándo |
|----------------------------|-------------------------|--------|
| SELECTOR_NOT_FOUND | `YJ.ACT.DOM_TARGET_NOT_FOUND` | **ya en registry** |
| (stale) | `YJ.ACT.DOM_TARGET_STALE` | **ya** |
| CDP / nav race | `YJ.ACT.NAVIGATION_RACE` | **ya** |
| missing idempotency | `YJ.ACT.ACTION_NOT_IDEMPOTENT` | **ya** |
| context budget | `YJ.CAPTURE.CONTEXT_BUDGET_EXCEEDED` | **ya** |
| domain permission | `YJ.POLICY.DOMAIN_PERMISSION_REQUIRED` | **ya** |
| opsec abort | `YJ.OPSEC.ANOMALY_RISK_ELEVATED` | **ya** |
| TYPE_PARTIAL | `YJ.ACT.TYPE_PARTIAL` | **registrar en P11** |
| TYPE_RETRY_BLOCKED | `YJ.ACT.TYPE_RETRY_BLOCKED` | P11 |
| INPUT_NOT_CLEARABLE | `YJ.ACT.INPUT_NOT_CLEARABLE` | P11 |
| SUBMIT_NO_EFFECT | `YJ.ACT.SUBMIT_NO_EFFECT` | P11 |
| WAIT_TIMEOUT | `YJ.ACT.WAIT_TIMEOUT` | P12 |
| QUOTA_EXHAUSTED | `YJ.POLICY.QUOTA_EXHAUSTED` | P13 |
| CAPTCHA_DETECTED | `YJ.OPSEC.CAPTCHA_DETECTED` | P13 |
| POLICY_GATE_DENIED | `YJ.POLICY.GATE_DENIED` | P14 |
| CAPABILITY_MISSING | `YJ.PROTOCOL.CAPABILITY_MISSING` | P16 |
| TAB_SWITCH_MISMATCH | `YJ.ACT.TAB_SWITCH_MISMATCH` | P13.5 |
| TAB_DETACHED | `YJ.NET.SESSION_STATE_UNKNOWN` o code tab nuevo | reattach |

### 10.6 Migración (4 sub-fases)

| Sub | Duración | Qué |
|-----|----------|-----|
| 10a Shim | 1–2 días | Envelope envuelve strings legacy; `result.legacy_text` |
| 10b Core tools | 2 días | `observe`, `act`, `inspect`, `diff`, `listTabs`, `reattach` nativos |
| 10c Intel tools | 1–2 días | intercept, capture, gql, stealth, techScan |
| 10d Tracker | — | `docs/envelope-migration-tracker.md` por tool; deprecate shim en P18 |

### 10.7 Acceptance criteria

- [ ] 100% tools listadas en MCP devuelven envelope parseable por Zod
- [ ] `schema_version: "1.0"` en handshake MCP (serverInfo metadata o resource)
- [ ] Tests: success path, error path, redaction de `Authorization` y `Set-Cookie`
- [ ] Skill `yautja/SKILL.md` actualizado: “si `ok:false`, seguir `error.recover`”
- [ ] Backward: agentes viejos siguen leyendo `content[0].text` (shim JSON stringificado del envelope)

### 10.8 Non-goals P10

- No cambiar semántica de actions
- No site profiles todavía
- No evidence store completo (solo stubs de resource URI)

---

## Phase 11 — Input Atomicity

### 11.1 Objetivo

Eliminar residuales de `smartType`/`findType` en contenteditable (Gemini, Perplexity). Type = transacción: begin → write → verify → optional submit → waitReady | rollback.

### 11.1b r2 — no reinventar la recovery machine

Envolver `smartType` / `ensureEmpty` con **`RecoveryMachine`** existente (`PREFLIGHT → EXECUTE → VERIFY → COMMIT`), no un state machine paralelo en `type-transaction.ts`.

| Paso RecoveryMachine | Mapping type TX |
|----------------------|-----------------|
| PREFLIGHT | profile preflight + ensureEmpty + stealth required? |
| EXECUTE | key events / insertText |
| VERIFY | triple-check DOM contains text (o vacío post-rollback) |
| COMMIT | siteMemory hit update + clear retry block |
| ROLLBACK | ensureEmpty + `state_integrity: contaminated` |

**Extra r2 (faltaba en r1):** `pasteText` / `type` con modo `clipboard` para prompts largos (Gemini/Perplexity). El stealth char-a-char a 30–150ms es **inviable** para 2–8k tokens. Opciones:

1. `Input.insertText` en un shot (rápido, menos humano)
2. Clipboard write + Ctrl+V con key events (más isTrusted-ish)
3. Híbrido: stealth solo si `text.length < N` (ej. 80)

Sin esto, “perfecto en UIs de IA” no se cumple para el caso real del operador.

### 11.2 Módulos

| Archivo | Responsabilidad |
|---------|-----------------|
| `src/arsenal/ensure-empty.ts` | Limpieza Angular/React-compatible |
| `src/arsenal/type-transaction.ts` | Orquestación TX de tipeo |
| `src/arsenal/action-types.ts` | Nuevos action types + tool schemas |
| `src/memory/input-session.ts` | Último fallo por selector/tab (anti-reintento ciego) |
| `tests/arsenal/ensure-empty.test.ts` | |
| `tests/arsenal/type-transaction.test.ts` | |

### 11.3 Tools / actions nuevas

#### `ensureEmpty`

```typescript
// MCP tool: ensureEmpty
{
  query?: string;          // text/aria find (preferido)
  selector?: string;       // CSS explícito
  strategy?: "auto" | "execCommand" | "selectAll" | "force";
  backup?: boolean;        // default true → session memory
}
// result:
{
  wasClean: boolean;
  afterClean: boolean;
  strategyUsed: string;
  residualBackupId?: string;  // si había residual
  selectorResolved: string;
}
```

**Algoritmo `auto`:**
1. Resolver elemento (finder o selector).
2. Leer `innerText` / `textContent` / `value` (triple check).
3. Si limpio → return.
4. `selectNodeContents` + `document.execCommand('delete')` + `InputEvent('input')`.
5. Re-triple-check.
6. Si aún sucio y strategy permite → `force` (innerHTML='' + input event) solo como último recurso.
7. Si falla → `TYPE_REJECTED` / `INPUT_NOT_CLEARABLE`.

#### `smartType` (breaking behavior, same tool name)

```typescript
{
  query: string;
  text: string;
  submit?: boolean;
  stealth?: boolean | "auto";
  transactional?: boolean;     // default true a partir de P11
  verify?: boolean;            // default true: DOM must contain text
  clearFirst?: boolean;        // default true
  onPartial?: "rollback" | "leave" | "error";  // default "rollback"
  waitReady?: WaitSpec;        // ver P12; opcional aquí
}
// result:
{
  source: "cache" | "discovered";
  selector: string;
  typed: boolean;
  verified: boolean;
  submitted: boolean;
  rolledBack: boolean;
  stealthUsed: boolean;
}
```

**Regla anti-reintento:** si el mismo `(tabId, selectorResolved)` falló con `TYPE_PARTIAL` en los últimos 30s → error `TYPE_RETRY_BLOCKED` con `next_tool_call: ensureEmpty` o `navigate reload`.

### 11.4 Códigos de error nuevos

| Code | state_integrity | Recovery |
|------|-----------------|----------|
| `TYPE_PARTIAL` | contaminated | ensureEmpty → retry once |
| `TYPE_REJECTED` | known | inspect dom / alternate selector |
| `TYPE_RETRY_BLOCKED` | contaminated | ensureEmpty o reload |
| `INPUT_NOT_CLEARABLE` | known | reload tab |
| `SUBMIT_NO_EFFECT` | known | waitForUi / findClick send |

### 11.5 Acceptance criteria

- [ ] Fixture local HTML: contenteditable React-like + Angular-like; residual se limpia
- [ ] Tras timeout simulado mid-type → DOM vacío si `onPartial=rollback`
- [ ] Doble smartType sin ensureEmpty tras fallo → `TYPE_RETRY_BLOCKED`
- [ ] Actualizar `inspecting-perplexity` y `inspecting-gemini` skills: Paso 0b puede delegar en `ensureEmpty`

### 11.6 Non-goals P11

- Stream extract (P12)
- File upload trusted (P16)

---

## Phase 12 — waitForUi + Stream Extract

### 12.1 Objetivo

Sustituir `sleep 8–12` y lecturas mid-stream por waits declarativos y extracción chunked de respuestas largas.

### 12.1b r2 — basarse en lo existente

- Hoy: `BrowserAction` ya tiene `wait` + `WaitCondition` (`selector|navigation|networkIdle|function|timeout`).
- Hoy: `translator.waitFor` — **stubs**: `navigation` y `networkIdle` hacen `sleep` y return true.
- Hoy: `helmet.act` siempre hace `sleep(1500)` post-acción.

**P12 debe:**
1. Implementar de verdad `networkIdle` (Thermal sensor / request count).
2. Añadir predicados nuevos al **mismo** `WaitCondition` (ariaBusy, textSettled, urlMatch, noPulse).
3. Tool MCP `waitFor` **opcional** — puede ser azúcar de `act({type:'wait',...})`; no duplicar dos APIs divergentes.
4. Quitar o hacer configurable el `sleep(1500)` global (ej. solo si no hay `waitReady`).

### 12.2 Módulos

| Archivo | Responsabilidad |
|---------|-----------------|
| `src/arsenal/action-types.ts` | Extender `WaitCondition` |
| `src/arsenal/translator.ts` | Implementar predicados reales (no stubs) |
| `src/arsenal/wait-for-ui.ts` | Motor compartido si crece |
| `src/arsenal/extract-answer.ts` | Extract settled + chunk |
| `src/vision/busy-detector.ts` | Heurísticas aria-busy / pulse / network |
| `src/helmet.ts` | sleep(1500) condicional |
| `tests/arsenal/wait-for-ui.test.ts` | |
| `tests/arsenal/extract-answer.test.ts` | |

### 12.3 Tool `waitFor`

```typescript
type WaitPredicate =
  | { type: "selector"; selector: string; state: "attached" | "visible" | "hidden" | "detached" }
  | { type: "urlMatch"; pattern: string }           // regex
  | { type: "ariaBusy"; root?: string; value: false }
  | { type: "noPulse"; root?: string }              // sin .animate-pulse en root
  | { type: "networkIdle"; quietMs: number }
  | { type: "textSettled"; selector: string; stableMs: number; minLength?: number }
  | { type: "fn"; expression: string }              // evaluate → truthy
  | { type: "timeout"; ms: number };

// MCP: waitFor
{
  anyOf?: WaitPredicate[];
  allOf?: WaitPredicate[];
  timeoutMs?: number;   // default 30000
  pollMs?: number;      // default 250
}
// result:
{
  matched: "anyOf" | "allOf" | "timeout";
  which?: number;       // index del predicado
  elapsedMs: number;
  snapshot?: { url: string; title: string };
}
```

Si timeout → `ok:false`, code `WAIT_TIMEOUT`, recover: inspect/observe.

### 12.4 Tool `extractAnswer`

```typescript
{
  root?: string;              // default "main"
  waitUntil?: "now" | "settled";  // settled = textSettled + ariaBusy false
  stableMs?: number;          // default 800
  chunkChars?: number;        // default 6000; 0 = single blob
  scrubSelectors?: string[];  // e.g. nav, [role=navigation], button
  maxChars?: number;          // safety cap
}
// result:
{
  text: string;
  chunks?: string[];
  length: number;
  waitedMs: number;
  truncated: boolean;
}
```

### 12.5 Integración

- `smartType({ waitReady: { allOf: [...] } })` reutiliza el mismo motor.
- `act({ type: "wait", ... })` legacy sigue; documentar deprecación suave hacia `waitFor`.

### 12.6 Acceptance criteria

- [ ] Página fixture que rellena texto en 3 fases → `extractAnswer waitUntil=settled` solo al final
- [ ] `textSettled` no dispara en mid-stream (simular append cada 100ms)
- [ ] Chunking: texto 20k → N chunks sin truncado silencioso en el primer read
- [ ] Docs skill Perplexity: reemplazar “wait 8–12s” por `waitFor` + `extractAnswer`

---

## Phase 13 — Site Profiles + Preflight / Quota

### 13.1 Objetivo

Política por dominio **en el casco**, no solo en skills. Preflight aborta acciones caras antes de tipear.

### 13.2 Layout en disco

```
~/.yautja/profiles/
  perplexity.yaml
  gemini.yaml
  default.yaml
D:/Yautja/profiles/          # shipped defaults (repo)
  perplexity.yaml
  gemini.yaml
  default.yaml
```

Prioridad: user profile > shipped default > hardcode.

### 13.3 Schema de perfil (YAML → Zod)

```yaml
# profiles/perplexity.yaml
id: perplexity
version: 1
match:
  hosts: ["www.perplexity.ai", "perplexity.ai"]
rules:
  intercept: forbid              # forbid | allow | silent_only (P17)
  stealth: required              # off | preferred | required
  maxAgentQueriesPerSession: 1
  preType: ensureEmpty
  onCaptcha: stop_hard           # stop_hard | warn | ignore
  allowEvaluateFetch: limited    # none | limited | full
preFlight:
  - id: read_quota_cookie
    type: cookieJson
    name: pplx.metadata
    decode: uriComponent
  - id: abort_if_qcd_high
    type: abortIf
    path: "preFlight.results.read_quota_cookie.qcd"
    op: ">"
    value: 15
    code: QUOTA_EXHAUSTED
waitDefaults:
  ready:
    allOf:
      - { type: ariaBusy, value: false }
      - { type: noPulse, root: "main" }
notes: "No intercept. One agent query per ~5 manual. See investigacion/perplexity-opsec-y-baneos.md"
```

### 13.4 Módulos

| Archivo | Responsabilidad |
|---------|-----------------|
| `src/doctrine/site-profile.ts` | Load/match/validate |
| `src/doctrine/preflight.ts` | Ejecutar checks + abort |
| `src/vision/economic-sensor.ts` | Sensor “budget/quota” (pluggable) |
| `src/tools/profile-tools.ts` | MCP tools |
| `tests/doctrine/site-profile.test.ts` | |

### 13.5 Tools MCP

| Tool | Args | Result |
|------|------|--------|
| `profileList` | — | perfiles cargados |
| `profileLoad` | `{ id? \| path? }` | perfil activo para tab |
| `profileStatus` | — | match host, rules efectivas, last preflight |
| `preflight` | `{ action?: "type"\|"navigate"\|"intercept" }` | pass/fail + reasons |

**Enforcement:** si perfil dice `intercept: forbid` y se llama `interceptEnable` → `POLICY_GATE_DENIED` (no silent ignore).  
Si `stealth: required` y stealth off → auto-`stealthEnable` o fail configurable (`stealthEnforcement: auto|strict`).

### 13.6 Economic sensor (mínimo viable)

```typescript
// inspect domain nuevo: "budget" o campo en observe
{
  domainProfile: "perplexity",
  quota: {
    source: "cookie:pplx.metadata" | "unknown",
    qcd?: number,
    remainingHint?: string,
    lastBurnAt?: string
  },
  estimatedCostOfNextTypeSubmit: "1_query" | "none" | "unknown"
}
```

Pluggable: `src/doctrine/quota-readers/perplexity.ts`, `gemini.ts` (usage page = opcional, no auto-navigate).

### 13.7 Acceptance criteria

- [ ] En host perplexity, `interceptEnable` → deny con code claro
- [ ] `preflight` con qcd simulado 20 → `QUOTA_EXHAUSTED`
- [ ] CAPTCHA fixture → `CAPTCHA_DETECTED` + stop (no retry loop)
- [ ] Profiles shipped en repo + merge con `~/.yautja/profiles`
- [ ] Skills Perplexity/Gemini referencian profile IDs

### 13.8 Non-goals P13

- UI para editar profiles
- Auto-navegación a `/usage` de Gemini

### 13.9 r2 — huecos de perfiles / multi-cuenta

| Hueco | Por qué importa | Mitigación |
|-------|-----------------|------------|
| Multi-cuenta Gemini `/u/{N}/` | Misma host, distinto estado/plan | Profile match por path prefix opcional; tab-scoped memory |
| Overlays Angular (`.cdk-overlay-pane`) | Mode picker / menus no están en “main” DOM compact | Finder: include `role=menu` portals; inspect flag `includeOverlays` |
| iframe / cross-origin widgets | reCAPTCHA, pagos, embeds | Capability limit documentado; no fake success |
| Build version invalidation | Gemini boq_* cambia selectores | siteMemory entry `buildVersion` (P18) + profile note |
| CF Access `/restricted/*` | Perplexity ban vector | profile `urlDenyRegex` en preflight navigate |

---

## Phase 13.5 — Tab Identity + Silent Network Listen *(promovido desde P17)*

### 13.5.1 Por qué no puede esperar a P17

Bugs y reglas que el operador **ya padece**:

- `openTab` a veces reporta URL de la pestaña activa (skill Gemini).
- Perplexity: **forbid Fetch intercept** pero aún se necesita ver tráfico API → mode `listen` ya parcialmente en `NetworkCapture`.
- Multi-tab Gemini + Perplexity + target recon en la misma sesión Brave.

### 13.5.2 Entregables

1. **Tab registry canónico** (`src/connection/tab-registry.ts`): `openTab` → `{ tabId, url, attached, previousActiveTabId }` verificado post-attach.
2. **`switchTab` verify** `location.href`; error `YJ.ACT.TAB_SWITCH_MISMATCH`.
3. **Capture modes unificados:**
   - `listen` = Network domain + buffer (default seguro; alinear `captureSetActive` / interceptorPull).
   - `intercept` = Fetch domain (profile-gated).
4. Documentar diferencia `intercept*` (reglas Fetch) vs `interceptor*` (pipeline intel) **o** deprecar uno en P18.

### 13.5.3 Acceptance

- [ ] 2 tabs: openTab B reporta URL de B
- [ ] Profile perplexity: interceptEnable deny; capture listen allow
- [ ] No regresión en captureList body redaction (PATTERNS ya en network-capture)

---

## Phase 14 — browserFetch + Session Gates (P0–P4)

### 14.1 Objetivo

`fetch` con cookie jar de la pestaña, rate limit, redacción, y **gates de intrusión** al estilo api-recon-yautja, enforced en runtime.

### 14.2 Gates en sesión

```typescript
// estado en ~/.yautja/sessions/<session_id>/gates.json
{
  sessionId: string;
  defaultGate: "P0";
  grants: Array<{
    level: "P0" | "P1" | "P2" | "P3" | "P4";
    scope: { hosts: string[]; pathPrefix?: string; methods?: string[] };
    grantedAt: string;
    grantedBy: "user_phrase";
    phrase: string;           // audit
    maxRequests?: number;
    maxRps?: number;
    expiresAt?: string;
  }>;
}
```

Tools:

| Tool | Función |
|------|---------|
| `gateStatus` | grants activos |
| `gateGrant` | solo si el **usuario** lo pide en chat; el agente no auto-grant |
| `gateRevoke` | `{ level? \| all }` |

**Hard rule:** default `P0`. `browserFetch` mutante sin grant → `POLICY_GATE_DENIED`.

### 14.3 Tool `browserFetch`

```typescript
{
  url: string;
  method?: "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  credentials?: "include" | "omit";  // default include
  gate: "P0" | "P1" | "P2" | "P3" | "P4";
  maxRps?: number;
  timeoutMs?: number;
  redactResponse?: boolean;          // default true
  captureAsEvidence?: boolean;
}
// result:
{
  status: number;
  statusText: string;
  headers: Record<string, string>;   // set-cookie redacted by default
  body: string | { redacted: true; sha256: string; bytes: number };
  timingMs: number;
  evidenceId?: string;
  gateUsed: string;
}
```

**Mapeo gate → métodos permitidos (default policy):**

| Gate | Métodos | Auth cookies | Mutations |
|------|---------|--------------|-----------|
| P0 | — (no network generated) | — | no; solo analyze local |
| P1 | GET HEAD OPTIONS | no (o yes read-only unauth) | no |
| P2 | GET HEAD OPTIONS | yes | no |
| P3 | + POST PUT PATCH DELETE | yes | yes, synthetic only (policy note) |
| P4 | + load/SSRF-class | yes | requires campaign fields |

Implementación: ejecutar en page context `fetch` **o** CDP `Fetch`/`Network` con cookies de jar — preferir `Runtime.evaluate` async fetch en isolated world para same-origin; cross-origin con credentials según CORS real del browser.

### 14.4 Módulos

| Archivo | Responsabilidad |
|---------|-----------------|
| `src/doctrine/gates.ts` | Grant/check/audit log |
| `src/intel/browser-fetch.ts` | Ejecución + rate limit bucket por host |
| `src/tools/gate-tools.ts` | MCP |
| `tests/doctrine/gates.test.ts` | |
| `tests/intel/browser-fetch.test.ts` | |

### 14.5 Acceptance criteria

- [ ] Sin grant: POST → deny
- [ ] Grant P1 host X: GET ok; POST deny
- [ ] Rate limit: 5 req con maxRps 1 → spacing ≥ ~1s
- [ ] Response con `Authorization` echo no aparece en body no redactado hacia LLM
- [ ] Audit log append-only en `~/.yautja/sessions/.../audit.jsonl`
- [ ] **r2:** `evaluate(fetch(...))` con profile `allowEvaluateFetch: none` → deny o warn+audit
- [ ] **r2:** `gateGrant` sin confirmación de operador (flag de sesión firmado / dry_run) → `user_confirmation_required`

### 14.6 Non-goals P14

- SSRF OAST automático
- Multi-identity cookie jar switcher completo (stub OK)

### 14.7 r2 — agujeros de seguridad del diseño original

1. **`gateGrant` como MCP tool es auto-bypass:** el agente puede llamarse grant a sí mismo. Mitigaciones (elegir una en phase-spec):
   - Grant solo vía fichero `~/.yautja/sessions/.../gates.json` editado por humano / CLI `yautja-gate`
   - O grant requiere `confirmationToken` que el host MCP inyecta solo tras UI de usuario
   - O `gateGrant` solo registra *request*; un proceso local aprueba
2. **`act.evaluate` bypasea browserFetch gates:** profile debe acotar `allowEvaluateFetch`. Sin esto P14 es cosmético.
3. **P0 vs “navigate to target”:** api-recon Phase 1 ya navega; documentar que navigate es P0 de *observación* y no cuenta como probe HTTP de API (distinción en audit).

---

## Phase 15 — apiSurface + HAR + Evidence Store

### 15.1 Objetivo

Salida machine-readable para api-recon: grafo de endpoints, HAR export, evidence content-addressed con redacción.

### 15.1b r2 — unificar stores, no crear el tercero

Hoy ya hay:

| Store | Path / módulo |
|-------|----------------|
| Network captures | `NetworkCapture` → `%APPDATA%/.yautja-network-captures` |
| Doctrine traces | `trace-store` → `~/.yautja/traces/` |
| Site memory | `~/.yautja-memory/*.json` |

P15 debe **definir un layout canónico** (`~/.yautja/{traces,evidence,har,sessions,profiles}`) y migrar/alias. Evitar un cuarto directorio huérfano.

### 15.2 Tool `apiSurface`

```typescript
// args
{
  sources?: Array<"network" | "bundles" | "openapi" | "graphql">; // default all passive
  openapiProbes?: boolean;   // default false; requires gate ≥ P1
  graphqlIntrospect?: boolean; // default false; gate ≥ P1
}
// result
{
  endpoints: Array<{
    method: string | "*";
    path: string;
    origin: string;
    authHint: "none" | "cookie" | "bearer" | "unknown";
    from: Array<"network" | "bundle" | "openapi" | "graphql">;
    confidence: number;
    sampleStatus?: number;
  }>;
  openapi: null | { url: string; title?: string };
  graphql: { url?: string; introspection: boolean; operations: string[] };
  websockets: Array<{ url: string }>;
  generatedAt: string;
}
```

**Bundles:** listar `document.scripts[src]`, fetch (P1) o leer de network cache, regex paths `/api/[A-Za-z0-9_./-]+` con denylist de assets.

### 15.3 HAR export

```typescript
// exportHar
{
  filter?: { urlIncludes?: string; method?: string };
  redact?: boolean;          // default true
  sinceMs?: number;          // ventana temporal
}
// result: { path: string; entries: number; bytes: number }
// file: ~/.yautja/har/<timestamp>-<host>.har
```

Formato HAR 1.2 compatible (Chrome-ish). Bodies grandes → hash + stub.

### 15.4 Evidence store

```
~/.yautja/evidence/<runId>/
  meta.json
  req-<hash>.json.enc?     # optional encryption later; P15 = chmod user-only + redact
  res-<hash>.json
index: ~/.yautja/evidence/index.jsonl
```

Tools:

| Tool | Función |
|------|---------|
| `evidencePut` | from last browserFetch / intercept / manual |
| `evidenceGet` | `{ id, includeRaw?: false }` |
| `evidenceList` | filter by host/run |
| `evidenceExport` | `{ format: "jsonl" \| "sarif-stub" }` |

**Regla:** `includeRaw:true` solo si profile/session flag `analystMode` y nunca como default en observe.

### 15.5 `responseDiff` (mínimo)

```typescript
{
  a: evidenceId | { body: string };
  b: evidenceId | { body: string };
  ignorePaths?: string[];  // jsonpath-ish
}
// result: { added, removed, changed }[]
```

Soporte JSON; text fallback line-diff.

### 15.6 Módulos

| Archivo | Responsabilidad |
|---------|-----------------|
| `src/intel/api-surface.ts` | Merge network + bundles + probes |
| `src/intel/har-export.ts` | |
| `src/intel/evidence-store.ts` | |
| `src/intel/response-diff.ts` | |
| `tests/intel/api-surface.test.ts` | |
| `tests/intel/evidence-store.test.ts` | |

### 15.7 Acceptance criteria

- [ ] Fixture SPA con 3 calls `/api/*` → apiSurface lista los 3 con `from:network`
- [ ] Bundle con string `/api/auth/me` → endpoint con `from:bundle`
- [ ] HAR abre en herramientas estándar (validar schema mínimo)
- [ ] evidenceGet default sin secretos en claro
- [ ] responseDiff detecta field extra en BOLA-style fixture

### 15.8 Non-goals P15

- SARIF 2.1 completo (stub de results OK; skill compone el resto)
- Cifrado age/gpg (fase posterior; documentar TODO)

---

## Phase 16 — Trusted Gestures + File Upload

### 16.1 Objetivo

Acciones que las SPAs verifican con `isTrusted` (Gemini uploads, drag&drop Conocimientos).

### 16.2 Enfoque técnico

| Opción | Pros | Contras |
|--------|------|---------|
| A. CDP `Input.dispatchMouseEvent` + `Page.setInterceptFileChooserDialog` | Nativo Yautja | Complejidad file chooser |
| B. Delegate SuperAPI `file_upload` | Ya funciona en stack operador | Acoplamiento externo |
| C. Híbrido | Yautja intenta A; si falla, `CAPABILITY_MISSING` + hint SuperAPI | Recomendado |

**Decisión roadmap:** **C (híbrido)**.

### 16.3 Tools / actions

```typescript
// trustedClick
{ selector?: string; query?: string; button?: "left"|"right"; clickCount?: number }

// trustedFileChooser
{ triggerSelector | triggerQuery; files: string[]; timeoutMs?: number }
// flow: enable file chooser intercept → trusted click trigger → set files

// trustedDragDrop (stretch)
{ fromSelector; toSelector; files?: string[] }
```

Si el backend no puede garantizar isTrusted:

```json
{
  "ok": false,
  "error": {
    "code": "CAPABILITY_MISSING",
    "agent_summary": "Trusted file upload unavailable; use SuperAPI file_upload or human drop",
    "recover": [{ "action": "delegate", "backend": "superapi", "tool": "file_upload" }]
  }
}
```

### 16.4 Módulos

| Archivo | Responsabilidad |
|---------|-----------------|
| `src/arsenal/trusted-input.ts` | Mouse/key real via CDP |
| `src/arsenal/file-chooser.ts` | Intercept + set files |
| `src/doctrine/capabilities.ts` | Matrix por sesión |
| `tests/arsenal/trusted-input.test.ts` | (Playwright page fixture checking event.isTrusted) |

### 16.5 Tool `capabilities`

```typescript
// result
{
  stealth: boolean;
  intercept: boolean;
  trustedClick: boolean;
  trustedFileChooser: boolean;
  silentNetwork: boolean;      // P17
  browserFetch: boolean;
  backends: { yautja: true; superapi?: "configured"|"missing"; chromeDevtools?: "configured"|"missing" };
}
```

### 16.6 Acceptance criteria

- [ ] Fixture HTML: listener `click` con `if (!e.isTrusted) reject` → trustedClick pasa, evaluate.click falla
- [ ] File chooser fixture: path de test file se adjunta al input
- [ ] Sin soporte → error tipado, no “success” falso
- [ ] Doc Gemini: sección upload apunta a trustedFileChooser o SuperAPI

### 16.7 Non-goals P16

- Drive picker / NotebookLM deep OAuth automation
- Screenshot-based RPA

---

## Phase 17 — Snapshots + Capture Unification *(resto tras P13.5)*

### 17.1 Objetivo (redefinido r2)

Tab identity + silent listen se movieron a **P13.5**. P17 cierra:

1. Session snapshots (cookies/storage/url) con warn OPSEC.
2. Unificación final `intercept*` vs `interceptor*` (deprecar o renombrar).
3. HAR-from-listen edge cases (SW, cached, streamed bodies).
4. MCP **resources** para `resource://yautja/traces/...` (contrato error § resource handler).

### 17.2 Session snapshots

```typescript
// snapshotSave { name }
// snapshotRestore { name, include: ["cookies","localStorage","url"] }
```

Solo same-origin profile lab; warn OPSEC al restaurar cookies de prod.

### 17.3 MCP resources (faltaba en r1)

Exponer traces/evidence vía MCP resources (read-only), TTL 7 días, GC. Sin esto el campo `evidence.snapshot_after` del envelope es URL muerta para el agente.

### 17.4 Acceptance criteria

- [ ] snapshot round-trip en fixture local
- [ ] resource list/read de un trace post-act
- [ ] doc única: cuándo usar intercept vs interceptor vs capture listen
- [ ] deprecation warnings en tools legacy si aplica

---

## Phase 18 — Backend Router + Hardening + Ship

### 18.1 Objetivo

Unificar capacidades entre Yautja, chrome-devtools MCP y SuperAPI; quitar shim de envelope; pulir docs/skills.

### 18.2 Tool `useBackend` / `delegate`

```typescript
{
  capability:
    | "heap_profile"
    | "cpu_profile"
    | "file_upload"
    | "observe"
    | "act"
    | "network_listen";
  args?: Record<string, unknown>;
}
// result: { backend: "yautja"|"chrome-devtools"|"superapi"; ... } | CAPABILITY_MISSING
```

Tabla default:

| Capability | Backend |
|------------|---------|
| observe, act, waitFor, profiles, gates, apiSurface | yautja |
| heap/cpu/coverage | chrome-devtools (si configurado) |
| file_upload isTrusted fallback | superapi |
| network_listen | yautja P17 |

Config: `~/.yautja/backends.json` paths/flags.

### 18.3 Hardening checklist

- [ ] Remover shim legacy text-only (o flag `YAUTJA_LEGACY_SHIM=0` default)
- [ ] Tracker de migración envelope 100% green
- [ ] `learningStatus` / `recovery_stats` wire con outcomes P10
- [ ] siteMemory v2: multi-strategy signatures + TTL + invalidación por `buildVersion` opcional
- [ ] Macros: precondition `stealthCheck.risk` / profile rules
- [ ] Actualizar `docs/SPEC.md` arquitectura (sensors 6 + economic + doctrine)
- [ ] Actualizar `~/.agents/skills/yautja/SKILL.md` + api-recon + inspecting-*
- [ ] Changelog `docs/CHANGELOG.md` entradas P10–P18
- [ ] E2E smoke: `test-e2e.mjs` ampliado (ensureEmpty, waitFor, profile deny intercept)

### 18.4 siteMemory v2 (incluido en hardening)

```typescript
{
  domain: string;
  entries: Array<{
    role: "search" | "password" | "submit" | string;
    strategies: Array<{ kind: "aria" | "css" | "text" | "role"; value: string; score: number }>;
    buildVersion?: string;
    hits: number;
    lastHit: string;
    ttlDays: number;
  }>;
}
```

### 18.5 Acceptance criteria

- [ ] `capabilities` refleja backends configured/missing
- [ ] delegate file_upload documentado y testeado en dry-run
- [ ] Skills actualizadas; roadmap marcado COMPLETE en header cuando se cierre
- [ ] Suite tests ≥ baseline + ~300 de este roadmap; CI local `npm test` green

---

## Cross-cutting concerns

### C1. Versionado

- Roadmap ID: `YJ-RM-10.18`
- Cada fase produce `docs/phase-N-spec.md` **de implementación** (este archivo es el plan maestro; al arrancar una fase se expande el spec detallado como phase-9).
- Envelope `schema_version` independiente del roadmap.

### C2. Orden de docs a generar al implementar

| Al empezar | Crear |
|------------|-------|
| P10 | `docs/phase-10-spec.md` (copy-from error contract + modules) |
| P11 | `docs/phase-11-spec.md` |
| … | … |
| P18 | `docs/phase-18-spec.md` + `docs/CHANGELOG.md` |

### C3. Skills a tocar (checklist)

| Skill | Fases |
|-------|-------|
| `~/.agents/skills/yautja/SKILL.md` | 10–18 |
| `~/.agents/skills/api-recon-yautja/SKILL.md` | 14, 15 |
| `~/.agents/skills/inspecting-perplexity/SKILL.md` | 11, 12, 13, 17 |
| `~/.agents/skills/inspecting-gemini/SKILL.md` | 11, 12, 16 |

### C4. Criterio “fase DONE”

Una fase solo se marca DONE si:

1. Código en `src/` + tests green  
2. `docs/phase-N-spec.md` merged  
3. Acceptance criteria checkboxes en este roadmap marcados (o en el phase-N)  
4. Skills críticas actualizadas si la fase cambia comportamiento observable  
5. Entrada breve en changelog  

### C5. Riesgos

| Riesgo | Mitigación |
|--------|------------|
| Envelope rompe clientes | Shim P10a; quitar solo en P18 |
| listen mode sin bodies | Documentar; intercept solo con grant + profile allow |
| trusted upload flaky en Brave | Híbrido SuperAPI; capability flag |
| Gates bypasseables vía evaluate | Profile `allowEvaluateFetch: none\|limited` + warn en audit |
| Scope creep P15 SARIF | Stub only; skill owns narrative |

### C6. Métricas de éxito (operador)

Tras P13+P11+P12 en producción local:

- 0 incidentes de query Frankenstein por residual en 2 semanas de uso Gemini/Perplexity  
- 0 usos accidentales de intercept en perplexity.ai  
- api-recon P0/P1 sin invocar bash/curl para surface discovery básica  

Tras P14–P15:

- Un run api-recon genera HAR + evidence IDs + apiSurface JSON sin scripts externos  

---

## Quick reference — nuevas tools por fase

| Fase | Tools / actions nuevas o materialmente cambiadas |
|------|--------------------------------------------------|
| 10 | (todas) envelope; `recovery_stats` opcional |
| 11 | `ensureEmpty`; `smartType` transactional |
| 12 | `waitFor`; `extractAnswer` |
| 13 | `profileList`, `profileLoad`, `profileStatus`, `preflight`; inspect `budget` |
| 14 | `gateStatus`, `gateGrant`, `gateRevoke`, `browserFetch` |
| 15 | `apiSurface`, `exportHar`, `evidencePut/Get/List/Export`, `responseDiff` |
| 16 | `trustedClick`, `trustedFileChooser`, `capabilities` |
| 17 | capture mode `listen`; openTab contract; `snapshotSave/Restore` stretch |
| 18 | `delegate` / `useBackend`; siteMemory v2; macros preconditions |

---

## Appendix A — Mapa de dependencias (r2)

```
P10 wire doctrine→helmet
  └──► P11 type TX (RecoveryMachine) + paste/long-text
         └──► P12 wait real + extractAnswer + kill sleep(1500)
                ├──► P13 profiles/preflight/quota
                │      └──► P13.5 tab identity + silent listen
                │             └──► P17 snapshots + MCP resources + unify intercept
                ├──► P14 gates + browserFetch (+ evaluate policy)
                │      └──► P15 apiSurface + HAR + evidence (unify stores)
                └──► P16 trusted gestures ──────────────────────┐
                                                                 ▼
                                                              P18 harden + backends
```

## Appendix B — Primer sprint recomendado (2 semanas) — r2

**Semana 1:** P10 wire — helmet observe/act/inspect/diff/listTabs/smartType → `YautjaResponse`; registrar `recovery_stats`; tests wire. **No reescribir doctrine.**  
**Semana 2:** P11 — `ensureEmpty` + smartType vía RecoveryMachine + long-text paste mode + skills Paso 0b.  

Entrega demable: “agente ve `ok/error.code` YJ.* y tipeo atómico sin residual”.

## Appendix D — Checklist “¿se nos pasó algo?” (auditoría r2)

### Crítico (corregido en r2 del doc)

| # | Hallazgo | Acción |
|---|----------|--------|
| D1 | doctrine ya implementado | P10 = wire |
| D2 | códigos `YJ.*` vs alias r1 | tabla 10.5 |
| D3 | RecoveryMachine no usada en type TX | §11.1b |
| D4 | wait stubs + sleep(1500) | §12.1b |
| D5 | NetworkCapture ya listen | unificar en 13.5/15/17 |
| D6 | tab identity / silent tarde | P13.5 |
| D7 | gateGrant auto-bypass + evaluate | §14.7 |
| D8 | tool bloat | §0.6 |
| D9 | paste/long prompt | §11.1b |
| D10 | Excel Web pendiente | P19? / fuera |
| D11 | recovery-stats no en helmet | P10 wire |
| D12 | MCP resources huérfanos | P17 |
| D13 | dual intercept stacks | 13.5 + 17 |
| D14 | multi-cuenta / overlays / iframe | §13.9 |
| D15 | stores de evidencia fragmentados | §15.1b |

### Importante pero aceptable posponer (backlog, no bloquea P10–12)

| # | Item | Notas |
|---|------|-------|
| B1 | siteMemory × hash-learner / learning-loop | Enganchar en P18 v2 |
| B2 | dry_run global en act | Ya hay code `YJ.POLICY.DRY_RUN_REQUIRED` |
| B3 | Checkpoints DOM reales para ROLLBACK | Recovery strategy existe; snapshot DOM costoso |
| B4 | Cifrado evidence (age/gpg) | Sigue deferred |
| B5 | i18n message locale | agent_summary EN fixed |
| B6 | HUD extension / neural-link loop | Fuera de casco MCP |
| B7 | Rate-limit sensor genérico multi-sitio | Perplexity cookie first; Gemini manual |
| B8 | Accessibility tree target (no solo CSS) | Mejora finder; P18 stretch |
| B9 | Service Worker response body limits | Doc only |
| B10 | Coordinación chrome-devtools solape | P18 delegate |
| B11 | E2E real Brave en CI | Hoy tests unitarios doctrine; planear smoke local |
| B12 | Version bump package.json 0.1.0 → 0.2/1.0 | Al cerrar P10 wire |
| B13 | `inspecting-excel-web` skill | Proyecto aparte |
| B14 | GraphQL recon deep (ya hay gql*) | apiSurface debe **llamar** gql existentes, no reimplementar |
| B15 | WS already first-class | apiSurface.websockets ← wsList |

### Cosas que el roadmap **acertó** (no tocar)

- North star operador (OPSEC AI UIs + api-recon + SPA + isTrusted)
- Non-goals (no CF bypass mágico, no scanner en casco)
- Perfiles por dominio como enforcement real
- Evidence redactada + split tool facts / LLM narrative
- Trusted gestures híbridos SuperAPI
- Orden mental P10 foundation → UX type → waits → policy → recon

### Veredicto r2

| Pregunta | Respuesta |
|----------|-----------|
| ¿Está bien la dirección? | **Sí** |
| ¿Listo para implementar sin cambios? | **No** — aplicar correcciones r2 (sobre todo P10 wire, codes YJ.*, P13.5, gates) |
| ¿Falta algo existencial? | **Paste/long-text**, **evaluate bypass**, **gateGrant trust**, **MCP resources**, **unificación stores/intercept** — ahora documentados |
| ¿Sobrediseño? | Riesgo medio en P15–18; §0.6 y “extender act/inspect” lo mitigan |

**Conclusión:** el roadmap es **sólido como brújula**; r1 pecaba de asumir greenfield y de retrasar tab/silent. Con r2 es **ejecutable**.

## Appendix C — Referencias locales

| Path | Uso |
|------|-----|
| `D:/Yautja/docs/SPEC.md` | Arquitectura base |
| `D:/Yautja/docs/phase-9-spec.md` | Patrón de phase spec |
| `D:/Yautja/proyectos-pendientes/yautja-error-contract-1.0.md` | Norma P10 |
| `D:/Yautja/investigacion/perplexity-opsec-y-baneos.md` | Profile Perplexity |
| `D:/Yautja/investigacion/gemini-operaciones-tecnicas.md` | Profile Gemini / isTrusted |
| `~/.agents/skills/api-recon-yautja/SKILL.md` | Gates P0–P4 semantics |

---

## Estado del documento

| Campo | Valor |
|-------|-------|
| Ubicación | `D:/Yautja/docs/roadmap-phase-10-18.md` |
| Revisión | 2026-07-16 **r2** (auditoría código + skills + pendientes) |
| Próximo paso de implementación | Ejecutar [phase-10-spec.md](./phase-10-spec.md): wire helmet → YautjaResponse |
| Spec de fase | [docs/phase-10-spec.md](./phase-10-spec.md) — “Wire & migrate” (r2, 2026-07-16) |

*Fin del roadmap YJ-RM-10.18*
