import { describe, it, expect } from 'vitest';
import {
  validatePlanInput,
  formatPlanForChat,
  PLAN_MIN_ITEMS,
  PLAN_MAX_ITEMS,
} from '../../src/doctrine/plan.js';

const VALID_ITEMS = ['Reconocer la API', 'Mapear endpoints', 'Probar auth'];

describe('validatePlanInput', () => {
  it('accepts a valid plan and defaults requestedLevel to P2', () => {
    const v = validatePlanInput({ items: VALID_ITEMS, domains: ['API.Example.com'] });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.plan.requestedLevel).toBe('P2');
    expect(v.plan.domains).toEqual(['api.example.com']); // normalizado a lowercase
    expect(v.plan.items).toEqual(VALID_ITEMS);
    expect(v.plan.proposedAt).toBeTruthy();
  });

  it('dedupes domains after normalization', () => {
    const v = validatePlanInput({ items: VALID_ITEMS, domains: ['Example.com', 'example.COM'] });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.plan.domains).toEqual(['example.com']);
  });

  it('rejects item counts outside the 3-7 range', () => {
    for (const items of [
      ['solo uno', 'y dos'],
      Array(PLAN_MAX_ITEMS + 1).fill('paso'),
    ]) {
      const v = validatePlanInput({ items, domains: ['example.com'] });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.message).toContain(`${PLAN_MIN_ITEMS}-${PLAN_MAX_ITEMS}`);
    }
    const min = validatePlanInput({ items: Array(PLAN_MIN_ITEMS).fill('paso'), domains: ['example.com'] });
    expect(min.ok).toBe(true);
  });

  it('rejects empty or non-string items', () => {
    expect(validatePlanInput({ items: ['a', '  ', 'c'], domains: ['example.com'] }).ok).toBe(false);
    expect(validatePlanInput({ items: ['a', 5, 'c'], domains: ['example.com'] }).ok).toBe(false);
    expect(validatePlanInput({ items: 'nope', domains: ['example.com'] }).ok).toBe(false);
  });

  it('rejects domains with scheme, path or port', () => {
    for (const d of ['https://example.com', 'example.com/v1', 'example.com:8443']) {
      const v = validatePlanInput({ items: VALID_ITEMS, domains: [d] });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.message).toContain('hosts only');
    }
  });

  it('rejects wildcards (bare and subdomain) — gate matching is exact', () => {
    for (const d of ['*', '*.example.com']) {
      const v = validatePlanInput({ items: VALID_ITEMS, domains: [d] });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.message).toContain('wildcards');
    }
  });

  it('rejects malformed hostnames and empty domain lists', () => {
    expect(validatePlanInput({ items: VALID_ITEMS, domains: ['not a host!'] }).ok).toBe(false);
    expect(validatePlanInput({ items: VALID_ITEMS, domains: [] }).ok).toBe(false);
    expect(validatePlanInput({ items: VALID_ITEMS }).ok).toBe(false);
  });

  it('accepts localhost and hyphenated multi-label hosts', () => {
    const v = validatePlanInput({ items: VALID_ITEMS, domains: ['localhost', 'my-api.example-site.co.uk'] });
    expect(v.ok).toBe(true);
  });

  it('rejects a bad requestedLevel', () => {
    const v = validatePlanInput({ items: VALID_ITEMS, domains: ['example.com'], requestedLevel: 'P5' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toContain('requestedLevel');
    expect(validatePlanInput({ items: VALID_ITEMS, domains: ['example.com'], requestedLevel: 'P0' }).ok).toBe(false);
  });

  it('accepts explicit levels P1-P4', () => {
    for (const requestedLevel of ['P1', 'P2', 'P3', 'P4']) {
      const v = validatePlanInput({ items: VALID_ITEMS, domains: ['example.com'], requestedLevel });
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.plan.requestedLevel).toBe(requestedLevel);
    }
  });
});

describe('formatPlanForChat', () => {
  it('renders items, domains and level; states nothing is granted yet', () => {
    const v = validatePlanInput({ items: VALID_ITEMS, domains: ['example.com'], requestedLevel: 'P3' });
    if (!v.ok) throw new Error('unexpected');
    const text = formatPlanForChat(v.plan);
    expect(text).toContain('P3');
    expect(text).toContain('1. Reconocer la API');
    expect(text).toContain('3. Probar auth');
    expect(text).toContain('example.com');
    expect(text).toContain('plan_approve');
    expect(text).toMatch(/nothing is granted yet/i);
  });
});
