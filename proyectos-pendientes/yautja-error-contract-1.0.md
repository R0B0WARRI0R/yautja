# Yautja Error Contract v1.0

**Spec ID:** YJ-ERR-1.0
**Fecha:** 2026-07-15
**Estado:** Aprobado para planificación (pendiente implementación)
**Autor:** Jordic Carranza + revisión asistida
**Origen:** Investigación Perplexity (prioridad #1: "transacciones atómicas + errores tipados") + diseño iterativo

---

## 1. Contexto y motivación

Yautja MCP tiene ~60 herramientas que devuelven errores inconsistentes: exceptions sin clasificar, null returns, strings genéricos como "FAILED". El agente no puede decidir robustamente si reintentar, reobservar, restaurar, pedir permiso o abortar.

Este spec define un **contrato de errores tipados** que actúa como capa de control transversal conectando DX del agente, gestión de contexto, observabilidad, seguridad, recuperación y arquitectura.

**Principio rector:** el error no es solo un mensaje — es un contrato operacional que le dice al agente exactamente qué puede hacer a continuación.

---

## 2. Decisiones de diseño (14 resoluciones)

| # | Decisión | Resolución |
|---|---|---|
| 1 | Schema versioning | MAJOR.MINOR. MINOR = aditivo. MAJOR = breaking. Código lleva `introduced_in` y `deprecated_since`. Deprecados se mantienen 2 MAJOR. Server declara `max_supported_schema` en handshake. |
| 2 | operation_id vs trace_id | **1 trace = N operations**. `trace_id` = intención lógica (ej. "loguearse"). `operation_id` = invocación individual. Traces anidables (macros). Ambos ULID. |
| 3 | idempotency_key | Generado por el **caller**. ULID. Yautja cachea `{key → result}` TTL 24h. Obligatorio para side-effects. Opcional para read-only. |
| 4 | state_integrity | 5 valores: `unknown` · `known` · `corrupted` · `restored` · `contaminated`. Contaminated = NO auto-recoverable. |
| 5 | evidence.redacted | Redacción declarativa: `secrets` (siempre), `pii` (default), `sensitive_dom` (default). Campo `redaction_policy: [...]` detalla. Sin redactar en capa diferida con ACL. |
| 6 | available_window_tokens | Calculado por Yautja core. Cliente declara `agent_context_window` en handshake. Trackeo `cumulative_tokens_emitted` por trace. Campo `confidence: high\|medium\|low`. |
| 7 | Agent desvía next_tool_call | Advisory no mandatory. Log `deviated_from_recovery: true`. 3+ desviaciones → warning `RECOVERY_DEVIATION_PATTERN`. |
| 8 | Versionado de códigos | **Inmutables.** Semántica nueva = código nuevo. Viejos deprecados pero nunca eliminados. Agentes matchean por `category + pattern`. |
| 9 | i18n | `agent_summary` siempre EN. `message` sigue locale del cliente. Códigos siempre ASCII EN. Locales custom = plugin. |
| 10 | OPSEC vs POLICY | POLICY = reglas enforced (permisos, rate-limit). OPSEC = amenazas detected (identidad, fingerprint). Flujo: OPSEC detecta → escalate a POLICY → POLICY decide. |
| 11 | Telemetría | Evento `recovery_outcome` post-recuperación. Alimenta `learningStatus`. Ajustes human-reviewed. Nueva tool `yautja_recovery_stats`. |
| 12 | resource:// handler | Servido por Yautja MCP via MCP resources. TTL 7 días. Storage local (`~/.yautja/traces/`) o S3. GC cron. Mismo agente o admin. |
| 13 | Migración backward | 4 fases: shim (sem 1-2) → incremental native (mes 1-3) → deprecate shim (mes 3-6) → remove shim (mes 6+). Tracker por tool. |
| 14 | SUCCESS simétrico | Toda respuesta lleva envelope. `ok: true` + `result` o `ok: false` + `error`. Mismos operation/state/evidence/context. |

---

## 3. Envelope YautjaResponse

Toda tool devuelve este envelope, sin importar si es success o error.

### 3.1 SUCCESS

```json
{
  "ok": true,
  "result": { "...tool-specific payload..." },
  "operation": {
    "tool": "yautja_act",
    "action_type": "click",
    "operation_id": "op_01J...",
    "trace_id": "tr_01J...",
    "attempt": 1,
    "max_attempts": 3,
    "idempotency_key": null
  },
  "state": {
    "session_id": "ses_...",
    "tab_id": 4,
    "origin": "https://target.example",
    "checkpoint_id": "cp_post_click",
    "state_integrity": "known"
  },
  "evidence": {
    "snapshot_after": "resource://yautja/traces/tr_01J/dom/44",
    "network_window": "resource://yautja/traces/tr_01J/network?window=3000",
    "redacted": true,
    "redaction_policy": ["secrets", "pii"]
  },
  "context": {
    "consumed_tokens_estimate": 412,
    "available_window_tokens": 7188,
    "confidence": "medium"
  },
  "schema_version": "1.0"
}
```

### 3.2 ERROR

```json
{
  "ok": false,
  "error": {
    "code": "YJ.ACT.DOM_TARGET_STALE",
    "introduced_in": "1.0",
    "category": "action",
    "severity": "recoverable",
    "retryable": true,
    "retry_strategy": "REOBSERVE_THEN_RETRY",
    "user_confirmation_required": false,
    "message": "El objetivo cambió después de resolver el selector.",
    "agent_summary": "Selector resolved to a different node than expected. Re-observe with interactive_delta profile and resolve target again. Do not retry with the same selector handle.",
    "recovery": {
      "allowed": ["REOBSERVE_THEN_RETRY", "ROLLBACK_TO_CHECKPOINT", "ABORT"],
      "recommended": "REOBSERVE_THEN_RETRY",
      "next_tool_call": {
        "name": "yautja_observe",
        "arguments": { "profile": "interactive_delta", "since_snapshot": "snap_42" }
      }
    }
  },
  "operation": {
    "tool": "yautja_act",
    "action_type": "click",
    "operation_id": "op_01J...",
    "trace_id": "tr_01J...",
    "attempt": 2,
    "max_attempts": 3,
    "idempotency_key": "ik_01J..."
  },
  "state": {
    "session_id": "ses_...",
    "tab_id": 4,
    "origin": "https://target.example",
    "url_before": "https://target.example/search",
    "url_after": "https://target.example/search",
    "checkpoint_id": "cp_post_search",
    "state_integrity": "corrupted"
  },
  "evidence": {
    "snapshot_before": "resource://yautja/traces/tr_01J/dom/42",
    "snapshot_after": "resource://yautja/traces/tr_01J/dom/43",
    "target_fingerprint_before": "sha256:abc123",
    "target_fingerprint_after": "sha256:def456",
    "network_window": "resource://yautja/traces/tr_01J/network?window=5000",
    "redacted": true,
    "redaction_policy": ["secrets"]
  },
  "context": {
    "consumed_tokens_estimate": 612,
    "available_window_tokens": 7600,
    "confidence": "medium"
  },
  "schema_version": "1.0"
}
```

---

## 4. Taxonomía

### 4.1 Seis familias (categorías)

| Familia | Prefijo | Responsabilidad |
|---|---|---|
| Protocolo y contrato | `YJ.PROTOCOL.*` | Argumentos inválidos, version mismatch |
| Acción y navegador | `YJ.ACT.*` | DOM stale, navigation race, no idempotente |
| Captura y contexto | `YJ.CAPTURE.*` | Budget excedido, ventana expirada |
| Red y sesión | `YJ.NET.*` | Timeout, estado sesión desconocido, WS desync |
| Política y seguridad | `YJ.POLICY.*` | Permiso de dominio, dry-run requerido, rate-limit guard |
| Integridad operacional | `YJ.OPSEC.*` | Riesgo de anomalía, violación de límite de identidad |

### 4.2 Cinco severidades (ortogonales a categoría)

| Severidad | Significado | Comportamiento del agente |
|---|---|---|
| `correctable` | Llamada mal formada | Reformular args; no reintentar igual |
| `transient` | Fallo temporal, estado confiable | Reintentar bajo política |
| `recoverable` | Estado cambió, hay ruta segura | Reobservar, restaurar o fallback |
| `approval_required` | Requiere permiso humano | No ejecutar ni reintentar |
| `terminal` | Estado no confiable o prohibido | Abort, preservar evidencia, abrir sesión nueva |

### 4.3 Códigos prohibidos

No usar códigos ambiguos: `FAILED`, `UNKNOWN`, `BLOCKED`, `SITE_ERROR`. Todo código debe decir: **qué subsistema falló, qué condición ocurrió, qué puede hacer el agente.**

---

## 5. Los 12 códigos MVP

| Código | Familia | Severidad | Retryable | Desde |
|---|---|---|---|---|
| `YJ.PROTOCOL.INVALID_ARGUMENT` | protocol | correctable | no | 1.0 |
| `YJ.ACT.DOM_TARGET_NOT_FOUND` | action | recoverable | yes (reobserve) | 1.0 |
| `YJ.ACT.DOM_TARGET_STALE` | action | recoverable | yes (reobserve) | 1.0 |
| `YJ.ACT.NAVIGATION_RACE` | action | recoverable | yes (invalidate handles) | 1.0 |
| `YJ.ACT.ACTION_NOT_IDEMPOTENT` | action | correctable | no | 1.0 |
| `YJ.CAPTURE.CONTEXT_BUDGET_EXCEEDED` | capture | recoverable | yes (degrade profile) | 1.0 |
| `YJ.CAPTURE.WINDOW_EXPIRED` | capture | transient | yes (re-open window) | 1.0 |
| `YJ.NET.REQUEST_TIMEOUT` | net | transient | yes (backoff) | 1.0 |
| `YJ.NET.SESSION_STATE_UNKNOWN` | net | recoverable | yes (restore checkpoint) | 1.0 |
| `YJ.POLICY.DOMAIN_PERMISSION_REQUIRED` | policy | approval_required | no | 1.0 |
| `YJ.POLICY.DRY_RUN_REQUIRED` | policy | approval_required | no | 1.0 |
| `YJ.OPSEC.ANOMALY_RISK_ELEVATED` | opsec | terminal | no | 1.0 |

---

## 6. Máquina de recuperación

```text
CALL
  → PREFLIGHT
      check policy, permissions, dry-run, state_integrity
      [state_integrity == contaminated] → ABORT_WITH_TRACE + human escalation
      [policy denied] → RETURN YJ.POLICY.* error
  → EXECUTE
      with idempotency check if side-effect
      [idempotency_key cached & TTL valid] → RETURN cached result
  → VERIFY
      postcondition check
      [mismatch] → CLASSIFY error
  → COMMIT
      checkpoint if configured
  → EMIT recovery_outcome event
  → RETURN SUCCESS

EXECUTE/VERIFY error:
  → CLASSIFY (code, severity, retryable)
  → switch (severity):
      correctable       → RETURN error (agent fixes args)
      transient         → RETRY_SAME (if idempotent) with backoff
      recoverable       → REOBSERVE_THEN_RETRY | ROLLBACK_TO_CHECKPOINT
      approval_required → BLOCK + RETURN error
      terminal          → ABORT_WITH_TRACE, set state_integrity
  → EMIT recovery_outcome event
```

**Reglas de la máquina:**
- `RETRY_SAME` solo si operación es idempotente o tiene `idempotency_key`.
- Acción con efecto externo (submit, download, storage mutation, macro con side effects) **nunca** se reintenta a ciegas.
- `NAVIGATION_RACE` invalida handles, selectores y ventana DOM previos.
- `CONTEXT_BUDGET_EXCEEDED` devuelve alternativa concreta (`interactive_delta`, `network_summary`), no "pid menos contexto".
- Fallo de POLICY u OPSEC bloquea acciones, preserva traza, escala a confirmación. No se convierte en rutina de elusión.

---

## 7. Retry policy format

Declarado por tool y action type:

```json
{
  "policy_id": "act.click.v2",
  "max_attempts": 3,
  "backoff": {
    "kind": "exponential_jitter",
    "base_ms": 250,
    "max_ms": 2000
  },
  "retry_on": [
    "YJ.ACT.DOM_TARGET_STALE",
    "YJ.NET.REQUEST_TIMEOUT",
    "YJ.NET.RENDER_NOT_SETTLED"
  ],
  "never_retry_on": [
    "YJ.POLICY.DOMAIN_PERMISSION_REQUIRED",
    "YJ.ACT.ACTION_NOT_IDEMPOTENT",
    "YJ.OPSEC.ANOMALY_RISK_ELEVATED"
  ],
  "escalation": [
    "RETRY_SAME",
    "REOBSERVE_THEN_RETRY",
    "ROLLBACK_TO_CHECKPOINT",
    "ABORT"
  ]
}
```

---

## 8. Telemetría — evento recovery_outcome

Tras cada recuperación (éxito o fallo terminal):

```json
{
  "trace_id": "tr_01J...",
  "operation_id": "op_01J...",
  "original_error_code": "YJ.ACT.DOM_TARGET_STALE",
  "recovery_strategy": "REOBSERVE_THEN_RETRY",
  "attempts": 2,
  "outcome": "recovered",
  "time_to_recover_ms": 1240,
  "context_cost_delta_tokens": 340,
  "deviated_from_recommendation": false
}
```

Valores de `outcome`: `recovered` · `recovered_with_degradation` · `failed` · `deviated`

Alimenta `learningStatus`. Ajustes de policy son **human-reviewed** (no ML auto-tuning). Nueva tool read-only `yautja_recovery_stats({tool?, code?, time_window?})`.

---

## 9. Core vs Plugin

### Core posee

- `YautjaError` schema y registry de códigos
- Clasificador de fallos
- Estado de operación e idempotencia
- Retry/recovery engine
- Checkpoints
- `trace_id` y audit trail
- Policy engine y confirmaciones
- Gestor de presupuesto de contexto
- `resource://` handler para trazas

### Plugins emiten

Plugins —GraphQL, WebSocket, OSINT harvest, skills de inspección, hashes, interceptores— solo emiten errores bajo sus namespaces (ej. `YJ.NET.GQL.SCHEMA_DRIFT`). **No deciden unilateralmente** reintentos, rollback o bypass de política.

---

## 10. Migración backward (4 fases)

| Fase | Tiempo | Acción | Tracker |
|---|---|---|---|
| 1 | Semanas 1-2 | Shim captura errores viejos, clasifica heurísticamente | `shim_active: true` |
| 2 | Mes 1-3 | Migración incremental tool por tool, implementación nativa | `tools_native / total` |
| 3 | Mes 3-6 | Deprecate shim; tools sin nativo emiten `YJ.PROTOCOL.LEGACY_ERROR_UNCLASSIFIED` warning | `shim_active: deprecated` |
| 4 | Mes 6+ | Remove shim; legacy errors = hard fail | `shim_active: false` |

Registry por tool: `{tool_name, status: shimmed|native|deprecated, migrated_in_version}`.

---

## 11. resource:// handler

| Aspecto | Especificación |
|---|---|
| Servidor | Yautja MCP server via MCP resources protocol |
| URIs | `resource://yautja/traces/{trace_id}/dom/{snapshot_id}`, `/network?window=N`, `/console`, `/screenshot` |
| TTL | 7 días default, configurable |
| Storage | Filesystem local (`~/.yautja/traces/`) o S3-compatible |
| Access | Mismo agente que creó el trace, o rol admin |
| GC | Cron purge expirados |
| Content-Type | JSON para DOM diffs, `image/png` para screenshots, etc. |

---

## 12. Referencias

- **MCP spec** — distinción JSON-RPC errors vs `isError: true` execution errors
- **Playwright actionability** — `playwright.dev/docs/actionability` (auto-wait + actionability checks)
- **Playwright Trace Viewer** — `playwright.dev/docs/trace-viewer` (modelo de traza acción→snapshot→red)
- **Saik0s/mcp-browser-use** — `github.com/Saik0s/mcp-browser-use` (patrones MCP browser)
- **Browser Control MCP (Firefox)** — `addons.mozilla.org/.../browser-control-mcp` (consentimiento por dominio, read-only-first)
- **Browserless Sessions** — `browserless.io/blog/session-management` (persistencia + restore)

---

## 13. Hipótesis y riesgos

| Hipótesis | Riesgo si falla | Mitigación |
|---|---|---|
| Agentes MCP pueden parsear JSON estructurado en errores | Si no, el envelope es inútil | `agent_summary` en texto plano EN como fallback |
| `available_window_tokens` es útil aunque sea estimación | Si estimación muy imprecisa, agentes ignoran | `confidence` field + ajuste con feedback |
| 12 códigos bastan para MVP | Si aparecen casos no cubiertos, shim los clasifica como `LEGACY_ERROR_UNCLASSIFIED` | Fase 2 añade códigos según datos reales |
| Plugins respetan "no decidir recovery" | Si un plugin hace bypass, policy se viola | Policy engine en core intercepta antes de ejecución |
| TTL 7 días de trazas es suficiente | Investigaciones largas pierden evidencia | Configurable por instalación |

---

## 14. Criterios de aceptación v1.0

- [ ] Schema `YautjaResponse` definido en TypeScript con validación runtime (zod o similar)
- [ ] Registry de los 12 códigos MVP con metadata completa
- [ ] Clasificador de fallos operational (shim para tools legacy)
- [ ] Retry engine con `retry_policy` configurable por tool
- [ ] `trace_id` + `operation_id` generados y propagados en toda tool
- [ ] `idempotency_key` registry con TTL 24h
- [ ] `state_integrity` tracking con transiciones válidas
- [ ] `resource://` handler para DOM/network/screenshot
- [ ] Evento `recovery_outcome` emitido y almacenado
- [ ] Tool `yautja_recovery_stats` read-only
- [ ] 1 tool nativa migrada como referencia (preferiblemente `yautja_act`)
- [ ] Tests E2E: cada código MVP tiene un scenario que lo dispara
- [ ] Doc de migración para autores de plugins
