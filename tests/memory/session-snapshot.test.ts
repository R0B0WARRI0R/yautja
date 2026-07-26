import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionSnapshotStore } from '../../src/memory/session-snapshot.js';
import type { SessionSnapshot } from '../../src/memory/session-snapshot.js';

describe('SessionSnapshotStore', () => {
  let dir: string;
  let store: SessionSnapshotStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yautja-snap-'));
    store = new SessionSnapshotStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const deps = {
    getCookies: async () => [
      { name: 'sess', value: 'abc', domain: 'app.example.com', path: '/' },
      { name: 'other', value: 'x', domain: 'cdn.other.com', path: '/' },
    ],
    getLocalStorage: async () => ({ theme: 'dark', token: 't1' }),
    getUrl: async () => 'https://app.example.com/dashboard',
  };

  it('capture + load round-trip (acceptance)', async () => {
    const snap = await store.capture(deps, 'lab1');
    expect(snap.origin).toBe('https://app.example.com');
    expect(snap.cookies).toHaveLength(2);
    expect(snap.localStorage.theme).toBe('dark');

    const loaded = store.load('lab1');
    expect(loaded).not.toBeNull();
    expect(loaded!.url).toBe('https://app.example.com/dashboard');
    expect(loaded!.cookies[0]!.name).toBe('sess');
  });

  it('load returns null for unknown snapshot; list shows saved ones', async () => {
    expect(store.load('ghost')).toBeNull();
    await store.capture(deps, 'one');
    await store.capture(deps, 'two');
    const names = store.list().map((s) => s.name).sort();
    expect(names).toEqual(['one', 'two']);
  });

  it('sanitizes snapshot names for the filesystem', async () => {
    await store.capture(deps, 'my snapshot/v2');
    expect(store.load('my snapshot/v2')).not.toBeNull();
  });

  it('restore: cookies matching current origin applied, foreign skipped', async () => {
    const snap = await store.capture(deps, 'lab1');
    const applied: any[] = [];
    const ls: Record<string, string> = {};
    const result = await store.restore({
      setCookie: async (c) => { applied.push(c); },
      setLocalStorage: async (k, v) => { ls[k] = v; },
      navigate: async () => {},
    }, snap, ['cookies', 'localStorage'], 'https://app.example.com/other-page');

    expect(applied).toHaveLength(1);
    expect(applied[0]!.name).toBe('sess');
    expect(result.skippedForeign).toBe(1);
    expect(ls).toEqual({ theme: 'dark', token: 't1' });
    expect(result.restored).toEqual(['cookies', 'localStorage']);
    // app.example.com is NOT a lab host → OPSEC warning
    expect(result.opsecWarning).toContain('non-lab host');
  });

  it('restore on localhost → no OPSEC warning', async () => {
    const snap = await store.capture(deps, 'lab1');
    const result = await store.restore({
      setCookie: async () => {},
      setLocalStorage: async () => {},
      navigate: async () => {},
    }, snap, ['cookies'], 'http://localhost:8080/app');
    expect(result.opsecWarning).toBeUndefined();
    expect(result.skippedForeign).toBe(2); // neither cookie matches localhost
  });

  it('restore with include:["url"] navigates only', async () => {
    const snap = await store.capture(deps, 'lab1');
    let navigated = '';
    const result = await store.restore({
      setCookie: async () => { throw new Error('should not be called'); },
      setLocalStorage: async () => { throw new Error('should not be called'); },
      navigate: async (url) => { navigated = url; },
    }, snap, ['url'], 'https://app.example.com/');
    expect(navigated).toBe('https://app.example.com/dashboard');
    expect(result.restored).toEqual(['url']);
  });

  it('capture survives failing deps', async () => {
    const snap = await store.capture({
      getCookies: async () => { throw new Error('cdp down'); },
      getLocalStorage: async () => { throw new Error('cdp down'); },
      getUrl: async () => 'https://x.com/',
    }, 'resilient');
    expect(snap.cookies).toEqual([]);
    expect(snap.localStorage).toEqual({});
  });
});
