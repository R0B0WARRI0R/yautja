import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from 'playwright';

export interface ConnectionInfo {
  connected: boolean;
  browserVersion?: string;
  cdpUrl: string;
  activeDomains: string[];
  tabUrl?: string;
  tabId?: string;
}

export interface SendOptions {
  timeoutMs?: number;
}

export interface TabInfo {
  url: string;
  title: string;
  index: number;
  active: boolean;
}

interface EventHandler {
  (params: any): void;
}

export class CDPSessionManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private session: CDPSession | null = null;
  private cdpUrl: string = '';
  private browserVersion: string | undefined;
  private enabledDomains: Set<string> = new Set();
  private listeners: Map<string, Set<EventHandler>> = new Map();
  private connected: boolean = false;

  async connect(cdpUrl: string): Promise<void> {
    if (this.connected) {
      throw new Error(`CDPSessionManager: already connected to ${this.cdpUrl}`);
    }
    let browser: Browser;
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`CDPSessionManager: failed to connect to CDP at ${cdpUrl}: ${reason}`);
    }

    let context: BrowserContext | undefined;
    try {
      context = browser.contexts()[0] ?? (await browser.newContext());
    } catch (err) {
      await browser.close().catch(() => {});
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`CDPSessionManager: failed to acquire browser context: ${reason}`);
    }

    let page: Page;
    const pages = context.pages();
    if (pages.length > 0) {
      page = pages[0]!;
    } else {
      try {
        page = await context.newPage();
      } catch (err) {
        await browser.close().catch(() => {});
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`CDPSessionManager: failed to create initial page: ${reason}`);
      }
    }

    let session: CDPSession;
    try {
      session = await context.newCDPSession(page);
    } catch (err) {
      await browser.close().catch(() => {});
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`CDPSessionManager: failed to create CDP session: ${reason}`);
    }

    this.browser = browser;
    this.context = context;
    this.page = page;
    this.session = session;
    this.cdpUrl = cdpUrl;
    this.browserVersion = browser.version();
    this.enabledDomains = new Set();
    this.listeners = new Map();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;

    const session = this.session;
    const browser = this.browser;
    this.session = null;
    this.page = null;
    this.context = null;
    this.browser = null;

    for (const [event, handlers] of this.listeners) {
      for (const handler of handlers) {
        try {
          session?.off(event as any, handler);
        } catch {
        }
      }
    }
    this.listeners.clear();
    this.enabledDomains.clear();

    try {
      await session?.detach();
    } catch {
    }
    try {
      await browser?.close();
    } catch {
    }
  }

  isConnected(): boolean {
    return this.connected && this.session !== null;
  }

  async enableDomains(domains: string[]): Promise<void> {
    if (!this.isConnected() || !this.session) {
      throw new Error('CDPSessionManager: cannot enable domains — not connected');
    }
    for (const domain of domains) {
      if (this.enabledDomains.has(domain)) continue;
      try {
        await this.session.send(`${domain}.enable` as any);
        this.enabledDomains.add(domain);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`CDPSessionManager: failed to enable domain '${domain}': ${reason}`);
      }
    }
  }

  async disableDomains(domains: string[]): Promise<void> {
    if (!this.isConnected() || !this.session) {
      throw new Error('CDPSessionManager: cannot disable domains — not connected');
    }
    for (const domain of domains) {
      if (!this.enabledDomains.has(domain)) continue;
      try {
        await this.session.send(`${domain}.disable` as any);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`CDPSessionManager: failed to disable domain '${domain}': ${reason}`);
      }
      this.enabledDomains.delete(domain);
    }
  }

  on(event: string, handler: EventHandler): () => void {
    if (!this.isConnected() || !this.session) {
      throw new Error('CDPSessionManager: cannot subscribe — not connected');
    }
    this.session.on(event as any, handler);
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  once(event: string, handler: EventHandler): () => void {
    let fired = false;
    const wrapper: EventHandler = (params: any) => {
      if (fired) return;
      fired = true;
      this.off(event, wrapper);
      handler(params);
    };
    return this.on(event, wrapper);
  }

  off(event: string, handler: EventHandler): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(handler);
      if (set.size === 0) this.listeners.delete(event);
    }
    if (this.session) {
      try {
        this.session.off(event as any, handler);
      } catch {
      }
    }
  }

  async send(
    method: string,
    params?: Record<string, any>,
    options?: SendOptions,
  ): Promise<any> {
    if (!this.isConnected() || !this.session) {
      throw new Error(`CDPSessionManager: cannot send '${method}' — not connected`);
    }
    const timeoutMs = options?.timeoutMs ?? 30000;
    const sendPromise = this.session.send(method as any, params ?? {});
    if (timeoutMs <= 0) {
      try {
        return await sendPromise;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`CDPSessionManager: CDP '${method}' failed: ${reason}`);
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`CDP '${method}' timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([sendPromise, timeoutPromise]);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`CDPSessionManager: CDP '${method}' failed: ${reason}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  getInfo(): ConnectionInfo {
    const info: ConnectionInfo = {
      connected: this.isConnected(),
      cdpUrl: this.cdpUrl,
      activeDomains: Array.from(this.enabledDomains),
    };
    if (this.browserVersion) info.browserVersion = this.browserVersion;
    if (this.page) {
      info.tabUrl = this.page.url();
    }
    return info;
  }

  async switchTab(match: string | number): Promise<void> {
    if (!this.isConnected() || !this.browser || !this.context) {
      throw new Error('CDPSessionManager: cannot switch tab — not connected');
    }

    const pages = this.context.pages();
    let target: Page | undefined;
    if (typeof match === 'number') {
      target = pages[match];
      if (!target) {
        throw new Error(
          `CDPSessionManager: tab index ${match} out of range (have ${pages.length} tabs)`,
        );
      }
    } else {
      target = pages.find((p) => p.url().includes(match));
      if (!target) {
        const urls = pages.map((p) => p.url()).join(', ');
        throw new Error(
          `CDPSessionManager: no tab matches '${match}' (available urls: ${urls || 'none'})`,
        );
      }
    }

    if (target === this.page) return;

    let newSession: CDPSession;
    try {
      newSession = await this.context.newCDPSession(target);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`CDPSessionManager: failed to create CDP session for tab: ${reason}`);
    }

    const oldSession = this.session;
    this.session = newSession;
    this.page = target;

    for (const domain of this.enabledDomains) {
      try {
        await newSession.send(`${domain}.enable` as any);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `CDPSessionManager: failed to re-enable domain '${domain}' on new tab: ${reason}`,
        );
      }
    }

    for (const [event, handlers] of this.listeners) {
      for (const handler of handlers) {
        newSession.on(event as any, handler);
      }
    }

    try {
      await oldSession?.detach();
    } catch {
    }
  }

  async listTabs(): Promise<TabInfo[]> {
    if (!this.isConnected() || !this.context || !this.page) {
      throw new Error('CDPSessionManager: cannot list tabs — not connected');
    }
    const pages = this.context.pages();
    const activeUrl = this.page.url();
    return pages.map((p, i) => ({
      url: p.url(),
      title: '',
      index: i,
      active: p.url() === activeUrl,
    }));
  }
}