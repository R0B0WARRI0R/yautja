import { describe, it, expect } from 'vitest';
import {
  scoreDomain,
  selectDomains,
  getTopDomain,
  type SensorDomain,
} from '../../src/targeting/relevance.js';

describe('scoreDomain', () => {
  it('returns 0 for unrelated question', () => {
    expect(scoreDomain('tell me a story about dragons', 'network')).toBe(0);
    expect(scoreDomain('what is the weather today', 'security')).toBe(0);
  });

  it('returns >0 for "why is this slow" → performance', () => {
    expect(scoreDomain('why is this slow', 'performance')).toBeGreaterThan(0);
  });

  it('returns >0 for "what errors" → console', () => {
    expect(scoreDomain('what errors are happening', 'console')).toBeGreaterThan(0);
  });

  it('returns >0 for "security issues" → security', () => {
    expect(scoreDomain('are there security issues', 'security')).toBeGreaterThan(0);
  });

  it('handles bilingual keywords (lento)', () => {
    expect(scoreDomain('por que esta lento', 'performance')).toBeGreaterThan(0);
  });

  it('handles bilingual keywords (error)', () => {
    expect(scoreDomain('hay un error en la página', 'console')).toBeGreaterThan(0);
  });

  it('handles bilingual keywords (memoria)', () => {
    expect(scoreDomain('uso de memoria alto', 'performance')).toBeGreaterThan(0);
  });

  it('"blocked" gets higher weight (1.2) for network', () => {
    const blockedScore = scoreDomain('why is this request blocked', 'network');
    const slowScore = scoreDomain('why is this slow', 'network');
    expect(blockedScore).toBe(1.2);
    expect(slowScore).toBe(1.0);
    expect(blockedScore).toBeGreaterThan(slowScore);
  });

  it('"typeerror" gets higher weight (1.1) for console', () => {
    const typeErrorScore = scoreDomain('TypeError: cannot read property', 'console');
    const errorScore = scoreDomain('there is an error', 'console');
    expect(typeErrorScore).toBe(1.1);
    expect(errorScore).toBe(1.0);
    expect(typeErrorScore).toBeGreaterThan(errorScore);
  });
});

describe('selectDomains', () => {
  it('returns sorted by score descending', () => {
    const result = selectDomains('why is the page slow and have errors');
    expect(result.length).toBeGreaterThan(0);
    for (let i = 1; i < result.length; i++) {
      expect(scoreDomain('why is the page slow and have errors', result[i - 1]!))
        .toBeGreaterThanOrEqual(scoreDomain('why is the page slow and have errors', result[i]!));
    }
  });

  it('returns empty for completely unrelated question', () => {
    const result = selectDomains('tell me about quantum physics');
    expect(result).toEqual([]);
  });

  it('threshold filters low-scoring domains', () => {
    const highThreshold = selectDomains('page is slow', 1.5);
    expect(highThreshold).toEqual([]);
    const lowThreshold = selectDomains('page is slow', 0.5);
    expect(lowThreshold).toContain('performance');
  });

  it('returns multiple domains when question matches several', () => {
    const result = selectDomains('why is the api slow and throwing errors');
    expect(result).toContain('network');
    expect(result).toContain('console');
  });
});

describe('getTopDomain', () => {
  it('returns highest scoring domain', () => {
    const result = getTopDomain('why is the api slow with typeerror');
    expect(result).not.toBeNull();
    expect(['network', 'console', 'performance']).toContain(result);
  });

  it('returns null for unrelated question', () => {
    const result = getTopDomain('xyzzy foobar baz');
    expect(result).toBeNull();
  });

  it('matches spec test case: security', () => {
    expect(getTopDomain('security issues on this page')).toBe('security');
  });

  it('matches spec test case: console for uncaught', () => {
    expect(getTopDomain('uncaught nan in app')).toBe('console');
  });
});

describe('SensorDomain type', () => {
  it('all 5 domains are valid', () => {
    const allDomains: SensorDomain[] = ['network', 'dom', 'console', 'performance', 'security'];
    expect(allDomains).toHaveLength(5);
  });
});
