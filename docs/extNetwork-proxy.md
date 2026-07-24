# extNetwork — Extension Network Capture via Local Proxy

## Problem

Capturing HTTP/HTTPS traffic made by **another extension's service worker** from within a Brave MV3 extension is impossible through standard extension APIs:

| Approach | Why it fails |
|----------|-------------|
| `chrome.webRequest` | Brave silently blocks observational webRequest listeners in MV3 extensions. Events never fire. |
| `chrome.debugger` (CDP) cross-extension attach | Chromium security prevents attaching the debugger to another extension's service worker target (`"Cannot access a chrome-extension:// URL of different extension"`). |
| CDP `Network.enable` on the tab | Only captures traffic from the page's own context. Extension service worker requests happen in a separate execution context and are invisible. |
| `--remote-debugging-port=9222` | Brave crashes ~5 seconds after launch with this flag. |

## Solution: Local Tunnel Proxy

A standalone HTTP forward proxy (`proxy-standalone.cjs`) that captures all browser traffic at the network level, including service worker requests from any extension.

### Architecture

```
Brave Browser (all traffic)
    ↓ System proxy → 127.0.0.1:9877
proxy-standalone.cjs (Node.js child process)
    ├── HTTP requests: full interception (URL, headers, body, response)
    ├── HTTPS requests: CONNECT tunneling (domain + port captured, content not decrypted)
    └── Logs each request as JSON line on stdout
         ↓ piped to parent process (helmet MCP server)
    MitmProxyServer class (aggregates + queries)
         ↓ exposed via extNetwork tool
    MCP client (Grok Build)
```

### Key Design Decisions

1. **Standalone process, not in-process**: The proxy runs as a `child_process.spawn()` separate Node.js instance. Running it in-process within the MCP server caused premature exit (the proxy's event loop interfered with the MCP stdio readline loop).

2. **Pure Node.js HTTP proxy (no `http-mitm-proxy`)**: The `http-mitm-proxy` library had multiple issues — it bound to IPv6-only (`::1`), required CA cert management for HTTPS, and crashed on null errors. A pure `http.createServer` with CONNECT handler is simpler and more reliable.

3. **HTTPS via CONNECT tunneling**: Instead of MITM-ing HTTPS (which requires generating per-domain certs and installing a CA in the trust store), we tunnel HTTPS connections transparently. We capture the **domain and port** of every HTTPS request without decrypting content. This is sufficient for identifying which API endpoints an extension calls.

4. **System proxy via Windows Registry**: Setting `HKCU\...\Internet Settings\ProxyEnable=1` and `ProxyServer=127.0.0.1:9877` routes all Brave traffic through the proxy. The extension's `chrome.proxy.settings` API is also supported via the `proxyStart`/`proxyStop` commands in `background.js`, but the registry approach works without requiring the MCP to have the latest code.

### What Gets Captured

**HTTP requests** (full detail):
- URL, method, host, path
- Request headers and body
- Response status, headers, body (text/JSON/XML only)
- Duration, MIME type

**HTTPS requests** (metadata only):
- Protocol (`https`)
- Domain and port (from CONNECT)
- Connection status (success/failure)
- Timestamp

### Verified Captures

Tested with DeepL extension (`cofdbpoegempjloogbagkncekinflcnj`) translating Wookieepedia pages:

| Domain | Source |
|--------|--------|
| `s.deepl.com:443` | DeepL telemetry |
| `oneshot.fal.pro.deepl.com:443` | DeepL full-page translation API |
| `g.static.mega.co.nz` | MEGA extension update check (HTTP, full body) |
| `starwars.fandom.com:443` | Page load |
| `discord.com:443` | Discord widget embed |

## Usage

### Via extNetwork MCP tool

```
# Start proxy + route browser traffic
extNetwork(extId: "cofdbpoegempjloogbagkncekinflcnj", action: "start")

# Navigate to a page (DeepL translates automatically)
act({ type: "navigate", url: "https://example.com" })

# Wait for translation, then list captured requests
extNetwork(extId: "cofdbpoegempjloogbagkncekinflcnj", action: "list")

# Filter by host
extNetwork(extId: "...", action: "list", hostPattern: "deepl")

# Stop proxy + restore direct connection
extNetwork(extId: "...", action: "stop")
```

### Manual proxy control

```powershell
# Start proxy
cd D:\Yautja; node proxy-standalone.cjs

# Set system proxy
$reg = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
Set-ItemProperty -Path $reg -Name ProxyEnable -Value 1
Set-ItemProperty -Path $reg -Name ProxyServer -Value "127.0.0.1:9877"

# ... browse ...

# Disable proxy
Set-ItemProperty -Path $reg -Name ProxyEnable -Value 0
```

## Files

| File | Purpose |
|------|---------|
| `proxy-standalone.cjs` | Standalone HTTP forward proxy with logging |
| `src/proxy/mitm-proxy.ts` | TypeScript wrapper — spawns proxy as child process, manages lifecycle, queries captured data |
| `src/helmet.ts` | `extNetwork` tool wiring — start/stop/list/installCert actions |
| `src/connection/extension-server.ts` | `proxyStart()`/`proxyStop()` — sends commands to extension's `chrome.proxy.settings` |
| `extension/background.js` | `proxyStart`/`proxyStop` handlers using `chrome.proxy.settings.set()` |
| `extension/manifest.json` | Added `"proxy"` permission |

## Limitations

1. **HTTPS content not decrypted**: CONNECT tunneling captures domain+port only. To decrypt HTTPS content, a MITM approach with CA cert installation is needed (the `http-mitm-proxy` library supports this, but was replaced for stability). The CA cert from the earlier MITM test (`NodeMITMProxyCA`) is still installed in the Windows trust store and can be removed with:
   ```
   certutil -user -delstore Root NodeMITMProxyCA
   ```

2. **System-wide proxy**: Setting the Windows registry proxy affects all applications, not just Brave. Only one proxy capture session should be active at a time.

3. **No request filtering at proxy level**: All traffic is captured. Filtering happens at query time via `hostPattern`.

4. **Port 9877**: Hardcoded. If occupied, the proxy will fail to start with a clear error message.
