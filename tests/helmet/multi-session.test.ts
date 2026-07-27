import { describe, it, expect, afterEach } from 'vitest';
import { resolveProxyPort, resolveCdpRemotePort, resolvePort } from '../../src/helmet.js';

describe('multi-session port resolvers', () => {
  afterEach(() => {
    delete process.env.YAUTJA_PROXY_PORT;
    delete process.env.YAUTJA_CDP_REMOTE_PORT;
    delete process.env.YAUTJA_PORT;
  });

  it('defaults: proxy 9877, cdp remote 9222, ws 9876', () => {
    expect(resolveProxyPort()).toBe(9877);
    expect(resolveCdpRemotePort()).toBe(9222);
    expect(resolvePort().port).toBe(9876);
  });

  it('env overrides per instance', () => {
    process.env.YAUTJA_PROXY_PORT = '9977';
    process.env.YAUTJA_CDP_REMOTE_PORT = '9333';
    process.env.YAUTJA_PORT = '9988';
    expect(resolveProxyPort()).toBe(9977);
    expect(resolveCdpRemotePort()).toBe(9333);
    expect(resolvePort()).toEqual({ port: 9988, source: 'env' });
  });

  it('invalid env values fall back to defaults', () => {
    process.env.YAUTJA_PROXY_PORT = 'not-a-port';
    process.env.YAUTJA_CDP_REMOTE_PORT = '80'; // below 1024
    expect(resolveProxyPort()).toBe(9877);
    expect(resolveCdpRemotePort()).toBe(9222);
  });
});
