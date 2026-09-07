# Changelog

## Sin publicar — 2026-08-27

### Módulo Mecamorph

- Integrado `@mecamorph/yautja-adapter` como capa de compilación semántica sin
  duplicar sensores ni actuadores.
- Nuevas herramientas MCP: `morph_compile`, `morph_list`, `morph_run` y
  `morph_explain`.
- `morph_compile` solo observa; los bindings generados empiezan en cuarentena.
- `morph_run` exige `validation:true` para probar bindings en cuarentena y solo
  promueve el binding que obtiene éxito verificado.
- La matriz `capabilities` anuncia `semanticCompilation: true`.
- Las acciones del adaptador vuelven a entrar por las herramientas de Yautja,
  preservando perfiles, gates, envelopes y errores tipados.

## 0.2.0 — 2026-07-26 (Roadmap P10–P18)

### P10 — Error contract + response envelope
- Toda tool MCP devuelve `YautjaResponse` (`schema_version: "1.0"`) con metas operation/state/evidence/context; handshake `initialize` anuncia `schema_version`.
- 10a: shim legacy (payloads preservados en `result`/`result.legacy_text`); 10b: core nativos (observe, act, inspect, diff, listTabs, reattach) con `StateMeta` real.
- `recovery_stats` registrada (estaba muerta); `TelemetryCollector` wired.
- Kill-switch: `YAUTJA_LEGACY_SHIM=0` hace fallar tipado las tools no migradas (P18).

### P11 — Input atomicity
- `ensureEmpty` (tool + módulo), type transaction con RecoveryMachine, anti blind-retry 30s (`input-session`), híbrido stealth≤80/insertText.
- Códigos: `TYPE_PARTIAL`, `TYPE_REJECTED`, `TYPE_RETRY_BLOCKED`, `INPUT_NOT_CLEARABLE`, `SUBMIT_NO_EFFECT`.

### P12 — waitForUi + stream extract
- Motor `wait-for-ui` (selector, urlMatch, ariaBusy, noPulse, networkIdle real vía Thermal, textSettled, fn, timeout); `extractAnswer` settled + chunked; `waitReady` en smartType; `act` sleep condicional.
- Código: `YJ.ACT.WAIT_TIMEOUT`.

### P13 — Site profiles + preflight/quota
- Perfiles JSON (`profiles/{perplexity,gemini,default}.json` + override usuario), preflight cookie/quota, economic sensor, enforcement en interceptEnable/act/smartType.
- Códigos: `YJ.POLICY.QUOTA_EXHAUSTED`, `YJ.OPSEC.CAPTCHA_DETECTED`, `YJ.POLICY.GATE_DENIED`.

### P13.5 — Tab identity + silent listen
- `TabRegistry`: openTab/switchTab verificados con `location.href`; `previousActiveTabId`.
- Código: `YJ.ACT.TAB_SWITCH_MISMATCH`.

### P14 — browserFetch + session gates
- Gates P0–P4 (`gates.json` + `audit.jsonl`), `browserFetch` en page context con redacción, rate limit por host, gate de `evaluate(fetch)` por perfil.
- Tools: `gateStatus`, `gateGrant` (phrase obligatoria), `gateRevoke`, `browserFetch`.

### P15 — apiSurface + HAR + evidence
- `apiSurface` (network + bundles), `exportHar` (HAR 1.2, redacción, stubs sha256), evidence store content-addressed, `responseDiff`.
- Tools: `apiSurface`, `exportHar`, `evidencePut`, `evidenceGet`, `evidenceList`, `responseDiff`.

### P16 — Trusted gestures
- `trustedClick` (isTrusted real vía Input domain), `trustedFileChooser` (path A direct / path B chooser intercept), `capabilities` matrix.
- Código: `YJ.PROTOCOL.CAPABILITY_MISSING` (nunca éxito falso).

### P17 — Snapshots + resources
- `snapshotSave/List/Restore` (OPSEC warning en hosts no-lab), MCP `resources/list|read` (traces + evidence, GC TTL 7d), HAR no-body edges, `docs/capture-modes.md`.

### P18 — Backend router + hardening
- `delegate` + `~/.yautja/backends.json`; siteMemory v2 (estrategias, hits, TTL por entrada, buildVersion); macros con precondition captcha/profile; shim kill-switch.
- Registry: 23 códigos `YJ.*`. Tests: 517 → 1073.

### Zombie/port hardening (2026-07-26)
- `helmet-main`: handlers SIGINT/SIGTERM + `stdin.on('end')` (con `resume()`) registrados **antes** de `start()` — host muerto o taskkill → `stop()` limpio + exit. Verificado en vivo: EOF durante startup y post-handshake → exit 0.
- `serveMCP`: `rl.on('close')` → `stop()` + exit (con force-exit a 3s).
- `proxy-standalone.cjs`: watchdog `stdin.on('end')` — padre muerto → el proxy sale (no zombie en :9877 ni proxy de sistema colgado en el registro).
- Puerto ocupado: falla rápido con fatal claro (ya existía; verificado EADDRINUSE).

### 10c + piezas experimentales + multi-sesión (2026-07-27)
- **10c completa:** las ~30 tools que quedaban en shim migran a nativas vía codemod (100 returns convertidos) + helper `native()` con clasificación de errores y payload preservado. **Shim eliminado del código** (`detectLegacyError`, path de strings, flag `YAUTJA_LEGACY_SHIM` sin función ya).
- **Telemetría `recovered`:** `RecoveryMachine.onOutcome` — un éxito tras retry queda registrado (antes solo `failed`).
- **Biofilm:** estado visible en `learningStatus` (opt-in, sin auto-init).
- **Multi-sesión:** `YAUTJA_PROXY_PORT` / `YAUTJA_CDP_REMOTE_PORT` configurables + `docs/multi-session.md` (receta y límites honestos).
- Tests: 1074 → 1081.
