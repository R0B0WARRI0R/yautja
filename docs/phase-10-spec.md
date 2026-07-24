# Yautja — Phase 10 Implementation Spec

**Spec ID:** YJ-P10-WIRE  
**Fecha:** 2026-07-16  
**Estado:** Listo para implementación  
**Roadmap:** [roadmap-phase-10-18.md](./roadmap-phase-10-18.md) § Phase 10 (r2)  
**Norma:** [yautja-error-contract-1.0.md](../proyectos-pendientes/yautja-error-contract-1.0.md)  
**Plan previo:** [2026-07-15-yautja-error-contract-plan.md](../proyectos-pendientes/2026-07-15-yautja-error-contract-plan.md) Tasks 1–8 **DONE** (library + tests)

---

## Context

Phases 1–9 DONE. Doctrine library **exists and is green**:

```
npx vitest run tests/doctrine  →  11 files, 77 tests PASS
```

| Ya en disco | No en runtime MCP |
|-------------|-------------------|
| `src/doctrine/*` (`YautjaResponse`, registry `YJ.*`, RecoveryMachine, trace-store, telemetry, idempotency, classifier) | `Helmet.observe/act/inspect/...` devuelven `string` ad-hoc |
| `arsenalToDoctrine()` / `classifyLegacyError()` | `act` serializa `ArsenalError` legacy en JSON suelto |
| `src/tools/recovery-stats.ts` | **No** registrado en `MCP_TOOLS` / `handleToolCall` |
| Integration scenarios sobre RecoveryMachine | Cero tests de wire helmet → envelope |

**Phase 10 is not greenfield.** Title: **Wire doctrine → Helmet (MCP envelope migration).**

Do **not** recreate `types.ts`, `registry.ts`, `recovery-machine.ts`, etc.

---

## Goal

Every MCP `tools/call` response body is a JSON-serialized `YautjaResponse<T>` (`schema_version: "1.0"`) so agents can branch on `ok`, `error.code` (`YJ.*`), and `error.recovery` without parsing free text.

### Non-goals (P10)

- ensureEmpty / smartType transactional (P11)
- waitForUi predicates reales (P12)
- Site profiles / gates / browserFetch (P13–P14)
- Trusted gestures (P16)
- MCP `resources/` handlers for `resource://yautja/traces/...` (P17 — URIs may be **stubs** in evidence)
- Removing legacy ArsenalError types (keep + classify)
- Breaking RecoveryMachine API
- Full token accounting accuracy (`context.consumed_tokens_estimate` may be heuristic)

---

## Architecture

```
Agent (MCP stdio)
  ↕ tools/call
Helmet.handleToolCall(name, args)
  │
  ├─► EnvelopeBuilder.wrapSuccess / wrapFailure
  │     uses: generateTraceId, generateOperationId, success(), failure()
  │     state: session_id, tab_id, origin from Helmet session
  │
  ├─► Core path (wave A): observe | act | inspect | diff | reattach | listTabs | openTab | switchTab | closeTab | smartType | find*
  │     act: ActionResult → arsenalToDoctrine on error
  │
  ├─► Rest tools (wave B): intercept*, capture*, stealth*, ws*, gql*, macros*, osint*, ...
  │     thin wrap: { success payload } | catch → YJ.PROTOCOL / YJ.NET
  │
  └─► recovery_stats (new tool registration)
        TelemetryCollector instance owned by Helmet

MCP content: [{ type: "text", text: JSON.stringify(yautjaResponse) }]
```

Optional env for clients that choke on envelope shape:

| Env | Default | Effect |
|-----|---------|--------|
| `YAUTJA_ENVELOPE=1` | on | Always envelope |
| `YAUTJA_LEGACY_SHIM=1` | off | Also embed `result.legacy_text` string for dual-read (wave A only if needed) |

P18 removes shim; P10 may leave shim off unless a host breaks.

---

## Modules

| File | Action | Responsibility |
|------|--------|----------------|
| `src/doctrine/*` | **REUSE** | No rewrite |
| `src/helmet/envelope.ts` (or `src/doctrine/helmet-bridge.ts`) | **NEW** | Build OperationMeta/StateMeta/ContextMeta; wrap any tool result |
| `src/helmet/session.ts` | **NEW** (optional small) | `session_id` (ULID once per process), current `trace_id` stack |
| `src/helmet.ts` | **MODIFY** | Own TelemetryCollector + IdempotencyRegistry + StateIntegrityTracker; route all tools through wrap; register `recovery_stats` |
| `src/arsenal/action-types.ts` | **MODIFY** (light) | Keep `ActionResult`; document that Helmet maps to envelope |
| `src/arsenal/errors.ts` | **REUSE** | `arsenalToDoctrine` already present |
| `src/tools/recovery-stats.ts` | **REUSE** | Wire only |
| `tests/helmet/envelope-wire.test.ts` | **NEW** | Unit tests with mocked Helmet pieces / pure envelope builder |
| `tests/helmet/handle-tool-envelope.test.ts` | **NEW** | Integration-style: wrap observe/act failure paths without browser if possible |
| `docs/envelope-migration-tracker.md` | **NEW** | Checkbox per MCP tool name |

---

## Module 1: Envelope bridge

**File:** `src/helmet/envelope.ts` (preferred path; keep doctrine free of MCP concerns)

```typescript
import {
  success,
  failure,
  type YautjaResponse,
  type YautjaError,
  type OperationMeta,
  type StateMeta,
  type ContextMeta,
  type StateIntegrity,
  SCHEMA_VERSION,
} from '../doctrine/types.js';
import { generateOperationId, generateTraceId } from '../doctrine/ids.js';
import { toYautjaError } from '../doctrine/registry.js';
import { arsenalToDoctrine } from '../arsenal/errors.js';
import type { ArsenalError } from '../arsenal/errors.js';

export interface EnvelopeSession {
  session_id: string;
  tab_id: number;
  origin: string;
  url?: string;
  checkpoint_id?: string | null;
  state_integrity?: StateIntegrity;
  agent_context_window?: number;
  cumulative_tokens_emitted?: number;
}

export interface WrapMeta {
  tool: string;           // e.g. "observe", "act" (MCP name without yautja_ prefix OK)
  action_type?: string;   // e.g. "click", "navigate", "smartType"
  trace_id?: string;      // if omitted, generate new
  attempt?: number;
  max_attempts?: number;
  idempotency_key?: string | null;
}

export function makeOperation(meta: WrapMeta, session: EnvelopeSession): OperationMeta {
  return {
    tool: meta.tool.startsWith('yautja_') ? meta.tool : `yautja_${meta.tool}`,
    action_type: meta.action_type ?? meta.tool,
    operation_id: generateOperationId(),
    trace_id: meta.trace_id ?? generateTraceId(),
    attempt: meta.attempt ?? 1,
    max_attempts: meta.max_attempts ?? 1,
    idempotency_key: meta.idempotency_key ?? null,
  };
}

export function makeState(session: EnvelopeSession): StateMeta {
  return {
    session_id: session.session_id,
    tab_id: session.tab_id,
    origin: session.origin || 'unknown',
    url_after: session.url,
    checkpoint_id: session.checkpoint_id ?? null,
    state_integrity: session.state_integrity ?? 'unknown',
  };
}

export function makeContext(session: EnvelopeSession, consumed = 0): ContextMeta {
  const window = session.agent_context_window ?? 128_000;
  const used = session.cumulative_tokens_emitted ?? 0;
  return {
    consumed_tokens_estimate: consumed,
    available_window_tokens: Math.max(0, window - used - consumed),
    confidence: 'low', // heuristic until real tokenizer
  };
}

export function wrapSuccess<T>(
  result: T,
  meta: WrapMeta,
  session: EnvelopeSession,
  opts?: { consumed_tokens?: number; evidence?: Partial<import('../doctrine/types.js').EvidenceMeta> },
): YautjaResponse<T> {
  return success(result, {
    operation: makeOperation(meta, session),
    state: makeState(session),
    evidence: opts?.evidence,
    context: makeContext(session, opts?.consumed_tokens ?? estimateTokens(result)),
  });
}

export function wrapFailure(
  error: YautjaError,
  meta: WrapMeta,
  session: EnvelopeSession,
  opts?: { state_integrity?: StateIntegrity },
): YautjaResponse<never> {
  const state = makeState({
    ...session,
    state_integrity: opts?.state_integrity ?? session.state_integrity ?? 'known',
  });
  return failure(error, {
    operation: makeOperation(meta, session),
    state,
    context: makeContext(session, 0),
  });
}

export function wrapArsenalFailure(
  arsenalErr: ArsenalError,
  meta: WrapMeta,
  session: EnvelopeSession,
): YautjaResponse<never> {
  return wrapFailure(arsenalToDoctrine(arsenalErr), meta, session, {
    state_integrity: arsenalErr.recoverable ? 'corrupted' : 'known',
  });
}

export function wrapThrown(
  err: unknown,
  meta: WrapMeta,
  session: EnvelopeSession,
): YautjaResponse<never> {
  const message = err instanceof Error ? err.message : String(err);
  // Prefer classified codes when message matches known patterns later; MVP:
  return wrapFailure(
    toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', { message }),
    meta,
    session,
  );
}

export function serializeEnvelope(resp: YautjaResponse<unknown>): string {
  return JSON.stringify(resp);
}

function estimateTokens(payload: unknown): number {
  try {
    return Math.ceil(JSON.stringify(payload).length / 4);
  } catch {
    return 0;
  }
}
```

**Rules:**

1. Never throw from wrap helpers (except programmer misuse of unknown `YJ.*` code in `toYautjaError`).
2. `tool` field always `yautja_<mcpName>` for consistency with error-contract examples.
3. `schema_version` comes only from `success()`/`failure()` builders in doctrine.

---

## Module 2: Helmet session + doctrine instances

**File:** `src/helmet.ts` (constructor additions)

```typescript
import { generateTraceId } from './doctrine/ids.js';
import { ulid } from 'ulid';
import { StateIntegrityTracker } from './doctrine/state-integrity.js';
import { IdempotencyRegistry } from './doctrine/idempotency.js';
import { TelemetryCollector } from './doctrine/telemetry.js';
import { createRecoveryStatsTool } from './tools/recovery-stats.js';
import {
  wrapSuccess,
  wrapFailure,
  wrapArsenalFailure,
  wrapThrown,
  serializeEnvelope,
  type EnvelopeSession,
} from './helmet/envelope.js';

// inside Helmet class:
private sessionId = `ses_${ulid()}`;
private telemetry = new TelemetryCollector();
private idempotency = new IdempotencyRegistry({ defaultTtlMs: 24 * 60 * 60 * 1000 });
private integrity = new StateIntegrityTracker(this.sessionId);
private recoveryStats = createRecoveryStatsTool(this.telemetry);

private envelopeSession(): EnvelopeSession {
  const tabId = this.server.getCurrentTabId() ?? 0;
  // origin/url: best-effort from last gather or evaluate — may be "unknown" if detached
  return {
    session_id: this.sessionId,
    tab_id: typeof tabId === 'number' ? tabId : 0,
    origin: this.lastOrigin ?? 'unknown',
    url: this.lastUrl,
    checkpoint_id: null,
    state_integrity: this.integrity.current(),
  };
}
```

Maintain `lastOrigin` / `lastUrl` updated in `gatherState()` or after navigate (lightweight; exact source left to implementer — may parse from EM sensor summary).

**P10 does not require** wiring every `act` through `RecoveryMachine.execute()`. That is the default for **P11** smartType TX. P10 only:

- Maps results to envelope
- Optionally records telemetry on failures (nice-to-have)

---

## Module 3: handleToolCall migration

### 3.1 MCP layer

```typescript
case 'tools/call': {
  const result = await this.handleToolCall(params.name, params.arguments || {});
  // result is already a JSON string of YautjaResponse
  this.sendMCP(id, {
    content: [{ type: 'text', text: result }],
    // isError: only for MCP protocol failures, NOT for ok:false business errors
  });
  break;
}
```

**Critical:** `ok: false` Yautja business errors must **not** set MCP `isError: true` (if the host supports it). Agents must read the envelope. MCP `-32603` only for true crashes outside wrap.

### 3.2 handleToolCall contract

```typescript
private async handleToolCall(name: string, args: any): Promise<string> {
  const metaBase = { tool: name, trace_id: generateTraceId() };
  try {
    const session = this.envelopeSession();
    switch (name) {
      // ... each case returns serializeEnvelope(wrapSuccess(...)) or wrapFailure
      default:
        return serializeEnvelope(
          wrapFailure(
            toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
              message: `Unknown tool: ${name}`,
            }),
            metaBase,
            session,
          ),
        );
    }
  } catch (err) {
    return serializeEnvelope(wrapThrown(err, { tool: name }, this.envelopeSession()));
  }
}
```

### 3.3 Wave A — core tools (must be perfect)

| MCP tool | Success `result` shape | Failure mapping |
|----------|------------------------|-----------------|
| `observe` | `{ text: string }` (was raw string) | throw → wrapThrown |
| `act` | `{ value?: unknown, diff?: string }` | `ActionResult` fail → `wrapArsenalFailure` |
| `inspect` | parsed JSON object or `{ domain, data }` | unknown domain → `YJ.PROTOCOL.INVALID_ARGUMENT` |
| `diff` | diff object or `{ message: "No previous..." }` with **ok: true** | — |
| `reattach` | `{ tabId }` | CDP fail → classifier |
| `listTabs` | `{ tabs, currentTabId }` | |
| `switchTab` | `{ tabId }` | missing tabId → INVALID_ARGUMENT |
| `openTab` | `{ tabId, url, attached }` — best-effort URL of opened tab | |
| `closeTab` | `{ closed: true, tabId }` | |
| `findElement` | finder payload | empty → optional ok:true with `[]` or DOM_TARGET_NOT_FOUND if query required |
| `findClick` / `findType` | same as today + envelope | arsenal path if click fails |
| `smartType` | existing success fields | arsenal / thrown |

#### `act` detail

```typescript
case 'act': {
  const action = args.action as BrowserAction;
  if (!action || typeof action !== 'object' || !('type' in action)) {
    return serializeEnvelope(wrapFailure(
      toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
        message: "Action must be an object with a 'type' field",
      }),
      { tool: 'act', action_type: 'invalid' },
      this.envelopeSession(),
    ));
  }
  // existing gather before/after can stay; prefer reducing sleep in P12
  const result = await this.translator.execute(action);
  if (!result.ok) {
    return serializeEnvelope(wrapArsenalFailure(
      result.error,
      { tool: 'act', action_type: action.type },
      this.envelopeSession(),
    ));
  }
  const diff = this.memory.diff();
  return serializeEnvelope(wrapSuccess(
    {
      value: result.value,
      changes: diff?.fields ?? [],
    },
    { tool: 'act', action_type: action.type },
    this.envelopeSession(),
  ));
}
```

#### `observe` detail

```typescript
case 'observe': {
  const text = await this.observe(args.question || 'overview');
  // refactor observe() to return string still, wrap here
  return serializeEnvelope(wrapSuccess(
    { text },
    { tool: 'observe', action_type: 'observe' },
    this.envelopeSession(),
    { consumed_tokens: Math.ceil(text.length / 4) },
  ));
}
```

### 3.4 Wave B — remaining tools (thin wrap)

For each remaining tool in `handleToolCall`:

1. Keep existing logic.
2. On success: `wrapSuccess(parsedOrObject, { tool: name }, session)`.
3. On `JSON.stringify({ error: '...' })` patterns: convert to `wrapFailure(toYautjaError(...))` instead of embedding error inside ok:true.
4. Never leave a bare non-JSON string as MCP text.

**Tracker file** lists every name from `MCP_TOOLS` with wave A/B and checkbox.

### 3.5 Register `recovery_stats`

Add to `MCP_TOOLS`:

```typescript
{
  name: 'recovery_stats',
  description: 'Read recovery_outcome telemetry stats (error codes, strategies, success rate). Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Filter by YJ.* error code' },
      strategy: { type: 'string' },
      since: { type: 'number', description: 'Optional epoch ms lower bound (best-effort)' },
    },
  },
},
```

```typescript
case 'recovery_stats': {
  const out = this.recoveryStats({
    code: args.code,
    strategy: args.strategy,
    since: args.since,
  });
  return serializeEnvelope(wrapSuccess(out, { tool: 'recovery_stats' }, this.envelopeSession()));
}
```

### 3.6 serverInfo metadata

```typescript
case 'initialize':
  this.sendMCP(id, {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: {
      name: 'yautja',
      version: '0.2.0', // bump: envelope wire
    },
    // If client ignores unknown fields, still document in SKILL:
    // envelope schema_version 1.0 is always in tool results
  });
```

Optional: include `yautja: { envelope: '1.0' }` inside serverInfo if hosts allow extra keys.

---

## Classifier completeness (P10 scope)

Existing `LEGACY_MAP` covers all `ArsenalErrorType` values. P10 acceptance:

- [ ] Every arsenal failure path in wave A goes through `arsenalToDoctrine` (no raw `type: SELECTOR_NOT_FOUND` in MCP text).
- [ ] Unit test: for each `ArsenalErrorType`, `classifyLegacyError` returns a code present in `REGISTRY`.

**Do not** expand MVP registry with P11 codes (`YJ.ACT.TYPE_PARTIAL`, etc.) in P10 unless needed for compile — leave those for P11.

**Optional fix (small, allowed in P10):** map `CDP_COMMAND_FAILED` to something better than `YJ.NET.REQUEST_TIMEOUT` if a net-adjacent code fits; only if tests updated. Prefer leave map as-is to avoid scope creep.

---

## Token / context fields

| Field | P10 behavior |
|-------|----------------|
| `consumed_tokens_estimate` | `ceil(JSON.stringify(result).length / 4)` |
| `available_window_tokens` | `agent_context_window - cumulative` (default window 128000) |
| `confidence` | `"low"` until real tokenizer |

Helmet may increment `cumulative_tokens_emitted` per tool call for session realism.

---

## Evidence stubs

```typescript
evidence: {
  redacted: true,
  redaction_policy: ['secrets'],
  // snapshot_after optional — omit or stub:
  // snapshot_after: `resource://yautja/traces/${traceId}/dom/pending`
}
```

Do **not** implement filesystem writes for every call in P10 (trace-store exists for later). Avoid disk spam.

---

## Tests

### `tests/helmet/envelope-wire.test.ts`

```typescript
// Required cases:
// 1. wrapSuccess → ok:true, schema_version === '1.0', tool starts with yautja_
// 2. wrapArsenalFailure(SELECTOR_NOT_FOUND) → error.code === 'YJ.ACT.DOM_TARGET_NOT_FOUND'
// 3. wrapThrown → ok:false, has agent_summary
// 4. serializeEnvelope parses back with same ok flag
// 5. makeOperation respects custom trace_id
```

### `tests/helmet/handle-tool-envelope.test.ts`

Prefer testing pure functions extracted from Helmet if full Helmet boot needs extension port.

Minimum without browser:

- Mock `envelopeSession` + call wrap paths used by act/observe/inspect invalid domain.
- Snapshot example envelopes for skill authors (optional file under `tests/helmet/fixtures/`).

### Regression

```bash
npx vitest run tests/doctrine   # still 77+ green
npx vitest run tests/helmet     # new
npm run lint                    # tsc --noEmit
```

### Manual smoke (operator)

```bash
npm run helmet
# MCP: tools/call observe { question: "what page?" }
# Expect: {"ok":true,"result":{"text":"..."},"operation":{...},"schema_version":"1.0"}
# MCP: tools/call act { action: { type: "click", selector: "#nope" } }
# Expect: ok:false, error.code YJ.ACT.DOM_TARGET_NOT_FOUND
```

---

## Migration tracker

**File:** `docs/envelope-migration-tracker.md`

Columns: `tool | wave | status | notes`

All names from `MCP_TOOLS` (~60) + `recovery_stats`.

Statuses: `pending | wrapped | verified`.

P10 DONE requires: **100% wrapped**, wave A **verified** with at least one automated or manual check each.

---

## Skill / docs updates (P10)

| Doc | Change |
|-----|--------|
| `~/.agents/skills/yautja/SKILL.md` | Note: tool results are `YautjaResponse` JSON; branch on `ok` / `error.code` / `error.recovery` |
| `docs/roadmap-phase-10-18.md` | Check off P10 acceptance when done |
| `package.json` version | `0.1.0` → `0.2.0` |

Do **not** rewrite inspecting-perplexity/gemini for envelope beyond one-line “parse ok field” unless needed.

---

## Implementation order (checklist)

### Wave 0 — bridge

- [ ] Create `src/helmet/envelope.ts` (+ optional `session` helper)
- [ ] Tests `envelope-wire.test.ts` green
- [ ] Commit: `feat(helmet): add YautjaResponse envelope bridge`

### Wave A — core path

- [ ] Helmet: sessionId, telemetry, integrity, idempotency instances
- [ ] Wrap: observe, act, inspect, diff, reattach, listTabs, switchTab, openTab, closeTab
- [ ] Wrap: findElement, findClick, findType, smartType
- [ ] Invalid act action shape → YJ.PROTOCOL.INVALID_ARGUMENT
- [ ] Tracker rows wave A → verified
- [ ] Commit: `feat(helmet): envelope wire for core MCP tools`

### Wave B — bulk wrap

- [ ] Remaining handleToolCall cases
- [ ] No bare strings / no `{error}` without ok:false envelope
- [ ] Commit: `feat(helmet): envelope wire for intel/intercept/ws/macro tools`

### Wave C — recovery_stats + ship

- [ ] Register `recovery_stats` tool + handler
- [ ] serverInfo version `0.2.0`
- [ ] package.json version bump
- [ ] Update yautja SKILL.md
- [ ] Create `docs/envelope-migration-tracker.md` completed
- [ ] Full vitest doctrine + helmet green
- [ ] Manual smoke observe + failing click
- [ ] Commit: `feat(helmet): register recovery_stats; ship envelope v0.2.0`

---

## Acceptance criteria (phase DONE)

- [ ] Every `tools/call` returns parseable `YautjaResponse` with `schema_version: "1.0"`
- [ ] Wave A failures use `YJ.*` codes from registry (via classifier)
- [ ] `recovery_stats` listed in `tools/list` and callable
- [ ] `tests/doctrine` still pass without modification (or only additive)
- [ ] New helmet envelope tests pass
- [ ] Tracker 100% wrapped
- [ ] SKILL.md documents envelope
- [ ] No new doctrine modules that duplicate types/registry
- [ ] `npm run lint` clean

---

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Agents/skills assume raw text observe | SKILL update; result always `{ text }` under ok |
| Hosts treat long JSON as noise | keep evidence light; token estimate honest |
| Double JSON encode | serialize once at handleToolCall edge |
| openTab still wrong URL | out of scope P10 (P13.5); still wrap whatever we return |
| RecoveryMachine unused | intentional; P11 binds smartType |
| Breaking MiniMax/neural-link string parse | neural-link is secondary; update if still used |

---

## Dependency for later phases

| Phase | Needs from P10 |
|-------|----------------|
| P11 | Envelope + classifier path; RecoveryMachine instances already on Helmet |
| P12 | act envelope stable for wait errors |
| P13+ | POLICY/OPSEC codes already in registry for profile denials |

---

## File touch summary

```
CREATE  src/helmet/envelope.ts
CREATE  tests/helmet/envelope-wire.test.ts
CREATE  tests/helmet/handle-tool-envelope.test.ts   # optional if covered by unit
CREATE  docs/envelope-migration-tracker.md
CREATE  docs/phase-10-spec.md                       # this file
MODIFY  src/helmet.ts                               # main wire
MODIFY  package.json                                # version 0.2.0
MODIFY  ~/.agents/skills/yautja/SKILL.md            # operator skill
# NO MODIFY of doctrine core except if bugfix discovered while wiring
```

---

## References

| Path | Role |
|------|------|
| `src/doctrine/types.ts` | `success` / `failure` / `YautjaResponse` |
| `src/doctrine/registry.ts` | `YJ.*` MVP codes + `toYautjaError` |
| `src/doctrine/classifier.ts` | Arsenal → YJ.* |
| `src/doctrine/recovery-machine.ts` | Future P11; optional telemetry only in P10 |
| `src/tools/recovery-stats.ts` | Tool factory |
| `src/helmet.ts` `handleToolCall` ~L347+ | Migration surface |
| `docs/roadmap-phase-10-18.md` | Master plan r2 |

---

*End Phase 10 Spec — Wire doctrine → Helmet*
