import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chromium } from 'playwright';
import { CDPSessionManager } from '../../src/connection/cdp-session.js';

const m = vi.hoisted(() => ({
  sessionSend: vi.fn(),
  sessionOn: vi.fn(),
  sessionOff: vi.fn(),
  sessionDetach: vi.fn(),
  pageUrl: vi.fn(),
  contextPages: vi.fn(),
  contextNewCDPSession: vi.fn(),
  contextNewPage: vi.fn(),
  browserContexts: vi.fn(),
  browserVersion: vi.fn(),
  browserClose: vi.fn(),
  browserNewContext: vi.fn(),
  connectOverCDP: vi.fn(),
}));

const fakeSession = {
  send: m.sessionSend,
  on: m.sessionOn,
  off: m.sessionOff,
  detach: m.sessionDetach,
};
const fakePage = { url: m.pageUrl };
const fakeContext = {
  pages: m.contextPages,
  newCDPSession: m.contextNewCDPSession,
  newPage: m.contextNewPage,
};
const fakeBrowser = {
  contexts: m.browserContexts,
  version: m.browserVersion,
  close: m.browserClose,
  newContext: m.browserNewContext,
};

vi.mock('playwright', () => ({
  chromium: {
    connectOverCDP: m.connectOverCDP,
  },
}));

function setupHappyPath(): void {
  m.sessionSend.mockReset().mockResolvedValue({});
  m.sessionOn.mockReset();
  m.sessionOff.mockReset();
  m.sessionDetach.mockReset().mockResolvedValue(undefined);
  m.pageUrl.mockReset().mockReturnValue('http://localhost/page1');
  m.contextPages.mockReset().mockReturnValue([fakePage]);
  m.contextNewCDPSession.mockReset().mockResolvedValue(fakeSession);
  m.contextNewPage.mockReset().mockResolvedValue(fakePage);
  m.browserContexts.mockReset().mockReturnValue([fakeContext]);
  m.browserVersion.mockReset().mockReturnValue('Chrome/120.0.0.0');
  m.browserClose.mockReset().mockResolvedValue(undefined);
  m.browserNewContext.mockReset().mockResolvedValue(fakeContext);
  m.connectOverCDP.mockReset().mockResolvedValue(fakeBrowser);
}

describe('CDPSessionManager', () => {
  let mgr: CDPSessionManager;

  beforeEach(() => {
    setupHappyPath();
    mgr = new CDPSessionManager();
  });

  describe('connect', () => {
    it('calls chromium.connectOverCDP with the supplied URL', async () => {
      await mgr.connect('ws://localhost:9222');
      expect(m.connectOverCDP).toHaveBeenCalledTimes(1);
      expect(m.connectOverCDP).toHaveBeenCalledWith('ws://localhost:9222');
    });

    it('uses default browser context and first page', async () => {
      await mgr.connect('ws://localhost:9222');
      expect(m.browserContexts).toHaveBeenCalled();
      expect(m.contextPages).toHaveBeenCalled();
      expect(m.contextNewCDPSession).toHaveBeenCalledWith(fakePage);
    });

    it('marks as connected', async () => {
      expect(mgr.isConnected()).toBe(false);
      await mgr.connect('ws://localhost:9222');
      expect(mgr.isConnected()).toBe(true);
    });

    it('creates a page when context has none', async () => {
      m.contextPages.mockReset().mockReturnValue([]);
      await mgr.connect('ws://localhost:9222');
      expect(m.contextNewPage).toHaveBeenCalledTimes(1);
      expect(m.contextNewCDPSession).toHaveBeenCalledWith(fakePage);
    });

    it('throws descriptive Error when connectOverCDP rejects', async () => {
      m.connectOverCDP.mockReset().mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(mgr.connect('ws://bad:9999')).rejects.toThrow(
        /CDPSessionManager: failed to connect to CDP at ws:\/\/bad:9999: ECONNREFUSED/,
      );
      expect(mgr.isConnected()).toBe(false);
    });

    it('refuses double connect', async () => {
      await mgr.connect('ws://localhost:9222');
      await expect(mgr.connect('ws://other:9222')).rejects.toThrow(/already connected/);
    });
  });

  describe('disconnect', () => {
    it('is idempotent when not connected', async () => {
      await mgr.disconnect();
      await mgr.disconnect();
      expect(m.browserClose).not.toHaveBeenCalled();
    });

    it('cleans up and marks disconnected', async () => {
      await mgr.connect('ws://localhost:9222');
      await mgr.disconnect();
      expect(mgr.isConnected()).toBe(false);
      expect(m.sessionDetach).toHaveBeenCalled();
      expect(m.browserClose).toHaveBeenCalled();
    });

    it('can connect again after disconnect', async () => {
      await mgr.connect('ws://localhost:9222');
      await mgr.disconnect();
      await mgr.connect('ws://localhost:9222');
      expect(mgr.isConnected()).toBe(true);
    });
  });

  describe('isConnected', () => {
    it('is false before connect', () => {
      expect(mgr.isConnected()).toBe(false);
    });

    it('is true after connect', async () => {
      await mgr.connect('ws://localhost:9222');
      expect(mgr.isConnected()).toBe(true);
    });

    it('is false after disconnect', async () => {
      await mgr.connect('ws://localhost:9222');
      await mgr.disconnect();
      expect(mgr.isConnected()).toBe(false);
    });
  });

  describe('enableDomains', () => {
    it('calls session.send for each domain', async () => {
      await mgr.connect('ws://localhost:9222');
      await mgr.enableDomains(['Network', 'DOM']);
      expect(m.sessionSend).toHaveBeenCalledWith('Network.enable');
      expect(m.sessionSend).toHaveBeenCalledWith('DOM.enable');
      expect(m.sessionSend).toHaveBeenCalledTimes(2);
    });

    it('is idempotent — skips already-enabled domains', async () => {
      await mgr.connect('ws://localhost:9222');
      await mgr.enableDomains(['Network']);
      m.sessionSend.mockClear();
      await mgr.enableDomains(['Network', 'DOM']);
      expect(m.sessionSend).toHaveBeenCalledTimes(1);
      expect(m.sessionSend).toHaveBeenCalledWith('DOM.enable');
    });

    it('throws with domain name when send fails', async () => {
      await mgr.connect('ws://localhost:9222');
      m.sessionSend.mockReset().mockRejectedValueOnce(new Error('Unknown domain'));
      await expect(mgr.enableDomains(['Bogus'])).rejects.toThrow(
        /failed to enable domain 'Bogus'/,
      );
    });

    it('throws when not connected', async () => {
      await expect(mgr.enableDomains(['Network'])).rejects.toThrow(/not connected/);
    });
  });

  describe('disableDomains', () => {
    it('calls session.send for each enabled domain', async () => {
      await mgr.connect('ws://localhost:9222');
      await mgr.enableDomains(['Network']);
      m.sessionSend.mockClear();
      await mgr.disableDomains(['Network']);
      expect(m.sessionSend).toHaveBeenCalledWith('Network.disable');
    });

    it('is idempotent — skipping non-enabled domains', async () => {
      await mgr.connect('ws://localhost:9222');
      await mgr.disableDomains(['Network']);
      expect(m.sessionSend).not.toHaveBeenCalled();
    });

    it('throws when not connected', async () => {
      await expect(mgr.disableDomains(['Network'])).rejects.toThrow(/not connected/);
    });
  });

  describe('on / off / once', () => {
    it('on registers a handler on the session and returns an unsubscribe fn', async () => {
      await mgr.connect('ws://localhost:9222');
      const handler = vi.fn();
      const unsub = mgr.on('Network.requestWillBeSent', handler);
      expect(m.sessionOn).toHaveBeenCalledWith('Network.requestWillBeSent', handler);
      expect(typeof unsub).toBe('function');
    });

    it('unsubscribe function removes the handler', async () => {
      await mgr.connect('ws://localhost:9222');
      const handler = vi.fn();
      const unsub = mgr.on('Network.requestWillBeSent', handler);
      m.sessionOff.mockClear();
      unsub();
      expect(m.sessionOff).toHaveBeenCalledWith('Network.requestWillBeSent', handler);
    });

    it('off removes a specific handler', async () => {
      await mgr.connect('ws://localhost:9222');
      const handler = vi.fn();
      mgr.on('Network.requestWillBeSent', handler);
      m.sessionOff.mockClear();
      mgr.off('Network.requestWillBeSent', handler);
      expect(m.sessionOff).toHaveBeenCalledWith('Network.requestWillBeSent', handler);
    });

    it('on throws when not connected', () => {
      expect(() => mgr.on('Network.requestWillBeSent', () => {})).toThrow(/not connected/);
    });

    it('once auto-unsubscribes after first fire', async () => {
      await mgr.connect('ws://localhost:9222');
      m.sessionOff.mockClear();
      const handler = vi.fn();
      mgr.once('Network.requestWillBeSent', handler);
      const onCalls = m.sessionOn.mock.calls;
      const wrapper = onCalls[onCalls.length - 1]?.[1] as (params: any) => void;
      expect(wrapper).toBeDefined();
      (wrapper)({ requestId: 'r1' });
      expect(handler).toHaveBeenCalledWith({ requestId: 'r1' });
      expect(m.sessionOff).toHaveBeenCalledWith('Network.requestWillBeSent', wrapper);
      (wrapper)({ requestId: 'r2' });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('send', () => {
    it('delegates to session.send with method and params', async () => {
      await mgr.connect('ws://localhost:9222');
      m.sessionSend.mockReset().mockResolvedValue({ body: 'ok' });
      const result = await mgr.send('Network.getResponseBody', { requestId: 'r1' });
      expect(m.sessionSend).toHaveBeenCalledWith('Network.getResponseBody', { requestId: 'r1' });
      expect(result).toEqual({ body: 'ok' });
    });

    it('defaults params to empty object when omitted', async () => {
      await mgr.connect('ws://localhost:9222');
      m.sessionSend.mockReset().mockResolvedValue({});
      await mgr.send('Page.enable');
      expect(m.sessionSend).toHaveBeenCalledWith('Page.enable', {});
    });

    it('throws when not connected', async () => {
      await expect(mgr.send('Page.enable')).rejects.toThrow(
        /CDPSessionManager: cannot send 'Page.enable' — not connected/,
      );
    });

    it('wraps CDP errors with method name', async () => {
      await mgr.connect('ws://localhost:9222');
      m.sessionSend.mockReset().mockRejectedValue(new Error('No such requestId'));
      await expect(mgr.send('Network.getResponseBody', { requestId: 'x' })).rejects.toThrow(
        /CDP 'Network.getResponseBody' failed: No such requestId/,
      );
    });

    it('rejects with timeout error when send exceeds timeoutMs', async () => {
      await mgr.connect('ws://localhost:9222');
      m.sessionSend.mockReset().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({}), 1000)),
      );
      await expect(
        mgr.send('Network.getResponseBody', { requestId: 'r1' }, { timeoutMs: 30 }),
      ).rejects.toThrow(/timed out after 30ms/);
    });
  });

  describe('getInfo', () => {
    it('returns cdpUrl and connected=false before connect', () => {
      const info = mgr.getInfo();
      expect(info.connected).toBe(false);
      expect(info.cdpUrl).toBe('');
      expect(info.activeDomains).toEqual([]);
    });

    it('returns full ConnectionInfo after connect + enableDomains', async () => {
      await mgr.connect('ws://localhost:9222');
      await mgr.enableDomains(['Network', 'DOM']);
      const info = mgr.getInfo();
      expect(info.connected).toBe(true);
      expect(info.cdpUrl).toBe('ws://localhost:9222');
      expect(info.browserVersion).toBe('Chrome/120.0.0.0');
      expect([...info.activeDomains].sort()).toEqual(['DOM', 'Network']);
      expect(info.tabUrl).toBe('http://localhost/page1');
    });
  });

  describe('listTabs', () => {
    it('returns one entry per page with index and active flag', async () => {
      m.pageUrl.mockReset().mockReturnValue('http://localhost/page1');
      m.contextPages.mockReset().mockReturnValue([fakePage]);
      await mgr.connect('ws://localhost:9222');
      const tabs = await mgr.listTabs();
      expect(tabs.length).toBe(1);
      expect(tabs[0]?.index).toBe(0);
      expect(tabs[0]?.url).toBe('http://localhost/page1');
      expect(tabs[0]?.active).toBe(true);
    });

    it('marks active page correctly when multiple pages exist', async () => {
      const pageAUrl = vi.fn(() => 'http://a');
      const pageBUrl = vi.fn(() => 'http://b');
      const pageA = { url: pageAUrl };
      const pageB = { url: pageBUrl };
      m.contextPages.mockReset().mockReturnValue([pageA, pageB]);
      m.pageUrl.mockReset().mockReturnValue('http://a');
      await mgr.connect('ws://localhost:9222');
      const tabs = await mgr.listTabs();
      expect(tabs.length).toBe(2);
      expect(tabs[0]).toMatchObject({ url: 'http://a', active: true });
      expect(tabs[1]).toMatchObject({ url: 'http://b', active: false });
    });

    it('throws when not connected', async () => {
      await expect(mgr.listTabs()).rejects.toThrow(/not connected/);
    });
  });
});