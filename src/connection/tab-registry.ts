import { assertOperationActive, OperationError } from './operation-scope.js';
/**
 * TabRegistry (P13.5) — canonical tab identity.
 *
 * Bugs this fixes:
 *   - openTab sometimes reported the URL of the previously ACTIVE tab
 *     instead of the new one (attach race). Now the URL is verified via
 *     location.href AFTER attach, and the previous active tab is captured
 *     BEFORE opening.
 *   - switchTab reported success without checking that the attached page
 *     is actually the requested tab. Now location.href is verified and a
 *     tab identity mismatch surfaces as TAB_SWITCH_MISMATCH.
 */

export interface TabSummary {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
}

export interface TabServerLike {
  listTabs(): Promise<TabSummary[]>;
  attachTab(tabId: number): Promise<void>;
  detachAll(): Promise<void>;
  openTab(url: string, groupId?: number, focus?: boolean): Promise<{ tabId: number; url: string }>;
  getCurrentTabId(): number | null;
  send(method: string, params?: Record<string, any>): Promise<any>;
}

export interface OpenTabVerified {
  tabId: number;
  url: string;
  attached: boolean;
  previousActiveTabId: number | null;
  verifiedUrl: string;
}

export type SwitchVerified =
  | { ok: true; tabId: number; url: string; previousTabId: number | null }
  | { ok: false; reason: 'not_found' | 'mismatch'; expectedUrl?: string; actualUrl?: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TabRegistry {
  private server: TabServerLike;

  constructor(server: TabServerLike) {
    this.server = server;
  }

  async activeTabId(): Promise<number | null> {
    try {
      const tabs = await this.server.listTabs();
      return tabs.find((t) => t.active)?.tabId ?? null;
    } catch {
      return null;
    }
  }

  async locationHref(): Promise<string> {
      const r = await this.server.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
      assertOperationActive();
      if (typeof r?.result?.value !== 'string' || !r.result.value) throw new OperationError('TARGET_UNVERIFIED', 'Cannot verify the attached document');
      return r.result.value;
  }

  /**
   * Open a tab, attach to it, and report the VERIFIED url (location.href
   * after attach) — never the previously active tab's url.
   */
  async openVerified(url: string, opts?: { settleMs?: number; groupId?: number; focus?: boolean; onCreated?: (tab: { tabId: number; url: string }) => void }): Promise<OpenTabVerified> {
    const previousActiveTabId = await this.activeTabId();
    const opened = await this.server.openTab(url, opts?.groupId, opts?.focus === true);
    opts?.onCreated?.(opened);

    await sleep(opts?.settleMs ?? 1500); // let the page start loading

    let attached = true;
    try {
      await this.server.attachTab(opened.tabId);
    } catch {
      await sleep(1000);
      try {
        await this.server.attachTab(opened.tabId);
      } catch {
        attached = false;
      }
    }

    let verifiedUrl = '';
    if (attached) {
      try {
        verifiedUrl = await this.locationHref();
        if (this.server.getCurrentTabId() !== opened.tabId) throw new OperationError('TARGET_MISMATCH', 'Attached tab changed during verification');
      } catch { attached = false; verifiedUrl = ''; }
    }
    return {
      tabId: opened.tabId,
      // Prefer the verified URL; fall back to what the extension reported.
      url: verifiedUrl && verifiedUrl !== 'about:blank' ? verifiedUrl : (verifiedUrl || opened.url),
      attached,
      previousActiveTabId,
      verifiedUrl,
    };
  }

  /**
   * Verify the transport target, allowing redirects within that exact tab.
   * A hostname cannot distinguish two tabs from the same origin.
   */
  async switchVerified(tabId: number): Promise<SwitchVerified> {
    const previousTabId = this.server.getCurrentTabId();
    const tabs = await this.server.listTabs();
    const target = tabs.find((t) => t.tabId === tabId);
    if (!target) return { ok: false, reason: 'not_found' };

    await this.server.attachTab(tabId);

    const actualUrl = await this.locationHref();
    if (this.server.getCurrentTabId() !== tabId) return { ok: false, reason: 'mismatch', expectedUrl: target.url, actualUrl };
    return { ok: true, tabId, url: actualUrl || target.url, previousTabId };
  }
}
