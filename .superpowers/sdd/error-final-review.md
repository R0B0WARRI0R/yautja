# Final Whole-Branch Review — Yautja Error Contract v1.0

## Verdict: REJECTED

The branch provides a tested scaffold for the registry, classifier, retry policy, idempotency store, state tracker, trace-store primitives, and telemetry collector. It is not merge-ready as an Error Contract implementation because the live Helmet/Arsenal tool path is still legacy, the recovery machine is not a complete PREFLIGHT → EXECUTE → VERIFY → COMMIT implementation, and the resource/telemetry/statistics features are not connected to MCP.

## Spec coverage

| Section | Status |
|---|---|
| §3 Envelope | ❌ |
| §4.1 Families | ✅ |
| §4.2 Severities | ✅ |
| §5 12 codes | ✅ |
| §6 Recovery | ❌ |
| §7 Retry | ✅ |
| §8 Telemetry | ❌ |
| §9 Core vs plugin | ❌ |
| §10 Migration | ❌ |
| §11 resource:// | ❌ |
| §14 Acceptance | ❌ |

**Summary: 4/11 sections fully covered, 7 gaps.**

## Cross-cutting concerns

- **Type safety:** `YautjaResponse` is not a discriminated union: `ok` is `boolean`, while `result` and `error` are independently optional (`src/doctrine/types.ts:95-104`). The Zod schema has the same flaw and accepts `ok: true` with an error or `ok: false` without one (`src/doctrine/schemas.ts:76-84`). `IdempotencyRegistry` uses unchecked generic casts when reading and storing results (`src/doctrine/idempotency.ts:20-38`). `RetryPolicy.escalation` is `string[]`, so invalid recovery actions are type-permitted (`src/doctrine/retry-engine.ts:7-14`).
- **Naming:** Most contract fields use snake_case, but telemetry/statistics use camelCase (`successRate`, `avgTimeToRecoverMs`, `avgContextCostTokens`) and the stats input uses `since` without a documented time-window shape (`src/doctrine/telemetry.ts:13-28`). This is inconsistent with the API-field convention in the spec.
- **Code coverage:** All 12 registry entries are covered by the parameterized integration test, and doctrine tests pass (`77/77`). Coverage is shallow: every code is injected through the same `yautja_act`/`act.click` callback rather than triggered by distinct production conditions. No test covers envelope symmetry, unknown plugin codes, MCP registration, telemetry emission from recovery, resource access control, TTL GC, screenshot reads, or native tool migration.
- **State machine:** `RecoveryMachine` has the loop shape, but it does not implement the specified severity dispatch, policy/permission/dry-run preflight, rollback, handle invalidation, checkpoint commit, escalation execution, or recovery outcome emission (`src/doctrine/recovery-machine.ts:40-110`). Verification failure is always classified as `YJ.ACT.DOM_TARGET_STALE` (`src/doctrine/recovery-machine.ts:64-73`), regardless of the failed postcondition.
- **Idempotency:** Cache short-circuiting works for a supplied key, but there is no default 24-hour configuration, no caller-key validation, no in-flight deduplication, and no enforcement that side-effecting operations must provide a key. A side-effecting callback can execute without an idempotency key (`src/doctrine/recovery-machine.ts:49-53`).
- **State integrity:** The standalone tracker enforces its transition table and makes `contaminated` terminal (`src/doctrine/state-integrity.ts:3-13`, `src/doctrine/state-integrity.ts:77-90`). The recovery machine does not mark state corrupted after execution/verification failures, does not restore checkpoints, and does not preserve or expose contamination evidence beyond the preflight rejection.
- **Regressions:** `tests/helmet.test.ts` is unchanged in the branch range. `tsc --noEmit` passes; all doctrine/integration tests pass. The full suite has 501 passing and 16 existing Helmet failures caused by `setNetworkCaptureCallback` missing from the pre-existing test mock; this failure is outside the tracked branch diff and is not a new error-contract regression.

## Acceptance criteria

1. ❌ **Schema `YautjaResponse` with runtime validation:** TypeScript and Zod definitions exist, but neither enforces the required success/error symmetry (`src/doctrine/types.ts:95-104`, `src/doctrine/schemas.ts:76-84`).
2. ✅ **Registry of 12 MVP codes with metadata:** `MVP_CODES` contains all 12 codes and the required family, severity, retry, recovery, and version metadata (`src/doctrine/registry.ts:25-146`).
3. ✅ **Legacy error classifier:** `classifyLegacyError()` maps all `ArsenalErrorType` values and preserves the legacy message (`src/doctrine/classifier.ts:5-32`).
4. ✅ **Configurable retry engine:** `RetryPolicy`, `RetryEngine`, and per-policy defaults exist (`src/doctrine/retry-engine.ts:1-89`). The engine is not wired into live tools.
5. ❌ **Generated and propagated `trace_id` + `operation_id`:** The machine generates an operation ID but accepts the trace ID from its caller; existing tools do not use the machine and do not return the envelope (`src/doctrine/recovery-machine.ts:56`, `src/arsenal/translator.ts:10`, `src/helmet.ts:243-269`).
6. ❌ **Idempotency registry with 24-hour TTL:** The registry has configurable TTL only, with no 24-hour default or side-effect enforcement (`src/doctrine/idempotency.ts:8-10`, `src/doctrine/recovery-machine.ts:49-53`).
7. ✅ **`state_integrity` tracking with valid transitions:** The tracker implements the five states and transition validation (`src/doctrine/state-integrity.ts:3-13`, `src/doctrine/state-integrity.ts:15-90`). Machine integration is incomplete.
8. ❌ **`resource://` handler for DOM/network/screenshot:** `TraceStore` can save primitive files, but there is no MCP `resources/read` handler, no access control, no seven-day GC, no console resource, and screenshot reads are decoded as UTF-8 text (`src/doctrine/trace-store.ts:16-68`).
9. ❌ **`recovery_outcome` emitted and stored:** `TelemetryCollector` can record in memory, but `RecoveryMachine` has no telemetry dependency and never records outcomes (`src/doctrine/telemetry.ts:30-35`, `src/doctrine/recovery-machine.ts:40-110`).
10. ❌ **Read-only `yautja_recovery_stats` tool:** `createRecoveryStatsTool()` is only a local factory; it is absent from Helmet’s MCP tool list and dispatch (`src/tools/recovery-stats.ts:14-26`, `src/helmet.ts:317-323`, `src/helmet.ts:807-849`). Its declared `tool` filter is also ignored by `TelemetryCollector.query()` (`src/doctrine/telemetry.ts:23-47`).
11. ❌ **One natively migrated tool:** `arsenalToDoctrine()` exists, but `ActionResult` remains the legacy union and `ActionTranslator`/Helmet still return legacy payloads (`src/arsenal/action-types.ts:39-41`, `src/arsenal/translator.ts:10-12`, `src/helmet.ts:243-269`).
12. ❌ **E2E scenario for every MVP code:** The 12 entries have direct test coverage, but the test injects `{ error: { code } }` into the recovery callback for every case rather than exercising the production tool path or distinct trigger conditions (`tests/doctrine/integration/scenarios.test.ts:20-46`).
13. ❌ **Plugin-author migration document:** No migration document was added to the branch or review package.

## Top 3 risks for production

1. **The contract is not on the production MCP path.** Agents will continue receiving legacy `ActionResult`/JSON responses; no native tool supplies operation metadata, typed errors, recovery hints, or the recovery-stats tool.
2. **Recovery can be unsafe or crash on valid extension cases.** Side-effect operations are not required to provide idempotency keys, state is not changed on failed verification, and an unknown/plugin error code reaches `toYautjaError()` and throws instead of returning a typed response (`src/doctrine/recovery-machine.ts:90-96`, `src/doctrine/registry.ts:162-168`).
3. **Evidence and observability are incomplete and unsafe.** Trace GC and persistence are missing, screenshots cannot be read correctly, MCP resource access controls are absent, and recovery telemetry is neither emitted by the machine nor persisted; `uriToPath()` also accepts unsanitized path components (`src/doctrine/trace-store.ts:50-68`).

## Findings table

| Severity | Finding | Action |
|---|---|---|
| Critical | No native production tool is migrated; Helmet still exposes legacy action results and no recovery-stats MCP tool. | Wrap at least one live tool, preferably `act`, in the envelope/recovery path and register `yautja_recovery_stats`; add an MCP integration test. |
| Critical | Unknown/plugin codes cause an exception because the recovery machine checks `!def` and then calls `toYautjaError()` with the unknown code. | Add a plugin/legacy fallback code or classifier path that always returns a valid envelope without throwing. |
| Critical | The recovery machine does not enforce side-effect idempotency or policy/dry-run preflight and does not emit recovery outcomes. | Add policy and idempotency gates before execution, state transitions/rollback, telemetry injection, and outcome recording on every recovery path. |
| Important | Envelope types and Zod schemas permit invalid `ok`/`result`/`error` combinations. | Use a discriminated success/error union and `z.discriminatedUnion('ok', ...)`; test invalid combinations. |
| Important | Verification failures are always classified as DOM target stale, and retries do not execute the recommended reobserve/rollback actions. | Make verification return a typed classification and implement the recovery strategy dispatcher. |
| Important | Idempotency TTL is caller-configured with no 24-hour default; storage is process-local and generic casts are unchecked. | Provide the contract default, validate keys/results, and define durable/concurrent registry behavior. |
| Important | TraceStore has a stubbed `findExpired()`, no MCP resource handler/access control, and reads PNG bytes as UTF-8. | Implement TTL GC, authenticated resource routing, content types/binary reads, and path-safe URI validation. |
| Important | Telemetry is in-memory only, ignores `tool`, uses an incorrect numeric comparison for `since`, and is not connected to recovery. | Persist/query by the specified filters and wire `recovery_outcome` into the machine and read-only tool. |
| Important | The integration suite proves registry plumbing but not real per-code trigger scenarios or live tool behavior. | Add production-path scenarios for all 12 codes and assert retry, approval, terminal, state, telemetry, and idempotency outcomes. |
| Important | The required plugin migration document is missing. | Add migration guidance covering shim phases, native envelope construction, plugin namespaces, and policy ownership. |
| Minor | API naming is mixed between snake_case and camelCase in telemetry/statistics, and several added files lack a trailing newline. | Normalize public API fields and formatting before release. |
