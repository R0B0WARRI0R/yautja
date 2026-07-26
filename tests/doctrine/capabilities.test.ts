import { describe, it, expect } from 'vitest';
import { detectCapabilities } from '../../src/doctrine/capabilities.js';

describe('detectCapabilities', () => {
  it('full session: everything on, backends configured', () => {
    const m = detectCapabilities({
      hasEventChannel: true,
      hasInterceptor: true,
      interceptAllowedByProfile: true,
      superapiConfigured: true,
      chromeDevtoolsConfigured: true,
    });
    expect(m).toEqual({
      stealth: true,
      intercept: true,
      trustedClick: true,
      trustedFileChooser: true,
      silentNetwork: true,
      browserFetch: true,
      backends: { yautja: true, superapi: 'configured', chromeDevtools: 'configured' },
    });
  });

  it('profile intercept:forbid turns intercept off', () => {
    const m = detectCapabilities({
      hasEventChannel: true,
      hasInterceptor: true,
      interceptAllowedByProfile: false,
      superapiConfigured: false,
      chromeDevtoolsConfigured: false,
    });
    expect(m.intercept).toBe(false);
    expect(m.backends.superapi).toBe('missing');
  });

  it('no event channel → no trustedFileChooser', () => {
    const m = detectCapabilities({
      hasEventChannel: false,
      hasInterceptor: true,
      interceptAllowedByProfile: true,
      superapiConfigured: false,
      chromeDevtoolsConfigured: false,
    });
    expect(m.trustedFileChooser).toBe(false);
    // silentNetwork (listen mode) does NOT depend on the event channel
    expect(m.silentNetwork).toBe(true);
  });
});
