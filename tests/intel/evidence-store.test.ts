import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EvidenceStore } from '../../src/intel/evidence-store.js';

describe('EvidenceStore', () => {
  let dir: string;
  let store: EvidenceStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yautja-evidence-'));
    store = new EvidenceStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const SECRET_BODY = '{"token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c","user":1}';

  it('put stores content-addressed, scrubbed evidence and indexes it', () => {
    const rec = store.put({ host: 'api.example.com', url: 'https://api.example.com/me', method: 'GET', body: SECRET_BODY, runId: 'run1' });
    expect(rec.id).toMatch(/^ev_[0-9a-f]{16}$/);
    expect(rec.redacted).toBe(true);
    // on disk: no secret in the clear (acceptance)
    const onDisk = fs.readFileSync(path.join(dir, rec.resPath), 'utf8');
    expect(onDisk).not.toContain('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c');
    expect(onDisk).toContain('REDACTED');
    expect(fs.existsSync(path.join(dir, 'index.jsonl'))).toBe(true);
  });

  it('get returns record and body; default has no secrets', () => {
    const rec = store.put({ host: 'api.example.com', body: SECRET_BODY });
    const found = store.get(rec.id);
    expect(found).not.toBeNull();
    expect(found!.record.host).toBe('api.example.com');
    expect(found!.body).toContain('REDACTED');
    expect(found!.body).not.toContain('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c');
  });

  it('get returns null for unknown ids', () => {
    expect(store.get('ev_0000000000000000')).toBeNull();
  });

  it('storeRaw keeps the raw body (analyst mode path)', () => {
    const rec = store.put({ host: 'x.com', body: SECRET_BODY, storeRaw: true });
    expect(rec.redacted).toBe(false);
    expect(store.get(rec.id)!.body).toBe(SECRET_BODY);
  });

  it('list filters by host and runId', () => {
    store.put({ host: 'a.com', body: '{}', runId: 'r1' });
    store.put({ host: 'b.com', body: '{}', runId: 'r2' });
    store.put({ host: 'a.com', body: '[]', runId: 'r2' });
    expect(store.list()).toHaveLength(3);
    expect(store.list({ host: 'a.com' })).toHaveLength(2);
    expect(store.list({ runId: 'r2' })).toHaveLength(2);
    expect(store.list({ host: 'a.com', runId: 'r2' })).toHaveLength(1);
  });

  it('export writes a JSONL with bodies included', () => {
    store.put({ host: 'a.com', body: '{"x":1}', runId: 'r1' });
    const dest = path.join(dir, 'export.jsonl');
    const out = store.export('jsonl', dest);
    expect(out.entries).toBe(1);
    const line = JSON.parse(fs.readFileSync(dest, 'utf8').trim());
    expect(line.body).toBe('{"x":1}');
    expect(line.host).toBe('a.com');
  });
});
