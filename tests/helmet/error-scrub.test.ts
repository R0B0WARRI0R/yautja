import { describe, it, expect } from 'vitest';
import { scrubErrorMessage } from '../../src/helmet.js';

describe('scrubErrorMessage (helmet pass-2)', () => {
  it('redacts Windows absolute paths', () => {
    const m = 'ENOENT: no such file or directory, open \'C:\\Users\\victim\\.config\\yautja\\profiles\\x.json\'';
    const s = scrubErrorMessage(m);
    expect(s).not.toContain('victim');
    expect(s).not.toContain('C:\\Users');
    expect(s).toContain('<path>');
  });

  it('redacts Unix /home and /Users paths', () => {
    const cases = [
      'Error: cannot read /home/alice/.config/yautja/state.json',
      'Cannot open /Users/bob/Documents/secrets.txt',
      'permission denied: /var/log/yautja/audit.jsonl',
      'Not a file: /etc/yautja/yautja.json',
      'Missing: /tmp/yautja-12345/abc.json',
    ];
    for (const c of cases) {
      const s = scrubErrorMessage(c);
      expect(s, c).not.toMatch(/\/(home|Users|var|etc|tmp)\/[^\s]+/);
      expect(s, c).toContain('<path>');
    }
  });

  it('strips ANSI escape codes', () => {
    const s = scrubErrorMessage('\x1b[31mfail\x1b[0m: something broke');
    expect(s).not.toContain('\x1b');
    expect(s).toBe('fail: something broke');
  });

  it('truncates messages over 240 chars', () => {
    const long = 'x'.repeat(1000);
    const s = scrubErrorMessage(long);
    expect(s.length).toBeLessThanOrEqual(241); // 240 + ellipsis
    expect(s.endsWith('…')).toBe(true);
  });

  it('handles null, undefined, non-string inputs', () => {
    expect(scrubErrorMessage(null)).toBe('');
    expect(scrubErrorMessage(undefined)).toBe('');
    expect(scrubErrorMessage(new Error('boom'))).toContain('boom');
    expect(scrubErrorMessage({ message: 'nested' })).toContain('nested');
  });

  it('does NOT redact relative paths or legitimate words', () => {
    const cases = [
      'TypeError: x is not a function',
      'NetworkError when attempting to fetch resource',
      'Could not find selector "input[name=email]"',
      'Tab 42 not found',
    ];
    for (const c of cases) {
      const s = scrubErrorMessage(c);
      expect(s, c).toBe(c);
    }
  });

  it('does not over-strip: keeps parentheses, brackets, and JSON syntax in error messages', () => {
    const m = 'SyntaxError: Unexpected token } in JSON at position 42';
    expect(scrubErrorMessage(m)).toBe(m);
  });
});