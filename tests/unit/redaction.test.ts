import { describe, it, expect } from 'vitest';
import { isSensitiveElement, redactValue, REDACTED_VALUE } from '../../src/vision/redaction.js';

describe('isSensitiveElement', () => {
  it('password type is sensitive', () => {
    expect(isSensitiveElement({ type: 'password' })).toBe(true);
  });

  it('hidden type is sensitive', () => {
    expect(isSensitiveElement({ type: 'hidden' })).toBe(true);
  });

  it('type matching is case-insensitive', () => {
    expect(isSensitiveElement({ type: 'PASSWORD' })).toBe(true);
  });

  it('text/email/search types are not sensitive', () => {
    for (const type of ['text', 'email', 'search', 'tel', 'number']) {
      expect(isSensitiveElement({ type })).toBe(false);
    }
  });

  it('autocomplete password tokens are sensitive', () => {
    expect(isSensitiveElement({ type: 'text', autocomplete: 'current-password' })).toBe(true);
    expect(isSensitiveElement({ autocomplete: 'new-password' })).toBe(true);
    expect(isSensitiveElement({ autocomplete: 'one-time-code' })).toBe(true);
  });

  it('autocomplete credit-card tokens are sensitive', () => {
    for (const ac of ['cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year']) {
      expect(isSensitiveElement({ autocomplete: ac })).toBe(true);
    }
  });

  it('autocomplete matching is case-insensitive and matches compound values', () => {
    expect(isSensitiveElement({ autocomplete: 'CURRENT-PASSWORD' })).toBe(true);
    expect(isSensitiveElement({ autocomplete: 'section-blue cc-number' })).toBe(true);
  });

  it('benign autocomplete values are not sensitive', () => {
    for (const ac of ['email', 'username', 'name', 'off', 'on', 'postal-code']) {
      expect(isSensitiveElement({ autocomplete: ac })).toBe(false);
    }
  });

  it('missing/null attributes are not sensitive', () => {
    expect(isSensitiveElement({})).toBe(false);
    expect(isSensitiveElement({ type: null, autocomplete: null })).toBe(false);
  });
});

describe('redactValue', () => {
  it('replaces the value of sensitive fields', () => {
    expect(redactValue({ type: 'password' }, 'hunter2')).toBe(REDACTED_VALUE);
    expect(REDACTED_VALUE).toBe('[value redacted]');
  });

  it('keeps the value of non-sensitive fields', () => {
    expect(redactValue({ type: 'text' }, 'hello')).toBe('hello');
  });
});
