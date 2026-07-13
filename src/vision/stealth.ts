export const STEALTH_PART_1 = `
(function() {
  if (window.__yautja_stealth) return 'already';
  window.__yautja_stealth = true;
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true }); } catch {}
  try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true }); } catch {}
  try {
    const o = CanvasRenderingContext2D.prototype.getImageData;
    const orig = function(ctx, args) { return o.apply(ctx, args); };
    CanvasRenderingContext2D.prototype.getImageData = function() {
      const img = o.apply(this, arguments);
      const w = img.width, h = img.height;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (Math.random() < 0.03) {
            img.data[i] = img.data[i] ^ 1;
            img.data[i+1] = img.data[i+1] ^ 1;
          }
        }
      }
      return img;
    };
  } catch {}
  return 'core';
})();
`;

export const STEALTH_PART_2 = `
(function() {
  if (!window.__yautja_stealth) return 'not-ready';
  try {
    const og = WebGLRenderingContext.prototype.getParameter;
    const og2 = WebGL2RenderingContext.prototype.getParameter;
    const v = ['Google Inc. (NVIDIA)', 'Google Inc. (Intel)', 'Google Inc. (AMD)'];
    const r = ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)'];
    const i = Math.floor(Math.random() * 3);
    WebGLRenderingContext.prototype.getParameter = function(p) { if (p === 37445) return v[i]; if (p === 37446) return r[i]; return og.call(this, p); };
    WebGL2RenderingContext.prototype.getParameter = function(p) { if (p === 37445) return v[i]; if (p === 37446) return r[i]; return og2.call(this, p); };
  } catch {}
  try {
    const o = AudioContext.prototype.createAnalyser;
    AudioContext.prototype.createAnalyser = function() { const a = o.call(this); const og = a.getFloatFrequencyData.bind(a); a.getFloatFrequencyData = function(arr) { og(arr); for (let i = 0; i < arr.length; i++) arr[i] += (Math.random()-0.5)*0.1; }; return a; };
  } catch {}
  return 'fingerprint';
})();
`;

export const STEALTH_PART_3 = `
(function() {
  if (!window.__yautja_stealth) return 'not-ready';
  try {
    const oq = navigator.permissions.query;
    navigator.permissions.query = function(p) { if (p.name === 'notifications') return Promise.resolve({ state: 'prompt', onchange: null }); return oq.call(this, p); };
  } catch {}
  try {
    Error.prepareStackTrace = function(err, stack) { let r = err.toString(); return r.replace(/chrome-extension:\\/\\/[a-z0-9]+/g, 'extension').replace(/debugger:\\/\\/\\S+/g, 'internal:'); };
  } catch {}
  return 'misc';
})();
`;

export const STEALTH_INJECT = STEALTH_PART_1;

export class StealthMode {
  private active = false;

  isActive(): boolean {
    return this.active;
  }

  getInjectScript(): string {
    return STEALTH_INJECT;
  }

  activate(): void {
    this.active = true;
  }

  deactivate(): void {
    this.active = false;
  }
}
