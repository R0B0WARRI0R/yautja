/**
 * Backend router (P18) — unify capabilities across Yautja, chrome-devtools
 * MCP and SuperAPI.
 *
 * Routing table (default):
 *   observe, act, waitFor, profiles, gates, apiSurface, network_listen → yautja
 *   heap_profile, cpu_profile, coverage                            → chrome-devtools (if configured)
 *   file_upload (isTrusted fallback)                               → superapi (if configured)
 *
 * Config: %APPDATA%/.yautja/backends.json (or ~/.yautja/backends.json):
 *   { "superapi": { "url": "http://localhost:8765" },
 *     "chromeDevtools": { "cdpUrl": "http://localhost:9222" } }
 * Env fallbacks: SUPERAPI_URL, YAUTJA_CDP_REMOTE.
 */

import fs from 'fs';
import path from 'path';

export interface BackendConfig {
  superapi?: { url?: string };
  chromeDevtools?: { cdpUrl?: string };
}

export type DelegableCapability =
  | 'heap_profile'
  | 'cpu_profile'
  | 'file_upload'
  | 'observe'
  | 'act'
  | 'network_listen';

export type BackendName = 'yautja' | 'chrome-devtools' | 'superapi';

export interface DelegateResult {
  backend: BackendName;
  delegated: boolean;
  dryRun: boolean;
  reason?: string;
}

const YAUTJA_CAPABILITIES = new Set(['observe', 'act', 'waitFor', 'profiles', 'gates', 'apiSurface', 'network_listen']);

export function loadBackendConfig(): BackendConfig {
  const config: BackendConfig = {};
  try {
    const file = path.join(process.env.APPDATA || process.env.HOME || '/tmp', '.yautja', 'backends.json');
    if (fs.existsSync(file)) {
      Object.assign(config, JSON.parse(fs.readFileSync(file, 'utf8')));
    }
  } catch { /* corrupt config → env only */ }
  if (!config.superapi?.url && process.env.SUPERAPI_URL) {
    config.superapi = { ...config.superapi, url: process.env.SUPERAPI_URL };
  }
  if (!config.chromeDevtools?.cdpUrl && process.env.YAUTJA_CDP_REMOTE) {
    config.chromeDevtools = { cdpUrl: process.env.YAUTJA_CDP_REMOTE };
  }
  return config;
}

export function isSuperapiConfigured(config: BackendConfig): boolean {
  return !!config.superapi?.url;
}

export function isChromeDevtoolsConfigured(config: BackendConfig): boolean {
  return !!config.chromeDevtools?.cdpUrl;
}

/** Which backend should handle a capability, or null if none configured. */
export function routeCapability(capability: string, config: BackendConfig): BackendName | null {
  if (YAUTJA_CAPABILITIES.has(capability)) return 'yautja';
  if (capability === 'heap_profile' || capability === 'cpu_profile') {
    return isChromeDevtoolsConfigured(config) ? 'chrome-devtools' : null;
  }
  if (capability === 'file_upload') {
    return isSuperapiConfigured(config) ? 'superapi' : null;
  }
  return null;
}

/**
 * Delegate a capability to its backend. P18 scope: dry-run — the call is
 * routed and reported, but the actual cross-process invocation is left to
 * the operator's stack (the backends have their own MCP protocols).
 */
export function delegate(capability: DelegableCapability, config: BackendConfig): DelegateResult {
  const backend = routeCapability(capability, config);
  if (!backend) {
    throw new Error(`NO_BACKEND:${capability}`);
  }
  if (backend === 'yautja') {
    return { backend, delegated: false, dryRun: true, reason: 'Capability is native to yautja — use the native tools directly' };
  }
  return { backend, delegated: true, dryRun: true, reason: `Routed to ${backend} (dry-run: invoke the backend's own MCP endpoint)` };
}
