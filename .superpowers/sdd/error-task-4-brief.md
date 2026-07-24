# Task 4 Brief — State Integrity Tracker

**Source plan:** `D:\Yautja\proyectos-pendientes\2026-07-15-yautja-error-contract-plan.md`
**Repo:** `D:\Yautja` (branch: main)
**Spec:** `D:\Yautja\proyectos-pendientes\yautja-error-contract-1.0.md`
**Ledger:** `D:\Yautja\.superpowers\sdd\error-contract-progress.md`
**Prior task:** Task 3 (commit `c521432`)

## Scene-setting

You are implementing Task 4: a `StateIntegrityTracker` class that tracks session state with valid transition rules. This is used by the recovery machine (Task 7) to know if the session can continue, needs restore, or is contaminated (terminal — requires human).

Critical invariant: `contaminated` is a **terminal state**. Once entered, only human intervention can transition out. The `markContaminated` followed by any auto-recovery attempt must throw.

## Files

- Create: `src/doctrine/state-integrity.ts`
- Create: `tests/doctrine/state-integrity.test.ts`

## Interfaces

- **Consumes:** `StateIntegrity` from `src/doctrine/types.js`
- **Produces:**
  - `isValidTransition(from, to)` — pure function
  - `StateIntegrityTracker` class

## Step 1: Write failing tests

Create `tests/doctrine/state-integrity.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { StateIntegrityTracker, isValidTransition } from '../../src/doctrine/state-integrity.js';

describe('State Integrity', () => {
  describe('isValidTransition', () => {
    it('known → corrupted is valid', () => {
      expect(isValidTransition('known', 'corrupted')).toBe(true);
    });

    it('corrupted → restored is valid', () => {
      expect(isValidTransition('corrupted', 'restored')).toBe(true);
    });

    it('restored → known is valid', () => {
      expect(isValidTransition('restored', 'known')).toBe(true);
    });

    it('known → contaminated is valid', () => {
      expect(isValidTransition('known', 'contaminated')).toBe(true);
    });

    it('contaminated → known is INVALID (requires human)', () => {
      expect(isValidTransition('contaminated', 'known')).toBe(false);
    });

    it('unknown → known is valid', () => {
      expect(isValidTransition('unknown', 'known')).toBe(true);
    });
  });

  describe('StateIntegrityTracker', () => {
    it('starts with unknown', () => {
      const tracker = new StateIntegrityTracker('ses_1');
      expect(tracker.current()).toBe('unknown');
    });

    it('transitions to known after checkpoint', () => {
      const tracker = new StateIntegrityTracker('ses_1');
      tracker.markKnown('cp_1');
      expect(tracker.current()).toBe('known');
    });

    it('transitions to corrupted on drift', () => {
      const tracker = new StateIntegrityTracker('ses_1');
      tracker.markKnown('cp_1');
      tracker.markCorrupted();
      expect(tracker.current()).toBe('corrupted');
    });

    it('restore sets to restored then resets to known on next op', () => {
      const tracker = new StateIntegrityTracker('ses_1');
      tracker.markKnown('cp_1');
      tracker.markCorrupted();
      tracker.restore('cp_1');
      expect(tracker.current()).toBe('restored');
      tracker.beginOperation();
      expect(tracker.current()).toBe('known');
    });

    it('markContaminated throws if trying to auto-recover', () => {
      const tracker = new StateIntegrityTracker('ses_1');
      tracker.markContaminated('fingerprint leak detected');
      expect(tracker.current()).toBe('contaminated');
      expect(() => tracker.markKnown('cp_1')).toThrow(/contaminated.*human/);
    });
  });
});
```

## Step 2: Implement state-integrity.ts

Create `src/doctrine/state-integrity.ts`:

```typescript
import type { StateIntegrity } from './types.js';

const VALID_TRANSITIONS: Record<StateIntegrity, StateIntegrity[]> = {
  unknown: ['known', 'corrupted', 'contaminated'],
  known: ['known', 'corrupted', 'contaminated', 'unknown'],
  corrupted: ['restored', 'contaminated', 'unknown'],
  restored: ['known', 'corrupted', 'contaminated'],
  contaminated: [], // terminal — requires human intervention
};

export function isValidTransition(from: StateIntegrity, to: StateIntegrity): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export class StateIntegrityTracker {
  private _state: StateIntegrity = 'unknown';
  private _session_id: string;
  private _current_checkpoint: string | null = null;
  private _contamination_reason: string | null = null;

  constructor(session_id: string) {
    this._session_id = session_id;
  }

  current(): StateIntegrity {
    return this._state;
  }

  checkpoint(): string | null {
    return this._current_checkpoint;
  }

  session_id(): string {
    return this._session_id;
  }

  contamination_reason(): string | null {
    return this._contamination_reason;
  }

  markKnown(checkpoint_id: string): void {
    this.assertCanTransition('known');
    this._state = 'known';
    this._current_checkpoint = checkpoint_id;
  }

  markCorrupted(): void {
    this.assertCanTransition('corrupted');
    this._state = 'corrupted';
  }

  restore(checkpoint_id: string): void {
    this.assertCanTransition('restored');
    this._state = 'restored';
    this._current_checkpoint = checkpoint_id;
  }

  markContaminated(reason: string): void {
    this.assertCanTransition('contaminated');
    this._state = 'contaminated';
    this._contamination_reason = reason;
  }

  beginOperation(): void {
    if (this._state === 'restored') {
      this._state = 'known';
    }
  }

  forceReset(): void {
    // Only for testing or admin override
    this._state = 'unknown';
    this._current_checkpoint = null;
    this._contamination_reason = null;
  }

  private assertCanTransition(target: StateIntegrity): void {
    if (this._state === 'contaminated' && target !== 'contaminated') {
      throw new Error(
        `Cannot transition from contaminated to ${target}. ` +
        `Contaminated state requires human intervention. ` +
        `Reason: ${this._contamination_reason ?? 'unknown'}`,
      );
    }
    if (!isValidTransition(this._state, target)) {
      throw new Error(
        `Invalid state transition: ${this._state} → ${target}`,
      );
    }
  }
}
```

## Step 3: Run tests

Run: `npx vitest run tests/doctrine/state-integrity.test.ts`
Expected: PASS (10 tests)

## Step 4: Commit

```bash
cd D:\Yautja
git add src/doctrine/state-integrity.ts tests/doctrine/state-integrity.test.ts
git commit -m "feat(doctrine): add state integrity tracker with valid transition rules"
```

## Report Contract

Write to `D:\Yautja\.superpowers\sdd\error-task-4-report.md`:

```markdown
# Task 4 Report

**Status:** DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
**Commits:** <hash7> <message>
**Test summary:** <passed>/<total>, tsc: 0 errors
**Self-review:** [what you checked]
**Concerns:** [observations]
```

Return ONLY: status, commits, test summary, concerns.