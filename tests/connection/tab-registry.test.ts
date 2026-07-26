import { describe, it, expect } from 'vitest';
import { TabRegistry } from '../../src/connection/tab-registry.js';
import type { TabSummary } from '../../src/connection/tab-registry.js';

/** Fake extension server with two tabs and a settable "live" location. */
function makeServer(opts: {
  tabs: TabSummary[];
  liveHref: string;
  attachFails?: number;
}) {
  const state = {
    tabs: opts.tabs,
    liveHref: opts.liveHref,
    attachCalls: [] as number[],
    attachFailsLeft: opts.attachFails ?? 0,
    detached: false,
    currentTabId: opts.tabs.find((t) => t.active)?.tabId ?? null as number | null,
  };
  return {
    state,
    async listTabs() { return state.tabs; },
    async attachTab(tabId: number) {
      state.attachCalls.push(tabId);
      if (state.attachFailsLeft > 0) {
        state.attachFailsLeft--;
        throw new Error('attach failed');
      }
      state.currentTabId = tabId;
    },
    async detachAll() { state.detached = true; state.currentTabId = null; },
    async openTab(url: string) {
      const tabId = Math.max(...state.tabs.map((t) => t.tabId), 0) + 1;
      state.tabs.push({ tabId, url, title: '', active: false });
      return { tabId, url };
    },
    getCurrentTabId() { return state.currentTabId; },
    async send(method: string, params?: any) {
      if (method === 'Runtime.evaluate' && params?.expression === 'location.href') {
        return { result: { value: state.liveHref } };
      }
      return {};
    },
  };
}

const TABS: TabSummary[] = [
  { tabId: 1, url: 'https://gemini.google.com/app', title: 'Gemini', active: true },
  { tabId: 2, url: 'https://www.perplexity.ai/', title: 'Perplexity', active: false },
];

describe('TabRegistry.openVerified', () => {
  it('reports the NEW tab URL, not the previously active tab (2 tabs)', async () => {
    const server = makeServer({ tabs: [...TABS.map((t) => ({ ...t }))], liveHref: 'https://example.com/new-page' });
    const registry = new TabRegistry(server);
    const r = await registry.openVerified('https://example.com/new-page', { settleMs: 1 });
    expect(r.tabId).toBe(3);
    expect(r.url).toBe('https://example.com/new-page');
    expect(r.verifiedUrl).toBe('https://example.com/new-page');
    expect(r.attached).toBe(true);
    expect(r.previousActiveTabId).toBe(1); // gemini tab was active
  });

  it('falls back to the extension-reported URL when verification returns empty', async () => {
    const server = makeServer({ tabs: [...TABS.map((t) => ({ ...t }))], liveHref: '' });
    const registry = new TabRegistry(server);
    const r = await registry.openVerified('https://example.com/x', { settleMs: 1 });
    expect(r.url).toBe('https://example.com/x');
    expect(r.verifiedUrl).toBe('');
  });

  it('retries attach once, then reports attached:false', async () => {
    const server = makeServer({ tabs: [...TABS.map((t) => ({ ...t }))], liveHref: 'https://x.com', attachFails: 1 });
    const registry = new TabRegistry(server);
    const ok = await registry.openVerified('https://x.com', { settleMs: 1 });
    expect(ok.attached).toBe(true);
    expect(server.state.attachCalls.length).toBe(2);

    const server2 = makeServer({ tabs: [...TABS.map((t) => ({ ...t }))], liveHref: '', attachFails: 99 });
    const registry2 = new TabRegistry(server2);
    const fail = await registry2.openVerified('https://x.com', { settleMs: 1 });
    expect(fail.attached).toBe(false);
  });
});

describe('TabRegistry.switchVerified', () => {
  it('switches and verifies location.href (same host)', async () => {
    const server = makeServer({ tabs: [...TABS.map((t) => ({ ...t }))], liveHref: 'https://www.perplexity.ai/search/abc' });
    const registry = new TabRegistry(server);
    const r = await registry.switchVerified(2);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tabId).toBe(2);
      expect(r.url).toBe('https://www.perplexity.ai/search/abc');
      expect(r.previousTabId).toBe(1);
    }
  });

  it('unknown tab → not_found', async () => {
    const server = makeServer({ tabs: [...TABS.map((t) => ({ ...t }))], liveHref: '' });
    const registry = new TabRegistry(server);
    const r = await registry.switchVerified(999);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found');
  });

  it('host mismatch after attach → mismatch with expected/actual', async () => {
    const server = makeServer({ tabs: [...TABS.map((t) => ({ ...t }))], liveHref: 'https://evil.example/phishing' });
    const registry = new TabRegistry(server);
    const r = await registry.switchVerified(2);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('mismatch');
      expect(r.expectedUrl).toBe('https://www.perplexity.ai/');
      expect(r.actualUrl).toBe('https://evil.example/phishing');
    }
  });

  it('no false mismatch when either URL is not parseable (about:blank)', async () => {
    const tabs: TabSummary[] = [{ tabId: 5, url: 'about:blank', title: '', active: true }];
    const server = makeServer({ tabs, liveHref: 'about:blank' });
    const registry = new TabRegistry(server);
    const r = await registry.switchVerified(5);
    expect(r.ok).toBe(true);
  });
});
