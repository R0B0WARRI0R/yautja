export interface APIEndpoint {
  url: string;
  method: string;
  status: number;
  mimeType: string;
  hasAuth: boolean;
  responseSize: number;
}

export interface TokenFinding {
  type: string;
  name: string;
  value: string;
  location: string;
}

export interface InfraInfo {
  domains: string[];
  cdnDomains: string[];
  apiDomains: string[];
  analyticsDomains: string[];
  trackingDomains: string[];
  externalServices: { domain: string; category: string }[];
  websocketUrls: string[];
}

export interface NetworkIntelResult {
  apis: APIEndpoint[];
  tokens: TokenFinding[];
  infra: InfraInfo;
  cookies: { name: string; domain: string; secure: boolean; httpOnly: boolean; session: boolean }[];
  localStorageKeys: string[];
  sessionStorageKeys: string[];
}

const KNOWN_ANALYTICS = ['google-analytics.com', 'googletagmanager.com', 'facebook.net', 'fbq', 'doubleclick.net', 'hotjar', 'mixpanel', 'segment.io', 'amplitude.com', 'bat.bing', 'ads-twitter', 'adsrvr.org', 'linkedin.com/px', 'snap.licdn'];
const KNOWN_CDN = ['cloudflare', 'cloudfront', 'akamai', 'fastly', 'jsdelivr', 'unpkg', 'cdnjs', 'googleapis', 'gstatic', 'bootstrapcdn'];
const KNOWN_TRACKING = ['facebook.com/tr', 'googleads', 'doubleclick', 'adsense', 'taboola', 'outbrain', 'criteo', 'scorecardresearch'];

const INTEL_SCRIPT = `(function() {
  var apis = [];
  var tokens = [];
  var domains = {};
  var wsUrls = [];
  var cookies = [];
  var lsKeys = [];
  var ssKeys = [];

  // --- Performance entries for API discovery ---
  var entries = performance.getEntriesByType('resource');
  for (var e of entries) {
    try {
      var url = new URL(e.name);
      var path = url.pathname;

      // API detection
      if (path.match(/\\/api\\/|\\/v[0-9]+\\/|\\/graphql|\\/rpc\\/|\\/rest\\//i) || e.initiatorType === 'xmlhttprequest' || e.initiatorType === 'fetch') {
        apis.push({ url: url.origin + path, method: 'GET', status: 0, mimeType: '', hasAuth: false, responseSize: e.encodedBodySize || 0 });
      }

      var d = url.hostname;
      if (!domains[d]) domains[d] = { count: 0, categories: [] };
      domains[d].count++;
    } catch {}
  }

  // --- WebSocket URLs from performance ---
  for (var e2 of entries) {
    if (e2.name.startsWith('ws://') || e2.name.startsWith('wss://')) {
      wsUrls.push(e2.name);
    }
  }

  // --- Tokens in localStorage ---
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      lsKeys.push(key);
      var val = localStorage.getItem(key) || '';
      var lcKey = key.toLowerCase();
      if (lcKey.match(/token|auth|jwt|bearer|session|secret|key|password|api/i)) {
        tokens.push({ type: 'localStorage', name: key, value: val.substring(0, 100), location: 'localStorage' });
      }
    }
  } catch {}

  // --- Tokens in sessionStorage ---
  try {
    for (var j = 0; j < sessionStorage.length; j++) {
      var sKey = sessionStorage.key(j);
      ssKeys.push(sKey);
      var sVal = sessionStorage.getItem(sKey) || '';
      var slcKey = sKey.toLowerCase();
      if (slcKey.match(/token|auth|jwt|bearer|session|secret|key|password|api/i)) {
        tokens.push({ type: 'sessionStorage', name: sKey, value: sVal.substring(0, 100), location: 'sessionStorage' });
      }
    }
  } catch {}

  // --- Tokens in cookies ---
  try {
    var cookieParts = document.cookie.split(';');
    for (var c of cookieParts) {
      var parts = c.trim().split('=');
      var cName = parts[0] || '';
      var cVal = parts.slice(1).join('=') || '';
      if (cName.toLowerCase().match(/token|auth|jwt|bearer|session|csrf|xsrf|api/i)) {
        tokens.push({ type: 'cookie', name: cName, value: cVal.substring(0, 80), location: 'cookie' });
      }
    }
  } catch {}

  // --- Tokens in meta tags ---
  document.querySelectorAll('meta').forEach(function(meta) {
    var name = (meta.getAttribute('name') || meta.getAttribute('property') || '').toLowerCase();
    var content = meta.getAttribute('content') || '';
    if (name.match(/token|csrf|key|api|auth/i) && content) {
      tokens.push({ type: 'meta', name: name, value: content.substring(0, 80), location: 'meta' });
    }
  });

  // --- JWT in localStorage ---
  try {
    for (var k = 0; k < localStorage.length; k++) {
      var jwtKey = localStorage.key(k);
      var jwtVal = localStorage.getItem(jwtKey) || '';
      if (jwtVal.match(/^ey[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/)) {
        tokens.push({ type: 'JWT', name: jwtKey, value: jwtVal.substring(0, 100), location: 'localStorage' });
      }
    }
  } catch {}

  // --- Deduplicate APIs ---
  var seenApi = {};
  apis = apis.filter(function(a) { if (seenApi[a.url]) return false; seenApi[a.url] = 1; return true; });

  // --- Cookie details ---
  try {
    cookieParts = document.cookie.split(';');
    for (var cd of cookieParts) {
      var cp = cd.trim().split('=');
      cookies.push({ name: cp[0] || '', domain: location.hostname, secure: location.protocol === 'https:', httpOnly: false, session: !cp[0] || cp[0].match(/session|sid|sess/i) });
    }
  } catch {}

  return JSON.stringify({ apis: apis, tokens: tokens, domains: domains, wsUrls: wsUrls, cookies: cookies, lsKeys: lsKeys, ssKeys: ssKeys });
})()`;

export interface Transport {
  send(method: string, params?: Record<string, any>): Promise<any>;
}

export class NetworkIntel {
  private transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  async analyze(): Promise<NetworkIntelResult> {
    const res = await this.transport.send('Runtime.evaluate', {
      expression: INTEL_SCRIPT,
      returnByValue: true,
    });

    if (!res?.result?.value) {
      return { apis: [], tokens: [], infra: { domains: [], cdnDomains: [], apiDomains: [], analyticsDomains: [], trackingDomains: [], externalServices: [], websocketUrls: [] }, cookies: [], localStorageKeys: [], sessionStorageKeys: [] };
    }

    const raw = JSON.parse(res.result.value);

    const infra: InfraInfo = {
      domains: [],
      cdnDomains: [],
      apiDomains: [],
      analyticsDomains: [],
      trackingDomains: [],
      externalServices: [],
      websocketUrls: raw.wsUrls || [],
    };

    for (const [domain] of Object.entries(raw.domains || {})) {
      infra.domains.push(domain);
      const dl = domain.toLowerCase();
      if (KNOWN_CDN.some(c => dl.includes(c))) infra.cdnDomains.push(domain);
      if (KNOWN_ANALYTICS.some(a => dl.includes(a))) infra.analyticsDomains.push(domain);
      if (KNOWN_TRACKING.some(t => dl.includes(t))) infra.trackingDomains.push(domain);
      if (dl.includes('api') || dl.includes('graphql') || dl.includes('rpc')) infra.apiDomains.push(domain);

      let category = 'other';
      if (KNOWN_CDN.some(c => dl.includes(c))) category = 'cdn';
      else if (KNOWN_ANALYTICS.some(a => dl.includes(a))) category = 'analytics';
      else if (KNOWN_TRACKING.some(t => dl.includes(t))) category = 'tracking';
      else if (dl.includes('api') || dl.includes('graphql')) category = 'api';
      else if (dl.includes('cdn') || dl.includes('static') || dl.includes('assets')) category = 'static';
      infra.externalServices.push({ domain, category });
    }

    return {
      apis: raw.apis || [],
      tokens: raw.tokens || [],
      infra,
      cookies: raw.cookies || [],
      localStorageKeys: raw.lsKeys || [],
      sessionStorageKeys: raw.ssKeys || [],
    };
  }
}
