import type { Transport } from './base-sensor.js';

export interface TechDetection {
  category: string;
  name: string;
  version?: string;
  confidence: 'certain' | 'high' | 'medium' | 'low';
}

export interface NetworkFingerprint {
  server?: string;
  poweredBy?: string;
  cdn?: string;
  framework?: string;
  securityHeaders: Record<string, string>;
  missingSecurityHeaders: string[];
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
}

export interface AntiBotDetection {
  detected: boolean;
  services: string[];
  signals: string[];
  riskLevel: 'none' | 'low' | 'medium' | 'high';
}

export interface TechSummary {
  technologies: TechDetection[];
  fingerprint: NetworkFingerprint;
  antiBot: AntiBotDetection;
}

const TECH_SCRIPT = `(function() {
  var tech = [];
  var scripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
  var metas = {};
  document.querySelectorAll('meta').forEach(function(m) {
    var name = m.getAttribute('name') || m.getAttribute('property') || '';
    metas[name.toLowerCase()] = m.getAttribute('content') || '';
  });
  var html = document.documentElement.outerHTML.substring(0, 50000);
  var cookies = document.cookie;

  function add(cat, name, ver, conf) {
    tech.push({ category: cat, name: name, version: ver || undefined, confidence: conf || 'high' });
  }

  // JS Frameworks
  if (window.React || html.match(/data-reactroot|__next|_reactRoot/)) add('framework', 'React', undefined, 'certain');
  if (window.__NEXT_DATA__ || html.match(/__next/)) add('framework', 'Next.js', undefined, 'certain');
  if (window.__NUXT__ || html.match(/__nuxt/)) add('framework', 'Nuxt', undefined, 'certain');
  if (window.Vue || html.match(/data-v-[a-f0-9]/)) add('framework', 'Vue', undefined, 'certain');
  if (window.angular || document.querySelector('[ng-version]')) {
    var v = document.querySelector('[ng-version]');
    add('framework', 'Angular', v ? v.getAttribute('ng-version') : undefined, 'certain');
  }
  if (window.__SVELTE__) add('framework', 'Svelte', undefined, 'certain');
  if (html.match(/data-emotion|css-[a-z0-9]{6}/)) add('framework', 'Emotion', undefined, 'high');
  if (html.match(/styled-components|sc-[a-z0-9]{6}/)) add('framework', 'Styled Components', undefined, 'high');
  if (html.match(/tailwind|tw-/)) add('css', 'Tailwind CSS', undefined, 'high');
  if (document.querySelector('[class*="bootstrap"], [class*="container-fluid"]')) add('css', 'Bootstrap', undefined, 'medium');

  // CDN
  scripts.forEach(function(s) {
    if (s.match(/cloudflare/)) add('cdn', 'Cloudflare', undefined, 'certain');
    if (s.match(/cdnjs/)) add('cdn', 'cdnjs', undefined, 'certain');
    if (s.match(/jsdelivr/)) add('cdn', 'jsDelivr', undefined, 'certain');
    if (s.match(/unpkg/)) add('cdn', 'unpkg', undefined, 'certain');
    if (s.match(/googleapis/)) add('cdn', 'Google Cloud', undefined, 'high');
  });

  // Analytics
  if (window.ga || window.gtag || window.dataLayer || cookies.match(/_ga/)) add('analytics', 'Google Analytics', undefined, 'certain');
  if (window._fbq || cookies.match(/_fbp/)) add('analytics', 'Facebook Pixel', undefined, 'high');
  if (window.mixpanel) add('analytics', 'Mixpanel', undefined, 'certain');
  if (window.amplitude) add('analytics', 'Amplitude', undefined, 'certain');
  if (window.hotjar) add('analytics', 'Hotjar', undefined, 'certain');
  if (window.clarity) add('analytics', 'Microsoft Clarity', undefined, 'certain');
  if (metas['segment-write-key'] || window.analytics) add('analytics', 'Segment', undefined, 'high');

  // Libraries
  if (window.jQuery) add('js', 'jQuery', window.jQuery.fn?.jquery, 'certain');
  if (window.Lodash) add('js', 'Lodash', undefined, 'high');
  if (window.axios) add('js', 'Axios', undefined, 'high');
  if (window._) add('js', 'Underscore/Lodash', undefined, 'medium');
  if (window.D3) add('js', 'D3.js', undefined, 'certain');
  if (window.three) add('js', 'Three.js', undefined, 'certain');

  // CMS
  if (html.match(/wp-content|wp-includes/)) add('cms', 'WordPress', undefined, 'certain');
  if (metas['generator'] && metas['generator'].match(/shopify/i)) add('cms', 'Shopify', undefined, 'certain');
  if (metas['generator'] && metas['generator'].match(/drupal/i)) add('cms', 'Drupal', undefined, 'certain');
  if (html.match(/__wix/)) add('cms', 'Wix', undefined, 'high');
  if (html.match(/squarespace/)) add('cms', 'Squarespace', undefined, 'high');

  // Payment
  if (window.Stripe) add('payment', 'Stripe', undefined, 'certain');
  if (html.match(/paypal/)) add('payment', 'PayPal', undefined, 'medium');

  // Deduplicate
  var seen = {};
  tech = tech.filter(function(t) {
    var key = t.category + ':' + t.name;
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });

  return JSON.stringify(tech);
})()`;

const ANTIBOT_SCRIPT = `(function() {
  var signals = [];
  var services = [];

  // Cloudflare
  if (document.cookie.match(/__cf_bm|cf_clearance/) || document.querySelector('script[src*="cloudflare"]')) {
    services.push('Cloudflare Bot Management');
    signals.push('Cloudflare cookie detected');
  }
  // reCAPTCHA
  if (document.querySelector('.g-recaptcha, [data-sitekey]') || document.querySelector('script[src*="recaptcha"]')) {
    services.push('Google reCAPTCHA');
    signals.push('reCAPTCHA element detected');
  }
  // hCaptcha
  if (document.querySelector('.h-captcha, script[src*="hcaptcha"]')) {
    services.push('hCaptcha');
    signals.push('hCaptcha detected');
  }
  // Turnstile
  if (document.querySelector('.cf-turnstile, script[src*="challenges.cloudflare.com/turnstile"]')) {
    services.push('Cloudflare Turnstile');
    signals.push('Turnstile widget detected');
  }
  // PerimeterX / HUMAN
  if (document.cookie.match(/_px|pxhd/) || document.querySelector('script[src*="px-cdn"]')) {
    services.push('PerimeterX (HUMAN)');
    signals.push('PerimeterX cookie/script detected');
  }
  // DataDome
  if (document.cookie.match(/datadome/) || document.querySelector('script[src*="datadome"]')) {
    services.push('DataDome');
    signals.push('DataDome cookie detected');
  }
  // Akamai Bot Manager
  if (document.cookie.match(/_abck|bm_sz/) || document.querySelector('script[src*="_sec"]')) {
    services.push('Akamai Bot Manager');
    signals.push('Akamai bot cookie detected');
  }
  // Kasada
  if (document.querySelector('script[src*="kasada"]') || document.cookie.match(/kp/)) {
    services.push('Kasada');
    signals.push('Kasada script detected');
  }
  // FingerprintJS
  if (document.querySelector('script[src*="fingerprintjs"]') || window.FingerprintJS) {
    services.push('FingerprintJS');
    signals.push('FingerprintJS library detected');
  }

  // Behavioral signals
  if (document.querySelector('[onpaste], [oncopy], [oncut]')) {
    signals.push('Copy/paste event monitoring');
  }
  var scripts = Array.from(document.querySelectorAll('script')).map(function(s) { return s.textContent || ''; }).join('\\n');
  if (scripts.match(/webdriver|headless|phantom|selenium|puppeteer|playwright|cdp|chrome\.runtime/)) {
    signals.push('Automation detection script found');
  }
  if (navigator.webdriver) {
    signals.push('navigator.webdriver = true');
  }

  var risk = 'none';
  if (services.length >= 2) risk = 'high';
  else if (services.length === 1) risk = 'medium';
  else if (signals.length > 0) risk = 'low';

  return JSON.stringify({ detected: services.length > 0 || signals.length > 2, services: services, signals: signals, riskLevel: risk });
})()`;

export class TechSensor {
  private transport: Transport;
  private docHeaders: Record<string, string> = {};

  constructor(transport: Transport) {
    this.transport = transport;
    this.transport.on('Network.responseReceived', (p: any) => {
      if (p.type === 'Document' && p.response) {
        this.docHeaders = {};
        const headers = p.response.headers || {};
        for (const [k, v] of Object.entries(headers)) {
          this.docHeaders[k] = v as string;
        }
      }
    });
  }

  async summarize(): Promise<TechSummary> {
    const [techRes, antiBotRes] = await Promise.all([
      this.transport.send('Runtime.evaluate', { expression: TECH_SCRIPT, returnByValue: true }),
      this.transport.send('Runtime.evaluate', { expression: ANTIBOT_SCRIPT, returnByValue: true }),
    ]);

    const technologies: TechDetection[] = techRes?.result?.value
      ? JSON.parse(techRes.result.value)
      : [];

    const antiBot: AntiBotDetection = antiBotRes?.result?.value
      ? JSON.parse(antiBotRes.result.value)
      : { detected: false, services: [], signals: [], riskLevel: 'none' };

    const fingerprint = await this.buildFingerprint();

    return { technologies, fingerprint, antiBot };
  }

  private async buildFingerprint(): Promise<NetworkFingerprint> {
    let responseHeaders: Record<string, string> = {};

    try {
      const res = await this.transport.send('Runtime.evaluate', {
        expression: `(async () => {
          try {
            const r = await fetch(location.origin + '/', { method: 'HEAD', credentials: 'include', mode: 'same-origin' });
            const h = {};
            r.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
            return JSON.stringify({ status: r.status, headers: h });
          } catch(e) { return JSON.stringify({ error: e.message }); }
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (res?.result?.value) {
        const data = JSON.parse(res.result.value);
        if (data.headers && !data.error) responseHeaders = data.headers;
      }
    } catch {}

    try {
      if (Object.keys(responseHeaders).length === 0) {
        const res2 = await this.transport.send('Runtime.evaluate', {
          expression: `(async () => {
            try {
              const r = await fetch(location.href, { credentials: 'include', mode: 'same-origin' });
              const h = {};
              r.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
              return JSON.stringify({ headers: h });
            } catch(e) { return JSON.stringify({ error: e.message }); }
          })()`,
          awaitPromise: true,
          returnByValue: true,
        });
        if (res2?.result?.value) {
          const data2 = JSON.parse(res2.result.value);
          if (data2.headers) responseHeaders = data2.headers;
        }
      }
    } catch {}

    const securityHeaders: Record<string, string> = {};
    const known = [
      'content-security-policy', 'x-frame-options', 'x-content-type-options',
      'strict-transport-security', 'referrer-policy', 'permissions-policy',
      'cross-origin-opener-policy', 'cross-origin-embedder-policy',
      'x-xss-protection', 'x-permitted-cross-domain-policies',
    ];

    for (const h of known) {
      const val = this.findHeader(responseHeaders, h);
      if (val) securityHeaders[h] = val;
    }

    const required = [
      'content-security-policy', 'x-frame-options', 'x-content-type-options',
      'strict-transport-security', 'referrer-policy',
    ];
    const missing = required.filter(h => !this.findHeader(responseHeaders, h));

    let score = required.length - missing.length;
    let grade: 'A' | 'B' | 'C' | 'D' | 'F' = 'F';
    if (score >= 5) grade = 'A';
    else if (score >= 4) grade = 'B';
    else if (score >= 3) grade = 'C';
    else if (score >= 2) grade = 'D';

    return {
      server: this.findHeader(responseHeaders, 'server'),
      poweredBy: this.findHeader(responseHeaders, 'x-powered-by'),
      cdn: this.detectCDN(responseHeaders),
      framework: this.findHeader(responseHeaders, 'x-powered-by') || this.findHeader(responseHeaders, 'x-aspnet-version'),
      securityHeaders,
      missingSecurityHeaders: missing,
      grade,
    };
  }

  private findHeader(headers: Record<string, string>, name: string): string | undefined {
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lower) return v;
    }
    return undefined;
  }

  private detectCDN(headers: Record<string, string>): string | undefined {
    const server = (this.findHeader(headers, 'server') || '').toLowerCase();
    const cfRay = this.findHeader(headers, 'cf-ray');
    const xAkamai = this.findHeader(headers, 'x-akamai-transformed');
    const via = (this.findHeader(headers, 'via') || '').toLowerCase();

    if (cfRay) return 'Cloudflare';
    if (xAkamai || server.includes('akamai')) return 'Akamai';
    if (via.includes('cloudfront')) return 'AWS CloudFront';
    if (via.includes('varnish')) return 'Varnish/Fastly';
    if (server.includes('nginx')) return 'nginx (origin)';
    if (server.includes('apache')) return 'Apache (origin)';
    return undefined;
  }
}
