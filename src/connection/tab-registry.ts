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
 *     host mismatch surfaces as TAB_SWITCH_MISMATCH.
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
  openTab(url: string, groupId?: number): Promise<{ tabId: number; url: string }>;
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

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
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
    try {
      const r = await this.server.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
      return typeof r?.result?.value === 'string' ? r.result.value : '';
    } catch {
      return '';
    }
  }

  /**
   * Open a tab, attach to it, and report the VERIFIED url (location.href
   * after attach) — never the previously active tab's url.
   */
  async openVerified(url: string, opts?: { settleMs?: number; groupId?: number }): Promise<OpenTabVerified> {
    const previousActiveTabId = await this.activeTabId();
    const opened = await this.server.openTab(url, opts?.groupId);

    await sleep(opts?.settleMs ?? 1500); // let the page start loading

    await this.server.detachAll();
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

    const verifiedUrl = attached ? await this.locationHref() : '';
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
   * Switch to a tab and verify identity. A mismatch is detected when both
   * the registry URL and the live location.href parse as http(s) URLs and
   * their hostnames differ (attach raced a close/redirect).
   */
  async switchVerified(tabId: number): Promise<SwitchVerified> {
    const previousTabId = this.server.getCurrentTabId();
    const tabs = await this.server.listTabs();
    const target = tabs.find((t) => t.tabId === tabId);
    if (!target) return { ok: false, reason: 'not_found' };

    await this.server.detachAll();
    await this.server.attachTab(tabId);

    const actualUrl = await this.locationHref();
    const expectedHost = hostnameOf(target.url);
    const actualHost = hostnameOf(actualUrl);
    if (expectedHost && actualHost && expectedHost !== actualHost) {
      return { ok: false, reason: 'mismatch', expectedUrl: target.url, actualUrl };
    }
    return { ok: true, tabId, url: actualUrl || target.url, previousTabId };
  }
}
