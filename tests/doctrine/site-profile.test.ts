import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SiteProfileStore,
  SiteProfileSchema,
  HARDCODED_DEFAULT_PROFILE,
  isInterceptAllowed,
  isUrlAllowed,
} from '../../src/doctrine/site-profile.js';
import { fileURLToPath } from 'url';

const SHIPPED_DIR = fileURLToPath(new URL('../../profiles', import.meta.url));

describe('SiteProfileSchema', () => {
  it('parses the shipped perplexity profile', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(SHIPPED_DIR, 'perplexity.json'), 'utf8'));
    const parsed = SiteProfileSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.id).toBe('perplexity');
      expect(parsed.data.rules.intercept).toBe('forbid');
      expect(parsed.data.preFlight).toHaveLength(2);
      const readyAllOf = parsed.data.waitDefaults.ready.allOf ?? [];
      const submit = readyAllOf.find((p: any) => p.type === 'submitState');
      expect(submit).toBeDefined();
      expect(submit.state).toBe('idle');
      expect(submit.signals).toEqual([{ kind: 'ariaLabel', value: 'Enviar' }]);
    }
  });

  it('applies rule defaults on a minimal profile', () => {
    const parsed = SiteProfileSchema.parse({ id: 'x', version: 1, match: { hosts: ['x.com'] } });
    expect(parsed.rules.intercept).toBe('allow');
    expect(parsed.rules.stealth).toBe('preferred');
    expect(parsed.rules.onCaptcha).toBe('warn');
    expect(parsed.preFlight).toEqual([]);
  });

  it('rejects an invalid profile', () => {
    expect(SiteProfileSchema.safeParse({ id: 'x' }).success).toBe(false);
    expect(SiteProfileSchema.safeParse({ id: 'x', version: 1, match: { hosts: [] }, rules: { intercept: 'bogus' } }).success).toBe(false);
  });
});

describe('SiteProfileStore', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yautja-profiles-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeProfile(dir: string, name: string, data: any): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  }

  it('loads shipped profiles from the repo', () => {
    const store = new SiteProfileStore([SHIPPED_DIR]);
    const ids = store.list().map((p) => p.id).sort();
    expect(ids).toEqual(['default', 'gemini', 'perplexity']);
  });

  it('user profile overrides shipped by id (precedence)', () => {
    writeProfile(tmp, 'perplexity.json', {
      id: 'perplexity', version: 99,
      match: { hosts: ['www.perplexity.ai'] },
      rules: { intercept: 'allow' },
    });
    const store = new SiteProfileStore([SHIPPED_DIR, tmp]);
    expect(store.get('perplexity')!.version).toBe(99);
    expect(store.get('perplexity')!.rules.intercept).toBe('allow');
    // non-overridden profiles still come from shipped
    expect(store.get('gemini')).not.toBeNull();
  });

  it('skips invalid files without breaking the store', () => {
    fs.writeFileSync(path.join(tmp, 'broken.json'), '{not json');
    writeProfile(tmp, 'ok.json', { id: 'ok', version: 1, match: { hosts: ['ok.com'] } });
    const store = new SiteProfileStore([tmp]);
    expect(store.get('ok')).not.toBeNull();
    expect(store.get('default')).not.toBeNull();
  });

  it('falls back to the hardcoded default when no default.json exists', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'yautja-empty-'));
    const store = new SiteProfileStore([empty]);
    expect(store.match('https://anything.example/page').id).toBe('default');
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('a custom default.json with restrictive rules is honored on unmatched URLs (smartType pass-2 contract)', () => {
    // The smartType path used to gate ALL safety checks behind
    // `if (siteProfile.id !== 'default')`, which silently bypassed
    // every rule for URLs not in a specific profile file. This test
    // documents the load-side contract that the fix relies on: a
    // user-supplied default.json with tight rules (e.g. captcha
    // stop_hard, maxAgentQueriesPerSession) WILL be the profile
    // returned for unmatched URLs, so the smartType sub-checks
    // (now run unconditionally) will actually fire.
    writeProfile(tmp, 'default.json', {
      id: 'default', version: 7,
      match: { hosts: ['*'] },
      rules: { onCaptcha: 'stop_hard', maxAgentQueriesPerSession: 5 },
      notes: 'Tight global default for paranoid deployments',
    });
    const store = new SiteProfileStore([tmp]);
    const matched = store.match('https://anything.example/');
    expect(matched.id).toBe('default');
    expect(matched.rules.onCaptcha).toBe('stop_hard');
    expect(matched.rules.maxAgentQueriesPerSession).toBe(5);
    expect(matched.notes).toBe('Tight global default for paranoid deployments');
  });

  it('matches by hostname and falls back to default', () => {
    const store = new SiteProfileStore([SHIPPED_DIR]);
    expect(store.match('https://www.perplexity.ai/search/abc').id).toBe('perplexity');
    expect(store.match('https://perplexity.ai/').id).toBe('perplexity');
    expect(store.match('https://gemini.google.com/app').id).toBe('gemini');
    expect(store.match('https://example.com/').id).toBe('default');
    expect(store.match('not a url').id).toBe('default');
  });

  it('pathPrefix match beats bare host match (multi-account r2)', () => {
    writeProfile(tmp, 'gemini-u0.json', {
      id: 'gemini-u0', version: 1,
      match: { hosts: ['gemini.google.com'], pathPrefix: '/u/0/' },
    });
    writeProfile(tmp, 'gemini-generic.json', {
      id: 'gemini-generic', version: 1,
      match: { hosts: ['gemini.google.com'] },
    });
    const store = new SiteProfileStore([tmp]);
    expect(store.match('https://gemini.google.com/u/0/app').id).toBe('gemini-u0');
    expect(store.match('https://gemini.google.com/u/1/app').id).toBe('gemini-generic');
  });
});

describe('profile policy helpers', () => {
  const perplexity = SiteProfileSchema.parse(JSON.parse(fs.readFileSync(path.join(SHIPPED_DIR, 'perplexity.json'), 'utf8')));

  it('isInterceptAllowed: forbid → false, allow → true', () => {
    expect(isInterceptAllowed(perplexity)).toBe(false);
    expect(isInterceptAllowed(HARDCODED_DEFAULT_PROFILE)).toBe(true);
  });

  it('isUrlAllowed: urlDenyRegex blocks CF Access and /restricted paths', () => {
    expect(isUrlAllowed(perplexity, 'https://www.perplexity.ai/cdn-cgi/access/login?x=1')).toBe(false);
    expect(isUrlAllowed(perplexity, 'https://www.perplexity.ai/restricted/area')).toBe(false);
    expect(isUrlAllowed(perplexity, 'https://www.perplexity.ai/search/abc')).toBe(true);
    expect(isUrlAllowed(HARDCODED_DEFAULT_PROFILE, 'https://anything.example')).toBe(true);
  });
});
