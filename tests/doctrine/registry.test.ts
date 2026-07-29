import { describe, it, expect } from 'vitest';
import { REGISTRY, lookupCode, codesInFamily, MVP_CODES } from '../../src/doctrine/registry.js';

describe('Error code registry', () => {
  it('has exactly 26 MVP codes (12 core + 5 P11 + 1 P12 + 3 P13 + 1 P13.5 + 2 P14.1 + 1 P16 + 1 link watchdog)', () => {
    expect(MVP_CODES).toHaveLength(26);
  });

  it('every code matches YJ.FAMILY.NAME pattern', () => {
    for (const code of MVP_CODES) {
      expect(code.code).toMatch(/^YJ\.[A-Z]+\.[A-Z_]+$/);
    }
  });

  it('lookupCode returns definition for known code', () => {
    const def = lookupCode('YJ.ACT.DOM_TARGET_STALE');
    expect(def).toBeDefined();
    expect(def!.category).toBe('action');
    expect(def!.severity).toBe('recoverable');
    expect(def!.retryable).toBe(true);
    expect(def!.introduced_in).toBe('1.0');
  });

  it('lookupCode returns undefined for unknown code', () => {
    expect(lookupCode('YJ.BOGUS.NOT_REAL')).toBeUndefined();
  });

  it('codesInFamily returns all codes in a category', () => {
    const actionCodes = codesInFamily('action');
    expect(actionCodes).toHaveLength(11);
    expect(actionCodes.map(c => c.code)).toContain('YJ.ACT.DOM_TARGET_STALE');
    expect(actionCodes.map(c => c.code)).toContain('YJ.ACT.TYPE_PARTIAL');
    expect(actionCodes.map(c => c.code)).toContain('YJ.ACT.WAIT_TIMEOUT');
    expect(actionCodes.map(c => c.code)).toContain('YJ.ACT.TAB_SWITCH_MISMATCH');
  });

  it('terminal severity codes are never retryable', () => {
    const terminal = MVP_CODES.filter(c => c.severity === 'terminal');
    for (const code of terminal) {
      expect(code.retryable).toBe(false);
    }
  });

  it('correctable severity codes are never retryable', () => {
    const correctable = MVP_CODES.filter(c => c.severity === 'correctable');
    for (const code of correctable) {
      expect(code.retryable).toBe(false);
    }
  });

  it('approval_required severity codes have user_confirmation_required', () => {
    const approval = MVP_CODES.filter(c => c.severity === 'approval_required');
    for (const code of approval) {
      expect(code.user_confirmation_required).toBe(true);
    }
  });
});