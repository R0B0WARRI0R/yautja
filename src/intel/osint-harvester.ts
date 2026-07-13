export interface OSINTResult {
  emails: string[];
  phones: string[];
  socialProfiles: { platform: string; url: string; username?: string }[];
  cryptoAddresses: { type: string; address: string }[];
  ibans: string[];
  apiKeys: { type: string; value: string }[];
  metadata: {
    openGraph: Record<string, string>;
    jsonLd: any[];
    meta: Record<string, string>;
  };
  links: { domain: string; count: number }[];
  forms: { action: string; method: string; fields: string[] }[];
}

const HARVEST_SCRIPT = `(function() {
  var result = {
    emails: [], phones: [], socialProfiles: [], cryptoAddresses: [],
    ibans: [], apiKeys: [], metadata: { openGraph: {}, jsonLd: [], meta: {} },
    links: [], forms: []
  };
  var seen = { emails: {}, phones: {}, social: {}, crypto: {}, iban: {}, apikey: {} };

  // --- Text sources ---
  var html = document.documentElement.outerHTML;
  var bodyText = document.body ? document.body.innerText : '';
  var allText = html + ' ' + bodyText;

  // --- Emails ---
  var emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/g;
  var m;
  while ((m = emailRe.exec(allText)) !== null) {
    var email = m[0].toLowerCase();
    if (email.endsWith('.png') || email.endsWith('.jpg') || email.endsWith('.css') || email.endsWith('.js')) continue;
    if (!seen.emails[email]) { seen.emails[email] = 1; result.emails.push(email); }
  }

  // --- Phones (international) ---
  var phoneRe = /(?:\\+?\\d{1,3}[-.\\s]?)?\\(?\\d{2,4}\\)?[-.\\s]?\\d{3,4}[-.\\s]?\\d{3,4}/g;
  while ((m = phoneRe.exec(bodyText)) !== null) {
    var phone = m[0].trim();
    if (phone.length < 8 || phone.length > 20) continue;
    if (!/^\\+?[\\d\\s()\\-.]+$/.test(phone)) continue;
    if (!seen.phones[phone]) { seen.phones[phone] = 1; result.phones.push(phone); }
  }

  // --- Social profiles ---
  var socialPatterns = [
    { p: /(?:https?:\\/\\/)?(?:www\\.)?twitter\\.com\\/([A-Za-z0-9_]+)/gi, platform: 'Twitter/X', urlPrefix: 'https://twitter.com/' },
    { p: /(?:https?:\\/\\/)?(?:www\\.)?x\\.com\\/([A-Za-z0-9_]+)/gi, platform: 'X', urlPrefix: 'https://x.com/' },
    { p: /(?:https?:\\/\\/)?(?:www\\.)?github\\.com\\/([A-Za-z0-9_-]+)/gi, platform: 'GitHub', urlPrefix: 'https://github.com/' },
    { p: /(?:https?:\\/\\/)?(?:www\\.)?linkedin\\.com\\/(?:in|company)\\/([A-Za-z0-9_-]+)/gi, platform: 'LinkedIn', urlPrefix: 'https://linkedin.com/in/' },
    { p: /(?:https?:\\/\\/)?(?:www\\.)?instagram\\.com\\/([A-Za-z0-9_.]+)/gi, platform: 'Instagram', urlPrefix: 'https://instagram.com/' },
    { p: /(?:https?:\\/\\/)?(?:www\\.)?facebook\\.com\\/([A-Za-z0-9_.]+)/gi, platform: 'Facebook', urlPrefix: 'https://facebook.com/' },
    { p: /(?:https?:\\/\\/)?(?:www\\.)?youtube\\.com\\/(?:@|channel\\/|user\\/|c\\/)([A-Za-z0-9_-]+)/gi, platform: 'YouTube', urlPrefix: 'https://youtube.com/@' },
    { p: /(?:https?:\\/\\/)?(?:www\\.)?t\\.me\\/([A-Za-z0-9_]+)/gi, platform: 'Telegram', urlPrefix: 'https://t.me/' },
    { p: /(?:https?:\\/\\/)?(?:www\\.)?discord(?:\\.gg|app\\.com\\/invite|\\.com\\/invite)\\/([A-Za-z0-9]+)/gi, platform: 'Discord', urlPrefix: 'https://discord.gg/' },
    { p: /(?:https?:\\/\\/)?(?:www\\.)?reddit\\.com\\/(?:u|user)\\/([A-Za-z0-9_-]+)/gi, platform: 'Reddit', urlPrefix: 'https://reddit.com/user/' },
    { p: /(?:https?:\\/\\/)?(?:www\\.)?tiktok\\.com\\/@([A-Za-z0-9_.]+)/gi, platform: 'TikTok', urlPrefix: 'https://tiktok.com/@' },
    { p: /(?:https?:\\/\\/)?(?:www\\.)?mastodon\\.social\\/@([A-Za-z0-9_]+)/gi, platform: 'Mastodon', urlPrefix: 'https://mastodon.social/@' },
  ];
  for (var sp of socialPatterns) {
    sp.p.lastIndex = 0;
    while ((m = sp.p.exec(allText)) !== null) {
      var username = m[1];
      var key = sp.platform + ':' + username;
      if (!seen.social[key]) { seen.social[key] = 1; result.socialProfiles.push({ platform: sp.platform, url: sp.urlPrefix + username, username: username }); }
    }
  }

  // --- Also check href links directly ---
  var anchors = document.querySelectorAll('a[href]');
  for (var a of anchors) {
    var href = a.getAttribute('href') || '';
    for (var sp2 of socialPatterns) {
      sp2.p.lastIndex = 0;
      var m2 = sp2.p.exec(href);
      if (m2 && m2[1]) {
        var u2 = m2[1];
        var k2 = sp2.platform + ':' + u2;
        if (!seen.social[k2]) { seen.social[k2] = 1; result.socialProfiles.push({ platform: sp2.platform, url: sp2.urlPrefix + u2, username: u2 }); }
      }
    }
  }

  // --- Crypto addresses ---
  var btcRe = /\\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\\b/g;
  var ethRe = /\\b0x[a-fA-F0-9]{40}\\b/g;
  while ((m = btcRe.exec(allText)) !== null) {
    if (!seen.crypto[m[0]]) { seen.crypto[m[0]] = 1; result.cryptoAddresses.push({ type: 'BTC', address: m[0] }); }
  }
  while ((m = ethRe.exec(allText)) !== null) {
    if (!seen.crypto[m[0]]) { seen.crypto[m[0]] = 1; result.cryptoAddresses.push({ type: 'ETH', address: m[0] }); }
  }

  // --- IBAN ---
  var ibanRe = /\\b[A-Z]{2}\\d{2}[A-Z0-9]{10,30}\\b/g;
  while ((m = ibanRe.exec(allText)) !== null) {
    if (m[0].length >= 15 && m[0].length <= 34 && !seen.iban[m[0]]) { seen.iban[m[0]] = 1; result.ibans.push(m[0]); }
  }

  // --- API keys (common patterns) ---
  var apiKeyPatterns = [
    { re: /(?:api[_-]?key|apikey|api[_-]?secret)["\\s:=]+([A-Za-z0-9_\\-]{32,})/gi, type: 'Generic API Key' },
    { re: /AIza[0-9A-Za-z_\\-]{35}/g, type: 'Google API Key' },
    { re: /sk_live_[0-9a-zA-Z]{24,}/g, type: 'Stripe Secret Key' },
    { re: /gh[ps]_[A-Za-z0-9]{36,}/g, type: 'GitHub Token' },
    { re: /AKIA[0-9A-Z]{16}/g, type: 'AWS Access Key' },
    { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, type: 'Slack Token' },
  ];
  for (var ap of apiKeyPatterns) {
    ap.re.lastIndex = 0;
    while ((m = ap.re.exec(allText)) !== null) {
      var val = m[1] || m[0];
      if (!seen.apikey[val]) { seen.apikey[val] = 1; result.apiKeys.push({ type: ap.type, value: val.substring(0, 50) }); }
    }
  }

  // --- OpenGraph ---
  document.querySelectorAll('meta[property]').forEach(function(meta) {
    var prop = meta.getAttribute('property');
    if (prop && prop.startsWith('og:')) {
      result.metadata.openGraph[prop] = meta.getAttribute('content') || '';
    }
  });

  // --- JSON-LD ---
  document.querySelectorAll('script[type="application/ld+json"]').forEach(function(s) {
    try { result.metadata.jsonLd.push(JSON.parse(s.textContent)); } catch {}
  });

  // --- Meta tags ---
  document.querySelectorAll('meta[name], meta[http-equiv]').forEach(function(meta) {
    var name = meta.getAttribute('name') || meta.getAttribute('http-equiv');
    if (name) result.metadata.meta[name] = meta.getAttribute('content') || '';
  });

  // --- External links by domain ---
  var domainCount = {};
  anchors.forEach = anchors.forEach || function(cb) { for (var i = 0; i < anchors.length; i++) cb(anchors[i]); };
  for (var a2 of anchors) {
    var h = a2.getAttribute('href') || '';
    if (h.startsWith('http') && !h.includes(location.hostname)) {
      try {
        var d = new URL(h).hostname;
        domainCount[d] = (domainCount[d] || 0) + 1;
      } catch {}
    }
  }
  result.links = Object.entries(domainCount).map(function(e) { return { domain: e[0], count: e[1] }; }).sort(function(a, b) { return b.count - a.count; }).slice(0, 20);

  // --- Forms ---
  document.querySelectorAll('form').forEach(function(form) {
    var fields = Array.from(form.querySelectorAll('input, textarea, select')).map(function(i) {
      return i.name || i.id || i.getAttribute('type') || i.tagName.toLowerCase();
    });
    result.forms.push({
      action: form.getAttribute('action') || '',
      method: (form.getAttribute('method') || 'GET').toUpperCase(),
      fields: fields,
    });
  });

  return JSON.stringify(result);
})()`;

export interface Transport {
  send(method: string, params?: Record<string, any>): Promise<any>;
}

export class OSINTHarvester {
  private transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  async harvest(): Promise<OSINTResult> {
    const res = await this.transport.send('Runtime.evaluate', {
      expression: HARVEST_SCRIPT,
      returnByValue: true,
    });
    if (!res?.result?.value) {
      return {
        emails: [], phones: [], socialProfiles: [], cryptoAddresses: [],
        ibans: [], apiKeys: [], metadata: { openGraph: {}, jsonLd: [], meta: {} },
        links: [], forms: [],
      };
    }
    return JSON.parse(res.result.value) as OSINTResult;
  }
}
