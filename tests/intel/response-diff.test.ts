import { describe, it, expect } from 'vitest';
import { responseDiff } from '../../src/intel/response-diff.js';

describe('responseDiff — JSON', () => {
  it('detects an extra field in B (BOLA-style acceptance)', () => {
    const a = '{"id":1,"name":"alice"}';
    const b = '{"id":1,"name":"alice","role":"admin"}';
    const d = responseDiff(a, b);
    expect(d.format).toBe('json');
    expect(d.added).toEqual([{ path: 'role', b: 'admin' }]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
  });

  it('detects removed and changed fields', () => {
    const a = '{"id":1,"name":"alice","email":"a@x.com"}';
    const b = '{"id":2,"name":"alice"}';
    const d = responseDiff(a, b);
    expect(d.changed).toEqual([{ path: 'id', a: 1, b: 2 }]);
    expect(d.removed).toEqual([{ path: 'email', a: 'a@x.com' }]);
  });

  it('recurses into nested objects with dotted paths', () => {
    const a = '{"data":{"user":{"id":1,"meta":{"plan":"free"}}}}';
    const b = '{"data":{"user":{"id":1,"meta":{"plan":"pro"}}}}';
    const d = responseDiff(a, b);
    expect(d.changed).toEqual([{ path: 'data.user.meta.plan', a: 'free', b: 'pro' }]);
  });

  it('ignorePaths skips subtrees', () => {
    const a = '{"data":{"ts":1,"value":5}}';
    const b = '{"data":{"ts":2,"value":5}}';
    const d = responseDiff(a, b, ['data.ts']);
    expect(d.changed).toEqual([]);
  });

  it('compares arrays as whole values', () => {
    const d = responseDiff('{"ids":[1,2]}', '{"ids":[1,2,3]}');
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]!.path).toBe('ids');
  });
});

describe('responseDiff — text fallback', () => {
  it('line-diffs non-JSON bodies', () => {
    const d = responseDiff('line one\nline two', 'line one\nline three');
    expect(d.format).toBe('text');
    expect(d.added).toEqual([{ path: 'line 2', b: 'line three' }]);
    expect(d.removed).toEqual([{ path: 'line 2', a: 'line two' }]);
  });
});
