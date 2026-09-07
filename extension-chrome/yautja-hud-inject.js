(function () {
  var HUD = {};
  var CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz01234><:=-+*/%#&|';

  function scramble(s, p) {
    return s.split('').map(function (c) {
      return Math.random() < p ? CHARS[Math.floor(Math.random() * CHARS.length)] : c;
    }).join('');
  }

  function injectFont(b64) {
    if (document.querySelector('[data-yautja-font]')) return;
    var s = document.createElement('style');
    s.setAttribute('data-yautja-font', '1');
    s.textContent =
      "@font-face{font-family:Yautja;src:url(\"data:font/woff2;base64," +
      b64 +
      '\") format("woff2");font-weight:400;font-style:normal;font-display:block;}';
    document.head.appendChild(s);
  }

  function createHUD() {
    var el = document.createElement('div');
    el.style.cssText =
      'position:fixed;bottom:10px;right:14px;z-index:99999;padding:8px 14px;' +
      'background:rgba(0,0,0,0.88);border:1px solid #0ff;border-radius:3px;' +
      'font:bold 14px/1.5 Yautja,monospace;color:#0f0;' +
      'text-shadow:0 0 6px #0f0;letter-spacing:1px;text-transform:uppercase;';
    document.body.appendChild(el);
    return el;
  }

  function startLoop(el) {
    if (window.__yhud_int) clearInterval(window.__yhud_int);
    window.__yhud_int = setInterval(function () {
      var r = performance.getEntriesByType('resource');
      var t = 0, f = 0;
      for (var i = 0; i < r.length; i++) {
        t++;
        if (r[i].responseStatus >= 400 || r[i].responseStatus === 0) f++;
      }
      var n = performance.getEntriesByType('navigation');
      var dur = n.length ? n[0].domComplete.toFixed(0) + 'ms' : '-';
      var d = new Date();
      var ts =
        String(d.getHours()).padStart(2, '0') + ':' +
        String(d.getMinutes()).padStart(2, '0') + ':' +
        String(d.getSeconds()).padStart(2, '0');
      var raw = '>> YJ-HUD << R:' + t + ' F:' + f + ' D:' + dur + ' ' + ts;
      el.textContent = scramble(raw, 0.35);
    }, 2000);
  }

  function destroyHUD() {
    if (window.__yhud_int) { clearInterval(window.__yhud_int); window.__yhud_int = null; }
    var el = window.__yhud_el;
    if (el) { el.remove(); window.__yhud_el = null; }
  }

  HUD.start = function (b64) {
    destroyHUD();
    injectFont(b64 || window.__yf);
    window.__yhud_el = createHUD();
    startLoop(window.__yhud_el);
  };

  HUD.stop = function () { destroyHUD(); };

  HUD.toggle = function (show) {
    if (show === false || (show === undefined && window.__yhud_el)) {
      HUD.stop(); return false;
    }
    HUD.start(); return true;
  };

  window.yhud = HUD;
})();
