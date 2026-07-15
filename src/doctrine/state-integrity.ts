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
