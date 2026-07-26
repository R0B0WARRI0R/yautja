/**
 * Session snapshots (P17) — capture/restore cookies + localStorage + url.
 *
 * OPSEC rule: restoring cookies is a lab-only operation. Restoring any
 * cookie whose domain is NOT the current origin host surfaces an explicit
 * `opsecWarning` in the result — the agent must mention it, not bury it.
 */

import fs from 'fs';
import path from 'path';

export interface SnapshotCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
}

export interface SessionSnapshot {
  name: string;
  createdAt: string;
  url: string;
  origin: string;
  cookies: SnapshotCookie[];
  localStorage: Record<string, string>;
}

export interface SnapshotDeps {
  getCookies: () => Promise<SnapshotCookie[]>;
  getLocalStorage: () => Promise<Record<string, string>>;
  getUrl: () => Promise<string>;
}

export interface RestoreDeps {
  setCookie: (cookie: SnapshotCookie) => Promise<void>;
  setLocalStorage: (key: string, value: string) => Promise<void>;
  navigate: (url: string) => Promise<void>;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isLabHost(host: string): boolean {
  return LOCAL_HOSTS.has(host) || host.endsWith('.local') || host === '';
}

export class SessionSnapshotStore {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }

  private path(name: string): string {
    const safe = name.replace(/[^a-z0-9._-]/gi, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  async capture(deps: SnapshotDeps, name: string): Promise<SessionSnapshot> {
    const url = await deps.getUrl();
    let origin = '';
    try { origin = new URL(url).origin; } catch {}
    const snapshot: SessionSnapshot = {
      name,
      createdAt: new Date().toISOString(),
      url,
      origin,
      cookies: await deps.getCookies().catch(() => []),
      localStorage: await deps.getLocalStorage().catch(() => ({})),
    };
    fs.writeFileSync(this.path(name), JSON.stringify(snapshot, null, 2));
    return snapshot;
  }

  load(name: string): SessionSnapshot | null {
    try {
      return JSON.parse(fs.readFileSync(this.path(name), 'utf8'));
    } catch {
      return null;
    }
  }

  list(): Array<{ name: string; createdAt: string; origin: string; cookies: number }> {
    try {
      return fs.readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          try {
            const s = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as SessionSnapshot;
            return { name: s.name, createdAt: s.createdAt, origin: s.origin, cookies: s.cookies?.length ?? 0 };
          } catch {
            return null;
          }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
    } catch {
      return [];
    }
  }

  /**
   * Restore a snapshot. `include` selects what to restore:
   * ["cookies", "localStorage", "url"]. Cookies whose domain does not match
   * the CURRENT origin host are skipped — and reported in skippedForeign.
   * Restoring cookies on a non-lab host produces an opsecWarning.
   */
  async restore(
    deps: RestoreDeps,
    snapshot: SessionSnapshot,
    include: string[],
    currentUrl: string,
  ): Promise<{ restored: string[]; skippedForeign: number; opsecWarning?: string }> {
    const restored: string[] = [];
    let skippedForeign = 0;
    const currentHost = hostnameOf(currentUrl);

    if (include.includes('cookies')) {
      for (const cookie of snapshot.cookies ?? []) {
        const cookieHost = cookie.domain.replace(/^\./, '');
        if (currentHost && (cookieHost === currentHost || currentHost.endsWith('.' + cookieHost))) {
          await deps.setCookie(cookie);
        } else {
          skippedForeign++;
        }
      }
      restored.push('cookies');
    }

    if (include.includes('localStorage')) {
      for (const [k, v] of Object.entries(snapshot.localStorage ?? {})) {
        await deps.setLocalStorage(k, v);
      }
      restored.push('localStorage');
    }

    if (include.includes('url') && snapshot.url) {
      await deps.navigate(snapshot.url);
      restored.push('url');
    }

    let opsecWarning: string | undefined;
    if (include.includes('cookies') && (snapshot.cookies?.length ?? 0) > 0 && !isLabHost(currentHost)) {
      opsecWarning = `Restoring ${snapshot.cookies.length} cookies on non-lab host "${currentHost}". Session snapshots are a lab tool — verify the operator intended this.`;
    }

    return { restored, skippedForeign, opsecWarning };
  }
}
