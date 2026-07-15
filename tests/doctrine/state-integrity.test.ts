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
