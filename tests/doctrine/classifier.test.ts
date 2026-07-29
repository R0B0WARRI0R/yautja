import { describe, it, expect } from 'vitest';
import { classifyLegacyError } from '../../src/doctrine/classifier.js';
import { makeError } from '../../src/arsenal/errors.js';

describe('Legacy error classifier', () => {
  it('maps SELECTOR_NOT_FOUND to YJ.ACT.DOM_TARGET_NOT_FOUND', () => {
    const legacy = makeError('SELECTOR_NOT_FOUND', 'Element not found');
    const yj = classifyLegacyError(legacy);
    expect(yj.code).toBe('YJ.ACT.DOM_TARGET_NOT_FOUND');
    expect(yj.severity).toBe('recoverable');
    expect(yj.retryable).toBe(true);
  });

  it('maps NAVIGATION_TIMEOUT to YJ.NET.REQUEST_TIMEOUT', () => {
    const legacy = makeError('NAVIGATION_TIMEOUT', 'Timeout');
    const yj = classifyLegacyError(legacy);
    expect(yj.code).toBe('YJ.NET.REQUEST_TIMEOUT');
  });

  it('maps TIMEOUT to YJ.NET.REQUEST_TIMEOUT', () => {
    const legacy = makeError('TIMEOUT', 'Timed out');
    const yj = classifyLegacyError(legacy);
    expect(yj.code).toBe('YJ.NET.REQUEST_TIMEOUT');
  });

  it('maps INVALID_ARGUMENT to YJ.PROTOCOL.INVALID_ARGUMENT', () => {
    const legacy = makeError('INVALID_ARGUMENT', 'Bad arg');
    const yj = classifyLegacyError(legacy);
    expect(yj.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
  });

  it('maps PERMISSION_DENIED to YJ.POLICY.DOMAIN_PERMISSION_REQUIRED', () => {
    const legacy = makeError('PERMISSION_DENIED', 'No access');
    const yj = classifyLegacyError(legacy);
    expect(yj.code).toBe('YJ.POLICY.DOMAIN_PERMISSION_REQUIRED');
  });

  it('maps UNKNOWN_ERROR to YJ.PROTOCOL.INVALID_ARGUMENT with LEGACY note', () => {
    const legacy = makeError('UNKNOWN_ERROR', '???');
    const yj = classifyLegacyError(legacy);
    expect(yj.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
    expect(yj.agent_summary).toContain('LEGACY_ERROR_UNCLASSIFIED');
  });

  it('maps FEATURE_DISABLED to YJ.POLICY.FEATURE_DISABLED', () => {
    const legacy = makeError('FEATURE_DISABLED', 'browser_batch disabled via yjBrowserBatch');
    const yj = classifyLegacyError(legacy);
    expect(yj.code).toBe('YJ.POLICY.FEATURE_DISABLED');
    expect(yj.retryable).toBe(false);
    expect(yj.message).toContain('yjBrowserBatch');
  });

  it('maps EXTENSION_LINK_DEGRADED to YJ.NET.EXTENSION_LINK_DEGRADED', () => {
    const legacy = makeError('EXTENSION_LINK_DEGRADED', 'Enlace extensión degradado');
    const yj = classifyLegacyError(legacy);
    expect(yj.code).toBe('YJ.NET.EXTENSION_LINK_DEGRADED');
    expect(yj.retryable).toBe(true);
    expect(legacy.recoverable).toBe(true);
    expect(legacy.recoveryHint).toContain('recuperación automática en curso');
  });

  it('preserves original message in override', () => {
    const legacy = makeError('SELECTOR_NOT_FOUND', 'Custom selector .foo failed');
    const yj = classifyLegacyError(legacy);
    expect(yj.message).toContain('Custom selector .foo failed');
  });
});