import { describe, it, expect } from 'vitest';
import {
  REGISTRY,
  lookupCode,
  codesInFamily,
  MVP_CODES,
  toYautjaError,
  validateRecoveryOverride,
  UNKNOWN_ERROR_CODE,
} from '../../src/doctrine/registry.js';

describe('Error code registry', () => {
  it('has 27 original codes and 12 runtime reliability codes', () => {
    expect(MVP_CODES).toHaveLength(39);
    expect(MVP_CODES.filter(c => c.code.startsWith('YJ.RUNTIME.'))).toHaveLength(12);
  });

  it('REGISTRY size matches MVP_CODES length (no duplicates, no missing)', () => {
    expect(REGISTRY.size).toBe(MVP_CODES.length);
  });

  it('every code is unique', () => {
    const codes = MVP_CODES.map(c => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('every code matches YJ.FAMILY.NAME pattern', () => {
    for (const code of MVP_CODES) {
      expect(code.code).toMatch(/^YJ\.[A-Z]+\.[A-Z_]+$/);
    }
  });

  it('every introduced_in is a dot-separated numeric version', () => {
    for (const code of MVP_CODES) {
      expect(code.introduced_in).toMatch(/^\d+(\.\d+)*$/);
    }
  });

  it('every default_message_en and default_agent_summary_en is non-empty', () => {
    for (const code of MVP_CODES) {
      expect(code.default_message_en.trim().length).toBeGreaterThan(0);
      expect(code.default_agent_summary_en.trim().length).toBeGreaterThan(0);
    }
  });

  it('every default_recovery_recommended is in default_recovery_allowed', () => {
    for (const code of MVP_CODES) {
      expect(code.default_recovery_allowed).toContain(code.default_recovery_recommended);
    }
  });

  it('every default_retry_strategy is in default_recovery_allowed', () => {
    for (const code of MVP_CODES) {
      expect(code.default_recovery_allowed).toContain(code.default_retry_strategy);
    }
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

  it('transient severity codes are always retryable', () => {
    const transient = MVP_CODES.filter(c => c.severity === 'transient');
    expect(transient.length).toBeGreaterThan(0);
    for (const code of transient) {
      expect(code.retryable).toBe(true);
    }
  });

  it('approval_required severity codes have user_confirmation_required=true', () => {
    const approval = MVP_CODES.filter(c => c.severity === 'approval_required');
    for (const code of approval) {
      expect(code.user_confirmation_required).toBe(true);
    }
  });
});

describe('lookupCode', () => {
  it('returns definition for known code', () => {
    const def = lookupCode('YJ.ACT.DOM_TARGET_STALE');
    expect(def).toBeDefined();
    expect(def!.category).toBe('action');
    expect(def!.severity).toBe('recoverable');
    expect(def!.retryable).toBe(true);
    expect(def!.introduced_in).toBe('1.0');
  });

  it('returns undefined for unknown code', () => {
    expect(lookupCode('YJ.BOGUS.NOT_REAL')).toBeUndefined();
  });

  it('canonicalizes input: lower-case + whitespace', () => {
    const def = lookupCode('  yj.act.dom_target_stale  ');
    expect(def).toBeDefined();
    expect(def!.code).toBe('YJ.ACT.DOM_TARGET_STALE');
  });

  it('returns undefined for empty string', () => {
    expect(lookupCode('')).toBeUndefined();
  });
});

describe('codesInFamily', () => {
  it('returns all 11 action codes', () => {
    const actionCodes = codesInFamily('action');
    expect(actionCodes).toHaveLength(23);
    expect(actionCodes.map(c => c.code)).toContain('YJ.ACT.DOM_TARGET_STALE');
    expect(actionCodes.map(c => c.code)).toContain('YJ.ACT.TYPE_PARTIAL');
    expect(actionCodes.map(c => c.code)).toContain('YJ.ACT.WAIT_TIMEOUT');
    expect(actionCodes.map(c => c.code)).toContain('YJ.ACT.TAB_SWITCH_MISMATCH');
  });

  it('returns 3 protocol codes (incl. UNKNOWN_ERROR_CODE sentinel)', () => {
    const protocolCodes = codesInFamily('protocol');
    expect(protocolCodes).toHaveLength(3);
    expect(protocolCodes.map(c => c.code)).toContain('YJ.PROTOCOL.INVALID_ARGUMENT');
    expect(protocolCodes.map(c => c.code)).toContain('YJ.PROTOCOL.CAPABILITY_MISSING');
    expect(protocolCodes.map(c => c.code)).toContain(UNKNOWN_ERROR_CODE);
  });

  it('returns 2 capture codes', () => {
    expect(codesInFamily('capture')).toHaveLength(2);
  });

  it('returns 3 net codes', () => {
    expect(codesInFamily('net')).toHaveLength(3);
  });

  it('returns 6 policy codes', () => {
    expect(codesInFamily('policy')).toHaveLength(6);
  });

  it('returns 2 opsec codes', () => {
    expect(codesInFamily('opsec')).toHaveLength(2);
  });

  it('known categories account for every registered code', () => {
    const total = (['protocol', 'action', 'capture', 'net', 'policy', 'opsec'] as const)
      .reduce((acc, cat) => acc + codesInFamily(cat).length, 0);
    expect(total).toBe(MVP_CODES.length);
  });

  it('returned array is frozen at runtime', () => {
    const action = codesInFamily('action');
    expect(Object.isFrozen(action)).toBe(true);
  });
});

describe('toYautjaError', () => {
  it('builds a typed YautjaError from a known code', () => {
    const err = toYautjaError('YJ.ACT.DOM_TARGET_STALE');
    expect(err.code).toBe('YJ.ACT.DOM_TARGET_STALE');
    expect(err.severity).toBe('recoverable');
    expect(err.retryable).toBe(true);
    expect(err.retry_strategy).toBe('REOBSERVE_THEN_RETRY');
    expect(err.recovery.allowed).toContain('REOBSERVE_THEN_RETRY');
    expect(err.recovery.recommended).toBe('REOBSERVE_THEN_RETRY');
    expect(err.recovery.next_tool_call).toBeNull();
    expect(err.message).toContain('Target element changed');
  });

  it('honors message override', () => {
    const err = toYautjaError('YJ.ACT.DOM_TARGET_STALE', { message: 'custom' });
    expect(err.message).toBe('custom');
    expect(err.agent_summary).toContain('Re-observe');
  });

  it('honors agent_summary override', () => {
    const err = toYautjaError('YJ.ACT.DOM_TARGET_STALE', { agent_summary: 'custom summary' });
    expect(err.agent_summary).toBe('custom summary');
  });

  it('honors recovery override (allowed + recommended)', () => {
    const err = toYautjaError('YJ.ACT.DOM_TARGET_STALE', {
      recovery: {
        allowed: ['ABORT', 'RETRY_SAME'],
        recommended: 'ABORT',
        next_tool_call: null,
      },
    });
    expect(err.recovery.allowed).toEqual(['ABORT', 'RETRY_SAME']);
    expect(err.recovery.recommended).toBe('ABORT');
  });

  it('throws TypeError on invalid recovery override (empty allowed)', () => {
    expect(() =>
      toYautjaError('YJ.ACT.DOM_TARGET_STALE', {
        recovery: {
          allowed: [],
          recommended: 'ABORT',
          next_tool_call: null,
        },
      }),
    ).toThrow(TypeError);
  });

  it('throws TypeError on invalid recovery override (recommended ∉ allowed)', () => {
    expect(() =>
      toYautjaError('YJ.ACT.DOM_TARGET_STALE', {
        recovery: {
          allowed: ['ABORT'],
          recommended: 'RETRY_SAME',
          next_tool_call: null,
        },
      }),
    ).toThrow(TypeError);
  });

  it('returns a typed UNKNOWN_ERROR_CODE YautjaError for unknown input', () => {
    const err = toYautjaError('YJ.BOGUS.NOT_REAL');
    expect(err.code).toBe(UNKNOWN_ERROR_CODE);
    expect(err.severity).toBe('terminal');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('YJ.BOGUS.NOT_REAL');
  });

  it('returned recovery.allowed is a fresh array (not aliased to default)', () => {
    const err1 = toYautjaError('YJ.ACT.DOM_TARGET_STALE');
    const err2 = toYautjaError('YJ.ACT.DOM_TARGET_STALE');
    expect(err1.recovery.allowed).not.toBe(err2.recovery.allowed);
    expect(err1.recovery.allowed).toEqual(err2.recovery.allowed);
  });
});

describe('validateRecoveryOverride', () => {
  it('accepts a valid recovery override', () => {
    expect(() =>
      validateRecoveryOverride({
        allowed: ['ABORT', 'RETRY_SAME'],
        recommended: 'ABORT',
        next_tool_call: null,
      }),
    ).not.toThrow();
  });

  it('rejects empty allowed array', () => {
    expect(() =>
      validateRecoveryOverride({
        allowed: [],
        recommended: 'ABORT',
        next_tool_call: null,
      }),
    ).toThrow(TypeError);
  });

  it('rejects recommended not in allowed', () => {
    expect(() =>
      validateRecoveryOverride({
        allowed: ['ABORT'],
        recommended: 'RETRY_SAME',
        next_tool_call: null,
      }),
    ).toThrow(TypeError);
  });
});

describe('runtime immutability guard', () => {
  it('MVP_CODES outer array is frozen', () => {
    expect(Object.isFrozen(MVP_CODES)).toBe(true);
  });

  it('each MVP_CODES entry is frozen', () => {
    for (const def of MVP_CODES) {
      expect(Object.isFrozen(def)).toBe(true);
    }
  });

  it('REGISTRY is frozen', () => {
    expect(Object.isFrozen(REGISTRY)).toBe(true);
  });

  it('default_recovery_allowed on each entry is frozen (would corrupt=aliases otherwise)', () => {
    for (const def of MVP_CODES) {
      expect(Object.isFrozen(def.default_recovery_allowed)).toBe(true);
    }
  });
});
