import { describe, it, expect } from 'vitest';
import { buildFormInputScript, parseFormInputResult } from '../../src/arsenal/form-input.js';
import { REDACTED_VALUE } from '../../src/vision/redaction.js';

describe('buildFormInputScript', () => {
  it('resolves by selector when no ref is given', () => {
    const js = buildFormInputScript({ selector: '#email', value: 'a@b.c' });
    expect(js).toContain('document.querySelector("#email")');
    expect(js).toContain("error: 'NOT_FOUND'");
    expect(js).not.toContain('__yjElementMap');
    expect(js).toContain('"a@b.c"');
  });

  it('resolves by ref via the element map with stale purge', () => {
    const js = buildFormInputScript({ ref: 'e3', value: 'x' });
    expect(js).toContain('__yjElementMap');
    expect(js).toContain('"e3"');
    expect(js).toContain('document.contains(el)');
    expect(js).toContain("error: 'REF_NOT_FOUND'");
  });

  it('duplicates the sensitive-field detector inline (keep in sync with redaction.ts)', () => {
    const js = buildFormInputScript({ selector: '#pw', value: 'secret' });
    expect(js).toContain('keep in sync with src/vision/redaction.ts');
    expect(js).toContain("'password' || t === 'hidden'");
    expect(js).toContain('one-time-code');
    expect(js).toContain(REDACTED_VALUE);
  });

  it('branches by element type and fires focus + input + change (bubbles)', () => {
    const js = buildFormInputScript({ selector: '#f', value: 5 });
    expect(js).toContain("tag === 'SELECT'");
    expect(js).toContain("itype === 'checkbox'");
    expect(js).toContain("itype === 'radio'");
    expect(js).toContain("itype === 'date'");
    expect(js).toContain("itype === 'range'");
    expect(js).toContain('isContentEditable');
    expect(js).toContain('el.focus()');
    expect(js).toContain("new Event('input', { bubbles: true })");
    expect(js).toContain("new Event('change', { bubbles: true })");
    expect(js).toContain('options: avail.slice(0, 20)');
  });
});

describe('parseFormInputResult', () => {
  it('parses a success payload with previous/new', () => {
    const raw = JSON.stringify({ ok: true, previous: 'old', new: 'val', sensitive: false, tag: 'INPUT', inputType: 'text' });
    const r = parseFormInputResult(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.previous).toBe('old');
      expect(r.value.new).toBe('val');
      expect(r.value.sensitive).toBe(false);
    }
  });

  it('forces redaction node-side when the field is sensitive', () => {
    const raw = JSON.stringify({ ok: true, previous: 'real-password', new: 'also-real', sensitive: true, tag: 'INPUT', inputType: 'password' });
    const r = parseFormInputResult(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.previous).toBe(REDACTED_VALUE);
      expect(r.value.new).toBe(REDACTED_VALUE);
      expect(r.value.sensitive).toBe(true);
    }
  });

  it('reports radio group when present', () => {
    const raw = JSON.stringify({ ok: true, previous: false, new: true, sensitive: false, tag: 'INPUT', inputType: 'radio', group: 'plan' });
    const r = parseFormInputResult(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.group).toBe('plan');
  });

  it('maps REF_NOT_FOUND', () => {
    const r = parseFormInputResult(JSON.stringify({ error: 'REF_NOT_FOUND' }));
    expect(r).toEqual({ ok: false, error: 'REF_NOT_FOUND' });
  });

  it('maps NO_OPTION with the available options (max 20)', () => {
    const options = Array.from({ length: 30 }, (_, i) => `opt${i}`);
    const r = parseFormInputResult(JSON.stringify({ error: 'NO_OPTION', options }));
    expect(r.ok).toBe(false);
    if (!r.ok && r.error === 'NO_OPTION') expect(r.options.length).toBe(20);
  });

  it('maps BAD_VALUE with expected type', () => {
    const r = parseFormInputResult(JSON.stringify({ error: 'BAD_VALUE', expected: 'boolean', inputType: 'checkbox' }));
    expect(r).toEqual({ ok: false, error: 'BAD_VALUE', expected: 'boolean', inputType: 'checkbox' });
  });

  it('maps NOT_INPUT and unknown/garbage payloads to NOT_FOUND', () => {
    expect(parseFormInputResult(JSON.stringify({ error: 'NOT_INPUT' }))).toEqual({ ok: false, error: 'NOT_INPUT' });
    expect(parseFormInputResult('not json')).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(parseFormInputResult(undefined)).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(parseFormInputResult('')).toEqual({ ok: false, error: 'NOT_FOUND' });
  });
});
