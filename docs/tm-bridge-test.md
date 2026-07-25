# Tampermonkey Bridge — Test Plan

## What changed

Two commits since `e787fe4`:

- **`e92b97e`** — Replaced the dead `tmMessage` bridge with `tmInstallViaBridge`. Generic: accepts any TM method via `message: { method, ...params }`. Open a hidden tab on `greasyfork.org`, attach CDP, inject `chrome.runtime.connect(TM_ID).postMessage(message)` from the page context → TM's `onMessageExternal` accepts it (page-side bridge, NOT `onConnectExternal`).
- **`650e723`** — `tmToggleScript` reads the raw meta (`@meta#<uuid>`) directly from LevelDB instead of using the simplified `tmGetScript` shape, then sends `saveScript` via the bridge.

## Steps to test

1. **Reload the Yautja Bridge extension** in `chrome://extensions` (toggle off/on, or click the reload button).
2. **Restart the MCP server** — the running server has the old `dist/helmet.js` in memory. A new process picks up the rebuilt files.
3. **Test install** with the Dark Mode Toggle script we drafted earlier:

```js
yautja_tmInstallScript({
  code: `// ==UserScript==
// @name         Dark Mode Toggle
// @namespace    yautja
// @version      1.0
// @description  Floating button to toggle dark mode on any site
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @license      MIT
// ==/UserScript==
(function() {
  'use strict';
  const BTN_ID = 'yautja-dark-mode-btn';
  if (document.getElementById(BTN_ID)) return;
  const btn = document.createElement('button');
  btn.id = BTN_ID;
  btn.textContent = '🌙';
  btn.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999999;width:48px;height:48px;border-radius:50%;border:none;background:#222;color:#fff;font-size:24px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
  const host = location.hostname;
  const toggle = () => {
    const on = document.documentElement.style.filter.includes('invert');
    if (on) {
      document.documentElement.style.filter = '';
      btn.textContent = '🌙';
      GM_setValue(host, false);
    } else {
      document.documentElement.style.filter = 'invert(1) hue-rotate(180deg)';
      btn.textContent = '☀️';
      GM_setValue(host, true);
    }
  };
  btn.addEventListener('click', toggle);
  document.body.appendChild(btn);
  if (GM_getValue(host, false)) {
    document.documentElement.style.filter = 'invert(1) hue-rotate(180deg)';
    btn.textContent = '☀️';
  }
})();`
});
```

Expected: a hidden tab briefly opens on `greasyfork.org`, the bridge installs the script, and you get `{"success": true, ...}` back. The script will appear in `tmListScripts` after that.

## Failure modes

- **No response** → `chrome.runtime.connect` from the page context was rejected. Check DevTools console on the bridge tab; the `lastError` will be reported.
- **`Unknown method importEx`** → TM version doesn't support `importEx` in this context. Try `installFromUrl` instead, or use `GM_xmlhttpRequest` to fetch the script first and call `saveScript`.
- **Tab flicker** → the hidden tab uses `active: false`, but if you have pop-up blocker or focus-stealing prevention, it might still flash. Adjust if annoying.
- **GreasyFork blocked** → if your network blocks `greasyfork.org`, swap the URL in `background.js` for another origin in TM's `externally_connectable` whitelist (e.g. `openuserjs.org`).

## Rollback

If something goes wrong, the previous working approach is `tmMessage` (still in `background.js` lines 580+, but inert because of `onConnectExternal` whitelist). Revert with:

```bash
git revert e92b97e 650e723
```
