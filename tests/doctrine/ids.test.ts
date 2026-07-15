import { describe, it, expect } from 'vitest';
import { generateTraceId, generateOperationId, generateIdempotencyKey } from '../../src/doctrine/ids.js';

describe('ID generators', () => {
  it('trace_id starts with tr_ prefix', () => {
    const id = generateTraceId();
    expect(id).toMatch(/^tr_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('operation_id starts with op_ prefix', () => {
    const id = generateOperationId();
    expect(id).toMatch(/^op_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('idempotency_key starts with ik_ prefix', () => {
    const key = generateIdempotencyKey();
    expect(key).toMatch(/^ik_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('two calls produce different IDs', () => {
    expect(generateOperationId()).not.toBe(generateOperationId());
  });
});