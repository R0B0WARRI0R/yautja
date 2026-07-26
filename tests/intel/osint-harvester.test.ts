import { describe, it, expect, beforeEach } from 'vitest';
import {
  OSINTHarvester,
  type Transport,
  type OSINTResult,
} from '../../src/intel/osint-harvester.js';

class MockTransport implements Transport {
  calls: { method: string; params?: Record<string, any> }[] = [];
  response: any = { result: { value: '{}' } };

  async send(method: string, params?: Record<string, any>): Promise<any> {
    this.calls.push({ method, params });
    return this.response;
  }
}

const EMPTY_RESULT: OSINTResult = {
  emails: [],
  phones: [],
  socialProfiles: [],
  cryptoAddresses: [],
  ibans: [],
  apiKeys: [],
  metadata: { openGraph: {}, jsonLd: [], meta: {} },
  links: [],
  forms: [],
};

// --- Fake browser environment to execute the real HARVEST_SCRIPT in Node ---
interface FakeField {
  name?: string;
  id?: string;
  type?: string;
  tag?: string;
}

interface FakeForm {
  action?: string;
  method?: string;
  fields?: FakeField[];
}

interface FakeHarvestEnv {
  html?: string;
  bodyText?: string | null;
  anchors?: string[];
  ogMetas?: Record<string, string>[];
  jsonLd?: string[];
  namedMetas?: Record<string, string>[];
  forms?: FakeForm[];
  hostname?: string;
}

function runHarvestScript(expression: string, env: FakeHarvestEnv): OSINTResult {
  const anchors = (env.anchors ?? []).map((href) => ({
    getAttribute: (n: string) => (n === 'href' ? href : null),
  }));
  const ogMetas = (env.ogMetas ?? []).map((attrs) => ({
    getAttribute: (n: string) => attrs[n] ?? null,
  }));
  const jsonLdScripts = (env.jsonLd ?? []).map((text) => ({ textContent: text }));
  const namedMetas = (env.namedMetas ?? []).map((attrs) => ({
    getAttribute: (n: string) => attrs[n] ?? null,
  }));
  const forms = (env.forms ?? []).map((f) => ({
    getAttribute: (n: string) => {
      if (n === 'action') return f.action ?? null;
      if (n === 'method') return f.method ?? null;
      return null;
    },
    querySelectorAll: (_sel: string) =>
      (f.fields ?? []).map((fld) => ({
        name: fld.name ?? '',
        id: fld.id ?? '',
        getAttribute: (n: string) => (n === 'type' ? fld.type ?? null : null),
        tagName: (fld.tag ?? 'input').toUpperCase(),
      })),
  }));

  const document = {
    documentElement: { outerHTML: env.html ?? '' },
    body: env.bodyText === null ? null : { innerText: env.bodyText ?? '' },
    querySelectorAll: (sel: string): any[] => {
      if (sel === 'a[href]') return anchors;
      if (sel === 'form') return forms;
      if (sel === 'meta[property]') return ogMetas;
      if (sel === 'script[type="application/ld+json"]') return jsonLdScripts;
      if (sel === 'meta[name], meta[http-equiv]') return namedMetas;
      return [];
    },
  };
  const location = { hostname: env.hostname ?? 'example.com' };
  const fn = new Function('document', 'location', `return (${expression});`);
  return JSON.parse(fn(document, location));
}

describe('OSINTHarvester', () => {
  let transport: MockTransport;
  let harvester: OSINTHarvester;

  beforeEach(() => {
    transport = new MockTransport();
    harvester = new OSINTHarvester(transport);
  });

  describe('transport interaction', () => {
    it('sends Runtime.evaluate once with returnByValue and the harvest script', async () => {
      await harvester.harvest();
      expect(transport.calls).toHaveLength(1);
      const call = transport.calls[0]!;
      expect(call.method).toBe('Runtime.evaluate');
      expect(call.params!.returnByValue).toBe(true);
      expect(typeof call.params!.expression).toBe('string');
      expect(call.params!.expression).toContain('outerHTML');
    });
  });

  describe('empty / malformed responses', () => {
    it('returns the empty result when response is undefined', async () => {
      transport.response = undefined;
      expect(await harvester.harvest()).toEqual(EMPTY_RESULT);
    });

    it('returns the empty result when result is missing', async () => {
      transport.response = {};
      expect(await harvester.harvest()).toEqual(EMPTY_RESULT);
    });

    it('returns the empty result when value is an empty string', async () => {
      transport.response = { result: { value: '' } };
      expect(await harvester.harvest()).toEqual(EMPTY_RESULT);
    });

    it('returns the empty result when value is null', async () => {
      transport.response = { result: { value: null } };
      expect(await harvester.harvest()).toEqual(EMPTY_RESULT);
    });

    it('rejects when the value is not valid JSON', async () => {
      transport.response = { result: { value: '{broken' } };
      await expect(harvester.harvest()).rejects.toThrow(SyntaxError);
    });

    it('passes a valid payload through untouched', async () => {
      const payload = {
        ...EMPTY_RESULT,
        emails: ['a@b.com'],
        links: [{ domain: 'x.com', count: 2 }],
      };
      transport.response = { result: { value: JSON.stringify(payload) } };
      expect(await harvester.harvest()).toEqual(payload);
    });
  });

  describe('HARVEST_SCRIPT execution against a fake DOM', () => {
    let expression: string;

    beforeEach(async () => {
      await harvester.harvest();
      expression = transport.calls[0]!.params!.expression;
    });

    describe('emails', () => {
      it('extracts, lowercases and deduplicates emails from html and body text', () => {
        const r = runHarvestScript(expression, {
          html: '<p>JOHN.DOE@Example.COM</p>',
          bodyText: 'Contact john.doe@example.com or admin@foo.co.uk',
        });
        expect(r.emails.sort()).toEqual(['admin@foo.co.uk', 'john.doe@example.com']);
      });

      it('filters out asset-like matches ending in image/code extensions', () => {
        const r = runHarvestScript(expression, {
          html: 'icon@assets.png bg@img.jpg real@site.org',
        });
        expect(r.emails).toEqual(['real@site.org']);
      });
    });

    describe('phones', () => {
      it('extracts international phone numbers from body text', () => {
        const r = runHarvestScript(expression, {
          bodyText: 'Call us at +1 (555) 123-4567 today',
        });
        expect(r.phones).toContain('+1 (555) 123-4567');
      });

      it('rejects matches longer than 20 chars', () => {
        const r = runHarvestScript(expression, {
          bodyText: '+999 (1234) 5678 9012',
        });
        expect(r.phones).toEqual([]);
      });

      it('deduplicates repeated numbers', () => {
        const r = runHarvestScript(expression, {
          bodyText: '+34 912 345 678 and again +34 912 345 678',
        });
        expect(r.phones).toEqual(['+34 912 345 678']);
      });
    });

    describe('social profiles', () => {
      it('extracts profiles from text across multiple platforms', () => {
        const r = runHarvestScript(expression, {
          html: [
            'https://twitter.com/johndoe',
            'https://x.com/janedoe',
            'https://github.com/someorg',
            'https://youtube.com/@mrbeast',
            'https://t.me/channelname',
            'https://discord.gg/abcd1234',
            'https://reddit.com/u/someuser',
            'https://tiktok.com/@charli',
            'https://mastodon.social/@alice',
          ].join(' '),
        });
        const byPlatform = Object.fromEntries(
          r.socialProfiles.map((p) => [p.platform, p.username]),
        );
        expect(byPlatform).toEqual({
          'Twitter/X': 'johndoe',
          X: 'janedoe',
          GitHub: 'someorg',
          YouTube: 'mrbeast',
          Telegram: 'channelname',
          Discord: 'abcd1234',
          Reddit: 'someuser',
          TikTok: 'charli',
          Mastodon: 'alice',
        });
      });

      it('deduplicates the same profile found in text and in an anchor href', () => {
        const r = runHarvestScript(expression, {
          html: 'follow us at https://twitter.com/johndoe',
          anchors: ['https://twitter.com/johndoe'],
        });
        const twitter = r.socialProfiles.filter((p) => p.platform === 'Twitter/X');
        expect(twitter).toHaveLength(1);
        expect(twitter[0]).toEqual({
          platform: 'Twitter/X',
          url: 'https://twitter.com/johndoe',
          username: 'johndoe',
        });
      });

      it('finds profiles only present in anchor hrefs', () => {
        const r = runHarvestScript(expression, {
          anchors: ['https://instagram.com/onlyinlink'],
        });
        expect(r.socialProfiles).toEqual([
          { platform: 'Instagram', url: 'https://instagram.com/onlyinlink', username: 'onlyinlink' },
        ]);
      });

      it('builds LinkedIn urls with the /in/ prefix (even for company pages)', () => {
        const r = runHarvestScript(expression, {
          html: 'https://linkedin.com/company/acme-corp',
        });
        expect(r.socialProfiles).toEqual([
          { platform: 'LinkedIn', url: 'https://linkedin.com/in/acme-corp', username: 'acme-corp' },
        ]);
      });
    });

    describe('crypto addresses', () => {
      it('extracts and deduplicates BTC and ETH addresses', () => {
        const btc = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
        const eth = '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe';
        const r = runHarvestScript(expression, {
          html: `donate ${btc} or ${eth}. again: ${btc}`,
        });
        expect(r.cryptoAddresses).toEqual([
          { type: 'BTC', address: btc },
          { type: 'ETH', address: eth },
        ]);
      });

      it('ignores hex strings that are not 40 chars after 0x', () => {
        const r = runHarvestScript(expression, {
          html: 'hash 0xabcdef12 is not an address',
        });
        expect(r.cryptoAddresses).toEqual([]);
      });
    });

    describe('IBANs', () => {
      it('extracts valid-length IBANs', () => {
        const r = runHarvestScript(expression, {
          html: 'IBAN: ES9121000418450200051332',
        });
        expect(r.ibans).toContain('ES9121000418450200051332');
      });

      it('rejects candidates shorter than 15 chars', () => {
        const r = runHarvestScript(expression, {
          html: 'code DE8937040044 here',
        });
        expect(r.ibans).toEqual([]);
      });
    });

    describe('API keys', () => {
      it('detects common provider key formats', () => {
        const html = [
          `google: AIza${'A'.repeat(35)}`,
          `aws: AKIA${'1A'.repeat(8)}`,
          `stripe: sk_live_${'a'.repeat(24)}`,
          `github: ghp_${'b'.repeat(36)}`,
          `slack: xoxb-abcdef1234`,
        ].join(' ');
        const r = runHarvestScript(expression, { html });
        const types = r.apiKeys.map((k) => k.type).sort();
        expect(types).toEqual([
          'AWS Access Key',
          'GitHub Token',
          'Google API Key',
          'Slack Token',
          'Stripe Secret Key',
        ]);
      });

      it('detects generic api_key assignments with capture group', () => {
        const r = runHarvestScript(expression, {
          html: 'api_key="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"',
        });
        const generic = r.apiKeys.find((k) => k.type === 'Generic API Key');
        expect(generic).toBeDefined();
        expect(generic!.value).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
      });

      it('deduplicates repeated keys and truncates values to 50 chars', () => {
        const key = `sk_live_${'z'.repeat(60)}`;
        const r = runHarvestScript(expression, { html: `${key} ${key}` });
        expect(r.apiKeys).toHaveLength(1);
        expect(r.apiKeys[0]!.value).toHaveLength(50);
      });
    });

    describe('metadata', () => {
      it('collects OpenGraph tags', () => {
        const r = runHarvestScript(expression, {
          ogMetas: [
            { property: 'og:title', content: 'My Title' },
            { property: 'og:image', content: 'https://ex.com/i.png' },
            { property: 'not-og', content: 'ignored' },
          ],
        });
        expect(r.metadata.openGraph).toEqual({
          'og:title': 'My Title',
          'og:image': 'https://ex.com/i.png',
        });
      });

      it('parses JSON-LD blocks and skips invalid ones', () => {
        const r = runHarvestScript(expression, {
          jsonLd: ['{"@type":"WebSite","name":"x"}', '{broken json'],
        });
        expect(r.metadata.jsonLd).toEqual([{ '@type': 'WebSite', name: 'x' }]);
      });

      it('collects named and http-equiv meta tags', () => {
        const r = runHarvestScript(expression, {
          namedMetas: [
            { name: 'description', content: 'a site' },
            { 'http-equiv': 'refresh', content: '30' },
          ],
        });
        expect(r.metadata.meta).toEqual({ description: 'a site', refresh: '30' });
      });
    });

    describe('links', () => {
      it('counts external links by domain, sorted desc, excluding same-host and relative', () => {
        const r = runHarvestScript(expression, {
          hostname: 'example.com',
          anchors: [
            'https://b.com/x',
            'https://b.com/y',
            'https://c.com/',
            'https://example.com/self',
            '/relative',
          ],
        });
        expect(r.links).toEqual([
          { domain: 'b.com', count: 2 },
          { domain: 'c.com', count: 1 },
        ]);
      });

      it('caps the list at 20 domains', () => {
        const anchors: string[] = [];
        for (let i = 0; i < 25; i++) {
          for (let j = 0; j <= i; j++) anchors.push(`https://d${i}.com/${j}`);
        }
        const r = runHarvestScript(expression, { anchors });
        expect(r.links).toHaveLength(20);
        expect(r.links[0]).toEqual({ domain: 'd24.com', count: 25 });
      });
    });

    describe('forms', () => {
      it('extracts action, uppercased method and field identifiers', () => {
        const r = runHarvestScript(expression, {
          forms: [
            {
              action: '/login',
              method: 'post',
              fields: [{ name: 'user' }, { id: 'pass' }, { type: 'hidden' }, { tag: 'textarea' }],
            },
            { fields: [] },
          ],
        });
        expect(r.forms).toEqual([
          { action: '/login', method: 'POST', fields: ['user', 'pass', 'hidden', 'textarea'] },
          { action: '', method: 'GET', fields: [] },
        ]);
      });
    });

    describe('robustness', () => {
      it('returns empty collections for a blank page with no body', () => {
        const r = runHarvestScript(expression, { html: '', bodyText: null });
        expect(r).toEqual(EMPTY_RESULT);
      });
    });
  });

  describe('end-to-end: script output through harvest()', () => {
    it('returns the parsed script result unchanged', async () => {
      await harvester.harvest();
      const expression = transport.calls[0]!.params!.expression;
      const harvested = runHarvestScript(expression, {
        html: 'mail me at bob@site.dev',
        anchors: ['https://github.com/bobdev'],
        hostname: 'site.dev',
      });
      transport.response = { result: { value: JSON.stringify(harvested) } };
      const r = await harvester.harvest();
      expect(r.emails).toEqual(['bob@site.dev']);
      expect(r.socialProfiles).toEqual([
        { platform: 'GitHub', url: 'https://github.com/bobdev', username: 'bobdev' },
      ]);
      expect(r.links).toEqual([{ domain: 'github.com', count: 1 }]);
    });
  });
});
