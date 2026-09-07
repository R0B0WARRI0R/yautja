(function () {
  if (window.__yautjaHudLoaded) return;
  window.__yautjaHudLoaded = true;

  const YAUTJA_FONT_B64 =
    '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';

  const style = document.createElement('style');
  style.textContent = `
    @font-face {
      font-family: 'Yautja';
      src: url('data:font/woff;base64,${YAUTJA_FONT_B64}') format('woff');
      font-weight: normal;
      font-style: normal;
    }
    #yautja-hud {
      position: fixed;
      bottom: 12px;
      right: 12px;
      z-index: 2147483647;
      background: rgba(13, 17, 23, 0.92);
      border: 1px solid #00ff4144;
      border-radius: 4px;
      padding: 8px 10px;
      font-family: 'Yautja', 'Courier New', monospace;
      font-size: 10px;
      line-height: 1.4;
      color: #00ff41;
      min-width: 160px;
      pointer-events: none;
      user-select: none;
      backdrop-filter: blur(4px);
      -webkit-font-smoothing: none;
      box-shadow: 0 0 12px rgba(0, 255, 65, 0.08);
    }
    #yautja-hud .y-hdr {
      display: flex;
      align-items: center;
      gap: 6px;
      border-bottom: 1px solid #00ff4122;
      padding-bottom: 3px;
      margin-bottom: 3px;
      font-size: 11px;
      letter-spacing: 1px;
    }
    #yautja-hud .y-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    #yautja-hud .y-dot.g { background: #00ff41; box-shadow: 0 0 4px #00ff41; }
    #yautja-hud .y-dot.r { background: #ff0041; box-shadow: 0 0 4px #ff0041; }
    #yautja-hud .y-dot.y { background: #ffaa00; box-shadow: 0 0 4px #ffaa00; }
    #yautja-hud .y-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    #yautja-hud .y-lbl { color: #6e7681; }
    #yautja-hud .y-val { color: #00ff41; }
    #yautja-hud .y-val.c { color: #00aaff; }
    #yautja-hud .y-val.w { color: #ffaa00; }
    #yautja-hud .y-val.e { color: #ff0041; }
    #yautja-hud .y-sensors {
      display: flex;
      gap: 2px;
      font-size: 9px;
    }
    #yautja-hud .y-sensor {
      color: #00ff4188;
    }
    #yautja-hud .y-sensor.on {
      color: #00ff41;
      text-shadow: 0 0 4px #00ff4188;
    }
    #yautja-hud .y-div {
      border-top: 1px solid #00ff4122;
      margin-top: 3px;
      padding-top: 3px;
    }
  `;
  document.head.appendChild(style);

  const hud = document.createElement('div');
  hud.id = 'yautja-hud';
  hud.innerHTML = [
    '<div class="y-hdr"><span class="y-dot g" id="yd"></span>YAUTJA</div>',
    '<div class="y-row"><span class="y-lbl">REQS</span><span class="y-val" id="yr">0</span></div>',
    '<div class="y-row"><span class="y-lbl">FAIL</span><span class="y-val" id="yf">0</span></div>',
    '<div class="y-row"><span class="y-lbl">CDN</span><span class="y-val" id="yc">-</span></div>',
    '<div class="y-row"><span class="y-lbl">PAGE</span><span class="y-val" id="yp">-</span></div>',
    '<div class="y-row y-div"><span class="y-lbl">SENSORS</span><span class="y-sensors" id="ys">',
    '  <span class="y-sensor" data-s="thermal">TH</span>',
    '  <span class="y-sensor" data-s="em">EM</span>',
    '  <span class="y-sensor" data-s="audio">AU</span>',
    '  <span class="y-sensor" data-s="motion">MO</span>',
    '  <span class="y-sensor" data-s="threat">THR</span>',
    '  <span class="y-sensor" data-s="tech">TECH</span>',
    '</span></div>',
    '<div class="y-row y-div"><span class="y-lbl">TS</span><span class="y-val" id="yts">-</span></div>',
  ].join('');
  document.body.appendChild(hud);

  function $(id) { return document.getElementById(id); }

  function update() {
    try {
      const perf = window.performance.getEntriesByType('resource');
      const total = perf.length;
      const failed = perf.filter(function (e) {
        return e.duration === 0 || (e.responseStatus >= 400 && e.responseStatus > 0);
      }).length;

      $('yr').textContent = total;
      $('yf').textContent = failed;
      $('yp').textContent = (document.title || '').substring(0, 16);

      var dot = $('yd');
      if (failed > total * 0.3 && total > 5) {
        dot.className = 'y-dot r';
      } else if (failed > 0) {
        dot.className = 'y-dot y';
      } else {
        dot.className = 'y-dot g';
      }

      var cdn = perf.filter(function (e) {
        return e.name.indexOf('nflxvideo') >= 0 || e.name.indexOf('.nflxvideo') >= 0;
      });
      var $yc = $('yc');
      if (cdn.length) {
        var sum = 0;
        for (var i = 0; i < cdn.length; i++) sum += cdn[i].duration;
        var avg = sum / cdn.length;
        $yc.textContent = (avg / 1000).toFixed(1) + 's';
        if (avg > 3000) $yc.className = 'y-val e';
        else if (avg > 1500) $yc.className = 'y-val w';
        else $yc.className = 'y-val';
      } else {
        $yc.textContent = '-';
        $yc.className = 'y-val';
      }

      $('yts').textContent = new Date().toLocaleTimeString();

      // Pulse sensors randomly (simulate activity)
      var sensors = document.querySelectorAll('.y-sensor');
      for (var i = 0; i < sensors.length; i++) {
        if (Math.random() < 0.15) {
          sensors[i].classList.toggle('on');
        }
      }
    } catch (e) {
      // silent
    }
    setTimeout(update, 2000);
  }

  // Start first update cycle
  setTimeout(update, 500);
})();
