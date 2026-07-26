import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { routeCapability, delegate, loadBackendConfig, isSuperapiConfigured, isChromeDevtoolsConfigured } from '../../src/doctrine/backends.js';
import type { BackendConfig } from '../../src/doctrine/backends.js';

describe('routeCapability', () => {
  const full: BackendConfig = {
    superapi: { url: 'http://localhost:8765' },
    chromeDevtools: { cdpUrl: 'http://localhost:9222' },
  };

  it('yautja-native capabilities route to yautja', () => {
    for (const cap of ['observe', 'act', 'network_listen']) {
      expect(routeCapability(cap, full)).toBe('yautja');
    }
  });

  it('heap/cpu profile route to chrome-devtools when configured, null otherwise', () => {
    expect(routeCapability('heap_profile', full)).toBe('chrome-devtools');
    expect(routeCapability('cpu_profile', full)).toBe('chrome-devtools');
    expect(routeCapability('heap_profile', {})).toBeNull();
  });

  it('file_upload routes to superapi when configured, null otherwise', () => {
    expect(routeCapability('file_upload', full)).toBe('superapi');
    expect(routeCapability('file_upload', {})).toBeNull();
  });

  it('unknown capability → null', () => {
    expect(routeCapability('teleport', full)).toBeNull();
  });
});

describe('delegate (dry-run)', () => {
  it('yautja capability → not delegated, use native tools', () => {
    const r = delegate('observe', {});
    expect(r.backend).toBe('yautja');
    expect(r.delegated).toBe(false);
    expect(r.dryRun).toBe(true);
  });

  it('configured external backend → delegated dry-run', () => {
    const r = delegate('file_upload', { superapi: { url: 'http://x' } });
    expect(r.backend).toBe('superapi');
    expect(r.delegated).toBe(true);
    expect(r.dryRun).toBe(true);
  });

  it('unconfigured backend → throws NO_BACKEND', () => {
    expect(() => delegate('heap_profile', {})).toThrow('NO_BACKEND:heap_profile');
  });
});

describe('loadBackendConfig', () => {
  const APPDATA = process.env.APPDATA;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yautja-backends-'));
    process.env.APPDATA = tmp;
    delete process.env.SUPERAPI_URL;
    delete process.env.YAUTJA_CDP_REMOTE;
  });

  afterEach(() => {
    process.env.APPDATA = APPDATA;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads ~/.yautja/backends.json', () => {
    fs.mkdirSync(path.join(tmp, '.yautja'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.yautja', 'backends.json'),
      JSON.stringify({ superapi: { url: 'http://sap:1' } }),
    );
    const cfg = loadBackendConfig();
    expect(cfg.superapi?.url).toBe('http://sap:1');
    expect(isSuperapiConfigured(cfg)).toBe(true);
  });

  it('env vars fill in when the file is absent', () => {
    process.env.SUPERAPI_URL = 'http://env-sap';
    process.env.YAUTJA_CDP_REMOTE = 'http://env-cdp';
    const cfg = loadBackendConfig();
    expect(cfg.superapi?.url).toBe('http://env-sap');
    expect(cfg.chromeDevtools?.cdpUrl).toBe('http://env-cdp');
    expect(isChromeDevtoolsConfigured(cfg)).toBe(true);
  });

  it('corrupt file → empty config, no crash', () => {
    fs.mkdirSync(path.join(tmp, '.yautja'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.yautja', 'backends.json'), '{broken');
    const cfg = loadBackendConfig();
    expect(cfg.superapi).toBeUndefined();
  });
});
