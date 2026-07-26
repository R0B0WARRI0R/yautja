/**
 * Capability matrix (P16) — what this session can actually do.
 *
 * Reported by the `capabilities` tool so the agent chooses a viable path
 * up front instead of discovering limits mid-action. A `false` here must
 * always correspond to a typed failure when the feature is invoked —
 * never a fake success.
 */

export interface CapabilityMatrix {
  stealth: boolean;
  intercept: boolean;
  trustedClick: boolean;
  trustedFileChooser: boolean;
  silentNetwork: boolean;
  browserFetch: boolean;
  backends: {
    yautja: true;
    superapi?: 'configured' | 'missing';
    chromeDevtools?: 'configured' | 'missing';
  };
}

export interface CapabilityEnv {
  /** CDP event channel available (extension server.on). */
  hasEventChannel: boolean;
  /** Fetch domain interception available. */
  hasInterceptor: boolean;
  /** Site profile allows interception on the current domain. */
  interceptAllowedByProfile: boolean;
  superapiConfigured: boolean;
  chromeDevtoolsConfigured: boolean;
}

export function detectCapabilities(env: CapabilityEnv): CapabilityMatrix {
  return {
    stealth: true, // StealthMode is local, always available
    intercept: env.hasInterceptor && env.interceptAllowedByProfile,
    trustedClick: true, // Input.dispatchMouseEvent via extension CDP
    trustedFileChooser: env.hasEventChannel,
    silentNetwork: true, // Network domain listen (P13.5) always on
    browserFetch: true, // gated, but the capability exists
    backends: {
      yautja: true,
      superapi: env.superapiConfigured ? 'configured' : 'missing',
      chromeDevtools: env.chromeDevtoolsConfigured ? 'configured' : 'missing',
    },
  };
}
