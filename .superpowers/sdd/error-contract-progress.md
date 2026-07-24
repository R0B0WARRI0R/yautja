# Yautja Error Contract — SDD Progress Ledger

**Plan:** `D:\Yautja\proyectos-pendientes\2026-07-15-yautja-error-contract-plan.md`
**Spec:** `D:\Yautja\proyectos-pendientes\yautja-error-contract-1.0.md`
**Branch:** `main`
**Started:** 2026-07-15

## Tasks

- [x] **Task 1: Types, Schemas, and Dependencies** (files: `src/doctrine/types.ts`, `src/doctrine/schemas.ts`, `tests/doctrine/types.test.ts`, `package.json`)
  - Implementer: DONE_WITH_CONCERNS — 4/4 tests pass, tsc 0 errors
  - Concerns: @types/ulid doesn't exist (ulid bundles types), zod v4 installed not v3, Step 3 expected fail doesn't fail with esbuild
  - Reviewer: APPROVED — 0 Critical, 0 Important, 1 Minor (no runtime test for success()/failure())
  - Commit: `18401bb` `feat(doctrine): add YautjaResponse types and zod schemas`
- [x] **Task 2: Error Code Registry** (files: `src/doctrine/registry.ts`, `tests/doctrine/registry.test.ts`)
  - Implementer: DONE — 8/8 tests pass, tsc 0 errors
  - Concerns: none
  - Reviewer: APPROVED — 0/0/0 (1 info: no trailing newline, cosmetic)
  - Commit: `1b99371` `feat(doctrine): add 12 MVP error codes with registry and lookup`
- [x] **Task 3: ID Generation + Idempotency** (files: `src/doctrine/ids.ts`, `src/doctrine/idempotency.ts`, `tests/doctrine/ids.test.ts`, `tests/doctrine/idempotency.test.ts`)
  - Implementer: DONE — 9/9 tests pass (4 ids + 5 idempotency), tsc 0 errors
  - Concerns: none
  - Reviewer: APPROVED — 0/0/1 Minor (no trailing newline, cosmetic)
  - Commit: `c521432` `feat(doctrine): add ULID generators and idempotency registry with TTL`
- [x] **Task 4: State Integrity Tracker** (files: `src/doctrine/state-integrity.ts`, `tests/doctrine/state-integrity.test.ts`)
  - Implementer: DONE_WITH_CONCERNS — 11/11 tests pass (brief said 10, defined 11), tsc 0 errors
  - Concerns: brief test-count typo, pre-existing helmet failures unrelated
  - Reviewer: APPROVED — 0 blockers, 1 advisory (brief typo, no code change)
  - Commit: `17b741d` `feat(doctrine): add state integrity tracker with valid transition rules`
- [x] **Task 5: Legacy Classifier Shim** (files: `src/doctrine/classifier.ts`, `tests/doctrine/classifier.test.ts`)
  - Implementer: DONE — 7/7 tests pass, tsc 0 errors
  - Concerns: none
  - Reviewer: APPROVED — 0 findings
  - Commit: `1fc8a99` `feat(doctrine): add legacy ArsenalError classifier shim for migration Phase 1`
- [x] **Task 6: Retry Engine** (files: `src/doctrine/retry-engine.ts`, `tests/doctrine/retry-engine.test.ts`)
  - Implementer: DONE_WITH_CONCERNS — 10/10 tests pass, full doctrine suite 49/49, tsc 0 errors
  - Concerns: brief's calculateBackoff had bug where jitter could exceed max_ms; implementer applied minimal Math.min() fix; brief test count typo (9 vs 10)
  - Reviewer: APPROVED — 1 info (jitter-at-cap effectively zeroed by clamp, not blocking)
  - Commit: `891e937` `feat(doctrine): add retry engine with backoff policies and escalation ladder`
- [x] **Task 7: Recovery Machine** (files: `src/doctrine/recovery-machine.ts`, `tests/doctrine/recovery-machine.test.ts`)
  - Implementer: DONE — 6/6 tests pass, full doctrine 55/55, runtime correct
  - Concerns: implementer didn't run tsc; 4 type errors found by reviewer
  - Reviewer: FIX_REQUIRED — 1 medium (tsc errors), 1 low (process)
  - Fix subagent: DONE — removed EvidenceMeta import, made private helpers generic; tsc 0 errors, 6/6 tests pass
  - Fix reviewer: APPROVED — both findings addressed
  - Commits: `ca963ad` (impl) + `f5f9829` (fix) — `feat(doctrine): add recovery machine` + `fix(doctrine): remove unused EvidenceMeta import and type private helpers as ExecuteOptions<unknown>`
- [x] **Task 8: Trace Store + Telemetry** (files: `src/doctrine/trace-store.ts`, `src/doctrine/telemetry.ts`, tests)
  - Implementer: DONE — 7/7 tests pass, tsc 0 errors (verified!)
  - Concerns: none
  - Reviewer: APPROVED — 1 info (trailing newline, cosmetic)
  - Commit: `5b36895` `feat(doctrine): add trace store (filesystem) and telemetry collector`
- [x] **Task 9: Wire into Arsenal + Barrel + Stats tool** (files: `src/doctrine/index.ts`, `src/tools/recovery-stats.ts`, modified `src/arsenal/errors.ts`)
  - Implementer: DONE — 62 doctrine tests pass, tsc 0 errors
  - Concerns: none
  - Reviewer: APPROVED — 0 findings
  - Commit: `3f9b7d6` `feat(doctrine): wire into arsenal, add barrel exports and recovery-stats tool`
- [x] **Task 10: Integration Test Scenarios** (files: `tests/doctrine/integration/scenarios.test.ts`)
  - Implementer: DONE — 15/15 integration tests pass (12 codes + 3 behavioral), tsc 0 errors, full suite 501 passed
  - Concerns: none (16 pre-existing helmet failures are baseline, not new)
  - Reviewer: APPROVED — 0 findings
  - Commit: `cf8a38f` `test(doctrine): integration scenarios for all 12 MVP error codes`
- [ ] **Final Whole-Branch Review** (in progress)
  - Verdict: **REJECTED** — 3 Critical, 7 Important, 1 Minor
  - Critical issues: (1) no native tool migrated to YJ envelope, (2) unknown error codes throw instead of returning typed response, (3) recovery machine missing policy/idempotency preflight, telemetry emission
  - Important issues: envelope not discriminated union, verify() always classified as DOM_STALE, idempotency TTL no 24h default, TraceStore stubs + UTF-8 PNG read, telemetry in-memory + ignores `tool` field, integration tests don't exercise real triggers, missing migration doc
  - **Branch is not merge-ready.** Per-task reviews passed but final review caught scope gaps that the per-task briefs didn't fully address.
- [ ] **Task 2: Error Code Registry** (files: `src/doctrine/registry.ts`, `tests/doctrine/registry.test.ts`)
- [ ] **Task 3: ID Generation + Idempotency Registry** (files: `src/doctrine/ids.ts`, `src/doctrine/idempotency.ts`, tests)
- [ ] **Task 4: State Integrity Tracker** (files: `src/doctrine/state-integrity.ts`, `tests/doctrine/state-integrity.test.ts`)
- [ ] **Task 5: Legacy Error Classifier** (files: `src/doctrine/classifier.ts`, `tests/doctrine/classifier.test.ts`)
- [ ] **Task 6: Retry Engine** (files: `src/doctrine/retry-engine.ts`, `tests/doctrine/retry-engine.test.ts`)
- [ ] **Task 7: Recovery Machine** (files: `src/doctrine/recovery-machine.ts`, `tests/doctrine/recovery-machine.test.ts`)
- [ ] **Task 8: Trace Store + Telemetry** (files: `src/doctrine/trace-store.ts`, `src/doctrine/telemetry.ts`, tests)
- [ ] **Task 9: Wire into Arsenal + Barrel + Recovery Stats Tool** (files: `src/doctrine/index.ts`, `src/tools/recovery-stats.ts`, modified `src/arsenal/errors.ts`)
- [ ] **Task 10: Integration Test Scenarios** (file: `tests/doctrine/integration/scenarios.test.ts`)

## Notes

- Working on `main` (no feature branch created — see user consent)
- Each task gets a fresh implementer subagent + reviewer subagent
- Reviewer reports: spec compliance ✅/❌ + task quality approved/fix-required
- Spec: `D:\Yautja\proyectos-pendientes\yautja-error-contract-1.0.md`
- Plan: `D:\Yautja\proyectos-pendientes\2026-07-15-yautja-error-contract-plan.md`
