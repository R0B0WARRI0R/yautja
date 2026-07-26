/**
 * Session gates (P14) — intrusion gates P0–P4 for in-session API recon.
 *
 * Hard rule: default P0 (no generated network). A mutating browserFetch
 * without a grant → POLICY_GATE_DENIED.
 *
 * Levels (default policy):
 *   P0  no generated network
 *   P1  GET/HEAD/OPTIONS without auth cookies
 *   P2  GET/HEAD/OPTIONS with cookies
 *   P3  + POST/PUT/PATCH/DELETE (mutations, synthetic only)
 *   P4  exotic methods / load-class
 *
 * Grants persist to <dir>/gates.json and every decision appends to
 * <dir>/audit.jsonl (append-only). Grants are grantedBy "user_phrase":
 * the agent must only grant when the user explicitly asked in chat, and
 * the phrase records the user's words for the audit trail (r2 mitigation
 * for gateGrant self-bypass — residual risk documented in the tracker).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export type GateLevel = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

const LEVEL_ORDER: Record<GateLevel, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };

export interface GateScope {
  hosts: string[];
  pathPrefix?: string;
  methods?: string[];
}

export interface GateGrant {
  level: GateLevel;
  scope: GateScope;
  grantedAt: string;
  grantedBy: 'user_phrase';
  phrase: string;
  maxRequests?: number;
  maxRps?: number;
  expiresAt?: string;
  usedRequests: number;
}

export interface GatesState {
  sessionId: string;
  defaultGate: 'P0';
  grants: GateGrant[];
}

export interface GateCheck {
  allowed: boolean;
  requiredLevel: GateLevel;
  gateUsed?: GateLevel;
  grant?: GateGrant;
  reason?: string;
}

/** Level required for a request, before any grant is consulted. */
export function requiredLevel(method: string, credentials: 'include' | 'omit'): GateLevel {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') {
    return credentials === 'include' ? 'P2' : 'P1';
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) return 'P3';
  return 'P4';
}

/** Per-host rate limiter: enforces a minimum interval between requests. */
export class RateLimiter {
  private lastAt = new Map<string, number>();

  nextDelay(host: string, maxRps: number, now = Date.now()): number {
    if (maxRps <= 0) return 0;
    const minInterval = 1000 / maxRps;
    const last = this.lastAt.get(host) ?? 0;
    return Math.max(0, last + minInterval - now);
  }

  record(host: string, now = Date.now()): void {
    this.lastAt.set(host, now);
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export class SessionGates {
  private dir: string;
  private state: GatesState;

  constructor(dir: string, sessionId: string) {
    this.dir = dir;
    this.state = { sessionId, defaultGate: 'P0', grants: [] };
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'gates.json');
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(data.grants)) this.state.grants = data.grants;
      }
    } catch {
      // corrupt/missing state → start clean; never break the helmet
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(path.join(this.dir, 'gates.json'), JSON.stringify(this.state, null, 2));
    } catch {}
  }

  audit(event: Record<string, unknown>): void {
    try {
      fs.appendFileSync(
        path.join(this.dir, 'audit.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n',
      );
    } catch {}
  }

  /** Save a response body as content-addressed evidence. Returns the evidence id. */
  saveEvidence(body: string): string {
    const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
    try {
      fs.mkdirSync(path.join(this.dir, 'evidence'), { recursive: true });
      fs.writeFileSync(path.join(this.dir, 'evidence', `${hash}.txt`), body);
    } catch {}
    return `ev_${hash}`;
  }

  private isExpired(g: GateGrant, now = Date.now()): boolean {
    return g.expiresAt !== undefined && Date.parse(g.expiresAt) <= now;
  }

  status(): GatesState & { activeGrants: number } {
    return {
      ...this.state,
      grants: this.state.grants.map((g) => ({ ...g })),
      activeGrants: this.state.grants.filter((g) => !this.isExpired(g)).length,
    };
  }

  grant(input: Omit<GateGrant, 'grantedAt' | 'grantedBy' | 'usedRequests'> & { phrase: string }): GateGrant {
    if (!input.phrase || input.phrase.trim().length === 0) {
      throw new Error('grant requires a non-empty phrase (the user\'s words, for the audit trail)');
    }
    const grant: GateGrant = {
      ...input,
      grantedAt: new Date().toISOString(),
      grantedBy: 'user_phrase',
      usedRequests: 0,
    };
    this.state.grants.push(grant);
    this.persist();
    this.audit({ type: 'gateGrant', level: grant.level, scope: grant.scope, phrase: grant.phrase });
    return grant;
  }

  revoke(opts: { level?: GateLevel; all?: boolean }): number {
    const before = this.state.grants.length;
    if (opts.all) {
      this.state.grants = [];
    } else if (opts.level) {
      this.state.grants = this.state.grants.filter((g) => g.level !== opts.level);
    }
    const revoked = before - this.state.grants.length;
    if (revoked > 0) {
      this.persist();
      this.audit({ type: 'gateRevoke', level: opts.level ?? 'all', revoked });
    }
    return revoked;
  }

  check(url: string, method: string, credentials: 'include' | 'omit'): GateCheck {
    const required = requiredLevel(method, credentials);
    const host = hostnameOf(url);
    let pathname = '';
    try { pathname = new URL(url).pathname; } catch {}

    for (const g of this.state.grants) {
      if (this.isExpired(g)) continue;
      if (LEVEL_ORDER[g.level] < LEVEL_ORDER[required]) continue;
      if (!g.scope.hosts.includes(host)) continue;
      if (g.scope.pathPrefix && !pathname.startsWith(g.scope.pathPrefix)) continue;
      if (g.scope.methods && !g.scope.methods.map((m) => m.toUpperCase()).includes(method.toUpperCase())) continue;
      if (g.maxRequests !== undefined && g.usedRequests >= g.maxRequests) continue;
      return { allowed: true, requiredLevel: required, gateUsed: g.level, grant: g };
    }
    return {
      allowed: false,
      requiredLevel: required,
      reason: `No active grant covers ${method} ${url} (requires ${required}${credentials === 'include' ? ' with cookies' : ''}; default gate P0)`,
    };
  }

  /** Mark a grant as used (call after the request executed). */
  consume(grant: GateGrant): void {
    const g = this.state.grants.find((x) => x === grant || (x.grantedAt === grant.grantedAt && x.phrase === grant.phrase));
    if (g) {
      g.usedRequests++;
      this.persist();
    }
  }
}
