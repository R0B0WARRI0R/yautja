import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionGates, RateLimiter, requiredLevel } from '../../src/doctrine/gates.js';

describe('requiredLevel', () => {
  it('maps methods and credentials to gate levels', () => {
    expect(requiredLevel('GET', 'omit')).toBe('P1');
    expect(requiredLevel('HEAD', 'omit')).toBe('P1');
    expect(requiredLevel('OPTIONS', 'omit')).toBe('P1');
    expect(requiredLevel('GET', 'include')).toBe('P2');
    expect(requiredLevel('POST', 'omit')).toBe('P3');
    expect(requiredLevel('DELETE', 'include')).toBe('P3');
    expect(requiredLevel('TRACE', 'omit')).toBe('P4');
  });
});

describe('RateLimiter', () => {
  it('spaces requests by maxRps', () => {
    const rl = new RateLimiter();
    let now = 10_000;
    // First request: no delay
    expect(rl.nextDelay('h', 1, now)).toBe(0);
    rl.record('h', now);
    // 5 sequential requests at maxRps 1 → each waits ~1s after the previous
    for (let i = 0; i < 5; i++) {
      const delay = rl.nextDelay('h', 1, now);
      expect(delay).toBeGreaterThan(0);
      now += delay;
      rl.record('h', now);
    }
    // After enough time passes, no delay
    expect(rl.nextDelay('h', 1, now + 2000)).toBe(0);
  });

  it('tracks hosts independently', () => {
    const rl = new RateLimiter();
    rl.record('a.com', 1000);
    expect(rl.nextDelay('b.com', 1, 1000)).toBe(0);
  });
});

describe('SessionGates', () => {
  let dir: string;
  let gates: SessionGates;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yautja-gates-'));
    gates = new SessionGates(dir, 'sess_test');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function grantP(level: any, hosts: string[], extra: any = {}) {
    return gates.grant({ level, phrase: 'sí, autoriza el recon', ...extra, scope: { hosts, ...extra.scope } });
  }

  it('default P0: any request denied without grants', () => {
    const c = gates.check('https://api.example.com/v1', 'GET', 'omit');
    expect(c.allowed).toBe(false);
    expect(c.requiredLevel).toBe('P1');
    expect(c.reason).toContain('P0');
  });

  it('grant P1 host X: GET ok, POST deny (acceptance)', () => {
    grantP('P1', ['api.example.com']);
    expect(gates.check('https://api.example.com/v1', 'GET', 'omit').allowed).toBe(true);
    expect(gates.check('https://api.example.com/v1', 'POST', 'omit').allowed).toBe(false);
    // GET with cookies needs P2 — P1 grant is not enough
    expect(gates.check('https://api.example.com/v1', 'GET', 'include').allowed).toBe(false);
  });

  it('grant scopes: host, pathPrefix, methods', () => {
    grantP('P3', ['api.example.com'], { scope: { pathPrefix: '/v2/', methods: ['POST'] } });
    expect(gates.check('https://api.example.com/v2/items', 'POST', 'omit').allowed).toBe(true);
    expect(gates.check('https://api.example.com/v1/items', 'POST', 'omit').allowed).toBe(false);
    expect(gates.check('https://api.example.com/v2/items', 'DELETE', 'omit').allowed).toBe(false);
    expect(gates.check('https://other.com/v2/items', 'POST', 'omit').allowed).toBe(false);
  });

  it('higher level grant covers lower requirements', () => {
    grantP('P3', ['api.example.com']);
    expect(gates.check('https://api.example.com/', 'GET', 'omit').allowed).toBe(true);
    expect(gates.check('https://api.example.com/', 'GET', 'include').allowed).toBe(true);
    expect(gates.check('https://api.example.com/', 'POST', 'include').allowed).toBe(true);
  });

  it('grant requires a non-empty phrase', () => {
    expect(() => gates.grant({ level: 'P1', scope: { hosts: ['x.com'] }, phrase: '' })).toThrow(/phrase/);
  });

  it('expired grants do not apply', () => {
    grantP('P2', ['x.com'], { expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(gates.check('https://x.com/', 'GET', 'include').allowed).toBe(false);
    expect(gates.status().activeGrants).toBe(0);
  });

  it('maxRequests exhausts the grant via consume', () => {
    const g = grantP('P2', ['x.com'], { maxRequests: 2 });
    expect(gates.check('https://x.com/', 'GET', 'include').allowed).toBe(true);
    gates.consume(g);
    gates.consume(g);
    expect(gates.check('https://x.com/', 'GET', 'include').allowed).toBe(false);
  });

  it('persists grants to gates.json and reloads them', () => {
    grantP('P2', ['x.com']);
    const gates2 = new SessionGates(dir, 'sess_test');
    expect(gates2.check('https://x.com/', 'GET', 'include').allowed).toBe(true);
  });

  it('revoke by level and all', () => {
    grantP('P1', ['a.com']);
    grantP('P3', ['b.com']);
    expect(gates.revoke({ level: 'P1' })).toBe(1);
    expect(gates.status().grants).toHaveLength(1);
    expect(gates.revoke({ all: true })).toBe(1);
    expect(gates.status().grants).toHaveLength(0);
  });

  it('audit log is appended as JSONL', () => {
    grantP('P1', ['a.com']);
    gates.revoke({ all: true });
    const lines = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const grantEvent = JSON.parse(lines[0]!);
    expect(grantEvent.type).toBe('gateGrant');
    expect(grantEvent.phrase).toContain('autoriza');
    expect(JSON.parse(lines[1]!).type).toBe('gateRevoke');
  });

  it('saveEvidence stores content-addressed body', () => {
    const id = gates.saveEvidence('{"secret":"data"}');
    expect(id).toMatch(/^ev_[0-9a-f]{16}$/);
    const file = path.join(dir, 'evidence', `${id.slice(3)}.txt`);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"secret":"data"}');
  });
});
