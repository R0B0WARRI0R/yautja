/**
 * Site profiles (P13) — per-domain policy in the helmet, not just in skills.
 *
 * Profiles are JSON files (spec said YAML; the project has no YAML parser
 * dependency, so the same schema ships as JSON — see tracker notes).
 *
 * Precedence: user profile (~/.yautja/profiles) > shipped (repo profiles/)
 * > hardcoded default. Matching is by hostname with an optional pathPrefix
 * (multi-account r2 note: same host, different state).
 */

import fs from 'fs';
import path from 'path';
import { z } from 'zod';

const PreFlightCheckSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string(),
    type: z.literal('cookieJson'),
    name: z.string(),
    decode: z.enum(['uriComponent', 'base64', 'none']).default('none'),
  }),
  z.object({
    id: z.string(),
    type: z.literal('abortIf'),
    path: z.string(),
    op: z.enum(['>', '>=', '<', '<=', '==', '!=']),
    value: z.number(),
    code: z.string(),
  }),
]);

const RulesSchema = z.object({
  intercept: z.enum(['forbid', 'allow', 'silent_only']).default('allow'),
  stealth: z.enum(['off', 'preferred', 'required']).default('preferred'),
  stealthEnforcement: z.enum(['auto', 'strict']).default('auto'),
  maxAgentQueriesPerSession: z.number().optional(),
  preType: z.enum(['ensureEmpty', 'none']).default('none'),
  onCaptcha: z.enum(['stop_hard', 'warn', 'ignore']).default('warn'),
  allowEvaluateFetch: z.enum(['none', 'limited', 'full']).default('limited'),
  urlDenyRegex: z.string().optional(),
});

export const SiteProfileSchema = z.object({
  id: z.string(),
  version: z.number(),
  match: z.object({
    hosts: z.array(z.string()),
    pathPrefix: z.string().optional(),
  }),
  rules: RulesSchema.default({
    intercept: 'allow',
    stealth: 'preferred',
    stealthEnforcement: 'auto',
    preType: 'none',
    onCaptcha: 'warn',
    allowEvaluateFetch: 'limited',
  }),
  preFlight: z.array(PreFlightCheckSchema).default([]),
  waitDefaults: z.object({
    ready: z.object({
      anyOf: z.array(z.record(z.string(), z.any())).optional(),
      allOf: z.array(z.record(z.string(), z.any())).optional(),
    }).optional(),
  }).optional(),
  notes: z.string().optional(),
});

export type SiteProfile = z.infer<typeof SiteProfileSchema>;
export type SiteProfileRules = z.infer<typeof RulesSchema>;
export type PreFlightCheck = z.infer<typeof PreFlightCheckSchema>;

/** Hardcoded fallback when no profile file matches and default.json is absent. */
export const HARDCODED_DEFAULT_PROFILE: SiteProfile = SiteProfileSchema.parse({
  id: 'default',
  version: 1,
  match: { hosts: ['*'] },
  notes: 'Hardcoded fallback (no profiles directory found).',
});

export class SiteProfileStore {
  private dirs: string[];
  private profiles = new Map<string, SiteProfile>();

  /**
   * @param dirs Profile directories in INCREASING precedence order
   *             (e.g. [shippedDir, userDir] — user files override shipped by id).
   */
  constructor(dirs: string[]) {
    this.dirs = dirs;
    this.reload();
  }

  reload(): void {
    this.profiles.clear();
    for (const dir of this.dirs) {
      let files: string[] = [];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      } catch {
        continue; // dir missing → skip
      }
      for (const f of files) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          const parsed = SiteProfileSchema.safeParse(raw);
          if (parsed.success) {
            this.profiles.set(parsed.data.id, parsed.data);
          }
          // invalid profiles are skipped silently — a broken user file
          // must never break the helmet boot
        } catch {
          continue;
        }
      }
    }
    if (!this.profiles.has('default')) {
      this.profiles.set('default', HARDCODED_DEFAULT_PROFILE);
    }
  }

  list(): SiteProfile[] {
    return Array.from(this.profiles.values());
  }

  get(id: string): SiteProfile | null {
    return this.profiles.get(id) ?? null;
  }

  /** Register (or replace) a profile in memory — used by profileLoad. */
  register(profile: SiteProfile): void {
    this.profiles.set(profile.id, profile);
  }

  /**
   * Find the active profile for a URL. Specific (non-default) profiles win;
   * among those, a pathPrefix match beats a bare host match. Falls back to
   * the default profile, never null.
   */
  match(url: string): SiteProfile {
    let hostname = '';
    let pathname = '';
    try {
      const u = new URL(url);
      hostname = u.hostname;
      pathname = u.pathname;
    } catch {
      return this.profiles.get('default') ?? HARDCODED_DEFAULT_PROFILE;
    }

    let hostMatch: SiteProfile | null = null;
    for (const p of this.profiles.values()) {
      if (p.id === 'default') continue;
      if (!p.match.hosts.includes(hostname)) continue;
      if (p.match.pathPrefix) {
        if (pathname.startsWith(p.match.pathPrefix)) return p; // most specific
        continue;
      }
      hostMatch = hostMatch ?? p;
    }
    return hostMatch ?? this.profiles.get('default') ?? HARDCODED_DEFAULT_PROFILE;
  }
}

/** Policy check: is request interception allowed by the profile? */
export function isInterceptAllowed(profile: SiteProfile): boolean {
  return profile.rules.intercept !== 'forbid';
}

/** Policy check: is a navigation target allowed by the profile? */
export function isUrlAllowed(profile: SiteProfile, url: string): boolean {
  if (!profile.rules.urlDenyRegex) return true;
  try {
    return !new RegExp(profile.rules.urlDenyRegex).test(url);
  } catch {
    return true; // broken regex → don't block
  }
}
