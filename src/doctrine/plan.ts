/**
 * Session plans (P14.1) — Claude-in-Chrome's `update_plan` UX bridged to
 * Yautja's hard gates: the agent proposes a plan (3-7 high-level items +
 * domains + requested gate level) and presents it in chat. Only when the
 * user explicitly approves does `plan_approve` materialize ONE real
 * GateGrant (grantedBy: user_phrase, audit trail via SessionGates).
 *
 * A pending plan lives in helmet memory only (one per session; proposing
 * another replaces it). Proposing grants NOTHING by itself.
 *
 * Wildcards are rejected: SessionGates host matching is exact
 * (`scope.hosts.includes(host)`), so a wildcard grant would silently never
 * match — better to fail loudly at proposal time.
 */

import type { GateLevel } from './gates.js';

export type PlanLevel = Exclude<GateLevel, 'P0'>;

export interface PendingPlan {
  items: string[];
  domains: string[];
  requestedLevel: PlanLevel;
  proposedAt: string;
}

export const PLAN_MIN_ITEMS = 3;
export const PLAN_MAX_ITEMS = 7;

const PLAN_LEVELS: readonly PlanLevel[] = ['P1', 'P2', 'P3', 'P4'];

/** Dotted hostname labels (alnum + hyphens), or localhost. No scheme/port/path. */
const HOST_RE = /^(localhost|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/;

export type PlanValidation = { ok: true; plan: PendingPlan } | { ok: false; message: string };

/**
 * Validates raw plan_propose args. Normalizes domains to lowercase and
 * dedupes them. Pure function (proposedAt is the only side input).
 */
export function validatePlanInput(args: any): PlanValidation {
  const items = args?.items;
  if (
    !Array.isArray(items) ||
    items.length < PLAN_MIN_ITEMS ||
    items.length > PLAN_MAX_ITEMS ||
    items.some((i) => typeof i !== 'string' || i.trim().length === 0)
  ) {
    return { ok: false, message: `items must be an array of ${PLAN_MIN_ITEMS}-${PLAN_MAX_ITEMS} non-empty high-level descriptions` };
  }

  const domains = args?.domains;
  if (!Array.isArray(domains) || domains.length === 0 || domains.some((d) => typeof d !== 'string')) {
    return { ok: false, message: 'domains must be a non-empty array of hostnames' };
  }
  const normalized: string[] = [];
  for (const raw of domains as string[]) {
    const d = raw.trim().toLowerCase();
    if (d.includes('://') || d.includes('/') || d.includes(':')) {
      return { ok: false, message: `invalid domain "${raw}": hosts only — no scheme, port or path` };
    }
    if (d.includes('*')) {
      return { ok: false, message: `invalid domain "${raw}": wildcards are not supported (gate host matching is exact)` };
    }
    if (!HOST_RE.test(d)) {
      return { ok: false, message: `invalid domain "${raw}": not a valid hostname` };
    }
    normalized.push(d);
  }

  const level = (args?.requestedLevel ?? 'P2') as string;
  if (!PLAN_LEVELS.includes(level as PlanLevel)) {
    return { ok: false, message: `requestedLevel must be one of ${PLAN_LEVELS.join(', ')} (default P2)` };
  }

  return {
    ok: true,
    plan: {
      items: (items as string[]).map((i) => i.trim()),
      domains: [...new Set(normalized)],
      requestedLevel: level as PlanLevel,
      proposedAt: new Date().toISOString(),
    },
  };
}

/** Renders the plan as markdown for the agent to present to the user in chat. */
export function formatPlanForChat(plan: PendingPlan): string {
  return [
    `### Proposed plan (gate level ${plan.requestedLevel})`,
    '',
    ...plan.items.map((item, i) => `${i + 1}. ${item}`),
    '',
    `**Domains to pre-approve for this session:** ${plan.domains.join(', ')}`,
    '',
    'Nothing is granted yet. If the user approves in chat, call `plan_approve` with their exact words — that creates ONE session GateGrant covering these domains.',
  ].join('\n');
}
