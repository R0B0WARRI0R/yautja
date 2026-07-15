import { describe, it, expect } from 'vitest';
import { REGISTRY, lookupCode, codesInFamily, MVP_CODES } from '../../src/doctrine/registry.js';

describe('Error code registry', () => {
  it('has exactly 12 MVP codes', () => {
    expect(MVP_CODES).toHaveLength(12);
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
    expect(actionCodes).toHaveLength(4);
    expect(actionCodes.map(c => c.code)).toContain('YJ.ACT.DOM_TARGET_STALE');
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